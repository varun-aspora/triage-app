// Quickwit query builder for logs_search, shared by the qw and http
// transports (D44, D76). Pure: it imports no I/O module, reads no env, and
// takes the entity's limits and field allowlist as arguments.
//
// The syntax follows the owner's tested qw and Grafana queries (D76):
// - a value with a space, a dash or any other character that is not a letter,
//   digit or _ is sent whole in single quotes ('26caff50-d980-...',
//   'Api execution completed'). Quickwit tokenises a single-quoted value and
//   ANDs the tokens, so it needs no positions and works on every field;
// - `message` is the developer's label, single-quoted over the default fields;
// - `error` is a per-word AND on the error field, which has no positions, so a
//   phrase query on it is an HTTP 400;
// - exclusions are NOT 'a' AND NOT 'b'. NOT ('a' AND 'b') means "not both".
import type { Registry } from '../config/registry.ts';
import type { Entity } from '../types/core.ts';
import { extractIdShaped, PHONE_DIGITS } from './id-patterns.ts';

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

/** One OR group: its values are ORed, and the groups are ANDed with the rest. */
export type LogsAnyOfGroup = {
  readonly level?: readonly string[];
  readonly message?: readonly string[];
  readonly terms?: readonly string[];
  readonly service?: readonly string[];
};

export type LogsOrder = 'newest' | 'oldest';
export type LogsDenoise = 'with_message' | 'only';

/** The typed logs_search input the builder reads. from/to are handled by quickwit-window.ts. */
export type LogsQueryInput = {
  readonly service?: string;
  readonly message?: string;
  readonly error?: string;
  readonly terms?: readonly string[];
  readonly exclude?: readonly string[];
  readonly any_of?: readonly LogsAnyOfGroup[];
  /** A substring of raw_message, one word. */
  readonly contains?: string;
  /** Field filters, name -> value. Names must be in the entity allowlist. */
  readonly fields?: Readonly<Record<string, string>>;
  readonly level?: string;
  /** SSFB only: the owner's noise filter. */
  readonly denoise?: LogsDenoise;
  readonly max_hits?: number;
  readonly group_by?: readonly string[];
  readonly count_distinct?: string;
  readonly count?: boolean;
  /** Extra fields per hit, on top of the allowlist. */
  readonly columns?: readonly string[];
  /** Full documents instead of the projection. */
  readonly raw?: boolean;
  readonly order?: LogsOrder;
  readonly offset?: number;
};

/** histogram is any tally over hits: group_by, count_distinct or both. */
export type LogsQueryMode = 'search' | 'count' | 'histogram';

export type LogsQuery = {
  readonly ok: true;
  readonly query: string;
  /** Output projection: the entity allowlist, then any extra columns. Not applied when raw is true. */
  readonly fields: readonly string[];
  readonly maxHits: number;
  readonly mode: LogsQueryMode;
  /** histogram only: 1 to MAX_GROUP_BY fields; a group is one tuple of their values. */
  readonly groupBy?: readonly string[];
  /** histogram only: the field whose distinct values are counted. */
  readonly countDistinct?: string;
  /** Newest first unless asked otherwise. */
  readonly order: LogsOrder;
  /** Index of the first hit of the page; 0 outside search mode. */
  readonly offset: number;
  /** The extra columns asked for (already in fields). */
  readonly columns: readonly string[];
  /** search only: return whole documents. */
  readonly raw: boolean;
  /** The service value used in the query; absent when the query has no service clause. */
  readonly service?: string;
  /** Short notes for the model, e.g. a clamped max_hits. */
  readonly notes: readonly string[];
};

export type LogsQueryRefusal = { readonly ok: false; readonly reason: string };

export type LogsQueryResult = LogsQuery | LogsQueryRefusal;

export const MAX_TERMS = 20;
export const MAX_FIELD_FILTERS = 20;
export const MAX_VALUE_LENGTH = 512;
export const MAX_ANY_OF_GROUPS = 5;
export const MAX_GROUP_BY = 4;
export const MAX_COLUMNS = 10;
/** Hits per page (owner, Q4). The entity's MAX_HITS can only lower it. */
export const PAGE_SIZE = 250;
/** A query over this many hits returns early (D76); no page starts at or past it. */
export const HIT_LIMIT = 5_000;

/** The owner's SSFB noise filter: drops kong, kafka and access lines unless they are errors. */
export const DENOISE_FILTER = "((NOT service:'kong'* AND NOT service:'kafka'* AND NOT 'Api execution completed') OR level:error)";

// Fields the model may not filter through `fields`: service and level have
// their own inputs, and the time window is applied by quickwit-window.ts.
const RESERVED_FILTER_FIELDS = new Set(['service', 'level', 'timestamp']);

// Entities whose exact id fields take a UUID. Elsewhere a UUID is a quoted term (Q8).
const FIELD_UUID_ENTITIES: ReadonlySet<Entity> = new Set(['ssfb']);

// Services that put the whole line in message and have no error field.
const WHOLE_LINE_IN_MESSAGE = /^(workflow-op|kong)/;

// Services that redact phone numbers in their lines (refs survey, Appendix A.3).
const REDACTS_PHONE: ReadonlySet<string> = new Set(['guardian']);

const BOOLEAN_WORDS = new Set(['AND', 'OR', 'NOT', 'TO', 'IN']);

// Characters the Quickwit query language reserves. A backslash in front makes
// them part of the word.
const RESERVED_CHARS = new Set(['+', '^', '`', ':', '{', '}', '"', "'", '[', ']', '(', ')', '~', '!', '\\', '*', ' ']);

// A value sent bare. Anything else is single-quoted whole.
const BARE = /^[\p{L}\p{N}_]+$/u;
// A field value sent bare: also dots, @ and inner dashes, so a UUID or a device id stays one exact value.
const FIELD_BARE = /^[\p{L}\p{N}_.@][\p{L}\p{N}_.@-]*$/u;
// The only range shape a field value may take.
const RANGE = /^\[-?\d+(?:\.\d+)? TO -?\d+(?:\.\d+)?\]$/;
// A wildcard word cannot escape reserved characters, so contains takes these only.
const CONTAINS = /^[\p{L}\p{N}_.@-]+$/u;
// Names for group_by, count_distinct and columns (Quickwit's field-name rule, shorter).
const FIELD_NAME = /^[@$_a-zA-Z][@$_/.\-a-zA-Z0-9]{0,63}$/;
const UUID_IN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
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

// Thrown inside the builder only; buildLogsQuery turns it into a refusal.
class Refusal extends Error {}

function refuse(reason: string): never {
  throw new Refusal(reason);
}

/**
 * Builds one Quickwit query string from the typed input. Every problem is a
 * returned refusal whose reason is shown to the model; nothing is thrown.
 */
export function buildLogsQuery(cfg: QuickwitGateConfig, input: LogsQueryInput): LogsQueryResult {
  try {
    return build(cfg, input);
  } catch (err) {
    if (err instanceof Refusal) return { ok: false, reason: err.message };
    throw err;
  }
}

function build(cfg: QuickwitGateConfig, input: LogsQueryInput): LogsQuery {
  const notes: string[] = [];
  const allowed = new Set(cfg.fields);
  const parts: string[] = [];
  let selective = 0;

  const service = input.service === undefined ? undefined : resolveService(cfg, input.service);
  if (service !== undefined) parts.push(`service:${escapeTerm(service)}`);

  if (input.level !== undefined) parts.push(levelClause('level', input.level));
  const denoiseAt = parts.length;

  let denoise: string | undefined;
  if (input.denoise !== undefined) {
    if (cfg.entity !== 'ssfb') {
      refuse(`denoise is for ssfb only: its filter names the ssfb kong and kafka services; on ${cfg.entity} use exclude instead`);
    }
    if (input.denoise === 'with_message') {
      if (input.message === undefined) refuse('denoise "with_message" needs message: that label is kept even from a filtered service');
      denoise = `${DENOISE_FILTER} OR ${messageWord('message', input.message)}`;
      selective += 1;
    } else {
      denoise = DENOISE_FILTER;
    }
  }

  // With denoise "with_message" the message is already inside the filter.
  if (input.message !== undefined && input.denoise !== 'with_message') {
    parts.push(messageWord('message', input.message));
    selective += 1;
  }

  if (input.error !== undefined) {
    checkValue('error', input.error);
    const words = input.error.split(/[^\p{L}\p{N}_]+/u).filter((w) => w !== '');
    if (words.length === 0) refuse('error has no searchable words');
    parts.push(`(${words.map((w) => `error:${escapeTerm(w)}`).join(' AND ')})`);
    selective += 1;
    if (service !== undefined && WHOLE_LINE_IN_MESSAGE.test(service)) {
      notes.push(`${service} logs the whole line in message and has no error field; search its text with message or terms`);
    }
  }

  const filters = Object.entries(input.fields ?? {});
  if (filters.length > MAX_FIELD_FILTERS) refuse(`at most ${MAX_FIELD_FILTERS} field filters per query, got ${filters.length}`);
  for (const [name, value] of filters) {
    parts.push(fieldClause(cfg, allowed, name, value));
    selective += 1;
  }

  const terms = input.terms ?? [];
  if (terms.length > MAX_TERMS) refuse(`at most ${MAX_TERMS} terms per query, got ${terms.length}`);
  for (const t of terms) {
    parts.push(termWord('a term', t));
    selective += 1;
  }

  if (input.contains !== undefined) {
    parts.push(containsClause(cfg, allowed, input.contains));
    selective += 1;
  }

  const groups = input.any_of ?? [];
  if (groups.length > MAX_ANY_OF_GROUPS) refuse(`at most ${MAX_ANY_OF_GROUPS} any_of groups per query, got ${groups.length}`);
  groups.forEach((group, i) => {
    parts.push(anyOfClause(cfg, group, `any_of[${i}]`));
    // An alternative such as level:error or a service matches too much on its own.
    if (group.level === undefined && group.service === undefined) selective += 1;
  });

  const exclude = input.exclude ?? [];
  if (exclude.length > MAX_TERMS) refuse(`at most ${MAX_TERMS} exclude values per query, got ${exclude.length}`);
  for (const x of exclude) parts.push(`NOT ${quote('an exclude value', checkWord('an exclude value', x))}`);

  if (selective === 0 && input.denoise !== 'only') {
    refuse(
      'the query needs a selective part: terms, fields, message, error, contains or an any_of group of messages or terms ' +
        '(service, level and exclude alone match too much)',
    );
  }

  if (service !== undefined && REDACTS_PHONE.has(service) && hasPhone(input)) {
    notes.push(
      `${service} redacts phone numbers in its lines (from, to, sim_card_number), so a phone search there can return 0 hits ` +
        'while the lines exist; search by another id',
    );
  }

  if (denoise !== undefined) {
    // Other filters are ANDed with the whole filter, so an OR on top needs its own parentheses.
    parts.splice(denoiseAt, 0, parts.length === 0 || input.denoise === 'only' ? denoise : `(${denoise})`);
  }

  const shape = modeOf(cfg, allowed, input);

  let maxHits = Math.min(PAGE_SIZE, cfg.maxHits);
  if (input.max_hits !== undefined) {
    if (!Number.isInteger(input.max_hits) || input.max_hits < 1) refuse('max_hits must be a whole number of at least 1');
    if (input.max_hits > maxHits) notes.push(`max_hits clamped to ${maxHits}, the page size for ${cfg.entity}`);
    maxHits = Math.min(input.max_hits, maxHits);
  }

  const query = parts.join(' AND ');
  const unsafe = qwSafeProblem(query);
  if (unsafe !== undefined) refuse(`the query ${unsafe}; remove it from the input`);

  return {
    ok: true,
    query,
    fields: Object.freeze([...cfg.fields, ...shape.columns.filter((c) => !allowed.has(c))]),
    maxHits,
    ...shape,
    ...(service === undefined ? {} : { service }),
    notes: Object.freeze(notes),
  };
}

type Shape = Pick<LogsQuery, 'mode' | 'groupBy' | 'countDistinct' | 'order' | 'offset' | 'columns' | 'raw'>;

function modeOf(cfg: QuickwitGateConfig, allowed: ReadonlySet<string>, input: LogsQueryInput): Shape {
  const groupable = (label: string, name: string): string => {
    if (name !== 'service' && !allowed.has(name)) refuse(`unknown ${label} field ${JSON.stringify(name)}; allowed fields: ${cfg.fields.join(', ')}`);
    return name;
  };
  let groupBy: string[] | undefined;
  if (input.group_by !== undefined) {
    if (input.group_by.length === 0) refuse('group_by is empty; give 1 to 4 field names');
    if (input.group_by.length > MAX_GROUP_BY) refuse(`group_by takes at most ${MAX_GROUP_BY} fields, got ${input.group_by.length}`);
    groupBy = input.group_by.map((f) => groupable('group_by', f));
    if (new Set(groupBy).size < groupBy.length) refuse('group_by names the same field twice');
  }
  const countDistinct = input.count_distinct === undefined ? undefined : groupable('count_distinct', input.count_distinct);
  const tally = groupBy !== undefined || countDistinct !== undefined;
  if (input.count === true && tally) refuse('use count, or group_by and count_distinct, not both');
  const mode: LogsQueryMode = tally ? 'histogram' : input.count === true ? 'count' : 'search';

  const offset = input.offset ?? 0;
  if (!Number.isInteger(offset) || offset < 0) refuse('offset must be a whole number of at least 0');
  if (offset >= HIT_LIMIT) refuse(`offset ${offset} is past the ${HIT_LIMIT} hits one query may page through; narrow the window or add a filter`);

  const columns = input.columns ?? [];
  if (columns.length > MAX_COLUMNS) refuse(`at most ${MAX_COLUMNS} columns, got ${columns.length}`);
  for (const c of columns) {
    if (!FIELD_NAME.test(c)) refuse(`column ${JSON.stringify(c)} is not a field name`);
  }

  if (mode !== 'search') {
    const hitOnly = [
      ...(offset > 0 ? ['offset'] : []),
      ...(columns.length > 0 ? ['columns'] : []),
      ...(input.raw === true ? ['raw'] : []),
    ];
    if (hitOnly.length > 0) refuse(`${hitOnly.join(', ')} apply to hits only; drop them when using count, group_by or count_distinct`);
  }

  return {
    mode,
    ...(groupBy === undefined ? {} : { groupBy: Object.freeze(groupBy) }),
    ...(countDistinct === undefined ? {} : { countDistinct }),
    order: input.order ?? 'newest',
    offset,
    columns: Object.freeze([...new Set(columns)]),
    raw: input.raw === true,
  };
}

// A phone with its country code, or 10 bare digits, in any searched value.
function hasPhone(input: LogsQueryInput): boolean {
  const values = [input.terms, input.fields, input.contains, input.message, input.any_of?.map((g) => g.terms)];
  return extractIdShaped(values).some((id) => id.kind === 'phone' || (id.kind === 'digits' && id.raw.length === PHONE_DIGITS));
}

function resolveService(cfg: QuickwitGateConfig, name: string): string {
  if (Object.hasOwn(cfg.services, name)) {
    const value = cfg.services[name];
    if (value === undefined) refuse(`service ${name} has no log service name in the ${cfg.entity} registry`);
    return value;
  }
  const known = Object.entries(cfg.services).filter((e): e is [string, string] => e[1] !== undefined);
  // The model sometimes passes the name the service logs under instead of the registry name.
  const byLogName = known.find(([, value]) => value === name);
  if (byLogName !== undefined) return byLogName[1];
  return refuse(`unknown service ${JSON.stringify(name)} for ${cfg.entity}; known services: ${known.map(([k]) => k).join(', ')}`);
}

function levelClause(label: string, level: string): string {
  if (!LEVEL.test(level)) refuse(`${label} must be a single word such as error, warn or info`);
  return `level:${level.toLowerCase()}`;
}

function fieldClause(cfg: QuickwitGateConfig, allowed: ReadonlySet<string>, name: string, raw: string): string {
  const label = `fields.${name}`;
  if (RESERVED_FILTER_FIELDS.has(name)) {
    refuse(`field ${name} cannot be used in fields; use the ${name === 'timestamp' ? 'from/to' : name} input instead`);
  }
  if (!allowed.has(name)) refuse(`unknown field ${JSON.stringify(name)}; allowed fields: ${cfg.fields.join(', ')}`);
  const value = checkWord(label, raw);
  if (RANGE.test(value)) return `${name}:${value}`;
  if (value.startsWith('[') || value.startsWith('{')) refuse(`${label} looks like a range; a range must be exactly [<number> TO <number>]`);
  if (!FIELD_UUID_ENTITIES.has(cfg.entity) && UUID_IN.test(value)) {
    refuse(`${label} holds a UUID; on ${cfg.entity} search a UUID as a term (terms: ["<uuid>"]), which is sent whole in single quotes`);
  }
  if (FIELD_BARE.test(value) && !BOOLEAN_WORDS.has(value)) return `${name}:${value}`;
  return `${name}:${quote(label, value)}`;
}

function containsClause(cfg: QuickwitGateConfig, allowed: ReadonlySet<string>, raw: string): string {
  const value = checkWord('contains', raw);
  if (/\s/.test(value)) {
    refuse('contains must be one word with no spaces: a wildcard over several words returns 0 hits with no error; use terms or message for words');
  }
  if (!CONTAINS.test(value)) refuse('contains may hold only letters, digits and _ . @ -, because a wildcard word cannot escape other characters');
  if (!allowed.has('raw_message')) refuse(`contains searches raw_message, which is not in the ${cfg.entity} field list`);
  return `raw_message:*${value}*`;
}

function anyOfClause(cfg: QuickwitGateConfig, group: LogsAnyOfGroup, label: string): string {
  const alternatives = [
    ...(group.level ?? []).map((l) => levelClause(`${label}.level`, l)),
    ...(group.message ?? []).map((m) => messageWord(`${label}.message`, m)),
    ...(group.terms ?? []).map((t) => termWord(`a term in ${label}`, t)),
    ...(group.service ?? []).map((s) => `service:${escapeTerm(resolveService(cfg, s))}`),
  ];
  if (alternatives.length === 0) refuse(`${label} is empty; give level, message, terms or service values`);
  if (alternatives.length > MAX_TERMS) refuse(`${label} has ${alternatives.length} values; at most ${MAX_TERMS}`);
  return alternatives.length === 1 ? (alternatives[0] as string) : `(${alternatives.join(' OR ')})`;
}

// A term: bare when it is letters, digits and _ only, else whole in single quotes.
function termWord(label: string, raw: string): string {
  const value = checkWord(label, raw);
  return BARE.test(value) && !BOOLEAN_WORDS.has(value) ? value : quote(label, value);
}

// A message label, always single-quoted whole.
function messageWord(label: string, raw: string): string {
  checkValue(label, raw);
  const text = phraseSafe(raw);
  if (text === '') refuse(`${label} has no searchable text`);
  return quote(label, text);
}

// Inside single quotes only the quote itself would need escaping, and a
// backslash would be read as an escape, so both are refused.
function quote(label: string, value: string): string {
  if (value.includes("'")) refuse(`${label} contains a single quote, which cannot be sent inside a quoted value; search the words on either side of it`);
  if (value.includes('\\')) refuse(`${label} contains a backslash, which cannot be sent inside a quoted value; search the words on either side of it`);
  return `'${value}'`;
}

function checkValue(label: string, value: string): void {
  if (value.trim() === '') refuse(`${label} is empty`);
  if (value.length > MAX_VALUE_LENGTH) refuse(`${label} is ${value.length} characters, longer than ${MAX_VALUE_LENGTH}`);
  if (CONTROL.test(value)) refuse(`${label} contains a control character`);
}

// Terms and field values are matched as given, so characters qw argv refuses
// are refused here. message drops punctuation instead, so it skips this check.
// Returns the trimmed value.
function checkWord(label: string, value: string): string {
  checkValue(label, value);
  const shell = shellProblem(value);
  if (shell !== undefined) refuse(`${label} ${shell}; remove it from the input`);
  return value.trim();
}

/**
 * Escapes one word for the Quickwit query language so it is matched, not
 * parsed. Reserved characters get a backslash; a boolean word or a leading
 * '-' is quoted, since a one-word phrase is still a term match. Used for
 * registry service names and error words, which are never quoted values.
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
// refuses into spaces does not change what a quoted label matches.
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
