// Promotion of reviewed material out of the _unreviewed/ folders (D27, D42).
//
// Two kinds of item share one promotion path:
//
//   fixtures/_unreviewed/<run_id>/<kind>/<entity>/<hash>.json   a recorded fixture
//   evals/_unreviewed/<run_id>/                                 an eval case draft
//
// A fixture is re-validated, its key is normalised again and its file name is
// recomputed from the key object in the file, because the reviewer may have
// replaced masks with pseudonyms. A key that still holds the mask token is
// refused. The stamped result must pass the persisted redaction check. The
// file is then renamed (not copied) to fixtures/cases/<caseId>/... or to
// fixtures/shared/....
//
// An eval case draft folder is renamed to evals/cases/<case_id>/ once every
// file in it passes the same check. Before the check, the cost key is dropped
// from the draft's report.json in place (D59), so no promotion path carries a
// run's token counts or spend into evals/cases, drafts written before
// feedback.ts stopped copying it included.
//
// Refusals are returned, not thrown, and name patterns, fields and file names,
// never values. Declined items stay where they are. Nothing here runs git or
// any other subprocess: committing promoted files is left to the human.
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, unlink } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import * as v from 'valibot';
import { checkEgress, type EgressResult, type PatternName } from '../gate/redact.ts';
import { DRAFT_REPORT_FILE } from '../report/feedback.ts';
import { writeFileAtomic } from '../report/run-folder.ts';
import { RunIdSchema } from '../types/core.ts';
import { canonicalJson, hashKeyString, keyString, semanticKey, SemanticKeyError } from './key.ts';
import { CASES_DIR, parseFixture, SHARED_DIR, UNREVIEWED_DIR } from './store.ts';
import { FixtureSchema, type Fixture } from './types.ts';

/** The token the persisted profile leaves in place of a masked id. */
export const MASK_TOKEN = '****';

export type ReviewDirs = {
  /** Absolute fixtures dir (config.paths.fixturesDir). */
  readonly fixturesDir: string;
  /** Absolute evals dir, <TRIAGE_HOME>/evals by default. */
  readonly evalsDir: string;
};

export type FixtureReviewItem = {
  readonly type: 'fixture';
  readonly fixturesDir: string;
  readonly runId: string;
  /** Absolute path of the file under _unreviewed/. */
  readonly path: string;
  /** Kind, entity and hash as the folders and file name say. */
  readonly kind: string;
  readonly entity: string;
  readonly hash: string;
  /** The parsed file, or null when it fails the schema (see problem). */
  readonly fixture: Fixture | null;
  /** Why the file cannot be promoted as it is, for display. Names fields only. */
  readonly problem?: string;
};

export type EvalCaseReviewItem = {
  readonly type: 'eval_case';
  readonly evalsDir: string;
  readonly runId: string;
  /** Absolute path of the draft folder under evals/_unreviewed/. */
  readonly path: string;
  /** Files in the folder, relative, '/'-separated, sorted. */
  readonly files: readonly string[];
};

export type ReviewItem = FixtureReviewItem | EvalCaseReviewItem;

/** The persisted check. Tests pass a fake. */
export type PersistedCheck = (value: unknown) => EgressResult;

export type PromoteOptions = {
  /** Who read the item. Stamped as meta.reviewed_by on fixtures. */
  readonly reviewer: string;
  /** Fixture: cases/<caseId>/ instead of shared/. Eval case: the case id (default: the run id). */
  readonly caseId?: string;
  /** Names for the persisted check, when the caller has them. */
  readonly names?: readonly string[];
  readonly check?: PersistedCheck;
  readonly now?: () => Date;
};

export type PromoteResult =
  | { readonly status: 'promoted'; readonly type: ReviewItem['type']; readonly from: string; readonly to: string }
  /** The target already holds the same content. The source is removed; the target is not touched. */
  | { readonly status: 'unchanged'; readonly type: ReviewItem['type']; readonly from: string; readonly to: string }
  | {
      readonly status: 'refused';
      readonly type: ReviewItem['type'];
      readonly from: string;
      readonly reason: string;
      readonly patterns?: readonly PatternName[];
    };

export type DeclineResult = { readonly status: 'declined'; readonly type: ReviewItem['type']; readonly path: string };

const CASE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const FIXTURE_FILE = /^([0-9a-f]{16})\.json$/;

/** The review dirs from config: TRIAGE_FIXTURES_DIR and <TRIAGE_HOME>/evals. */
export function reviewDirsFrom(config: {
  readonly home: string;
  readonly paths: { readonly fixturesDir: string };
}): ReviewDirs {
  return { fixturesDir: config.paths.fixturesDir, evalsDir: join(config.home, 'evals') };
}

// ------------------------------------------------------------------ listing

/** Every fixture and eval case draft waiting for review, fixtures first, each sorted by path. */
export async function listUnreviewed(dirs: ReviewDirs): Promise<ReviewItem[]> {
  const fixturesDir = absolute('fixturesDir', dirs.fixturesDir);
  const evalsDir = absolute('evalsDir', dirs.evalsDir);
  const items: ReviewItem[] = [];

  const fixturesRoot = join(fixturesDir, UNREVIEWED_DIR);
  for (const runId of await dirNames(fixturesRoot)) {
    for (const kind of await dirNames(join(fixturesRoot, runId))) {
      for (const entity of await dirNames(join(fixturesRoot, runId, kind))) {
        const entityDir = join(fixturesRoot, runId, kind, entity);
        for (const name of await fileNames(entityDir)) {
          if (!name.endsWith('.json')) continue;
          items.push(await loadFixtureItem(fixturesDir, runId, kind, entity, name));
        }
      }
    }
  }

  const evalsRoot = join(evalsDir, UNREVIEWED_DIR);
  for (const runId of await dirNames(evalsRoot)) {
    const path = join(evalsRoot, runId);
    const walked = await walkFiles(path);
    items.push({ type: 'eval_case', evalsDir, runId, path, files: walked.files });
  }
  return items;
}

async function loadFixtureItem(
  fixturesDir: string,
  runId: string,
  kind: string,
  entity: string,
  name: string,
): Promise<FixtureReviewItem> {
  const path = join(fixturesDir, UNREVIEWED_DIR, runId, kind, entity, name);
  const hash = FIXTURE_FILE.exec(name)?.[1] ?? name.slice(0, -'.json'.length);
  const base = { type: 'fixture' as const, fixturesDir, runId, path, kind, entity, hash };
  const loaded = await readFixture(path);
  if (!loaded.ok) return { ...base, fixture: null, problem: loaded.reason };
  const problem = layoutProblem(runId, kind, entity, name, loaded.fixture) ?? maskProblem(loaded.fixture);
  return problem === null ? { ...base, fixture: loaded.fixture } : { ...base, fixture: loaded.fixture, problem };
}

function layoutProblem(runId: string, kind: string, entity: string, name: string, f: Fixture): string | null {
  if (!v.is(RunIdSchema, runId)) return 'run folder name is not a valid run id';
  if (!FIXTURE_FILE.test(name)) return 'file name is not <16 hex>.json';
  if (f.kind !== kind) return 'kind does not match its folder';
  if (f.entity !== entity) return 'entity does not match its folder';
  return null;
}

// ------------------------------------------------------------------ promote

/** Promotes one reviewed item. Re-reads it from disk, so edits made after listing count. */
export async function promote(item: ReviewItem, options: PromoteOptions): Promise<PromoteResult> {
  const refuse = (reason: string, patterns?: readonly PatternName[]): PromoteResult => ({
    status: 'refused',
    type: item.type,
    from: item.path,
    reason,
    ...(patterns !== undefined ? { patterns } : {}),
  });
  const reviewer = typeof options.reviewer === 'string' ? options.reviewer.trim() : '';
  if (reviewer === '') return refuse('a reviewer name is required');
  if (options.caseId !== undefined && !validCaseId(options.caseId)) {
    return refuse('case id must match [A-Za-z0-9][A-Za-z0-9_.-]*');
  }
  const check = options.check ?? ((value: unknown) => checkEgress(value, { names: options.names }));
  const now = options.now ?? (() => new Date());
  if (item.type === 'fixture') return promoteFixture(item, { ...options, reviewer, check, now }, refuse);
  if (item.type === 'eval_case') return promoteEvalCase(item, { ...options, reviewer, check, now }, refuse);
  return refuse('unknown review item type');
}

type Resolved = PromoteOptions & { readonly reviewer: string; readonly check: PersistedCheck; readonly now: () => Date };
type Refuse = (reason: string, patterns?: readonly PatternName[]) => PromoteResult;

async function promoteFixture(item: FixtureReviewItem, o: Resolved, refuse: Refuse): Promise<PromoteResult> {
  const root = absolute('fixturesDir', item.fixturesDir);
  const source = await sourceInside(join(root, UNREVIEWED_DIR), item.path, 'file');
  if (!source.ok) return refuse(source.reason);

  const loaded = await readFixture(source.path);
  if (!loaded.ok) return refuse(loaded.reason);
  const masked = maskProblem(loaded.fixture);
  if (masked !== null) return refuse(masked);

  // The key in the file is the truth: normalise it and rebuild key_string and the name.
  const kind = loaded.fixture.kind;
  let key: unknown;
  try {
    // A normalised key passed back in gives itself, so this only normalises edits.
    key = semanticKey(kind, loaded.fixture.key as never);
  } catch (err) {
    if (err instanceof SemanticKeyError) return refuse(`key is not a valid ${kind} key: ${err.fields.join(', ')}`);
    throw err;
  }
  const key_string = keyString(key);
  const hash = hashKeyString(key_string);
  const { reviewed_by: _by, reviewed_at: _at, ...meta } = loaded.fixture.meta;
  const promoted = {
    ...loaded.fixture,
    key,
    key_string,
    meta: { ...meta, reviewed_by: o.reviewer, reviewed_at: o.now().toISOString() },
  };

  const checked = o.check(promoted);
  if (!checked.ok) {
    return refuse(`fails the persisted redaction check: ${checked.unmasked.join(', ')}`, checked.unmasked);
  }

  const scopeDir = o.caseId !== undefined ? join(root, CASES_DIR, o.caseId) : join(root, SHARED_DIR);
  const target = join(scopeDir, kind, loaded.fixture.entity, `${hash}.json`);
  const text = `${JSON.stringify(promoted, null, 2)}\n`;
  let fixture: Fixture;
  try {
    // The same checks the store runs on load, so the promoted file is servable.
    fixture = parseFixture(target, text, { kind, entity: loaded.fixture.entity, hash });
  } catch (err) {
    return refuse(err instanceof Error ? err.message.replace(`fixture ${target}: `, '') : 'fails the fixture checks');
  }

  const existing = await existingTarget(target, 'file');
  if (existing === 'symlink') return refuse('target is a symlink');
  if (existing === 'other') return refuse('target exists and is not a file');
  if (existing === 'present') {
    const same = sameFixture(await readFile(target, 'utf8'), fixture);
    if (!same) return refuse('target exists with different content');
    await unlink(source.path);
    return { status: 'unchanged', type: 'fixture', from: item.path, to: target };
  }

  // Stamp the reviewed file in place, then rename it into the reviewed tree.
  await writeFileAtomic(source.path, text);
  await mkdir(join(scopeDir, kind, loaded.fixture.entity), { recursive: true });
  await rename(source.path, target);
  return { status: 'promoted', type: 'fixture', from: item.path, to: target };
}

async function promoteEvalCase(item: EvalCaseReviewItem, o: Resolved, refuse: Refuse): Promise<PromoteResult> {
  const root = absolute('evalsDir', item.evalsDir);
  const source = await sourceInside(join(root, UNREVIEWED_DIR), item.path, 'dir');
  if (!source.ok) return refuse(source.reason);

  const caseId = o.caseId ?? item.runId;
  if (!validCaseId(caseId)) return refuse('case id must match [A-Za-z0-9][A-Za-z0-9_.-]*');

  const walked = await walkFiles(source.path);
  if (walked.symlinks.length > 0) return refuse(`draft holds symlinks: ${walked.symlinks.join(', ')}`);
  if (walked.files.length === 0) return refuse('draft folder has no files');
  if (walked.files.includes(DRAFT_REPORT_FILE)) await dropDraftCost(join(source.path, DRAFT_REPORT_FILE));

  const failures: string[] = [];
  const patterns = new Set<PatternName>();
  const contents = new Map<string, Buffer>();
  for (const file of walked.files) {
    const bytes = await readFile(join(source.path, ...file.split('/')));
    contents.set(file, bytes);
    const text = utf8Text(bytes);
    if (text === null) {
      failures.push(`${file}: not a text file`);
      continue;
    }
    const checked = o.check(file.endsWith('.json') ? parseJsonOr(text) : text);
    if (!checked.ok) {
      for (const p of checked.unmasked) patterns.add(p);
      failures.push(`${file}: ${checked.unmasked.join(', ')}`);
    }
  }
  if (failures.length > 0) {
    const list = [...patterns];
    return refuse(`fails the persisted redaction check (${failures.join('; ')})`, list.length > 0 ? list : undefined);
  }

  const target = join(root, CASES_DIR, caseId);
  const existing = await existingTarget(target, 'dir');
  if (existing === 'symlink') return refuse('target is a symlink');
  if (existing === 'other') return refuse('target exists and is not a folder');
  if (existing === 'present') {
    if (!(await sameFolder(target, contents))) return refuse('target case folder exists with different content');
    await rm(source.path, { recursive: true });
    return { status: 'unchanged', type: 'eval_case', from: item.path, to: target };
  }
  await mkdir(join(root, CASES_DIR), { recursive: true });
  await rename(source.path, target);
  return { status: 'promoted', type: 'eval_case', from: item.path, to: target };
}

/**
 * Rewrites a draft's report.json in place without its cost key (D59).
 * Anything unexpected (no file, a symlink, not JSON, not an object, no cost
 * key) is left as it is for the checks that follow to accept or refuse.
 * Returns whether the file was rewritten.
 */
export async function dropDraftCost(path: string): Promise<boolean> {
  try {
    if (!(await lstat(path)).isFile()) return false;
  } catch {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return false;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || !('cost' in parsed)) return false;
  const { cost: _cost, ...rest } = parsed as Record<string, unknown>;
  await writeFileAtomic(path, `${JSON.stringify(rest, null, 2)}\n`);
  return true;
}

// ------------------------------------------------------------------ decline

/** Leaves the item where it is. It stays in _unreviewed/ for a later review or for cleanup. */
export function decline(item: ReviewItem): DeclineResult {
  return { status: 'declined', type: item.type, path: item.path };
}

// ------------------------------------------------------------------ checks

type FixtureRead = { ok: true; fixture: Fixture } | { ok: false; reason: string };

async function readFixture(path: string): Promise<FixtureRead> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    // The parser's message quotes the file, so only the kind of failure is kept.
    return { ok: false, reason: err instanceof SyntaxError ? 'is not valid JSON' : `cannot be read (${errCode(err)})` };
  }
  const parsed = v.safeParse(FixtureSchema, raw);
  if (!parsed.success) {
    const fields = [...new Set(parsed.issues.map((i) => v.getDotPath(i) ?? '(root)'))];
    return { ok: false, reason: `fails the fixture schema at ${fields.join(', ')}` };
  }
  return { ok: true, fixture: parsed.output };
}

/** A key that still holds a mask cannot match a pseudonymised call, so it is refused. */
function maskProblem(fixture: Fixture): string | null {
  const at = maskPaths(fixture.key, 'key');
  if (at.length === 0) return null;
  return (
    `the key still contains the mask token '${MASK_TOKEN}' at ${at.join(', ')}; ` +
    'pseudonymise the ids (replace each mask with a consistent pseudonym) before promoting'
  );
}

function maskPaths(value: unknown, path: string): string[] {
  if (typeof value === 'string') return value.includes(MASK_TOKEN) ? [path] : [];
  if (Array.isArray(value)) return value.flatMap((item, i) => maskPaths(item, `${path}[${i}]`));
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, item]) =>
      k.includes(MASK_TOKEN) ? [`${path}.[*]`] : maskPaths(item, `${path}.${k}`),
    );
  }
  return [];
}

// Same content means the same fixture apart from who reviewed it and when.
function sameFixture(existingText: string, fixture: Fixture): boolean {
  let existing: unknown;
  try {
    existing = JSON.parse(existingText);
  } catch {
    return false;
  }
  return comparable(existing) === comparable(fixture);
}

function comparable(value: unknown): string | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const { meta, ...rest } = value as { meta?: unknown };
  let m = meta;
  if (meta !== null && typeof meta === 'object' && !Array.isArray(meta)) {
    const { reviewed_by: _by, reviewed_at: _at, ...others } = meta as Record<string, unknown>;
    m = others;
  }
  try {
    return canonicalJson({ ...rest, meta: m });
  } catch {
    return null;
  }
}

async function sameFolder(dir: string, contents: ReadonlyMap<string, Buffer>): Promise<boolean> {
  const walked = await walkFiles(dir);
  if (walked.symlinks.length > 0 || walked.files.length !== contents.size) return false;
  for (const file of walked.files) {
    const want = contents.get(file);
    if (want === undefined) return false;
    const have = await readFile(join(dir, ...file.split('/')));
    if (!have.equals(want)) return false;
  }
  return true;
}

// ------------------------------------------------------------------ fs helpers

type SourceCheck = { ok: true; path: string } | { ok: false; reason: string };

// The item must be a real file or folder inside the given _unreviewed/ root,
// so a hand-built item cannot move something from elsewhere.
async function sourceInside(unreviewedRoot: string, path: string, want: 'file' | 'dir'): Promise<SourceCheck> {
  if (typeof path !== 'string' || !isAbsolute(path)) return { ok: false, reason: 'item path must be absolute' };
  const lexical = relative(unreviewedRoot, resolve(path));
  if (lexical === '' || lexical.startsWith('..') || isAbsolute(lexical)) {
    return { ok: false, reason: `item is not inside ${UNREVIEWED_DIR}/` };
  }
  let stat;
  try {
    stat = await lstat(path);
  } catch (err) {
    return { ok: false, reason: `item is gone (${errCode(err)})` };
  }
  if (stat.isSymbolicLink()) return { ok: false, reason: 'item is a symlink' };
  if (want === 'file' ? !stat.isFile() : !stat.isDirectory()) {
    return { ok: false, reason: want === 'file' ? 'item is not a file' : 'item is not a folder' };
  }
  const [realRoot, realPath] = await Promise.all([realpath(unreviewedRoot), realpath(path)]);
  const rel = relative(realRoot, realPath);
  if (rel === '' || rel.split(sep)[0] === '..' || isAbsolute(rel)) {
    return { ok: false, reason: `item resolves outside ${UNREVIEWED_DIR}/` };
  }
  return { ok: true, path: resolve(path) };
}

async function existingTarget(path: string, want: 'file' | 'dir'): Promise<'absent' | 'present' | 'symlink' | 'other'> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) return 'symlink';
    return (want === 'file' ? stat.isFile() : stat.isDirectory()) ? 'present' : 'other';
  } catch (err) {
    if (errCode(err) === 'ENOENT') return 'absent';
    throw err;
  }
}

type Walked = { files: string[]; symlinks: string[] };

async function walkFiles(dir: string, prefix = ''): Promise<Walked> {
  const out: Walked = { files: [], symlinks: [] };
  const list = await readdir(dir, { withFileTypes: true }).catch((err: unknown) => {
    if (errCode(err) === 'ENOENT' || errCode(err) === 'ENOTDIR') return [];
    throw err;
  });
  for (const entry of [...list].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isSymbolicLink()) out.symlinks.push(rel);
    else if (entry.isDirectory()) {
      const inner = await walkFiles(join(dir, entry.name), rel);
      out.files.push(...inner.files);
      out.symlinks.push(...inner.symlinks);
    } else if (entry.isFile()) out.files.push(rel);
  }
  return out;
}

async function dirNames(dir: string): Promise<string[]> {
  const list = await readdir(dir, { withFileTypes: true }).catch((err: unknown) => {
    if (errCode(err) === 'ENOENT' || errCode(err) === 'ENOTDIR') return [];
    throw err;
  });
  return list.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name).sort();
}

async function fileNames(dir: string): Promise<string[]> {
  const list = await readdir(dir, { withFileTypes: true });
  // Dot files are temp files from an in-flight write.
  return list.filter((e) => (e.isFile() || e.isSymbolicLink()) && !e.name.startsWith('.')).map((e) => e.name).sort();
}

function utf8Text(bytes: Buffer): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function parseJsonOr(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function validCaseId(caseId: string): boolean {
  return typeof caseId === 'string' && CASE_ID.test(caseId) && caseId !== UNREVIEWED_DIR;
}

function absolute(name: string, dir: string): string {
  if (typeof dir !== 'string' || !isAbsolute(dir)) {
    throw new TypeError(`${name} must be an absolute path; the cwd is never used`);
  }
  return resolve(dir);
}

function errCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'unknown error';
}

