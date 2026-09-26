// Admin HTTP connector for http_call (HLD §2 http_call row, §3 http.ts, §4.2,
// §4.4; D8, D31, D40).
//
// The tool builds the URL with buildUrl and decides the call with decideHttp
// from src/gate/http.ts, then hands both here. This module checks them again
// before any I/O:
// - the decision must be an allow for the same method and pathname;
// - the URL must keep the registry base origin and sit under the base path
//   at a segment boundary;
// - services with transport 'cbs' (finacle) are refused; they go through
//   cbs_call.
// Headers are built only here (see auth.ts). fetch never follows a redirect:
// any 3xx is a refusal, so a Location header cannot move the call to another
// host. The body is read up to MAX_HTTP_BODY_BYTES and cut there.
//
// Messages name entities, services and env var names, never a URL, host or
// token. A failed request keeps the fetch error's own words with the URL,
// host, header values and addresses taken out. A non-2xx answer is not an
// error: its status and body go back to the model as the result. In mock
// mode the fixture answers through withMock and fetch is never called.
import type { Config } from '../../config/env.ts';
import type { Registry } from '../../config/registry.ts';
import { CBS_SERVICE, type HttpDecision } from '../../gate/http.ts';
import type { HttpCallFacts } from '../../mock/key.ts';
import type { Entity } from '../../types/core.ts';
import { errorText, safeErrorText, scrubSecrets, stripAddresses } from '../error-text.ts';
import { withMock } from '../mock.ts';
import { ConnectorError, MAX_HTTP_BODY_BYTES, type ConnectorContext, type ConnectorOutcome } from '../types.ts';
import { connectorHeaders, resolveAuth } from './auth.ts';

export type FetchLike = (input: URL, init: RequestInit) => Promise<Response>;

export type HttpConnectorDeps = {
  readonly registry: Pick<Registry, 'service' | 'serviceApi' | 'serviceAuth'>;
  readonly config: { readonly budgets: Pick<Config['budgets'], 'httpTimeoutMs'> };
  /** Defaults to globalThis.fetch. Tests pass a fake. */
  readonly fetchImpl?: FetchLike;
};

export type HttpSendRequest = {
  readonly entity: Entity;
  readonly service: string;
  readonly method: string;
  /** The URL from buildUrl (T02.4). */
  readonly url: URL;
  /** The decideHttp result (T02.4). Anything but an allow is refused. */
  readonly decision: HttpDecision | undefined;
  /** From the IdChain. Sent in the registry customer header when the service has one. */
  readonly customerId?: string;
  /** Sent as JSON. Not allowed on GET or HEAD. */
  readonly body?: unknown;
  /** Facts for the http_call fixture key. */
  readonly keyInput: HttpCallFacts;
};

export type HttpCallData = {
  readonly status: number;
  /** Parsed JSON when the content type says json and the body is whole; text otherwise. */
  readonly body: unknown;
  readonly truncated: boolean;
  readonly rule_index: number | 'default';
};

export type HttpConnector = {
  send(ctx: ConnectorContext, request: HttpSendRequest): Promise<ConnectorOutcome<HttpCallData>>;
};

const NO_BODY_METHODS = new Set(['GET', 'HEAD']);

function refused(message: string): ConnectorError {
  return new ConnectorError('refused', message);
}

/** The base pathname without trailing slashes; '' for '/'. */
function basePrefix(base: URL): string {
  return base.pathname.replace(/\/+$/, '');
}

function parseBase(value: string): URL | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    if (url.username !== '' || url.password !== '') return undefined;
    return url;
  } catch {
    return undefined;
  }
}

/** Refuses a URL that is not on the registry base host and path. */
function checkBound(url: URL, base: URL, where: string): void {
  if (!(url instanceof URL)) throw refused(`${where}: the request URL must come from buildUrl`);
  if (url.origin !== base.origin || url.username !== '' || url.password !== '' || url.hash !== '') {
    throw refused(`${where}: the request URL is not on the registry host for this service`);
  }
  const prefix = basePrefix(base);
  const path = url.pathname;
  if (prefix !== '' && path !== prefix && !path.startsWith(`${prefix}/`)) {
    throw refused(`${where}: the request path is outside the service base path`);
  }
}

function lookupService(registry: HttpConnectorDeps['registry'], entity: Entity, service: string, where: string) {
  try {
    return {
      spec: registry.service(entity, service),
      api: registry.serviceApi(entity, service),
      authCap: registry.serviceAuth(entity, service),
    };
  } catch {
    throw refused(`${where}: not a known service for an enabled entity`);
  }
}

export function createHttpConnector(deps: HttpConnectorDeps): HttpConnector {
  const { registry, config } = deps;
  const fetchImpl: FetchLike = deps.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));

  async function send(ctx: ConnectorContext, request: HttpSendRequest): Promise<ConnectorOutcome<HttpCallData>> {
    const { entity, service, decision } = request;
    const where = `${entity}:${service}`;

    if (service === CBS_SERVICE) throw refused(`${where}: finacle has no HTTP route; use cbs_call`);
    if (decision?.ok !== true || decision.action !== 'allow') {
      throw refused(`${where}: the call has no allow decision from the rules`);
    }
    if (request.method !== decision.method) {
      throw refused(`${where}: the method differs from the one the rules decided`);
    }

    const { spec, api, authCap } = lookupService(registry, entity, service, where);
    if (api === undefined) throw new ConnectorError('not_configured', `${where}: the registry lists no API for this service`);
    if (api.transport === 'cbs') throw refused(`${where}: this service is reachable only through cbs_call`);
    if (api.status !== 'ok') throw new ConnectorError('not_configured', `${where}: ${api.envName} is blank`);
    const base = parseBase(api.value);
    if (base === undefined) throw refused(`${where}: ${api.envName} is not a usable http or https base URL`);

    checkBound(request.url, base, where);
    if (request.url.pathname !== decision.pathname) {
      throw refused(`${where}: the request path differs from the one the rules decided`);
    }

    const k = request.keyInput;
    if (k.entity !== entity || k.service !== service || k.method.toUpperCase() !== decision.method) {
      throw refused(`${where}: the fixture key does not match the request`);
    }

    const method = decision.method;
    let payload: string | undefined;
    if (request.body !== undefined) {
      if (NO_BODY_METHODS.has(method)) throw refused(`${where}: ${method} takes no body`);
      try {
        payload = JSON.stringify(request.body);
      } catch {
        // Left undefined and refused below.
      }
      if (payload === undefined) throw refused(`${where}: the body must be JSON-serialisable`);
    }

    const customer = {
      ...(spec.customer_header !== undefined ? { customerHeader: spec.customer_header } : {}),
      ...(request.customerId !== undefined ? { customerId: request.customerId } : {}),
    };
    // Checked here so a bad id is refused in mock mode too.
    const headerCheck = connectorHeaders(customer);
    if (!headerCheck.ok) throw new ConnectorError(headerCheck.code, `${where}: ${headerCheck.message}`);

    const url = new URL(request.url.href);
    const rule_index = decision.rule_index;
    const timeoutMs = config.budgets.httpTimeoutMs;

    const real = async (signal: AbortSignal) => {
      // Auth is read only on the real path, so mock runs need no credentials.
      const auth = resolveAuth(authCap);
      if (!auth.ok) throw new ConnectorError(auth.code, `${where}: ${auth.message}`);
      const headers = connectorHeaders({
        ...(auth.auth !== undefined ? { auth: auth.auth } : {}),
        ...customer,
        jsonBody: payload !== undefined,
      });
      if (!headers.ok) throw new ConnectorError(headers.code, `${where}: ${headers.message}`);

      const timeout = AbortSignal.timeout(timeoutMs);
      const combined = AbortSignal.any([signal, timeout]);
      // The fetch error and its cause ("fetch failed: getaddrinfo ENOTFOUND
      // ..."), without the base URL, its host, header values or addresses.
      const secrets = [
        api.value,
        base.href,
        base.origin,
        base.host,
        base.hostname,
        url.href,
        ...Object.values(headers.headers).flatMap((v) => [v, ...v.split(/\s+/)]),
      ];
      const failed = (err: unknown): never => {
        if (signal.aborted) throw signal.reason;
        if (timeout.aborted) throw new ConnectorError('timeout', `${where}: no answer within ${timeoutMs} ms`);
        const said = safeErrorText(stripAddresses(scrubSecrets(errorText(err), secrets)));
        throw new ConnectorError('unreachable', `${where}: the request failed${said !== '' ? `: ${said}` : ''}`);
      };

      let response: Response;
      try {
        response = await fetchImpl(url, {
          method,
          headers: { ...headers.headers },
          redirect: 'manual',
          signal: combined,
          ...(payload !== undefined ? { body: payload } : {}),
        });
      } catch (err) {
        return failed(err);
      }

      if ((response.status >= 300 && response.status < 400) || response.type === 'opaqueredirect') {
        await response.body?.cancel().catch(() => undefined);
        throw refused(`${where}: the service answered with a redirect (status ${response.status}); redirects are not followed`);
      }

      let read: { bytes: Uint8Array; truncated: boolean };
      try {
        read = await readCapped(response, MAX_HTTP_BODY_BYTES, combined);
      } catch (err) {
        return failed(err);
      }
      const data: HttpCallData = Object.freeze({
        status: response.status,
        body: decodeBody(read.bytes, response.headers.get('content-type'), read.truncated),
        truncated: read.truncated,
        rule_index,
      });
      return { data, ...(read.truncated ? { truncated: true } : {}) };
    };

    return withMock(ctx, 'http_call', request.keyInput, real, { target_env: api.envName });
  }

  return Object.freeze({ send });
}

/** Reads the body as a stream and stops at max bytes. */
export async function readCapped(
  response: Response,
  max: number,
  signal: AbortSignal,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const stream = response.body;
  if (stream === null) return { bytes: new Uint8Array(0), truncated: false };
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  const onAbort = (): void => {
    reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      const room = max - size;
      if (value.byteLength > room) {
        if (room > 0) chunks.push(value.subarray(0, room));
        size = max;
        truncated = true;
        await reader.cancel().catch(() => undefined);
        break;
      }
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  return { bytes, truncated };
}

const JSON_TYPE = /^application\/(?:[\w.+-]+\+)?json\b/i;

/** JSON when the content type says so and the body is whole; text otherwise. */
export function decodeBody(bytes: Uint8Array, contentType: string | null, truncated: boolean): unknown {
  const text = new TextDecoder('utf-8').decode(bytes);
  if (truncated || contentType === null || !JSON_TYPE.test(contentType.trim()) || text.trim() === '') return text;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
