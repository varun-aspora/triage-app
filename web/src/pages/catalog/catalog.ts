// Pure helpers for the catalog pages: name rules, filters and the previews of
// the files the server writes. The previews mirror the server's rendering so
// what the operator reads is what lands on disk; the server re-validates
// everything, so a drift here only makes a preview wrong, never a file.

import type { ApiErrorBody, Entity, EntityServices, EnvKeyRef, GuideRow, GuideStatus, RepoPinRow, ServiceRow } from '../../api/types.ts';
import { ENTITIES, ENTITY_LABELS } from '../../lib/constants.ts';
import type { StatusLook } from '../../lib/status.ts';

// ------------------------------------------------------------------ names

/**
 * Letters and digits only. The registry allows '_' and skill names allow '-',
 * but the guide is named <entity>-<key>, so only the characters both accept.
 */
export const SERVICE_KEY_RE = /^[a-z][a-z0-9]*$/;
export const SERVICE_KEY_MAX = 40;
export const SKILL_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const SKILL_NAME_MAX = 64;
export const DESCRIPTION_MAX = 1024;
export const SOURCES_MAX = 500;
export const NOTE_MAX = 500;
export const BODY_MAX = 100_000;
const ENV_NAME_RE = /^(SSFB|ATSPL|RTL)_[A-Z0-9_]+$/;
const LOG_SERVICE_RE = /^[A-Za-z0-9._-]+$/;
const LOG_SERVICE_MAX = 128;

export const entityLabel = (e: string): string => (ENTITY_LABELS as Record<string, string>)[e] ?? e.toUpperCase();

/** Why a service key cannot be used, or null when it can. */
export function serviceKeyProblem(key: string, entity: Entity, existing: readonly string[]): string | null {
  if (key === '') return 'Enter a service key.';
  if (!SERVICE_KEY_RE.test(key)) return 'Use lowercase letters and digits, starting with a letter.';
  if (key.length > SERVICE_KEY_MAX) return `At most ${SERVICE_KEY_MAX} characters.`;
  if (key === 'overview') return '“overview” is reserved for the entity overview guide.';
  if (existing.includes(key)) return `${entityLabel(entity)} already has a service with this key.`;
  return null;
}

/** Why an env key name cannot be used, or null. Empty is allowed: the field is optional. */
export function envKeyProblem(name: string, entity: Entity): string | null {
  if (name === '') return null;
  const prefix = `${entity.toUpperCase()}_`;
  if (!ENV_NAME_RE.test(name)) return 'Use uppercase letters, digits and underscores, such as RTL_REMINDER_DB_URL.';
  if (!name.startsWith(prefix)) return `Must start with ${prefix}.`;
  return null;
}

export function logServiceProblem(name: string): string | null {
  if (name === '') return null;
  if (name.length > LOG_SERVICE_MAX) return `At most ${LOG_SERVICE_MAX} characters.`;
  if (!LOG_SERVICE_RE.test(name)) return 'Use letters, digits, dots, hyphens and underscores.';
  return null;
}

export function suggestDbEnv(entity: Entity, key: string): string {
  return key === '' ? '' : `${entity.toUpperCase()}_${key.toUpperCase()}_DB_URL`;
}

export function suggestApiEnv(entity: Entity, key: string): string {
  return key === '' ? '' : `${entity.toUpperCase()}_${key.toUpperCase()}_API_URL`;
}

export type GuideKind = 'service' | 'overview';

export function guideName(kind: GuideKind, entity: Entity, service: string): string {
  return kind === 'overview' ? `${entity}-overview` : `${entity}-${service}`;
}

/** Front-matter values must sit on one line. */
export function oneLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, ' ');
}

// ------------------------------------------------------------------ status tags

export function guideStatusTone(status: GuideStatus | null): StatusLook {
  switch (status) {
    case 'stub':
      return { tone: 'amber', icon: 'alert' };
    case 'ported':
    case 'written':
      return { tone: 'neutral', icon: 'check' };
    default:
      return { tone: 'muted', icon: 'dash' };
  }
}

// ------------------------------------------------------------------ filters

export function serviceMatches(row: ServiceRow, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (needle === '') return true;
  return [row.key, row.repo, row.quickwit_service, row.note].some((v) => v !== null && v.toLowerCase().includes(needle));
}

export type OtherMatch = { entity: Entity; row: ServiceRow };

/** Matches for q in every entity except the active one, for the no-match state. */
export function matchesInOtherEntities(entities: readonly EntityServices[], active: Entity, q: string): OtherMatch[] {
  if (q.trim() === '') return [];
  return entities
    .filter((e) => e.entity !== active)
    .flatMap((e) => e.services.filter((row) => serviceMatches(row, q)).map((row) => ({ entity: e.entity, row })));
}

export type GuideFilter = { q: string; entity: string; kind: string; status: string };

export function guideMatches(row: GuideRow, f: GuideFilter): boolean {
  if (f.entity !== '' && row.entity !== f.entity) return false;
  if (f.kind !== '' && row.kind !== f.kind) return false;
  if (f.status !== '' && row.status !== f.status) return false;
  const needle = f.q.trim().toLowerCase();
  if (needle === '') return true;
  return row.name.toLowerCase().includes(needle) || row.description.toLowerCase().includes(needle);
}

/** Registry services of an entity that have no guide yet, in file order. */
export function servicesWithoutGuide(entities: readonly EntityServices[], entity: Entity): ServiceRow[] {
  return entities.find((e) => e.entity === entity)?.services.filter((s) => s.guide === null) ?? [];
}

/**
 * What the last GET /services said about an env key, when some registered
 * service already names it. Undefined for a new name: only the server can
 * check the .env, and it does so when the form is saved.
 */
export function knownEnvState(entities: readonly EntityServices[], name: string): EnvKeyRef['state'] | undefined {
  if (name === '') return undefined;
  for (const group of entities) {
    for (const row of group.services) {
      for (const ref of [row.db_env, row.api_env]) if (ref !== null && ref.name === name) return ref.state;
    }
  }
  return undefined;
}

// ------------------------------------------------------------------ previews

export type ServiceDraft = {
  entity: Entity;
  key: string;
  repo: string;
  quickwit_service: string;
  db_env: string;
  api_env: string;
  note: string;
};

const NOTE_PLACEHOLDER = '[what it does, deploy and log name caveats]';

/** The entry appended to resources/<entity>.entity.json, keys in the server's order. */
export function registryEntryPreview(d: ServiceDraft): string {
  const entry: Record<string, string> = {};
  if (d.db_env !== '') entry.db = d.db_env;
  if (d.api_env !== '') entry.api = d.api_env;
  if (d.quickwit_service !== '') entry.quickwit_service = d.quickwit_service;
  entry.repo = d.repo;
  entry.note = d.note.trim() === '' ? NOTE_PLACEHOLDER : oneLine(d.note.trim());
  const body = JSON.stringify(entry, null, 2);
  return `// resources/${d.entity}.entity.json  → services\n${JSON.stringify(d.key || '<key>')}: ${body}`;
}

/** The pin after adding entity, or null when the pin already lists it (repos.json is left alone). */
export function repoPinAfter(pin: RepoPinRow | undefined, entity: Entity): RepoPinRow | null {
  if (pin === undefined || pin.entities.includes(entity)) return null;
  const entities = ENTITIES.filter((e) => e === entity || pin.entities.includes(e));
  return { ...pin, entities };
}

/** One pin per line, as repos.json keeps it. */
export function repoPinLine(pin: RepoPinRow): string {
  const branch = pin.branch !== undefined ? `, "branch": ${JSON.stringify(pin.branch)}` : '';
  return `{ "repo": ${JSON.stringify(pin.repo)}, "entities": [${pin.entities.map((e) => JSON.stringify(e)).join(', ')}]${branch} }`;
}

export type FrontMatter = {
  name: string;
  description: string;
  kind: GuideKind;
  entity: Entity;
  service?: string;
  sources?: string;
  status: GuideStatus;
};

/**
 * The SKILL.md front-matter as the server renders it (knowledge/README.md):
 * name plain, description and sources JSON double-quoted, metadata indented by
 * two spaces. Empty description or sources show a bracketed placeholder so
 * the preview reads as a template, not as the saved text.
 */
export function renderFrontMatter(fm: FrontMatter): string {
  const desc = oneLine(fm.description.trim());
  const sources = fm.sources !== undefined ? oneLine(fm.sources.trim()) : '';
  const lines = [
    '---',
    `name: ${fm.name}`,
    `description: ${desc === '' ? '[what the note covers and when to use it]' : JSON.stringify(desc)}`,
    'metadata:',
    `  kind: ${fm.kind}`,
    `  entity: ${fm.entity}`,
  ];
  if (fm.kind === 'service' && fm.service !== undefined) lines.push(`  service: ${fm.service}`);
  if (sources !== '') lines.push(`  sources: ${JSON.stringify(sources)}`);
  lines.push(`  status: ${fm.status}`, '---');
  return lines.join('\n');
}

export function renderSkillFile(fm: FrontMatter, body: string): string {
  return `${renderFrontMatter(fm)}\n\n${body.replace(/^\n+/, '')}`;
}

/** The starting body of a new guide, with the headings the other service guides use. */
export function defaultGuideBody(kind: GuideKind, entity: Entity, service: string, repo: string | null): string {
  const title =
    kind === 'overview'
      ? `# ${entityLabel(entity)} overview`
      : `# ${service || '<service>'} (${entityLabel(entity)}${repo !== null && repo !== '' ? ` ${repo}` : ''})`;
  const headings = kind === 'overview' ? ['## ID chain', '## Services', '## Join keys'] : ['## Tables', '## Endpoints', '## Logs', '## Known issues'];
  return [title, ...headings].join('\n\n') + '\n';
}

// ------------------------------------------------------------------ errors

type ErrorLike = { status: number; body: ApiErrorBody };

function asApiError(err: unknown): ErrorLike | null {
  if (typeof err !== 'object' || err === null) return null;
  const e = err as Partial<ErrorLike>;
  return typeof e.status === 'number' && typeof e.body === 'object' && e.body !== null ? (e as ErrorLike) : null;
}

export type SubmitErrors = { fields: Record<string, string>; form: string | null };

/**
 * Splits a 400/409 answer into messages per field and one for the form. The
 * server names fields and never echoes values, so its reason is safe to show.
 * conflict turns a 409 on a field into plainer copy.
 */
export function submitErrors(err: unknown, conflict?: (field: string, body: ApiErrorBody) => string | undefined): SubmitErrors {
  const api = asApiError(err);
  if (api === null) return { fields: {}, form: err instanceof Error ? err.message : 'Something went wrong.' };
  const names = api.body.fields ?? [];
  if ((api.status === 400 || api.status === 409) && names.length > 0) {
    const fields: Record<string, string> = {};
    for (const name of names) {
      const plain = api.status === 409 ? conflict?.(name, api.body) : undefined;
      fields[name] = plain ?? api.body.reason ?? api.body.error;
    }
    return { fields, form: null };
  }
  const reason = api.body.reason !== undefined ? `: ${api.body.reason}` : '';
  return { fields: {}, form: `${api.body.error}${reason}` };
}

/** Field errors the form has no place for, folded into one line so none is lost. */
export function leftoverErrors(errors: SubmitErrors, shown: readonly string[]): string | null {
  const rest = Object.entries(errors.fields).filter(([name]) => !shown.includes(name));
  const parts = [errors.form, ...rest.map(([name, msg]) => `${name}: ${msg}`)].filter((x): x is string => x !== null);
  return parts.length > 0 ? parts.join(' ') : null;
}

export function isNotFound(err: unknown): boolean {
  return asApiError(err)?.status === 404;
}
