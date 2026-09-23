// Shared build for the four CodeGraph tools (code_explore, code_node,
// code_callers, code_impact; D11, HLD 02 §1.4 and §2). Each *.tool.ts file
// calls codeToolModule() with its command and texts.
//
// - Input is { repo, <query|symbol> }. repo is a picklist of names from
//   resources/repos.json, never a path. Entity and run id come from the
//   closure (D3).
// - Every call goes through runIoTool, so budget, audit and mock mode work
//   as for every other I/O tool. The gate refuses an unknown repo and a
//   query that fails checkQueryText() before any exec.
// - In mock mode the answer is the 'code_query' fixture keyed by repo,
//   command and query, and neither codegraph nor git runs.
// - In real mode, before the first query per repo per run, ensureSynced
//   (T11.3) runs when CODEGRAPH_SYNC_BEFORE_QUERY=true. The guard is kept
//   per run deps object, so a new run syncs again.
// - A blank CODEGRAPH_BIN, a blank TRIAGE_REPOS_DIR (real mode) or a repo
//   without an index answers 'not configured for code:<repo>'.
// - The output is capped and carries the repo's current commit; taken_at is
//   on the envelope.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { FlueLogger } from '@flue/runtime';
import { defineTool, type ToolDefinition } from '@flue/runtime/tool';
import * as v from 'valibot';
import { loadRepos, REPOS_FILE, repoEnum, type RepoPin } from '../../config/repos.ts';
import {
  checkQueryText,
  type CodegraphConnector,
  codegraphBinBlank,
  type CodeQueryCommand,
  type CodeQueryResult,
  QUERY_MAX_CHARS,
} from '../../connectors/codegraph.ts';
import { ConnectorError } from '../../connectors/types.ts';
import { semanticKey } from '../../mock/key.ts';
import { CODEGRAPH_BIN_KEY, type CodegraphResult, REPOS_DIR_KEY, type SyncOnce } from '../../ops/codegraph.ts';
import type { ToolEnvelope } from '../../types/tool-result.ts';
import { type BackingRef, type GateDecision, runIoTool } from '../_lib/pipeline.ts';
import type { Mount, ToolContext, ToolDeps, ToolModule } from '../types.ts';

declare module '../_lib/context.ts' {
  interface ToolConnectors {
    /** CodeGraph queries for the code tools. Missing means the code tools answer not configured in real mode. */
    readonly codegraph?: CodegraphConnector;
  }
}

export const CODE_TOOL_MOUNTS: readonly Mount[] = Object.freeze(['code_walker', 'investigator_deep']);

/** Most characters of codegraph output the model sees per call. */
export const CODE_OUTPUT_MAX_CHARS = 16_000;

export type CodeToolSpec = {
  readonly name: string;
  readonly command: CodeQueryCommand;
  /** The input field that carries the text codegraph gets. */
  readonly field: 'query' | 'symbol';
  readonly description: string;
  readonly fieldDescription: string;
};

// ------------------------------------------------------------ repo picklist

function manifest(ctx: Pick<ToolContext, 'config' | 'registry'>): readonly RepoPin[] | undefined {
  if (!existsSync(join(ctx.config.paths.resourcesDir, REPOS_FILE))) return undefined;
  return loadRepos(ctx.config, ctx.registry);
}

/**
 * The repo names the code tools accept for this context: pins in
 * resources/repos.json for the investigator's entity, or for any enabled
 * entity on code_walker. When the home has no resources/repos.json (a split
 * test context), the registry's repos are used; real queries still require
 * the repo to be pinned, since resolveRepoDir checks the manifest.
 */
export function codeRepoNames(ctx: Pick<ToolContext, 'config' | 'registry' | 'entity'>): readonly string[] {
  const entities = ctx.entity !== null ? [ctx.entity] : ctx.registry.enabledEntities();
  const pins = manifest(ctx);
  if (pins === undefined) return repoEnum(ctx.registry, [], entities).names;
  const names = pins.filter((p) => p.entities.some((e) => entities.includes(e))).map((p) => p.repo);
  return Object.freeze([...new Set(names)].sort());
}

// ------------------------------------------------------------ sync once per run

// Keyed by the run's deps object: one guard and one entry per repo per run.
// A 'busy' answer is dropped, as T11.3 does, so a later query can sync once
// the lock is free.
type RunSyncs = { readonly guard: SyncOnce; readonly byRepo: Map<string, Promise<CodegraphResult>> };
const runSyncs = new WeakMap<ToolDeps, RunSyncs>();

function syncBeforeFirstQuery(deps: ToolDeps, connector: CodegraphConnector, repo: string): Promise<CodegraphResult> {
  let run = runSyncs.get(deps);
  if (run === undefined) {
    run = { guard: connector.createSyncOnce(), byRepo: new Map() };
    runSyncs.set(deps, run);
  }
  const seen = run.byRepo.get(repo);
  if (seen !== undefined) return seen;
  const byRepo = run.byRepo;
  const pending = run.guard.ensureSynced(repo).then(
    (result) => {
      if (result.status === 'busy') byRepo.delete(repo);
      return result;
    },
    (err: unknown) => {
      byRepo.delete(repo);
      throw err;
    },
  );
  byRepo.set(repo, pending);
  return pending;
}

// ------------------------------------------------------------ result shape

const CodeQueryResultSchema = v.object({
  output: v.string(),
  truncated: v.optional(v.boolean(), false),
  commit: v.optional(v.nullable(v.string()), null),
  exit_code: v.optional(v.number()),
  index_sync: v.optional(v.string()),
});

type RealAnswer = CodeQueryResult & { readonly index_sync?: CodegraphResult['status'] };

// ------------------------------------------------------------ the call

type CodeRunInput = {
  readonly data: Readonly<Record<string, unknown>>;
  readonly signal?: AbortSignal;
  readonly toolCallId: string;
  readonly log: FlueLogger;
};

function gateFor(spec: CodeToolSpec, repos: readonly string[], repo: unknown, text: unknown): GateDecision {
  if (typeof repo !== 'string' || !repos.includes(repo)) {
    return {
      ok: false,
      message: 'Refused: repo is not one of the listed repos. Pick a repo from the list.',
      reason: `repo not in ${REPOS_FILE}`,
    };
  }
  const check = checkQueryText(text);
  if (!check.ok) {
    return {
      ok: false,
      message: `Refused: ${spec.field} ${check.reason}. Use a plain symbol name or phrase without shell characters.`,
      reason: `${spec.field} ${check.reason}`,
    };
  }
  return { ok: true };
}

function backingFor(ctx: ToolContext): BackingRef {
  if (codegraphBinBlank(ctx.config)) return { envName: CODEGRAPH_BIN_KEY, status: 'blank' };
  // Mock mode never touches the checkout, so it does not need the repos dir.
  const mockMode = ctx.deps.fixtures.settings.mockMode;
  if (!mockMode && (ctx.config.paths.reposDir ?? '').trim() === '') return { envName: REPOS_DIR_KEY, status: 'blank' };
  return { envName: CODEGRAPH_BIN_KEY, status: 'ok' };
}

function render(spec: CodeToolSpec, ctx: ToolContext, repo: string, text: string, value: unknown): unknown {
  const parsed = v.safeParse(CodeQueryResultSchema, value);
  if (!parsed.success) throw new Error(`${spec.name}: the code_query answer has the wrong shape`);
  const answer = parsed.output;
  const cap = Math.max(1, Math.min(CODE_OUTPUT_MAX_CHARS, ctx.config.budgets.maxResponseBytesPerCall));
  const cut = answer.output.length > cap;
  return {
    repo,
    command: spec.command,
    [spec.field]: text,
    commit: answer.commit,
    output: cut ? answer.output.slice(0, cap) : answer.output,
    truncated: cut || answer.truncated,
    ...(answer.exit_code !== undefined ? { exit_code: answer.exit_code } : {}),
    ...(answer.index_sync !== undefined ? { index_sync: answer.index_sync } : {}),
  };
}

// The pipeline has no entity for code tools, so its not-configured answer is
// a refusal with this text. Give it the not_configured status instead.
function asNotConfigured(envelope: ToolEnvelope, service: string): ToolEnvelope {
  const out = envelope.output;
  if (out.status === 'refused' && out.message === `not configured for ${service}`) {
    return { output: { ...out, status: 'not_configured' } };
  }
  return envelope;
}

async function runCodeQuery(
  spec: CodeToolSpec,
  ctx: ToolContext,
  repos: readonly string[],
  flue: CodeRunInput,
): Promise<ToolEnvelope> {
  const repo = flue.data['repo'];
  const text = flue.data[spec.field];
  const known = typeof repo === 'string' && repos.includes(repo);
  // Only a listed repo name goes into audit lines and messages.
  const repoName = known ? repo : 'unknown';
  const query = typeof text === 'string' ? text : '';
  const service = `code:${repoName}`;
  const deps = ctx.deps;

  const envelope = await runIoTool<'code_query', RealAnswer>(
    {
      tool: spec.name,
      service,
      input: flue.data,
      entity: null,
      backing: backingFor(ctx),
      scope: 'skip',
      gate: () => gateFor(spec, repos, repo, text),
      fixture: () => ({
        kind: 'code_query',
        entity: 'global',
        key: semanticKey('code_query', { repo: repoName, command: spec.command, query }),
      }),
      real: async (signal) => {
        const connector = deps.connectors.codegraph;
        if (connector === undefined) throw new ConnectorError('not_configured', 'no codegraph connector for this run');
        let index_sync: CodegraphResult['status'] | undefined;
        if (ctx.config.code.syncBeforeQuery) {
          const synced = await syncBeforeFirstQuery(deps, connector, repoName);
          signal.throwIfAborted();
          index_sync = synced.status;
        }
        const answer = await connector.query({ repo: repoName, command: spec.command, query }, signal);
        return index_sync !== undefined ? { ...answer, index_sync } : answer;
      },
      render: (value) => render(spec, ctx, repoName, query, value),
      summary: () => `${spec.name} ${service} ${spec.command}`,
    },
    {
      toolContext: ctx,
      toolCallId: flue.toolCallId,
      log: flue.log,
      ...(flue.signal !== undefined ? { signal: flue.signal } : {}),
    },
  );
  return asNotConfigured(envelope, service);
}

// ------------------------------------------------------------ the module

export function codeToolModule(spec: CodeToolSpec): ToolModule {
  return Object.freeze({
    name: spec.name,
    mounts: CODE_TOOL_MOUNTS,
    entities: 'all',
    enabled(ctx: ToolContext) {
      if (codeRepoNames(ctx).length === 0) {
        return { on: false, reason: `no repos in ${REPOS_FILE} for this agent` } as const;
      }
      return { on: true } as const;
    },
    create(ctx: ToolContext): ToolDefinition {
      const repos = codeRepoNames(ctx);
      const textSchema = v.pipe(
        v.string(),
        v.minLength(1),
        v.maxLength(QUERY_MAX_CHARS),
        v.description(spec.fieldDescription),
      );
      const input = v.object({
        repo: v.pipe(v.picklist(repos), v.description('Repo to query, by name. One of the listed repos; never a path.')),
        ...(spec.field === 'query' ? { query: textSchema } : { symbol: textSchema }),
      });
      return defineTool({
        name: spec.name,
        description: spec.description,
        input,
        run: async ({ data, signal, toolCallId, log }): Promise<ToolEnvelope> =>
          runCodeQuery(spec, ctx, repos, { data: data as Record<string, unknown>, toolCallId, log, ...(signal !== undefined ? { signal } : {}) }),
      });
    },
  });
}
