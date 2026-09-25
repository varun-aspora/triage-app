// The one place the console talks to the API. Every authed call carries the
// stored token in the Authorization header; the token never goes into a URL.
// Any 401 clears the stored token and tells the listeners (TokenGate), which
// shows the prompt again.

import { clearToken, getToken } from '../auth/token.ts';
import type { ApiErrorBody } from './types.ts';

export class ApiError extends Error {
  override readonly name = 'ApiError';
  readonly status: number;
  readonly body: ApiErrorBody;

  constructor(status: number, body: ApiErrorBody) {
    super(body.error || `request failed (${status})`);
    this.status = status;
    this.body = body;
  }
}

export type QueryValue = string | number | boolean | readonly string[] | undefined | null;

export type RequestOptions = {
  readonly query?: Readonly<Record<string, QueryValue>>;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  /** false for the public /ui/config.json. Default true. */
  readonly auth?: boolean;
  /**
   * Checks a token the operator just typed instead of the stored one. A 401
   * then only throws: nothing is stored yet, so there is nothing to clear.
   */
  readonly token?: string;
  readonly signal?: AbortSignal;
};

type Listener = () => void;
const listeners = new Set<Listener>();

/** Called after a 401 has cleared the stored token. Returns an unsubscribe function. */
export function onUnauthorized(listener: Listener): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

let fetchImpl: typeof fetch = (input, init) => globalThis.fetch(input, init);

/** Swaps the fetch used by request(). Returns a function that puts the previous one back. For tests. */
export function setFetch(impl: typeof fetch): () => void {
  const previous = fetchImpl;
  fetchImpl = impl;
  return () => {
    fetchImpl = previous;
  };
}

export function buildUrl(path: string, query?: RequestOptions['query']): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) for (const item of value) params.append(key, item);
    else params.append(key, String(value));
  }
  const qs = params.toString();
  return qs === '' ? path : `${path}?${qs}`;
}

export async function request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json', ...options.headers };
  const auth = options.auth ?? true;
  const token = options.token ?? (auth ? getToken() : null);
  if (auth) {
    if (token === null) {
      // No token: behave as the server would, without sending anything.
      notifyUnauthorized(options);
      throw new ApiError(401, { error: 'unauthorized' });
    }
    headers.Authorization = `Bearer ${token}`;
  }
  let body: string | undefined;
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }

  let res: Response;
  try {
    res = await fetchImpl(buildUrl(path, options.query), {
      method,
      headers,
      body,
      signal: options.signal,
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError(0, { error: 'Could not reach the server.' });
  }

  const parsed = await readBody(res);
  if (res.status === 401 && auth) {
    notifyUnauthorized(options);
  }
  if (!res.ok) {
    const errBody: ApiErrorBody =
      parsed !== null && typeof parsed === 'object' && typeof (parsed as { error?: unknown }).error === 'string'
        ? (parsed as ApiErrorBody)
        : { error: `request failed (${res.status})` };
    throw new ApiError(res.status, errBody);
  }
  return parsed as T;
}

function notifyUnauthorized(options: RequestOptions): void {
  if (options.token !== undefined) return;
  clearToken();
  for (const listener of [...listeners]) listener();
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text === '') return undefined;
  if ((res.headers.get('content-type') ?? '').includes('json')) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return undefined;
    }
  }
  return text;
}
