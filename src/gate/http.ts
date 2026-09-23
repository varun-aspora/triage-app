// URL builder, header builder and method decision for http_call and cbs_call
// (HLD §2 and §3 http.ts; D8, D30, D31, D40).
//
// The model gives a path, never a URL. The base URL comes from the registry
// and is passed in by the tool, so this module reads no env and does no I/O.
// The path is checked as a string first, then resolved with new URL(), and
// the result must keep the base origin and sit under the base pathname at a
// segment boundary. Rules from <entity>.api.rules.json are evaluated on that
// built pathname only, never on the model's string.
//
// Every refusal carries a stable code and a short message meant for the model.
// Messages never echo the rejected value, the base URL or a token.
import type { IdChain } from '../types/id-chain.ts';
import { evaluateRule, type ApiRule } from './rules.ts';

export const HTTP_REFUSAL_CODES = [
  'bad_base',
  'bad_path',
  'outside_base',
  'bad_query',
  'bad_method',
  'finacle_via_http',
  'bad_service',
  'bad_cbs_path',
  'bad_auth',
  'bad_customer_id',
  'blocked_by_rule',
] as const;
export type HttpRefusalCode = (typeof HTTP_REFUSAL_CODES)[number];

export type HttpRefusal = {
  readonly ok: false;
  readonly code: HttpRefusalCode;
  readonly message: string;
  readonly rule_index?: number | 'default';
};

/** Methods the model may ask for. Anything else is refused before the rules run. */
export const CALLABLE_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type CallableMethod = (typeof CALLABLE_METHODS)[number];

export const MAX_PATH_LENGTH = 2048;
export const MAX_QUERY_PARAMS = 50;
export const MAX_QUERY_VALUE_LENGTH = 2048;

const QUERY_KEY = /^[A-Za-z0-9_.\-[\]]+$/;
const CUSTOMER_ID = /^[A-Za-z0-9-]+$/;
const HEADER_NAME = /^[A-Za-z0-9-]+$/;
const CBS_PATH = /^\/[A-Za-z0-9/_.-]+$/;
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
// Control characters and whitespace, including CR, LF, tab and NUL.
const CONTROL_OR_SPACE = /[\u0000- \u007f]/;
const TOKEN_UNSAFE = /[\u0000- \u007f]/;
const PERCENT = /%(.{0,2})/g;
const HEX2 = /^[0-9A-Fa-f]{2}$/;

// Bytes that must never appear percent-encoded in a path, besides control
// bytes. An encoded '.', '/', '\', '#', '?', '@', ';' or '%' would let a
// decoding proxy or server see a different path than the rules did.
const DENIED_ENCODED = new Set<number>([0x2e, 0x2f, 0x5c, 0x23, 0x3f, 0x40, 0x3b, 0x25]);

function refuse(code: HttpRefusalCode, message: string, rule_index?: number | 'default'): HttpRefusal {
  return rule_index === undefined ? { ok: false, code, message } : { ok: false, code, message, rule_index };
}

// ------------------------------------------------------------------ path

/** String checks on the raw path, before any URL parsing. */
function checkRawPath(path: unknown): HttpRefusal | undefined {
  const bad = (why: string) => refuse('bad_path', `path ${why}`);
  if (typeof path !== 'string' || path.length === 0) return bad("must be a non-empty string starting with '/'");
  if (path.length > MAX_PATH_LENGTH) return bad(`must be at most ${MAX_PATH_LENGTH} characters`);
  if (SCHEME.test(path)) return bad('must not carry a scheme; give a path such as /api/v1/x, not a URL');
  if (!path.startsWith('/')) return bad("must start with '/'");
  if (path.includes('//')) return bad("must not contain '//'");
  if (CONTROL_OR_SPACE.test(path)) return bad('must not contain whitespace or control characters');
  if (path.includes('\\')) return bad('must not contain a backslash');
  if (path.includes('..')) return bad("must not contain '..'");
  if (path.includes('@')) return bad("must not contain '@'");
  if (path.includes('#')) return bad("must not contain '#'; fragments are not sent");
  if (path.includes('?')) return bad("must not contain '?'; pass query parameters in query");
  if (path.includes(';')) return bad("must not contain ';'");
  if (path.length > 1 && path.endsWith('/')) return bad("must not end with '/'");
  for (const m of path.matchAll(PERCENT)) {
    const hex = m[1] ?? '';
    if (!HEX2.test(hex)) return bad("has a '%' that is not followed by two hex digits");
    const byte = Number.parseInt(hex, 16);
    if (byte < 0x20 || byte === 0x7f || DENIED_ENCODED.has(byte)) {
      return bad('must not percent-encode control characters or any of . / \\ # ? @ ; %');
    }
  }
  return undefined;
}

type ParsedBase = { readonly url: URL; readonly prefix: string };

function parseBase(base: string | URL): ParsedBase | HttpRefusal {
  let url: URL;
  try {
    url = new URL(typeof base === 'string' ? base : base.href);
  } catch {
    return refuse('bad_base', 'the service base URL in the registry is not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return refuse('bad_base', 'the service base URL in the registry must be http or https');
  }
  if (url.username !== '' || url.password !== '') {
    return refuse('bad_base', 'the service base URL in the registry must not carry credentials');
  }
  if (url.search !== '' || url.hash !== '') {
    return refuse('bad_base', 'the service base URL in the registry must not carry a query or fragment');
  }
  // '/api/' and '/api' both mean the '/api' prefix; '/' means no prefix.
  const prefix = url.pathname.replace(/\/+$/, '');
  return { url, prefix };
}

export type QueryValue = string | number | boolean;
export type QueryInput = Readonly<Record<string, QueryValue | readonly QueryValue[]>>;

function queryValueToString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

/** Appends query parameters with URLSearchParams only. Values are encoded, never split. */
function applyQuery(url: URL, query: QueryInput | undefined): HttpRefusal | undefined {
  if (query === undefined) return undefined;
  if (typeof query !== 'object' || query === null || Array.isArray(query)) {
    return refuse('bad_query', 'query must be an object of key to value');
  }
  const params = new URLSearchParams();
  let count = 0;
  for (const [key, raw] of Object.entries(query)) {
    if (!QUERY_KEY.test(key)) {
      return refuse('bad_query', 'query keys may use only letters, digits and _ . - [ ]');
    }
    const values = Array.isArray(raw) ? raw : [raw];
    for (const value of values) {
      const text = queryValueToString(value);
      if (text === undefined) return refuse('bad_query', 'query values must be strings, finite numbers or booleans');
      if (text.length > MAX_QUERY_VALUE_LENGTH) {
        return refuse('bad_query', `query values must be at most ${MAX_QUERY_VALUE_LENGTH} characters`);
      }
      count += 1;
      if (count > MAX_QUERY_PARAMS) return refuse('bad_query', `at most ${MAX_QUERY_PARAMS} query parameters`);
      params.append(key, text);
    }
  }
  const search = params.toString();
  url.search = search === '' ? '' : `?${search}`;
  return undefined;
}

export type BuiltUrl = { readonly ok: true; readonly url: URL; readonly pathname: string };

/**
 * Builds the request URL from the registry base and the model's path. The
 * origin (scheme, host, port) always comes from the base, userinfo is always
 * empty, and the pathname must equal the base pathname or sit under it at a
 * segment boundary. `pathname` is the canonical path the rules must see.
 */
export function buildUrl(base: string | URL, path: string, query?: QueryInput): BuiltUrl | HttpRefusal {
  const parsedBase = parseBase(base);
  if ('ok' in parsedBase) return parsedBase;
  const rawProblem = checkRawPath(path);
  if (rawProblem !== undefined) return rawProblem;

  let url: URL;
  try {
    url = new URL(path, parsedBase.url);
  } catch {
    return refuse('bad_path', 'path could not be resolved against the service base');
  }

  // Belt and braces: the string checks above should make all of these
  // impossible, but the host binding is the point of this module.
  if (
    url.origin !== parsedBase.url.origin ||
    url.protocol !== parsedBase.url.protocol ||
    url.host !== parsedBase.url.host ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    return refuse('bad_path', 'path must not change the host, port or credentials');
  }

  const { prefix } = parsedBase;
  const pathname = url.pathname;
  if (prefix !== '' && pathname !== prefix && !pathname.startsWith(`${prefix}/`)) {
    return refuse('outside_base', `path must start with the service base path ${prefix}`);
  }

  const queryProblem = applyQuery(url, query);
  if (queryProblem !== undefined) return queryProblem;
  return { ok: true, url, pathname };
}

// --------------------------------------------------------------- headers

export type AuthHeader = { readonly header: string; readonly scheme: 'Bearer' | 'Basic'; readonly token: string };

/**
 * The only inputs headers are built from. There is deliberately no field for
 * headers supplied by the model.
 */
export type HeaderInput = {
  /** Registry auth for the service, with the token already read from env by the tool. */
  readonly auth?: AuthHeader;
  /** Registry customer_header for the service, e.g. 'x-customer-id'. */
  readonly customerHeader?: string;
  readonly idChain: Pick<IdChain, 'ids'>;
};

export type BuiltHeaders = { readonly ok: true; readonly headers: Readonly<Record<string, string>> };

/**
 * Builds request headers from registry auth and the IdChain customer id. The
 * customer header is set only when the registry names one and the IdChain has
 * a customer_id, and only after the id passes ^[A-Za-z0-9-]+$.
 */
export function buildHeaders(input: HeaderInput): BuiltHeaders | HttpRefusal {
  const headers: Record<string, string> = {};

  if (input.auth !== undefined) {
    const { header, scheme, token } = input.auth;
    if (typeof header !== 'string' || !HEADER_NAME.test(header)) {
      return refuse('bad_auth', 'the registry auth header name is not valid');
    }
    if (scheme !== 'Bearer' && scheme !== 'Basic') return refuse('bad_auth', 'the registry auth scheme is not valid');
    if (typeof token !== 'string' || token.length === 0 || TOKEN_UNSAFE.test(token)) {
      return refuse('bad_auth', 'the service token is empty or has characters a header cannot carry');
    }
    headers[header.toLowerCase()] = `${scheme} ${token}`;
  }

  if (input.customerHeader !== undefined) {
    const name = input.customerHeader;
    if (typeof name !== 'string' || !HEADER_NAME.test(name)) {
      return refuse('bad_customer_id', 'the registry customer header name is not valid');
    }
    const key = name.toLowerCase();
    if (key in headers) return refuse('bad_customer_id', 'the registry customer header clashes with the auth header');
    const customerId = input.idChain.ids.customer_id;
    if (customerId !== undefined) {
      if (typeof customerId !== 'string' || !CUSTOMER_ID.test(customerId)) {
        return refuse('bad_customer_id', 'the IdChain customer_id has characters a header cannot carry; call without it');
      }
      headers[key] = customerId;
    }
  }

  return { ok: true, headers: Object.freeze(headers) };
}

// ------------------------------------------------------------------- cbs

export type CheckedCbsPath = { readonly ok: true; readonly path: string };

/** cbs_call paths: ^/[A-Za-z0-9/_.-]+$, no '?' and no '..'. */
export function checkCbsPath(path: unknown): CheckedCbsPath | HttpRefusal {
  if (typeof path !== 'string' || path.length > MAX_PATH_LENGTH || !CBS_PATH.test(path) || path.includes('..')) {
    return refuse(
      'bad_cbs_path',
      "cbs path must start with '/' and use only letters, digits and / _ . - (no query string, no '..')",
    );
  }
  return { ok: true, path };
}

// -------------------------------------------------------------- decision

export type HttpTool = 'http_call' | 'cbs_call';

export type HttpDecisionInput = {
  readonly tool: HttpTool;
  readonly service: string;
  /** Defaults to GET. Must be one of CALLABLE_METHODS exactly (upper case, no spaces). */
  readonly method?: string;
  readonly path: string;
  readonly query?: QueryInput;
  /** The service base URL, resolved by the tool through the registry. */
  readonly base: string | URL;
  readonly rules: readonly ApiRule[];
};

export type HttpAllowed = {
  readonly ok: true;
  readonly url: URL;
  readonly pathname: string;
  readonly method: CallableMethod;
  readonly rule_index: number | 'default';
  readonly action: 'allow';
  readonly reason?: string;
};

export type HttpDecision = HttpAllowed | HttpRefusal;

export const CBS_SERVICE = 'finacle';

/**
 * Decides one http_call or cbs_call. Order: finacle refused on http_call,
 * method check, cbs path check, URL build, then evaluateRule on the built
 * pathname. cbs_call is always evaluated as service 'finacle' and takes no
 * query.
 */
export function decideHttp(input: HttpDecisionInput): HttpDecision {
  const { tool, service } = input;

  if (tool === 'http_call' && service === CBS_SERVICE) {
    return refuse('finacle_via_http', 'finacle has no HTTP route; use cbs_call for Finacle paths');
  }
  if (tool === 'cbs_call' && service !== CBS_SERVICE) {
    return refuse('bad_service', `cbs_call only reaches ${CBS_SERVICE}`);
  }

  const method = input.method ?? 'GET';
  if (!(CALLABLE_METHODS as readonly string[]).includes(method)) {
    return refuse('bad_method', `method must be one of ${CALLABLE_METHODS.join(', ')}`);
  }

  if (tool === 'cbs_call') {
    const cbs = checkCbsPath(input.path);
    if (!cbs.ok) return cbs;
    if (input.query !== undefined && Object.keys(input.query).length > 0) {
      return refuse('bad_query', 'cbs_call takes no query parameters');
    }
  }

  const built = buildUrl(input.base, input.path, tool === 'cbs_call' ? undefined : input.query);
  if (!built.ok) return built;

  const decision = evaluateRule(input.rules, { service, method, pathname: built.pathname });
  if (decision.action !== 'allow') {
    const where = decision.rule_index === 'default' ? 'by default' : `by rule ${decision.rule_index}`;
    const why = decision.reason === undefined ? '' : `: ${decision.reason}`;
    return refuse('blocked_by_rule', `${method} on this path is blocked ${where}${why}`, decision.rule_index);
  }

  const allowed: HttpAllowed = {
    ok: true,
    url: built.url,
    pathname: built.pathname,
    method: method as CallableMethod,
    rule_index: decision.rule_index,
    action: 'allow',
    ...(decision.reason === undefined ? {} : { reason: decision.reason }),
  };
  return allowed;
}
