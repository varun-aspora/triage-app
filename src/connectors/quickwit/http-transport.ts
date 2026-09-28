// The direct HTTP transport for logs_search (D44). One POST to
// <ENTITY>_QUICKWIT_URL/api/v1/<index>/search through the injected fetch,
// with redirect: 'manual' (a redirect is refused, never followed) and a hard
// timeout of TRIAGE_HTTP_TIMEOUT_MS.
//
// Auth is none or bearer. The Authorization header is set only for bearer,
// and bearer without a token is not_configured. Error messages name env keys
// and HTTP statuses, never the URL or the token. A non-2xx answer keeps an
// excerpt of Quickwit's own error (its JSON "message", or the body text), and
// a failed fetch keeps its cause, both with the URL, host, token and
// addresses taken out, so the model can see why a query was rejected.
//
// One call is one request: a count (max_hits 0) or one page of hits sorted
// by timestamp. Paging and the group_by tally are done by the client
// (client.ts), the same way as for qw; no aggregation is sent.
import type { LogsOrder } from '../../gate/quickwit.ts';
import { windowSeconds } from '../../gate/quickwit-window.ts';
import type { TimeWindow } from '../../types/core.ts';
import { errorText, safeErrorText, scrubSecrets, stripAddresses } from '../error-text.ts';
import { readCapped } from '../http/client.ts';
import { ConnectorError, MAX_HTTP_BODY_BYTES } from '../types.ts';
import type { LogHit, TransportResult } from './client.ts';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type HttpSearchRequest = {
  /** <ENTITY>_QUICKWIT_URL value. */
  readonly url: string;
  readonly auth: 'none' | 'bearer';
  /** <ENTITY>_QUICKWIT_TOKEN value; used only when auth is bearer. */
  readonly token?: string;
  readonly index: string;
  readonly query: string;
  /** count sends max_hits 0; search asks for one page. */
  readonly mode: 'count' | 'search';
  /** search: hits in the page. */
  readonly maxHits: number;
  /** search: index of the page's first hit. */
  readonly offset: number;
  readonly order: LogsOrder;
  readonly window: TimeWindow;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
};

/** Env key names, for error messages. */
export type HttpEnvNames = {
  readonly url: string;
  readonly auth: string;
  readonly token?: string;
};

/** Quickwit v0.9 and later refuse a page that ends past this many hits. */
export const MAX_PAGE_END = 10_000;

/**
 * The JSON body for one call. Timestamps are epoch seconds and cover the
 * whole window. Quickwit reads a bare sort field as descending and a leading
 * '-' as ascending (the reverse of Elasticsearch).
 */
export function searchBody(req: Pick<HttpSearchRequest, 'query' | 'mode' | 'maxHits' | 'offset' | 'order' | 'window'>): Record<string, unknown> {
  const { start, end } = windowSeconds(req.window);
  const body: Record<string, unknown> = { query: req.query, max_hits: 0, start_timestamp: start, end_timestamp: end };
  if (req.mode === 'count') return body;
  if (req.offset + req.maxHits > MAX_PAGE_END) {
    throw new ConnectorError(
      'refused',
      `offset ${req.offset} is past ${MAX_PAGE_END - req.maxHits}: Quickwit pages at most ${MAX_PAGE_END} hits deep; narrow the window or add a filter`,
    );
  }
  body.max_hits = req.maxHits;
  body.start_offset = req.offset;
  body.sort_by = req.order === 'oldest' ? '-timestamp' : 'timestamp';
  return body;
}

/** The search endpoint, or not_configured when the URL is not a plain http(s) URL. */
export function searchUrl(base: string, index: string, names: HttpEnvNames): string {
  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    throw new ConnectorError('not_configured', `${names.url} is not a valid URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ConnectorError('not_configured', `${names.url} must be an http or https URL`);
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new ConnectorError('not_configured', `${names.url} must not carry credentials; use ${names.auth}=bearer and a token`);
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    throw new ConnectorError('not_configured', `${names.url} must not carry a query string or fragment`);
  }
  const path = parsed.pathname.replace(/\/+$/, '');
  return `${parsed.origin}${path}/api/v1/${encodeURIComponent(index)}/search`;
}

export async function httpSearch(fetchImpl: FetchLike, req: HttpSearchRequest, names: HttpEnvNames): Promise<TransportResult> {
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
  if (req.auth === 'bearer') {
    const token = req.token?.trim() ?? '';
    if (token === '') {
      throw new ConnectorError('not_configured', `${names.token ?? 'the token key'} is blank and ${names.auth} is bearer`);
    }
    headers.authorization = `Bearer ${token}`;
  }
  const url = searchUrl(req.url, req.index, names);
  const body = JSON.stringify(searchBody(req));
  req.signal.throwIfAborted();

  // One controller for both stops, so we know which one fired.
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = (): void => controller.abort(req.signal.reason);
  req.signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, req.timeoutMs);

  const secrets = secretsOf(req, url);
  const fail = (err: unknown): never => {
    if (err instanceof ConnectorError) throw err;
    if (req.signal.aborted) throw req.signal.reason ?? err;
    if (timedOut) throw new ConnectorError('timeout', `Quickwit did not answer within ${req.timeoutMs} ms`, { cause: err });
    throw new ConnectorError('unreachable', `Quickwit at ${names.url} could not be reached${said(errorText(err), secrets)}`, { cause: err });
  };

  try {
    let res: Response;
    try {
      res = await fetchImpl(url, { method: 'POST', headers, body, redirect: 'manual', signal: controller.signal });
    } catch (err) {
      return fail(err);
    }
    await checkStatus(res, names, secrets, controller.signal);
    let read: Awaited<ReturnType<typeof readCapped>>;
    try {
      read = await readCapped(res, MAX_HTTP_BODY_BYTES, controller.signal);
    } catch (err) {
      return fail(err);
    }
    if (read.truncated) {
      throw new ConnectorError('cap_exceeded', `the Quickwit response passed the ${MAX_HTTP_BODY_BYTES} byte cap; narrow the query or lower max_hits`);
    }
    return parseResponse(new TextDecoder().decode(read.bytes), req);
  } finally {
    clearTimeout(timer);
    req.signal.removeEventListener('abort', onAbort);
  }
}

/** The URL, host and token, which never go into a message. */
function secretsOf(req: HttpSearchRequest, url: string): string[] {
  const out = [req.url, url];
  try {
    const parsed = new URL(req.url);
    out.push(parsed.origin, parsed.host, parsed.hostname);
  } catch {
    // searchUrl already refused a bad URL.
  }
  if (req.token !== undefined) out.push(req.token, req.token.trim());
  return out;
}

/** ": <scrubbed excerpt>", or '' when there is nothing to say. */
function said(text: string, secrets: readonly string[]): string {
  const safe = safeErrorText(stripAddresses(scrubSecrets(text, secrets)), [], ERROR_BODY_CHARS);
  return safe === '' ? '' : `: ${safe}`;
}

/** Bytes of an error body read for the message. */
const ERROR_BODY_BYTES = 8 * 1024;
const ERROR_BODY_CHARS = 1000;

/** Quickwit's own error from a non-2xx body: its JSON message, or the text. Never throws. */
async function errorBody(res: Response, signal: AbortSignal): Promise<string> {
  const text = await readCapped(res, ERROR_BODY_BYTES, signal).then(
    (read) => new TextDecoder().decode(read.bytes),
    () => '',
  );
  try {
    const parsed: unknown = JSON.parse(text);
    if (isObject(parsed)) {
      for (const key of ['message', 'error', 'reason']) {
        const value = parsed[key];
        if (typeof value === 'string' && value.trim() !== '') return value;
      }
    }
  } catch {
    // Not JSON: use the text.
  }
  return text;
}

async function checkStatus(res: Response, names: HttpEnvNames, secrets: readonly string[], signal: AbortSignal): Promise<void> {
  const s = res.status;
  if (res.type === 'opaqueredirect' || (s >= 300 && s < 400)) {
    void res.body?.cancel().catch(() => {});
    throw new ConnectorError('refused', `Quickwit at ${names.url} answered with a redirect; redirects are refused`);
  }
  if (s >= 200 && s < 300) return;
  const body = said(await errorBody(res, signal), secrets);
  if (s === 401 || s === 403) {
    const check = names.token === undefined ? names.auth : `${names.auth} and ${names.token}`;
    throw new ConnectorError('unreachable', `Quickwit refused the credentials (HTTP ${s}); check ${check}${body}`);
  }
  if (s === 400) throw new ConnectorError('refused', `Quickwit rejected the query (HTTP 400)${body}`);
  if (s === 404) throw new ConnectorError('unreachable', `Quickwit has no such index (HTTP 404)${body}`);
  throw new ConnectorError('unreachable', `Quickwit answered HTTP ${s}${body}`);
}

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isCount = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x) && x >= 0;

function invalid(): ConnectorError {
  return new ConnectorError('unreachable', 'Quickwit answered with a body that is not the expected JSON');
}

function parseResponse(text: string, req: HttpSearchRequest): TransportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw invalid();
  }
  if (!isObject(parsed) || !isCount(parsed.num_hits)) throw invalid();
  const num_hits = parsed.num_hits;
  if (req.mode === 'count') return { kind: 'count', num_hits };
  const hits = parsed.hits;
  if (!Array.isArray(hits) || !hits.every(isObject)) throw invalid();
  return { kind: 'hits', hits: hits as LogHit[], num_hits };
}
