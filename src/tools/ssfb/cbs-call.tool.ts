// cbs_call: one request to the Finacle CBS gateway for the SSFB investigator
// (HLD 02 §2 cbs_call row; D14, D30, D31; Q26 default: laptop kubectl).
//
// - Mounted only when SSFB_CBS_VIA_KUBECTL_ENABLED is exactly 'true'.
// - Order, all inside runIoTool: budget, scope (ids in the path and body
//   must be in the run's IdChain), then the gate: the path must match
//   ^/[A-Za-z0-9/_.-]+$ with no '..' and no query, and the SSFB rules file
//   is evaluated with service 'finacle' (GET and HEAD by default, anything
//   else only where a rule allows it). Every refusal happens before the
//   connector is touched and writes one deny audit line with rule_index.
// - Real mode calls the T04.6 CBS connector, which runs kubectl on the
//   laptop and curl in the eventbus pod with the path, body and token on
//   stdin, never in argv. The connector checks the flag and the gate's
//   decision again.
// - Mock mode answers from the 'cbs_call' fixture keyed by
//   {entity, method, path, body}; the connector is never called, no kubectl
//   runs and the audit line says transport mock.
//
// The gate builds the URL against a fixed placeholder origin. The rules match
// on the path alone, and the connector resolves the path against
// SSFB_CBS_GATEWAY_URL itself, so the tool never reads the gateway value.

import { defineTool } from '@flue/runtime/tool';
import * as v from 'valibot';
import { lookupEnv } from '../../config/env.ts';
import { CBS_KEYS, type CbsConnector, type CbsResponse, createCbsConnector } from '../../connectors/cbs/client.ts';
import { CALLABLE_METHODS, CBS_SERVICE, decideHttp, type HttpAllowed, MAX_PATH_LENGTH } from '../../gate/http.ts';
import type { ApiRule } from '../../gate/rules.ts';
import { loadRulesFile } from '../../gate/rules-file.ts';
import { semanticKey } from '../../mock/key.ts';
import type { ToolEnvelope } from '../../types/tool-result.ts';
import { type BackingRef, type GateDecision, type IoRunContext, runIoTool } from '../_lib/pipeline.ts';
import type { ToolContext, ToolDeps, ToolEnabled, ToolModule } from '../types.ts';
import { outcomeData, realConnectorContext, SSFB } from './_lib/ssfb-io.ts';

declare module '../_lib/context.ts' {
  interface ToolConnectors {
    /** The CBS connector for cbs_call. When missing, one is built per run from the registry and config. */
    readonly cbs?: CbsConnector;
  }
}

const NAME = 'cbs_call';

/** Placeholder origin for the pure URL check; never contacted. */
export const CBS_GATE_BASE = 'https://finacle.invalid';

type Method = (typeof CALLABLE_METHODS)[number];
type CbsBody = Record<string, unknown>;

export function cbsCallEnabled(ctx: Pick<ToolContext, 'config' | 'registry'>): ToolEnabled {
  const flag = lookupEnv(ctx.config, CBS_KEYS.flag);
  if (flag.state !== 'set' || flag.value !== 'true') return { on: false, reason: `${CBS_KEYS.flag} is not true` };
  if (!ctx.registry.isEnabled(SSFB)) return { on: false, reason: `${SSFB} is not in TRIAGE_ENTITIES` };
  return { on: true };
}

// In mock mode the connector reads no env, so the gateway URL need not be set.
function backingFor(ctx: ToolContext): BackingRef {
  if (ctx.deps.fixtures.settings.mockMode) return { envName: CBS_KEYS.gateway, status: 'ok' };
  const api = ctx.registry.serviceApi(SSFB, CBS_SERVICE);
  return { envName: CBS_KEYS.gateway, status: api?.status ?? 'disabled' };
}

function loadRules(ctx: ToolContext): readonly ApiRule[] | null {
  try {
    return loadRulesFile(ctx.config.home, SSFB, ctx.registry.services(SSFB)).rules;
  } catch {
    return null;
  }
}

type GateOutcome = { readonly gate: GateDecision; readonly decision?: HttpAllowed };

/** The pure part of the gate: path, method, body and the rules file. */
export function cbsGate(
  rules: readonly ApiRule[] | null,
  input: { readonly path: unknown; readonly method: string; readonly body?: unknown },
): GateOutcome {
  if (rules === null) {
    return {
      gate: {
        ok: false,
        message: 'Refused: the SSFB rules file could not be loaded, so no cbs_call can be decided. Record the gap.',
        reason: 'rules file failed to load',
        rule_index: 'default',
        action: 'block',
      },
    };
  }
  const path = typeof input.path === 'string' ? input.path : '';
  const decided = decideHttp({ tool: NAME, service: CBS_SERVICE, method: input.method, path, base: CBS_GATE_BASE, rules });
  if (!decided.ok) {
    return {
      gate: {
        ok: false,
        message: `Refused: ${decided.message}.`,
        reason: `gate: ${decided.code}`,
        ...(decided.rule_index !== undefined ? { rule_index: decided.rule_index, action: 'block' as const } : {}),
      },
    };
  }
  // The connector requires the decided pathname to equal the path it sends.
  if (decided.pathname !== path) {
    return {
      gate: {
        ok: false,
        message: "Refused: cbs path must be in plain form (no '.' segments).",
        reason: 'gate: bad_cbs_path',
      },
    };
  }
  if (input.body !== undefined && (decided.method === 'GET' || decided.method === 'HEAD')) {
    return {
      gate: { ok: false, message: `Refused: ${decided.method} takes no body.`, reason: 'gate: body on a read method' },
    };
  }
  return { gate: { ok: true, rule_index: decided.rule_index, action: 'allow' }, decision: decided };
}

// One connector per run when the deps do not carry one.
const builtConnectors = new WeakMap<ToolDeps, CbsConnector>();

function connectorFor(ctx: ToolContext): CbsConnector {
  const given = ctx.deps.connectors.cbs;
  if (given !== undefined) return given;
  let built = builtConnectors.get(ctx.deps);
  if (built === undefined) {
    built = createCbsConnector({ registry: ctx.registry, config: ctx.config });
    builtConnectors.set(ctx.deps, built);
  }
  return built;
}

/** Caps the body the model sees. The status is always kept. */
export function renderCbs(res: CbsResponse, maxChars: number): Record<string, unknown> {
  const cap = Math.max(1, maxChars);
  const text = typeof res.body === 'string' ? res.body : JSON.stringify(res.body ?? null);
  if (text.length <= cap) return { status: res.status, body: res.body, truncated: false };
  return {
    status: res.status,
    body: text.slice(0, cap),
    truncated: true,
    note: `body cut to ${cap} characters`,
  };
}

async function runCbsCall(
  ctx: ToolContext,
  data: { readonly path: string; readonly method?: Method | undefined; readonly body?: CbsBody | undefined },
  flue: { readonly toolCallId: string; readonly log: IoRunContext['log']; readonly signal?: AbortSignal },
): Promise<ToolEnvelope> {
  const method: string = data.method ?? 'GET';
  const path = data.path;
  const body = data.body;
  let decision: HttpAllowed | undefined;

  return runIoTool<'cbs_call', CbsResponse>(
    {
      tool: NAME,
      service: CBS_SERVICE,
      input: data,
      backing: backingFor(ctx),
      scope: {},
      gate: () => {
        const out = cbsGate(loadRules(ctx), { path, method, ...(body !== undefined ? { body } : {}) });
        decision = out.decision;
        return out.gate;
      },
      fixture: () => ({
        kind: 'cbs_call',
        entity: SSFB,
        key: semanticKey('cbs_call', { entity: SSFB, method, path, ...(body !== undefined ? { body } : {}) }),
      }),
      real: async (signal) => {
        const out = await connectorFor(ctx).call(realConnectorContext(ctx, signal), {
          path,
          method,
          decision,
          ...(body !== undefined ? { body } : {}),
          keyInput: { entity: SSFB, service: CBS_SERVICE, method, path, ...(body !== undefined ? { body } : {}) },
        });
        return outcomeData(out);
      },
      render: (res) => renderCbs(res, ctx.config.budgets.maxResponseBytesPerCall),
      summary: (res) => `${NAME} ${SSFB}:${CBS_SERVICE} ${method} status=${String(res.status)}`,
    },
    { toolContext: ctx, toolCallId: flue.toolCallId, log: flue.log, ...(flue.signal !== undefined ? { signal: flue.signal } : {}) },
  );
}

export const toolModule: ToolModule = {
  name: NAME,
  mounts: ['investigator'],
  entities: [SSFB],
  enabled: (ctx) => cbsCallEnabled(ctx),
  create: (ctx) =>
    defineTool({
      name: NAME,
      description:
        'Call the Finacle CBS gateway for SSFB with one path, for balances, holds and account state the admin ' +
        "APIs do not show. path must start with '/' and use only letters, digits and / _ . - (no query string, " +
        "no '..'); any id in it must come from the brief or the ID chain. GET is the default; other methods are " +
        'refused unless the SSFB rules file allows them. Returns status and body (size-capped). "Refused" names the ' +
        'rule; do not retry the same call. "unreachable" means kubectl or the pod did not answer; record the gap.',
      input: v.object({
        path: v.pipe(
          v.string(),
          v.minLength(1),
          v.maxLength(MAX_PATH_LENGTH),
          v.description('Gateway path, for example /fi/accounts/<account_number>/balance. No query string.'),
        ),
        method: v.optional(v.pipe(v.picklist(CALLABLE_METHODS), v.description('HTTP method. Defaults to GET.')), 'GET'),
        body: v.optional(
          v.pipe(v.record(v.string(), v.unknown()), v.description('JSON body, only for a method a rule allows.')),
        ),
      }),
      run: async ({ data, signal, toolCallId, log }): Promise<ToolEnvelope> =>
        runCbsCall(ctx, data, { toolCallId, log, ...(signal !== undefined ? { signal } : {}) }),
    }),
};
