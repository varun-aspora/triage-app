// HTTP method policy over resources/<entity>.api.rules.json (HLD §4.4, D31, D40).
//
// Rules are checked top to bottom and the first rule whose service, method and
// api all match decides. With no match, GET and HEAD are allowed and every
// other method is blocked. Matching runs on the canonical pathname built by
// the gate's URL builder, never on the model's string, and never on a query.
//
// Everything here is pure. src/gate/rules-file.ts does the file read.

export type RuleAction = 'allow' | 'block';

export type ApiRule = {
  readonly service: string;
  readonly method: string;
  readonly api: string;
  readonly action: RuleAction;
  readonly reason?: string;
  readonly confirm_broad?: boolean;
};

export type RuleRequest = {
  readonly service: string;
  readonly method: string;
  readonly pathname: string;
};

export type RuleDecision = {
  readonly action: RuleAction;
  readonly rule_index: number | 'default';
  readonly reason?: string;
};

export type RulesValidation = {
  readonly rules: readonly ApiRule[];
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
};

export const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];
const HTTP_METHOD_SET: ReadonlySet<string> = new Set(HTTP_METHODS);

/** Methods allowed when no rule matches. */
export const DEFAULT_ALLOWED_METHODS: readonly string[] = Object.freeze(['GET', 'HEAD']);

const DEFAULT_ALLOW_REASON = 'no rule matched; GET and HEAD are allowed by default';
const DEFAULT_BLOCK_REASON = 'no rule matched; only GET and HEAD are allowed by default';
const BAD_PATH_REASON = 'pathname must be an absolute path with no query string or fragment';

const RULE_KEYS = new Set(['service', 'method', 'api', 'action', 'reason', 'confirm_broad']);
const PARAM_SEGMENT = /^:[A-Za-z_][A-Za-z0-9_]*$/;
const LITERAL_SEGMENT = /^[A-Za-z0-9._~!$&'()+,;=@%-][A-Za-z0-9._~!$&'()+,;=@%:-]*$/;

// ---------------------------------------------------------------- matching

type Template =
  | { readonly kind: 'all' }
  | { readonly kind: 'path'; readonly segments: readonly string[]; readonly subtree: boolean };

/** Parses a template, or returns undefined when it is malformed. */
function parseTemplate(template: string): Template | undefined {
  if (template === '*') return { kind: 'all' };
  if (!template.startsWith('/')) return undefined;
  const segments = template.slice(1).split('/');
  let subtree = false;
  if (segments.length > 1 && segments[segments.length - 1] === '*') {
    subtree = true;
    segments.pop();
  }
  for (const seg of segments) {
    if (PARAM_SEGMENT.test(seg)) continue;
    if (!LITERAL_SEGMENT.test(seg)) return undefined;
  }
  return { kind: 'path', segments, subtree };
}

function isCanonicalPathname(pathname: string): boolean {
  if (!pathname.startsWith('/')) return false;
  if (pathname.includes('?') || pathname.includes('#')) return false;
  return !/[\u0000-\u001f\u007f\s]/.test(pathname);
}

function segmentMatches(templateSeg: string, pathSeg: string): boolean {
  if (templateSeg.startsWith(':')) return pathSeg.length > 0;
  return templateSeg === pathSeg;
}

/**
 * True when the pathname matches the template. ':name' is one non-empty
 * segment, a trailing '/*' is any suffix at a segment boundary, '*' alone is
 * every path. A pathname with a query string, a fragment or no leading '/'
 * never matches, and neither does a malformed template.
 */
export function matchTemplate(template: string, pathname: string): boolean {
  if (!isCanonicalPathname(pathname)) return false;
  const t = parseTemplate(template);
  if (t === undefined) return false;
  if (t.kind === 'all') return true;
  const parts = pathname.slice(1).split('/');
  if (t.subtree) {
    if (parts.length <= t.segments.length) return false;
  } else if (parts.length !== t.segments.length) {
    return false;
  }
  return t.segments.every((seg, i) => segmentMatches(seg, parts[i] as string));
}

// -------------------------------------------------------------- evaluation

/**
 * Decides one request. Pure and total: every input gets a decision. A
 * pathname that is not canonical (for example one carrying '?') is blocked
 * with rule_index 'default' before any rule is looked at.
 */
export function evaluateRule(rules: readonly ApiRule[], request: RuleRequest): RuleDecision {
  if (typeof request.pathname !== 'string' || !isCanonicalPathname(request.pathname)) {
    return { action: 'block', rule_index: 'default', reason: BAD_PATH_REASON };
  }
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i] as ApiRule;
    if (rule.service !== '*' && rule.service !== request.service) continue;
    if (rule.method !== '*' && rule.method !== request.method) continue;
    if (!matchTemplate(rule.api, request.pathname)) continue;
    const action: RuleAction = rule.action === 'allow' ? 'allow' : 'block';
    return rule.reason === undefined ? { action, rule_index: i } : { action, rule_index: i, reason: rule.reason };
  }
  if (DEFAULT_ALLOWED_METHODS.includes(request.method)) {
    return { action: 'allow', rule_index: 'default', reason: DEFAULT_ALLOW_REASON };
  }
  return { action: 'block', rule_index: 'default', reason: DEFAULT_BLOCK_REASON };
}

// -------------------------------------------------------------- validation

/** True when every path that `inner` matches is also matched by `outer`. */
function templateCovers(outer: Template, inner: Template): boolean {
  if (outer.kind === 'all') return true;
  if (inner.kind === 'all') return false;
  const n = outer.segments.length;
  if (outer.subtree) {
    // inner must always have more than n segments.
    const minInner = inner.segments.length + (inner.subtree ? 1 : 0);
    if (minInner <= n) return false;
  } else {
    if (inner.subtree || inner.segments.length !== n) return false;
  }
  for (let i = 0; i < n; i++) {
    const o = outer.segments[i] as string;
    const s = inner.segments[i] as string;
    if (o.startsWith(':')) continue;
    if (o !== s) return false;
  }
  return true;
}

function isBroadAllow(rule: ApiRule): boolean {
  if (rule.action !== 'allow') return false;
  if (rule.api === '*') return true;
  return rule.method === '*' && rule.api.endsWith('/*');
}

function hasReason(rule: { reason?: unknown }): boolean {
  return typeof rule.reason === 'string' && rule.reason.trim() !== '';
}

function quote(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value.length > 80 ? `${value.slice(0, 80)}...` : value);
  return typeof value;
}

type Checked = { readonly rule: ApiRule; readonly template: Template };

/** Checks one entry's shape and fields. Returns the rule or pushes errors. */
function checkEntry(raw: unknown, at: string, services: ReadonlySet<string>, errors: string[]): Checked | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    errors.push(`${at}: must be an object`);
    return undefined;
  }
  const entry = raw as Record<string, unknown>;
  const before = errors.length;

  for (const key of Object.keys(entry)) {
    if (!RULE_KEYS.has(key)) errors.push(`${at}: unknown field ${quote(key)}`);
  }

  const { service, method, api, action, reason, confirm_broad } = entry;

  if (typeof service !== 'string') errors.push(`${at}: service must be a string`);
  else if (service !== '*' && !services.has(service)) errors.push(`${at}: unknown service ${quote(service)}`);

  if (typeof method !== 'string') errors.push(`${at}: method must be a string`);
  else if (method !== '*' && !HTTP_METHOD_SET.has(method)) {
    const upper = method.toUpperCase();
    if (upper !== method && HTTP_METHOD_SET.has(upper)) {
      errors.push(`${at}: method ${quote(method)} must be upper case`);
    } else {
      errors.push(`${at}: unknown method ${quote(method)}`);
    }
  }

  let template: Template | undefined;
  if (typeof api !== 'string') errors.push(`${at}: api must be a string`);
  else if (api.includes('?') || api.includes('#')) errors.push(`${at}: api must not contain a query string or fragment`);
  else {
    template = parseTemplate(api);
    if (template === undefined) {
      errors.push(`${at}: api ${quote(api)} must be '*' or a path of literal, ':name' and trailing '/*' segments`);
    }
  }

  if (action !== 'allow' && action !== 'block') errors.push(`${at}: action ${quote(action)} must be allow or block`);
  if (reason !== undefined && typeof reason !== 'string') errors.push(`${at}: reason must be a string`);
  if (confirm_broad !== undefined && typeof confirm_broad !== 'boolean') {
    errors.push(`${at}: confirm_broad must be a boolean`);
  }

  if (errors.length > before || template === undefined) return undefined;

  const rule: ApiRule = Object.freeze({
    service: service as string,
    method: method as string,
    api: api as string,
    action: action as RuleAction,
    ...(reason === undefined ? {} : { reason: reason as string }),
    ...(confirm_broad === undefined ? {} : { confirm_broad: confirm_broad as boolean }),
  });
  return { rule, template };
}

/**
 * Validates a parsed rules file. Errors and warnings name the rule by its
 * index in the file. `rules` holds the valid entries in file order; callers
 * must not use it when `errors` is non-empty.
 */
export function validateRules(raw: unknown, serviceNames: readonly string[]): RulesValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!Array.isArray(raw)) {
    return { rules: Object.freeze([]), errors: Object.freeze(['file must be a JSON array of rules']), warnings: Object.freeze([]) };
  }

  const services = new Set(serviceNames);
  const checked: { index: number; value: Checked }[] = [];

  raw.forEach((entry, index) => {
    const at = `rule ${index}`;
    const value = checkEntry(entry, at, services, errors);
    if (value === undefined) return;
    const { rule, template } = value;

    if (isBroadAllow(rule) && !(rule.confirm_broad === true && hasReason(rule))) {
      errors.push(`${at}: allow is too broad; set confirm_broad: true and a reason`);
    } else if (rule.action === 'allow' && !hasReason(rule)) {
      warnings.push(`${at}: allow has no reason`);
    }

    for (const earlier of checked) {
      const e = earlier.value.rule;
      const sameKey = e.service === rule.service && e.method === rule.method && e.api === rule.api;
      if (sameKey) {
        errors.push(`${at}: duplicate of rule ${earlier.index}`);
        break;
      }
      const serviceCovers = e.service === '*' || e.service === rule.service;
      const methodCovers = e.method === '*' || e.method === rule.method;
      if (serviceCovers && methodCovers && templateCovers(earlier.value.template, template)) {
        errors.push(`${at}: never reached; shadowed by rule ${earlier.index}`);
        break;
      }
    }

    checked.push({ index, value });
  });

  return {
    rules: Object.freeze(checked.map((c) => c.value.rule)),
    errors: Object.freeze(errors),
    warnings: Object.freeze(warnings),
  };
}
