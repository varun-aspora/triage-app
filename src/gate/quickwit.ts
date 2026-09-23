// Quickwit query builder for logs_search, shared by the qw and http
// transports (D44). Pure: it imports no I/O module, reads no env, and takes
// the entity's limits and field allowlist as arguments.
//
// The rules come from the old search.py and search_sim_binding.py scripts:
// `message` is a phrase query, `error` is a per-word AND (the field has no
// positions indexed, so a phrase query on it is an HTTP 400), and a dashed
// UUID given as a bare term is cut to its first segment because the default
// field has no positions either.
import type { Registry } from '../config/registry.ts';
import type { Entity } from '../types/core.ts';

/** What the gate needs to know about one entity's Quickwit. */
export type QuickwitGateConfig = {
  readonly entity: Entity;
  /** Field names the model may filter or group by (registry quickwit_fields). */
  readonly fields: readonly string[];
  /** Registry service name -> the service value in the logs, when the service has one. */
  readonly services: Readonly<Record<string, string | undefined>>;
  /** <ENTITY>_QUICKWIT_MAX_HITS. */
  readonly maxHits: number;
};

/** The typed logs_search input the builder reads. from/to are handled by quickwit-window.ts. */
export type LogsQueryInput = {
  readonly service: string;
  readonly message?: string;
  readonly error?: string;
  readonly terms?: readonly string[];
  /** Field filters, name -> value. Names must be in the entity allowlist. */
  readonly fields?: Readonly<Record<string, string>>;
  readonly level?: string;
  readonly max_hits?: number;
  readonly group_by?: string;
  readonly count?: boolean;
};

export type LogsQueryMode = 'search' | 'count' | 'histogram';

export type LogsQuery = {
  readonly ok: true;
  readonly query: string;
  /** Output projection for qw --fields: the entity allowlist. */
  readonly fields: readonly string[];
  readonly maxHits: number;
  readonly mode: LogsQueryMode;
  readonly groupBy?: string;
  /** The service value used in the query. */
  readonly service: string;
  /** Short notes for the model, e.g. a clamped max_hits or a cut UUID. */
  readonly notes: readonly string[];
};

export type LogsQueryRefusal = { readonly ok: false; readonly reason: string };

export type LogsQueryResult = LogsQuery | LogsQueryRefusal;

export const MAX_TERMS = 20;
export const MAX_FIELD_FILTERS = 20;
export const MAX_VALUE_LENGTH = 512;

// Fields the model may not filter through `fields`: service and level have
// their own inputs, and the time window is applied by quickwit-window.ts.
const RESERVED_FILTER_FIELDS = new Set(['service', 'level', 'timestamp']);

const BOOLEAN_WORDS = new Set(['AND', 'OR', 'NOT', 'TO', 'IN']);

// Characters the Quickwit query language reserves. A backslash in front makes
// them part of the word.
const RESERVED_CHARS = new Set(['+', '^', '`', ':', '{', '}', '"', "'", '[', ']', '(', ')', '~', '!', '\\', '*', ' ']);

const UUID_DASHED = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LEVEL = /^[A-Za-z]{1,16}$/;
// Control characters, including newline, tab and NUL.
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Builds the gate config for an entity from the registry, or undefined when its Quickwit is disabled. */
export function quickwitGateConfig(registry: Registry, entity: Entity): QuickwitGateConfig | undefined {
  const cap = registry.quickwit(entity);
  if (cap.status !== 'ok') return undefined;
  const services: Record<string, string | undefined> = {};
  for (const name of registry.services(entity)) services[name] = registry.service(entity, name).quickwit_service;
  return Object.freeze({
    entity,
    fields: Object.freeze([...registry.quickwitFields(entity)]),
    services: Object.freeze(services),
    maxHits: cap.maxHits,
  });
}

/**
 * Builds one Quickwit query string from the typed input. Every problem is a
 * returned refusal whose reason is shown to the model; nothing is thrown.
 */
export function buildLogsQuery(cfg: QuickwitGateConfig, input: LogsQueryInput): LogsQueryResult {
  const refuse = (reason: string): LogsQueryRefusal => ({ ok: false, reason });
  const notes: string[] = [];
  const allowed = new Set(cfg.fields);

  const service = resolveService(cfg, input.service);
  if (typeof service !== 'string') return refuse(service.reason);
  const parts: string[] = [`service:${escapeTerm(service)}`];

  if (input.level !== undefined) {
    if (!LEVEL.test(input.level)) return refuse('level must be a single word such as error, warn or info');
    parts.push(`level:${input.level.toLowerCase()}`);
  }

  let selective = 0;

  if (input.message !== undefined) {
    const bad = checkValue('message', input.message);
    if (bad !== undefined) return refuse(bad);
    const text = phraseSafe(input.message);
    if (text === '') return refuse('message has no searchable text');
    parts.push(`message:"${escapePhrase(text)}"`);
    selective += 1;
  }

  if (input.error !== undefined) {
    const bad = checkValue('error', input.error);
    if (bad !== undefined) return refuse(bad);
    const words = input.error.split(/[^\p{L}\p{N}_]+/u).filter((w) => w !== '');
    if (words.length === 0) return refuse('error has no searchable words');
    parts.push(`(${words.map((w) => `error:${escapeTerm(w)}`).join(' AND ')})`);
    selective += 1;
  }

  const filters = Object.entries(input.fields ?? {});
  if (filters.length > MAX_FIELD_FILTERS) return refuse(`at most ${MAX_FIELD_FILTERS} field filters per query`);
  for (const [name, value] of filters) {
    if (RESERVED_FILTER_FIELDS.has(name)) {
      return refuse(`field ${name} cannot be used in fields; use the ${name === 'timestamp' ? 'from/to' : name} input instead`);
    }
    if (!allowed.has(name)) return refuse(`unknown field ${JSON.stringify(name)}; allowed fields: ${cfg.fields.join(', ')}`);
    const bad = checkWord(`fields.${name}`, value);
    if (bad !== undefined) return refuse(bad);
    parts.push(`${name}:${escapeTerm(value.trim())}`);
    selective += 1;
  }

  const terms = input.terms ?? [];
  if (terms.length > MAX_TERMS) return refuse(`at most ${MAX_TERMS} terms per query`);
  for (const raw of terms) {
    const bad = checkWord('a term', raw);
    if (bad !== undefined) return refuse(bad);
    let term = raw.trim();
    if (UUID_DASHED.test(term)) {
      term = term.split('-')[0] as string;
      notes.push(
        `a dashed UUID term was cut to its first segment (${term}) because the default field has no positions; keep another filter on, a short segment can collide`,
      );
    }
    parts.push(escapeTerm(term));
    selective += 1;
  }

  if (selective === 0) {
    return refuse('service alone is not selective enough; add message, error, terms or fields');
  }

  if (input.count === true && input.group_by !== undefined) return refuse('use count or group_by, not both');
  let mode: LogsQueryMode = 'search';
  let groupBy: string | undefined;
  if (input.group_by !== undefined) {
    if (!allowed.has(input.group_by)) {
      return refuse(`unknown group_by field ${JSON.stringify(input.group_by)}; allowed fields: ${cfg.fields.join(', ')}`);
    }
    mode = 'histogram';
    groupBy = input.group_by;
  } else if (input.count === true) {
    mode = 'count';
  }

  let maxHits = cfg.maxHits;
  if (input.max_hits !== undefined) {
    if (!Number.isInteger(input.max_hits) || input.max_hits < 1) return refuse('max_hits must be a whole number of at least 1');
    if (input.max_hits > cfg.maxHits) notes.push(`max_hits clamped to ${cfg.maxHits}, the cap for ${cfg.entity}`);
    maxHits = Math.min(input.max_hits, cfg.maxHits);
  }

  const query = parts.join(' AND ');
  const unsafe = qwSafeProblem(query);
  if (unsafe !== undefined) return refuse(`the query ${unsafe}; remove it from the input`);

  return {
    ok: true,
    query,
    fields: cfg.fields,
    maxHits,
    mode,
    ...(groupBy === undefined ? {} : { groupBy }),
    service,
    notes: Object.freeze(notes),
  };
}

function resolveService(cfg: QuickwitGateConfig, name: string): string | { reason: string } {
  const known = Object.entries(cfg.services).filter((e): e is [string, string] => e[1] !== undefined);
  if (Object.hasOwn(cfg.services, name)) {
    const value = cfg.services[name];
    if (value === undefined) return { reason: `service ${name} has no log service name in the ${cfg.entity} registry` };
    return value;
  }
  // The model sometimes passes the name the service logs under instead of the registry name.
  const byLogName = known.find(([, value]) => value === name);
  if (byLogName !== undefined) return byLogName[1];
  return { reason: `unknown service ${JSON.stringify(name)} for ${cfg.entity}; known services: ${known.map(([k]) => k).join(', ')}` };
}

function checkValue(label: string, value: string): string | undefined {
  if (value.trim() === '') return `${label} is empty`;
  if (value.length > MAX_VALUE_LENGTH) return `${label} is longer than ${MAX_VALUE_LENGTH} characters`;
  if (CONTROL.test(value)) return `${label} contains a control character`;
  return undefined;
}

// Terms and field values are matched as given, so characters qw argv refuses
// are refused here, before escaping could split a pair such as $(. message and
// error drop punctuation instead, so they skip this check.
function checkWord(label: string, value: string): string | undefined {
  const bad = checkValue(label, value);
  if (bad !== undefined) return bad;
  const shell = shellProblem(value);
  return shell === undefined ? undefined : `${label} ${shell}; remove it from the input`;
}

/**
 * Escapes one word for the Quickwit query language so it is matched, not
 * parsed. Reserved characters get a backslash; a boolean word or a leading
 * '-' is quoted, since a one-word phrase is still a term match.
 */
export function escapeTerm(term: string): string {
  if (BOOLEAN_WORDS.has(term) || term.startsWith('-')) return `"${escapePhrase(term)}"`;
  let out = '';
  for (const ch of term) out += RESERVED_CHARS.has(ch) ? `\\${ch}` : ch;
  return out;
}

/** Escapes text for use inside a double-quoted phrase. */
export function escapePhrase(text: string): string {
  return text.replace(/[\\"]/g, (ch) => `\\${ch}`);
}

// The text tokenizer drops punctuation, so turning the characters qw argv
// refuses into spaces does not change what a phrase on `message` matches.
function phraseSafe(text: string): string {
  return text
    .replace(/[;|&`$]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ------------------------------------------------------------ normalisation

/** Label for an empty error, as the sim-binding script printed it. */
export const EMPTY_MESSAGE_LABEL = '{} (empty error from workflow-v2)';

const UUID_ANY = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const HEX_LONG = /\b[0-9a-f]{16,}\b/gi;
const NUM_LONG = /\b\d{6,}\b/g;

/**
 * Port of normalize_error from search_sim_binding.py: UUIDs, long hex runs and
 * numbers of six or more digits become placeholders, so messages that differ
 * only by those fold into one group.
 */
export function normalizeMessage(message: string): string {
  const s = message.trim();
  if (s === '' || s === '{}' || s === '{ }' || s === 'null') return EMPTY_MESSAGE_LABEL;
  return s.replace(UUID_ANY, '<uuid>').replace(HEX_LONG, '<hex>').replace(NUM_LONG, '<num>');
}

// ------------------------------------------------------------- qw argv check

/** Thrown by assertQwSafe. The message names the problem, never the value. */
export class QwArgError extends Error {
  override readonly name = 'QwArgError';
}

const QW_DENY: readonly [RegExp, string][] = [
  [/\n|\r/, 'contains a newline'],
  [/\u0000/, 'contains a NUL byte'],
  [/[\u0000-\u001f\u007f]/, 'contains a control character'],
  [/`/, 'contains a backtick'],
  [/\$[({]/, 'contains $( or ${'],
  [/;/, 'contains ;'],
  [/\|/, 'contains |'],
  [/&/, 'contains &'],
];

/** Returns why a string may not go into qw argv, or undefined when it may. */
export function qwSafeProblem(s: string): string | undefined {
  if (s === '') return 'is empty';
  if (s.startsWith('-')) return "starts with '-' and would be read as an option";
  return shellProblem(s);
}

function shellProblem(s: string): string | undefined {
  for (const [re, problem] of QW_DENY) if (re.test(s)) return problem;
  return undefined;
}

/**
 * Charset check for every value that goes into qw argv. execFile runs no
 * shell, so this is a second line: it keeps shell syntax and option injection
 * out even if a later change adds a shell by mistake.
 */
export function assertQwSafe(s: string): void {
  const problem = qwSafeProblem(s);
  if (problem !== undefined) throw new QwArgError(`qw argument refused: it ${problem}`);
}
