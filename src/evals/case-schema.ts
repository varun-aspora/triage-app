// Eval case files (D42, P1 §3.5). One case lives in evals/cases/<id>/case.yaml
// and holds the request thread, the ids and ID chain known before the
// classifier, the basic state read with them, the expected labels and, for
// offline runs, the classification the faux provider serves.
//
// Ids in a case are pseudonyms (src/evals/pseudonym.ts), never masks, so the
// scope gate sees well-formed ids that are all in the chain.
//
// loadCases reports problems by file and field path only, never by value, so
// a bad case never prints the text it holds.
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import * as v from 'valibot';
import { parse as parseYaml } from 'yaml';

import type { TierPolicyContext } from '../classify/policy.ts';
import { PatternSchema } from '../classify/patterns.ts';
import { CategorySchema, ClassificationSchema } from '../types/classification.ts';
import {
  EntitySchema,
  KnownIdsSchema,
  NonEmptyStringSchema,
  ReportStatusSchema,
  TakenAtSchema,
  TierSchema,
  type Tier,
} from '../types/core.ts';
import { BasicStateItemSchema, IdHopSchema, type IdChain } from '../types/id-chain.ts';
import { AttachmentSchema, ThreadMessageSchema } from '../types/request.ts';

/**
 * The category taxonomy a case was labelled against: the twelve categories in
 * knowledge/classifier/categories.json and CATEGORIES. Bump it when that list
 * changes, so old labels can be migrated or skipped instead of silently
 * scored against new categories.
 */
export const TAXONOMY_VERSION = 'v1';

export const CASE_FILE = 'case.yaml';

export const LABEL_SOURCES = ['verified', 'triager_findings', 'synthetic'] as const;
export const LabelSourceSchema = v.picklist(LABEL_SOURCES);
export type LabelSource = v.InferOutput<typeof LabelSourceSchema>;

export const CASE_ORIGINS = ['synthetic', 'refs', 'run'] as const;
export const CaseOriginSchema = v.picklist(CASE_ORIGINS);
export type CaseOrigin = v.InferOutput<typeof CaseOriginSchema>;

// Also the directory name under evals/cases.
export const CaseIdSchema = v.pipe(v.string(), v.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'id must be kebab-case'));
export type CaseId = v.InferOutput<typeof CaseIdSchema>;

// Either a Slack-style thread or one block of text, as ingress accepts both.
// One object with a check rather than a union, so a bad field is reported by
// its own path.
export const CaseRequestSchema = v.pipe(
  v.strictObject({
    messages: v.optional(v.pipe(v.array(ThreadMessageSchema), v.minLength(1, 'messages must not be empty'))),
    text: v.optional(NonEmptyStringSchema),
    attachments: v.optional(v.array(AttachmentSchema)),
  }),
  v.check((r) => (r.messages === undefined) !== (r.text === undefined), 'request needs exactly one of messages or text'),
);
export type CaseRequest = v.InferOutput<typeof CaseRequestSchema>;

// The ID chain without basic state, which sits at the top level of a case.
export const CaseIdChainSchema = v.strictObject({
  ids: KnownIdsSchema,
  hops: v.array(IdHopSchema),
});
export type CaseIdChain = v.InferOutput<typeof CaseIdChainSchema>;

export const ExpectedSchema = v.strictObject({
  category: CategorySchema,
  tier: TierSchema,
  money_moved: v.optional(v.boolean()),
  entities: v.optional(v.array(EntitySchema)),
  status: v.optional(ReportStatusSchema),
  current_ask: v.optional(NonEmptyStringSchema),
});
export type Expected = v.InferOutput<typeof ExpectedSchema>;

// What the tier policy needs besides the classification, so a case's expected
// tier can be computed offline. Absent fields take the defaults in
// policyContextFor.
export const CasePolicySchema = v.strictObject({
  // Patterns the classification may match; stands in for patterns.json.
  patterns: v.optional(v.array(PatternSchema)),
  // Tiers whose model accepts image input. Default: strong only, as D36
  // requires of MODEL_TIER_STRONG and as the fake provider has it.
  image_capable_tiers: v.optional(v.array(TierSchema)),
});
export type CasePolicy = v.InferOutput<typeof CasePolicySchema>;

export const ProvenanceSchema = v.strictObject({
  origin: CaseOriginSchema,
  // A run id or a reviewed-case reference. Never a refs/ directory name,
  // since those can contain customer names.
  ref: v.optional(NonEmptyStringSchema),
  created_at: v.optional(TakenAtSchema),
  reviewed_by: v.optional(NonEmptyStringSchema),
  reviewed_at: v.optional(TakenAtSchema),
  notes: v.optional(v.string()),
});
export type Provenance = v.InferOutput<typeof ProvenanceSchema>;

export const CaseSchema = v.pipe(
  v.strictObject({
    id: CaseIdSchema,
    taxonomy_version: NonEmptyStringSchema,
    label_source: LabelSourceSchema,
    request: CaseRequestSchema,
    // The ids ingress parsed from the request (bot fields and hints).
    ids: KnownIdsSchema,
    id_chain: CaseIdChainSchema,
    basic_state: v.array(BasicStateItemSchema),
    expected: ExpectedSchema,
    // Served by the faux provider so the suite runs offline.
    faux_classification: v.optional(ClassificationSchema),
    policy: v.optional(CasePolicySchema),
    provenance: ProvenanceSchema,
  }),
  v.check(
    (c) => (c.label_source === 'synthetic') === (c.provenance.origin === 'synthetic'),
    'label_source synthetic and provenance.origin synthetic go together',
  ),
);
export type EvalCase = v.InferOutput<typeof CaseSchema>;

/** The thread text of a case, one entry per message. */
export function threadTexts(c: Pick<EvalCase, 'request'>): string[] {
  return c.request.messages ? c.request.messages.map((m) => m.text) : [c.request.text ?? ''];
}

/** The IdChain the pipeline would hold for this case. */
export function toIdChain(c: Pick<EvalCase, 'id_chain' | 'basic_state'>): IdChain {
  return { ids: c.id_chain.ids, hops: c.id_chain.hops, basic_state: c.basic_state };
}

/** True when the request carries an image attachment. */
export function hasImages(c: Pick<EvalCase, 'request'>): boolean {
  return (c.request.attachments ?? []).some((a) => a.mime.toLowerCase().startsWith('image/'));
}

export const DEFAULT_IMAGE_CAPABLE_TIERS: readonly Tier[] = Object.freeze(['strong'] as Tier[]);

/** The tier policy context a case's expected tier was labelled under. */
export function policyContextFor(c: Pick<EvalCase, 'request' | 'policy'>): TierPolicyContext {
  const capable = new Set<Tier>(c.policy?.image_capable_tiers ?? DEFAULT_IMAGE_CAPABLE_TIERS);
  const ctx: TierPolicyContext = {
    hasImages: hasImages(c),
    imageCapable: (tier) => capable.has(tier),
  };
  if (c.policy?.patterns) ctx.patterns = c.policy.patterns;
  return ctx;
}

/** Field paths and expectations only; the received value is never included. */
export function describeIssues(issues: readonly v.BaseIssue<unknown>[]): string[] {
  return issues.map((issue) => {
    const path = v.getDotPath(issue) ?? '(root)';
    // Custom check messages are written in this repo and carry no input.
    const what = issue.type === 'check' ? issue.message : `${issue.type}, expected ${issue.expected ?? 'valid'}`;
    return `${path}: ${what}`;
  });
}

export class CaseLoadError extends Error {
  override readonly name = 'CaseLoadError';
  readonly file: string;
  readonly problems: readonly string[];
  constructor(file: string, problems: readonly string[]) {
    super(`${file}: ${problems.join('; ')}`);
    this.file = file;
    this.problems = problems;
  }
}

export type CaseParseResult =
  | { readonly ok: true; readonly case: EvalCase }
  | { readonly ok: false; readonly problems: string[] };

/** Validates an already-parsed case object. */
export function parseCase(raw: unknown): CaseParseResult {
  const parsed = v.safeParse(CaseSchema, raw);
  if (parsed.success) return { ok: true, case: parsed.output };
  return { ok: false, problems: describeIssues(parsed.issues) };
}

/** Parses case.yaml text. YAML errors are reported by position, not content. */
export function parseCaseYaml(text: string): CaseParseResult {
  let raw: unknown;
  try {
    raw = parseYaml(text, { uniqueKeys: true, prettyErrors: false });
  } catch (err) {
    const pos = (err as { linePos?: { line: number; col: number }[] }).linePos?.[0];
    const code = (err as { code?: string }).code ?? 'YAML_ERROR';
    return { ok: false, problems: [`yaml: ${code}${pos ? ` at line ${pos.line}, col ${pos.col}` : ''}`] };
  }
  return parseCase(raw);
}

export type LoadedCase = { readonly dir: string; readonly file: string; readonly case: EvalCase };

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Loads every <dir>/<id>/case.yaml, sorted by id. Directories starting with
 * '_' or '.' are skipped, as is a directory with no case.yaml. Throws
 * CaseLoadError on the first invalid case, or when a case id does not match
 * its directory name.
 */
export async function loadCases(dir: string): Promise<LoadedCase[]> {
  if (!(await isDir(dir))) throw new CaseLoadError(dir, ['cases directory not found']);
  const names = (await readdir(dir)).filter((n) => !n.startsWith('_') && !n.startsWith('.')).sort();
  const out: LoadedCase[] = [];
  for (const name of names) {
    const caseDir = join(dir, name);
    if (!(await isDir(caseDir))) continue;
    const file = join(caseDir, CASE_FILE);
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    const result = parseCaseYaml(text);
    if (!result.ok) throw new CaseLoadError(file, result.problems);
    if (result.case.id !== name) throw new CaseLoadError(file, ['id: must match the directory name']);
    out.push({ dir: caseDir, file, case: result.case });
  }
  return out;
}
