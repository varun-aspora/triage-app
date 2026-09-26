// Read-only fixture store over one fixtures tree:
//
//   <fixturesDir>/cases/<caseId>/<kind>/<entity>/<hash>.json   (checked first)
//   <fixturesDir>/shared/<kind>/<entity>/<hash>.json
//
// <fixturesDir>/_unreviewed/ holds recordings no human has read yet (D27). The
// store never builds a path into it and refuses any file that resolves there.
//
// A file that fails the schema, whose name is not the hash of its key_string,
// or whose content does not match the path it sits at is a load error. Load
// errors name the file and the failing field, never the file's contents.
import { readdir, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import * as v from 'valibot';
import { hashKeyString, keyString, semanticKey, type SemanticKeyFacts } from './key.ts';
import {
  FixtureEntitySchema,
  FixtureKindSchema,
  FixtureSchema,
  type Fixture,
  type FixtureEntity,
  type FixtureKind,
  type SemanticKey,
} from './types.ts';

export const UNREVIEWED_DIR = '_unreviewed';
export const CASES_DIR = 'cases';
export const SHARED_DIR = 'shared';

export type FixtureScope = 'case' | 'shared';

export type StoreOptions = {
  /** Absolute, or relative to home. Never resolved against the cwd. */
  readonly fixturesDir: string;
  /** When set, fixtures under cases/<caseId>/ shadow shared ones. */
  readonly caseId?: string;
  /** TRIAGE_HOME, used only when fixturesDir is relative. */
  readonly home?: string;
};

export type LoadedFixture<K extends FixtureKind = FixtureKind> = {
  readonly scope: FixtureScope;
  readonly path: string;
  readonly hash: string;
  readonly fixture: Fixture & { readonly kind: K };
};

export type FixtureEntry = {
  readonly scope: FixtureScope;
  readonly path: string;
  readonly kind: FixtureKind;
  readonly entity: FixtureEntity;
  readonly hash: string;
  readonly key_string: string;
};

export type FixtureStore = {
  readonly fixturesDir: string;
  readonly caseId?: string;
  /** The case fixture if there is one, else the shared one, else null. */
  get<K extends FixtureKind>(kind: K, entity: FixtureEntity, key: SemanticKey<K>): Promise<LoadedFixture<K> | null>;
  /** Every fixture this store can serve, case entries first, shadowed shared entries left out. */
  list(): Promise<FixtureEntry[]>;
};

export class FixtureLoadError extends Error {
  override readonly name = 'FixtureLoadError';
  readonly path: string;
  readonly fields: readonly string[];

  constructor(path: string, reason: string, fields: readonly string[] = []) {
    super(`fixture ${path}: ${reason}`);
    this.path = path;
    this.fields = Object.freeze([...fields]);
  }
}

export class FixtureStoreError extends Error {
  override readonly name = 'FixtureStoreError';
}

const CASE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
/** A fixture file name, <16 hex>.json; the capture is the hash. */
export const FIXTURE_FILE_NAME = /^([0-9a-f]{16})\.json$/;

/** A case id is one safe folder name and never the _unreviewed/ folder. */
export function isValidCaseId(caseId: string): boolean {
  return typeof caseId === 'string' && CASE_ID.test(caseId) && caseId !== UNREVIEWED_DIR;
}

export function resolveFixturesDir(fixturesDir: string, home?: string): string {
  let dir: string;
  if (isAbsolute(fixturesDir)) dir = resolve(fixturesDir);
  else if (home !== undefined && isAbsolute(home)) dir = resolve(home, fixturesDir);
  else throw new FixtureStoreError('a relative fixtures dir needs an absolute TRIAGE_HOME; the cwd is never used');
  if (dir.split(sep).includes(UNREVIEWED_DIR)) {
    throw new FixtureStoreError(`the fixtures dir must not be inside ${UNREVIEWED_DIR}/`);
  }
  return dir;
}

export function createFixtureStore(options: StoreOptions): FixtureStore {
  const root = resolveFixturesDir(options.fixturesDir, options.home);
  const { caseId } = options;
  if (caseId !== undefined && !isValidCaseId(caseId)) {
    throw new FixtureStoreError('case id must match [A-Za-z0-9][A-Za-z0-9_.-]*');
  }

  const scopes: { scope: FixtureScope; dir: string }[] = [];
  if (caseId !== undefined) scopes.push({ scope: 'case', dir: join(root, CASES_DIR, caseId) });
  scopes.push({ scope: 'shared', dir: join(root, SHARED_DIR) });

  async function get<K extends FixtureKind>(
    kind: K,
    entity: FixtureEntity,
    key: SemanticKey<K>,
  ): Promise<LoadedFixture<K> | null> {
    if (!v.is(FixtureKindSchema, kind)) throw new FixtureStoreError('unknown fixture kind');
    if (!v.is(FixtureEntitySchema, entity)) throw new FixtureStoreError('unknown fixture entity');
    // Normalising again is a no-op for a key from semanticKey() and guards a hand-built one.
    const wanted = keyString(semanticKey(kind, key as SemanticKeyFacts[K]));
    const hash = hashKeyString(wanted);
    for (const { scope, dir } of scopes) {
      const path = join(dir, kind, entity, `${hash}.json`);
      const text = await readIfPresent(path);
      if (text === null) continue;
      await assertInsideReviewedTree(root, path);
      const fixture = parseFixture(path, text, { kind, entity, hash });
      if (fixture.key_string !== wanted) {
        throw new FixtureLoadError(path, 'key_string does not match the requested key', ['key_string']);
      }
      return { scope, path, hash, fixture: fixture as Fixture & { kind: K } };
    }
    return null;
  }

  async function list(): Promise<FixtureEntry[]> {
    const seen = new Set<string>();
    const out: FixtureEntry[] = [];
    for (const { scope, dir } of scopes) {
      for (const kind of await subdirs(dir)) {
        const kindDir = join(dir, kind);
        if (!v.is(FixtureKindSchema, kind)) {
          throw new FixtureLoadError(kindDir, 'is not a known fixture kind folder');
        }
        for (const entity of await subdirs(kindDir)) {
          const entityDir = join(kindDir, entity);
          if (!v.is(FixtureEntitySchema, entity)) {
            throw new FixtureLoadError(entityDir, 'is not a known entity folder');
          }
          for (const name of await files(entityDir)) {
            const path = join(entityDir, name);
            const match = FIXTURE_FILE_NAME.exec(name);
            if (match === null) throw new FixtureLoadError(path, 'file name is not <16 hex>.json', ['name']);
            const hash = match[1] as string;
            const text = await readIfPresent(path);
            if (text === null) continue;
            await assertInsideReviewedTree(root, path);
            const fixture = parseFixture(path, text, { kind, entity, hash });
            const id = `${kind}/${entity}/${hash}`;
            if (seen.has(id)) continue;
            seen.add(id);
            out.push({ scope, path, kind: fixture.kind, entity: fixture.entity, hash, key_string: fixture.key_string });
          }
        }
      }
    }
    return out;
  }

  return Object.freeze({ fixturesDir: root, caseId, get, list });
}

/**
 * Validates one fixture file against the schema and against where it sits.
 * Exported for the promotion and review code, which read the same files.
 */
export function parseFixture(
  path: string,
  text: string,
  at: { readonly kind: FixtureKind; readonly entity: FixtureEntity; readonly hash: string },
): Fixture {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    // The parser's own message quotes part of the file, so it is not passed on.
    throw new FixtureLoadError(path, 'is not valid JSON');
  }
  const parsed = v.safeParse(FixtureSchema, raw);
  if (!parsed.success) {
    const fields = [...new Set(parsed.issues.map((i) => v.getDotPath(i) ?? '(root)'))];
    const detail = parsed.issues
      .slice(0, 5)
      .map((i) => `${v.getDotPath(i) ?? '(root)'} ${describeIssue(i)}`)
      .join('; ');
    throw new FixtureLoadError(path, `fails the fixture schema: ${detail}`, fields);
  }
  const fixture = parsed.output;
  if (hashKeyString(fixture.key_string) !== at.hash) {
    throw new FixtureLoadError(path, 'file name does not equal the hash of its key_string', ['key_string']);
  }
  if (keyString(fixture.key) !== fixture.key_string) {
    throw new FixtureLoadError(path, 'key_string is not the canonical form of key', ['key', 'key_string']);
  }
  if (fixture.kind !== at.kind) throw new FixtureLoadError(path, 'kind does not match its folder', ['kind']);
  if (fixture.entity !== at.entity) throw new FixtureLoadError(path, 'entity does not match its folder', ['entity']);
  const keyEntity = (fixture.key as { entity?: unknown }).entity;
  if (keyEntity !== undefined && keyEntity !== fixture.entity) {
    throw new FixtureLoadError(path, 'key.entity does not match entity', ['key.entity']);
  }
  return fixture;
}

// Valibot's own messages include the received value, which may be customer
// data, so only the kind of check and what it expected are reported.
function describeIssue(issue: v.BaseIssue<unknown>): string {
  if (issue.kind === 'schema' && issue.type === 'strict_object' && issue.expected === 'never') {
    return 'is not an allowed field';
  }
  if (issue.received === 'undefined') return 'is required';
  const expected = issue.kind === 'schema' ? issue.expected : null;
  return expected === null ? `fails the ${issue.type} check` : `expected ${expected}`;
}

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if (isCode(err, 'ENOENT') || isCode(err, 'ENOTDIR')) return null;
    throw new FixtureLoadError(path, `cannot be read (${errCode(err)})`);
  }
}

// A symlink from the reviewed tree into _unreviewed/ or out of the tree is refused.
async function assertInsideReviewedTree(root: string, path: string): Promise<void> {
  let realRoot: string;
  let realFile: string;
  try {
    [realRoot, realFile] = await Promise.all([realpath(root), realpath(path)]);
  } catch (err) {
    throw new FixtureLoadError(path, `cannot be resolved (${errCode(err)})`);
  }
  const rel = relative(realRoot, realFile);
  const first = rel.split(sep)[0];
  if (rel === '' || isAbsolute(rel) || first === '..' || first === UNREVIEWED_DIR) {
    throw new FixtureLoadError(path, `resolves outside the reviewed fixtures tree or into ${UNREVIEWED_DIR}/`);
  }
}

async function subdirs(dir: string): Promise<string[]> {
  return (await entries(dir)).filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

async function files(dir: string): Promise<string[]> {
  return (await entries(dir))
    .filter((e) => (e.isFile() || e.isSymbolicLink()) && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();
}

async function entries(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (isCode(err, 'ENOENT') || isCode(err, 'ENOTDIR')) return [];
    throw new FixtureLoadError(dir, `cannot be listed (${errCode(err)})`);
  }
}

function isCode(err: unknown, code: string): boolean {
  return errCode(err) === code;
}

function errCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'unknown error';
}
