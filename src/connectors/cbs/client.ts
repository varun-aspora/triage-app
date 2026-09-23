// The CBS connector behind cbs_call (HLD §2 cbs_call row; D14, D30, A13).
//
// call(ctx, {path, method, decision, body?, keyInput}) runs in this order:
// 1. SSFB_CBS_VIA_KUBECTL_ENABLED must be true, else not_configured.
// 2. decision must be an allow from the T02 rules gate (decideHttp with
//    service finacle) for this exact method and path, else refused.
// 3. The path is checked again: ^/[A-Za-z0-9/_.-]+$ with no '..', no '?'
//    and no '//'.
// 4. Mock mode answers from the fixture (key {entity, method, path, body})
//    and never runs kubectl or touches the token cache.
// 5. Real mode checks every env value, finds a Running eventbus pod, gets a
//    token (cache or mint) and runs curl in the pod with the request on
//    stdin. A 401 clears the cache, mints once and retries once.
//
// Every CBS API request carries a fresh RequestUUID header ("asp" plus 7
// random letters or digits), as the bank's gateway expects. The OAuth mint
// does not send one.
//
// Errors are ConnectorError and name env keys only, never their values.
import { randomInt } from 'node:crypto';
import { lookupEnv, type Config } from '../../config/env.ts';
import type { Registry } from '../../config/registry.ts';
import { CALLABLE_METHODS, CBS_SERVICE, checkCbsPath, type HttpDecision } from '../../gate/http.ts';
import type { CbsCallFacts } from '../../mock/key.ts';
import { createExecRunner, type ExecRunner } from '../exec.ts';
import { withMock } from '../mock.ts';
import { ConnectorError, MAX_HTTP_BODY_BYTES, type ConnectorContext, type ConnectorOutcome } from '../types.ts';
import { checkKubeConfig, parseSecretRef, podCurl, resolvePod, type KubeConfig, type SecretRef } from './kubectl.ts';
import { clearToken, getToken, type TokenConfig } from './token-cache.ts';

export const CBS_ENTITY = 'ssfb';

/** The env keys this connector reads. */
export const CBS_KEYS = Object.freeze({
  flag: 'SSFB_CBS_VIA_KUBECTL_ENABLED',
  context: 'SSFB_KUBE_CONTEXT',
  namespace: 'SSFB_CBS_K8S_NAMESPACE',
  selector: 'SSFB_CBS_POD_SELECTOR',
  container: 'SSFB_CBS_CONTAINER',
  secret: 'SSFB_CBS_CREDS_SECRET',
  gateway: 'SSFB_CBS_GATEWAY_URL',
  scope: 'SSFB_CBS_OAUTH_SCOPE',
  source: 'SSFB_CBS_SOURCE',
  sourceIdentifier: 'SSFB_CBS_SOURCE_IDENTIFIER',
});

export type CbsResponse = {
  readonly status: number;
  /** Parsed JSON when the body is JSON, else the text. */
  readonly body: unknown;
};

export type CbsCallInput = {
  readonly path: string;
  /** Defaults to GET. Must equal the method the gate decided on. */
  readonly method?: string;
  /** The gate's decision for this call. Anything but an allow is refused. */
  readonly decision: HttpDecision | undefined;
  readonly body?: unknown;
  /** Mock key facts. service is accepted for the caller's clarity and must be finacle. */
  readonly keyInput: CbsCallFacts & { readonly service?: string };
};

export type CbsConnector = {
  /** True when the entity is enabled and SSFB_CBS_VIA_KUBECTL_ENABLED=true. */
  enabled(): boolean;
  call(ctx: ConnectorContext, input: CbsCallInput): Promise<ConnectorOutcome<CbsResponse>>;
};

export type CbsConnectorOptions = {
  readonly registry: Registry;
  readonly config: Config;
  /** Defaults to the real runner. Tests pass the fake from exec-fake.ts. */
  readonly exec?: ExecRunner;
  /** Defaults to kubectl on PATH. */
  readonly kubectlBin?: string;
};

const RID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** A RequestUUID for one CBS request: "asp" plus 7 random alphanumerics. */
export function newRequestUuid(): string {
  let id = 'asp';
  for (let i = 0; i < 7; i++) id += RID_CHARS[randomInt(RID_CHARS.length)];
  return id;
}

function refused(message: string): ConnectorError {
  return new ConnectorError('refused', message);
}

/** The path checks on top of the gate: charset, no '..', no '?', no '//'. */
export function checkPath(path: unknown): string {
  const checked = checkCbsPath(path);
  if (!checked.ok) throw refused(checked.message);
  if (checked.path.includes('?') || checked.path.includes('//')) {
    throw refused("cbs path must not hold '?' or '//'");
  }
  return checked.path;
}

/** Refuses unless decision is an allow for exactly this method and path. */
export function checkDecision(decision: HttpDecision | undefined, method: string, path: string): void {
  if (decision === undefined || decision === null || typeof decision !== 'object') {
    throw refused('cbs_call needs an allow decision from the rules gate');
  }
  if (decision.ok !== true || decision.action !== 'allow') {
    throw refused('the rules gate did not allow this cbs_call');
  }
  if (decision.method !== method) throw refused('method differs from the one the rules gate decided on');
  if (decision.pathname !== path) throw refused('path differs from the one the rules gate decided on');
}

function checkKeyInput(keyInput: CbsCallInput['keyInput'], method: string, path: string): void {
  if (typeof keyInput !== 'object' || keyInput === null) throw refused('cbs_call needs keyInput');
  if (keyInput.entity !== CBS_ENTITY) throw refused(`cbs_call keyInput entity must be ${CBS_ENTITY}`);
  if (keyInput.service !== undefined && keyInput.service !== CBS_SERVICE) {
    throw refused(`cbs_call keyInput service must be ${CBS_SERVICE}`);
  }
  if ((keyInput.method ?? 'GET').toUpperCase() !== method || keyInput.path !== path) {
    throw refused('cbs_call keyInput must name the same method and path as the call');
  }
}

type RealEnv = {
  readonly kube: KubeConfig;
  readonly secret: SecretRef;
  readonly gatewayUrl: string;
  readonly scope: string;
  readonly source?: string;
  readonly sourceIdentifier?: string;
  readonly maxTimeSec: number;
};

function checkGateway(value: string): string {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw refused(`${CBS_KEYS.gateway} is not a URL`);
  }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username !== '' || u.password !== '' || u.search !== '' || u.hash !== '') {
    throw refused(`${CBS_KEYS.gateway} must be an http(s) URL without credentials, query or fragment`);
  }
  return value;
}

export function createCbsConnector(options: CbsConnectorOptions): CbsConnector {
  const { registry, config } = options;
  let runner: ExecRunner | undefined = options.exec;
  const exec = (): ExecRunner => (runner ??= createExecRunner());

  const enabled = (): boolean => registry.isEnabled(CBS_ENTITY) && registry.cbsEnabled(CBS_ENTITY);

  function envValue(name: string): string {
    const l = lookupEnv(config, name);
    if (l.state !== 'set') throw new ConnectorError('not_configured', `cbs_call is not configured for ${CBS_ENTITY}: ${name} is blank`);
    return l.value;
  }

  // A header value from env: left out when blank, printable ASCII only when set.
  function headerEnv(name: string): string | undefined {
    const l = lookupEnv(config, name);
    if (l.state !== 'set') return undefined;
    if (!/^[\u0020-\u007e]+$/.test(l.value)) throw refused(`${name} must be printable ASCII to go in a header`);
    return l.value;
  }

  // Read only on a real call, so mock mode needs none of these set.
  function realEnv(): RealEnv {
    const api = registry.serviceApi(CBS_ENTITY, CBS_SERVICE);
    if (api === undefined || api.status !== 'ok') {
      throw new ConnectorError('not_configured', `cbs_call is not configured for ${CBS_ENTITY}: ${CBS_KEYS.gateway} is blank`);
    }
    const ctxCap = registry.kube(CBS_ENTITY).context;
    if (ctxCap.status !== 'ok') {
      throw new ConnectorError('not_configured', `cbs_call is not configured for ${CBS_ENTITY}: ${ctxCap.envName} is blank`);
    }
    const timeoutMs = config.budgets.httpTimeoutMs;
    const kube = checkKubeConfig(
      {
        context: ctxCap.value,
        namespace: envValue(CBS_KEYS.namespace),
        selector: envValue(CBS_KEYS.selector),
        container: envValue(CBS_KEYS.container),
        timeoutMs,
        ...(options.kubectlBin !== undefined ? { bin: options.kubectlBin } : {}),
      },
      { context: ctxCap.envName, namespace: CBS_KEYS.namespace, selector: CBS_KEYS.selector, container: CBS_KEYS.container },
    );
    const source = headerEnv(CBS_KEYS.source);
    const sourceIdentifier = headerEnv(CBS_KEYS.sourceIdentifier);
    return {
      kube,
      secret: parseSecretRef(envValue(CBS_KEYS.secret), CBS_KEYS.secret),
      gatewayUrl: checkGateway(api.value),
      scope: envValue(CBS_KEYS.scope),
      ...(source !== undefined ? { source } : {}),
      ...(sourceIdentifier !== undefined ? { sourceIdentifier } : {}),
      maxTimeSec: Math.max(1, Math.ceil(timeoutMs / 1000)),
    };
  }

  async function call(ctx: ConnectorContext, input: CbsCallInput): Promise<ConnectorOutcome<CbsResponse>> {
    if (!enabled()) {
      throw new ConnectorError('not_configured', `cbs_call is off for ${CBS_ENTITY}: ${CBS_KEYS.flag} is not true`);
    }
    const method = input.method ?? 'GET';
    if (!(CALLABLE_METHODS as readonly string[]).includes(method)) {
      throw refused(`method must be one of ${CALLABLE_METHODS.join(', ')}`);
    }
    const path = checkPath(input.path);
    checkDecision(input.decision, method, path);
    if (input.body !== undefined && (method === 'GET' || method === 'HEAD')) throw refused(`${method} takes no body`);
    checkKeyInput(input.keyInput, method, path);
    const { entity, method: keyMethod, path: keyPath, body: keyBody } = input.keyInput;
    const facts: CbsCallFacts = {
      entity,
      path: keyPath,
      ...(keyMethod !== undefined ? { method: keyMethod } : {}),
      ...(keyBody !== undefined ? { body: keyBody } : {}),
    };

    return withMock(
      ctx,
      'cbs_call',
      facts,
      async (signal) => {
        const env = realEnv();
        const run = exec();
        const pod = await resolvePod(run, env.kube, signal);
        const tokenCfg: TokenConfig = {
          dataDir: config.paths.dataDir,
          kube: env.kube,
          pod,
          secret: env.secret,
          gatewayUrl: env.gatewayUrl,
          scope: env.scope,
          maxTimeSec: env.maxTimeSec,
        };
        const tctx = { signal, now: () => ctx.now() };
        const url = new URL(path, env.gatewayUrl).toString();
        const data =
          input.body === undefined ? undefined : typeof input.body === 'string' ? input.body : JSON.stringify(input.body);

        const send = (token: string) => {
          const headers: [string, string][] = [
            ['Authorization', `Bearer ${token}`],
            ['Accept', 'application/json'],
            ['RequestUUID', newRequestUuid()],
          ];
          if (env.source !== undefined) headers.push(['Source', env.source]);
          if (env.sourceIdentifier !== undefined) headers.push(['SourceIdentifier', env.sourceIdentifier]);
          if (data !== undefined) headers.push(['Content-Type', 'application/json']);
          return podCurl(
            run,
            env.kube,
            pod,
            { url, method, headers, ...(data !== undefined ? { data } : {}) },
            { signal, maxTimeSec: env.maxTimeSec, maxOutputBytes: MAX_HTTP_BODY_BYTES },
          );
        };

        let token = await getToken(tctx, run, tokenCfg);
        let res = await send(token);
        if (res.status === 401) {
          await clearToken(tokenCfg, token);
          token = await getToken(tctx, run, tokenCfg);
          res = await send(token);
        }
        return { data: Object.freeze({ status: res.status, body: parseBody(res.body) }) };
      },
      { target_env: CBS_KEYS.gateway },
    );
  }

  return Object.freeze({ enabled, call });
}

function parseBody(text: string): unknown {
  if (text === '') return '';
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
