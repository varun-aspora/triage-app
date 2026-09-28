// A pattern note draft from a reviewed eval case (D92).
//
// `triage fixtures review` calls buildPatternDraft after it promotes an eval
// case whose feedback has both an actual root cause and a faster path. The
// draft is one patterns.json entry, schema-valid, for an owner to finish and
// merge in a PR:
//   category and tier_hint  from the report's classification
//   entities                the entities the run consulted
//   first_queries           one per step of the faster path
//   query_recipe            the faster path on one line
//   lesson                  the actual root cause
//   signature.regex         a TODO: the owner writes the trigger
//   stable                  false; source_ref evals/cases/<case_id>
// The problem text rides along beside the entry, to help write the trigger.
//
// Ids are stripped before anything is written: each id chain value becomes
// <key>, other UUIDs and hex tokens become <uuid> and <id>, the persisted
// profile masks the rest, and its **** masks become <id>. The draft must then
// pass checkEgress. It goes to <TRIAGE_HOME>/patterns/_unreviewed/, never under
// knowledge/, so the loader cannot package an unreviewed entry.

import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { checkEgress, redactPersisted } from '../gate/redact.ts';
import { hexTokenSpans, uuidSpans, type Span } from '../gate/redact-patterns.ts';
import { DRAFT_FEEDBACK_FILE, DRAFT_REPORT_FILE } from '../report/feedback.ts';
import { writeFileAtomic } from '../report/run-folder.ts';
import { ENTITIES, type Entity } from '../types/core.ts';
import { parsePatterns, type FirstQuery, type Pattern } from './patterns.ts';

const PATTERN_DRAFTS_DIR = join('patterns', '_unreviewed');
export const TRIGGER_TODO = 'TODO write the error text this pattern matches';
const MAX_ID = 64;

export type PatternDraft = {
  readonly pattern: Pattern;
  /** The thread's question, ids stripped, to help write signature.regex. */
  readonly problem: string;
  /** Set when the run matched an entry: editing that entry may be better than a new one. */
  readonly matched_pattern_id?: string;
};

export type PatternDraftResult =
  | { readonly status: 'none' }
  | { readonly status: 'refused'; readonly reason: string }
  | { readonly status: 'draft'; readonly draft: PatternDraft };

type FrontMatter = {
  input?: { problem?: unknown; identifiers?: Record<string, unknown> };
  ground_truth?: { actual_root_cause?: unknown; faster_path?: unknown };
};

/** Builds the draft from a promoted case folder (evals/cases/<case_id>). */
export async function buildPatternDraft(caseDir: string, caseId: string): Promise<PatternDraftResult> {
  const front = await readFrontMatter(join(caseDir, DRAFT_FEEDBACK_FILE));
  const cause = text(front?.ground_truth?.actual_root_cause);
  const faster = text(front?.ground_truth?.faster_path);
  if (cause === '' || faster === '') return { status: 'none' };
  const report = await readJson(join(caseDir, DRAFT_REPORT_FILE));
  if (report === undefined) return { status: 'refused', reason: `${DRAFT_REPORT_FILE} is missing or not JSON` };

  const ids: Record<string, string> = {};
  for (const [key, value] of Object.entries(front?.input?.identifiers ?? {})) if (typeof value === 'string') ids[key] = value;
  const strip = (s: string): string => stripIds(s, ids);

  const classification = (report.classification ?? {}) as { proposed?: Record<string, unknown>; tier_final?: unknown };
  const proposed = classification.proposed ?? {};
  const steps = faster
    .split(/\n|;/)
    .map((s) => oneLine(strip(s.replace(/^\s*(?:[-*]|\d+[.)])\s+/, ''))))
    .filter((s) => s !== '');
  const entities = entityList(report.entities_consulted, proposed.entities_likely);
  const first_queries: FirstQuery[] = steps.map((query) => ({ entity: namedEntity(query) ?? entities[0] ?? 'ssfb', query }));
  for (const q of first_queries) if (!entities.includes(q.entity)) entities.push(q.entity);

  const matched = text((report.root_cause as { matched_pattern_id?: unknown } | null)?.matched_pattern_id) || text(proposed.matched_pattern_id);
  const draft: PatternDraft = {
    pattern: {
      id: draftId(caseId),
      category: proposed.category as Pattern['category'],
      signature: { regex: [TRIGGER_TODO], services: [] },
      entities,
      query_recipe: oneLine(strip(faster)),
      tier_hint: classification.tier_final as Pattern['tier_hint'],
      stable: false,
      source_ref: `evals/cases/${caseId}`,
      first_queries,
      lesson: oneLine(strip(cause)),
    },
    problem: oneLine(strip(text(front?.input?.problem))) || 'none',
    ...(matched !== '' ? { matched_pattern_id: matched } : {}),
  };

  try {
    parsePatterns([draft.pattern], 'pattern draft');
  } catch (err) {
    return { status: 'refused', reason: (err as Error).message };
  }
  const checked = checkEgress(draft);
  if (!checked.ok) return { status: 'refused', reason: `fails the persisted redaction check at ${checked.paths.join(', ')}` };
  return { status: 'draft', draft };
}

/** Writes the draft to <home>/patterns/_unreviewed/<case_id>.json and returns the path. */
export async function writePatternDraft(home: string, caseId: string, draft: PatternDraft): Promise<string> {
  const dir = join(home, PATTERN_DRAFTS_DIR);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${caseId}.json`);
  await writeFileAtomic(path, `${JSON.stringify(draft, null, 2)}\n`);
  return path;
}

/** Replaces id chain values with <key>, UUIDs with <uuid>, hex tokens and persisted masks with <id>. */
export function stripIds(s: string, ids: Readonly<Record<string, string>>): string {
  let t = s;
  for (const [key, value] of Object.entries(ids).sort((a, b) => b[1].length - a[1].length)) {
    if (value.length >= 4) t = t.split(value).join(`<${key}>`);
  }
  t = replaceSpans(t, uuidSpans(t), '<uuid>');
  t = replaceSpans(t, hexTokenSpans(t), '<id>');
  return redactPersisted(t).value.replace(/\*{4}[0-9A-Za-z]{0,4}/g, '<id>');
}

function replaceSpans(s: string, spans: readonly Span[], with_: string): string {
  let out = '';
  let at = 0;
  for (const sp of [...spans].sort((a, b) => a.start - b.start)) {
    if (sp.start < at) continue;
    out += s.slice(at, sp.start) + with_;
    at = sp.end;
  }
  return out + s.slice(at);
}

function draftId(caseId: string): string {
  const slug = caseId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `reviewed-${slug}`.slice(0, MAX_ID).replace(/-+$/, '');
}

function entityList(...lists: unknown[]): Entity[] {
  for (const list of lists) {
    const out = Array.isArray(list) ? list.filter((e): e is Entity => (ENTITIES as readonly unknown[]).includes(e)) : [];
    if (out.length > 0) return [...new Set(out)];
  }
  return [];
}

function namedEntity(step: string): Entity | undefined {
  return ENTITIES.find((e) => new RegExp(`\\b${e}\\b`, 'i').test(step));
}

async function readFrontMatter(path: string): Promise<FrontMatter | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
  const m = /^---\n([\s\S]*?)\n---/.exec(raw);
  if (m === null) return undefined;
  try {
    const parsed: unknown = parseYaml(m[1] as string);
    return parsed !== null && typeof parsed === 'object' ? (parsed as FrontMatter) : undefined;
  } catch {
    return undefined;
  }
}

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();
