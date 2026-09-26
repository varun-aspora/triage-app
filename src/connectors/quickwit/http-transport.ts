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
import type { LogsQueryMode } from '../../gate/quickwit.ts';
import type { TimeWindow } from '../../types/core.ts';
import { errorText, safeErrorText, scrubSecrets, stripAddresses } from '../error-text.ts';
import { ConnectorError, MAX_HTTP_BODY_BYTES } from '../types.ts';
import type { LogGroup, LogHit, TransportResult } from './client.ts';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type HttpSearchRequest = {
  /** <ENTITY>_QUICKWIT_URL value. */
  readonly url: string;
  readonly auth: 'none' | 'bearer';
  /** <ENTITY>_QUICKWIT_TOKEN value; used only when auth is bearer. */
  readonly token?: string;
  readonly index: string;
  readonly query: string;
  readonly mode: LogsQueryMode;
  readonly maxHits: number;
  readonly groupBy?: string;
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

/** The name of the terms aggregation used for group_by. */
export const GROUPS_AGG = 'groups';

/** The JSON body for one call. Timestamps are epoch seconds and cover the whole window. */
export function searchBody(req: Pick<HttpSearchRequest, 'query' | 'mode' | 'maxHits' | 'groupBy' | 'window'>): Record<string, unknown> {
  const body: Record<string, unknown> = {
    query: req.query,
    max_hits: req.mode === 'search' ? req.maxHits : 0,
    start_timestamp: Math.floor(Date.parse(req.window.from) / 1000),
    end_timestamp: Math.ceil(Date.parse(req.window.to) / 1000),
  };
  if (req.mode === 'histogram') {
    if (req.groupBy === undefined) throw new ConnectorError('refused', 'group_by is missing');
    body.aggs = { [GROUPS_AGG]: { terms: { field: req.groupBy, size: req.maxHits } } };
  }
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
    await checkStatus(res, names, secrets);
    let text: string;
    try {
      text = await readCapped(res, MAX_HTTP_BODY_BYTES);
    } catch (err) {
      return fail(err);
    }
    return parseResponse(text, req);
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
async function errorBody(res: Response): Promise<string> {
  let text = '';
  try {
    text = await readPrefix(res, ERROR_BODY_BYTES);
  } catch {
    return '';
  }
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

/** The first max bytes of the body as text; the rest is cancelled. */
async function readPrefix(res: Response, max: number): Promise<string> {
  if (res.body === null) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < max) {
    const { done, value } = await reader.read();
    if (done) break;
    const part = value.subarray(0, max - total);
    chunks.push(part);
    total += part.byteLength;
  }
  await reader.cancel().catch(() => {});
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

async function checkStatus(res: Response, names: HttpEnvNames, secrets: readonly string[]): Promise<void> {
  const s = res.status;
  if (res.type === 'opaqueredirect' || (s >= 300 && s < 400)) {
    void res.body?.cancel().catch(() => {});
    throw new ConnectorError('refused', `Quickwit at ${names.url} answered with a redirect; redirects are refused`);
  }
  if (s >= 200 && s < 300) return;
  const body = said(await errorBody(res), secrets);
  if (s === 401 || s === 403) {
    const check = names.token === undefined ? names.auth : `${names.auth} and ${names.token}`;
    throw new ConnectorError('unreachable', `Quickwit refused the credentials (HTTP ${s}); check ${check}${body}`);
  }
  if (s === 400) throw new ConnectorError('refused', `Quickwit rejected the query (HTTP 400)${body}`);
  if (s === 404) throw new ConnectorError('unreachable', `Quickwit has no such index (HTTP 404)${body}`);
  throw new ConnectorError('unreachable', `Quickwit answered HTTP ${s}${body}`);
}

/** Reads the body as text, stopping with cap_exceeded once it passes max bytes. */
async function readCapped(res: Response, max: number): Promise<string> {
  if (res.body === null) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new ConnectorError('cap_exceeded', `the Quickwit response passed the ${max} byte cap; narrow the query or lower max_hits`);
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
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
  if (req.mode === 'search') {
    const hits = parsed.hits;
    if (!Array.isArray(hits) || !hits.every(isObject)) throw invalid();
    return { kind: 'hits', hits: hits as LogHit[], num_hits };
  }
  const agg = isObject(parsed.aggregations) ? parsed.aggregations[GROUPS_AGG] : undefined;
  if (!isObject(agg) || !Array.isArray(agg.buckets)) throw invalid();
  const groups: LogGroup[] = [];
  for (const b of agg.buckets as unknown[]) {
    if (!isObject(b) || !isCount(b.doc_count)) throw invalid();
    const key = typeof b.key === 'string' ? b.key : JSON.stringify(b.key);
    groups.push({ key, count: b.doc_count });
  }
  groups.sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const other = agg.sum_other_doc_count;
  return { kind: 'groups', groups, num_hits, truncated: isCount(other) && other > 0 };
}
