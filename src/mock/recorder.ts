// Records real results as candidate fixtures for a human to review (D19, D27).
//
// A candidate lands at
//
//   <fixturesDir>/_unreviewed/<run_id>/<kind>/<entity>/<hash>.json
//
// and nowhere else. The store never reads _unreviewed/; `triage fixtures
// review` promotes a file after someone has read it.
//
// Both the result and the key go through the persisted redaction profile with
// the run's ingress-collected names (D24). The key is normalised again after
// redaction and the hash is taken over that redacted key_string, so the file
// passes the store's own checks once it is promoted. UUIDs pass (A11).
//
// If the persisted check still finds a pattern after redaction, nothing is
// written and a gap is returned naming the patterns, never the values.
//
// Writes go to a temp file that is then linked into place, which fails when
// the target exists, so an existing file is never overwritten. No git, no
// subprocess: committing a fixture is always a human step.
import { randomBytes } from 'node:crypto';
import { link, lstat, mkdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import * as v from 'valibot';
import {
  checkEgress,
  redactPersisted as defaultRedactPersisted,
  type EgressResult,
  type Persisted,
  type PersistedOptions,
} from '../gate/redact.ts';
import { PATTERN_NAMES } from '../gate/redact-patterns.ts';
import { RunIdSchema } from '../types/core.ts';
import { hashKeyString, keyString, semanticKey, SemanticKeyError, type SemanticKeyFacts } from './key.ts';
import type { RealIoOutcome, RecordContext, Recorder, RecordResult } from './resolve.ts';
import { parseFixture, resolveFixturesDir, UNREVIEWED_DIR } from './store.ts';
import { FixtureEntitySchema, FixtureKindSchema, type Fixture, type FixtureEntity, type FixtureKind } from './types.ts';

export type RedactPersistedFn = <T>(value: T, opts: PersistedOptions) => Persisted<T>;
export type CheckPersistedFn = (value: unknown, opts: PersistedOptions) => EgressResult;

export type RecordGapContext = {
  readonly kind: FixtureKind;
  readonly entity: FixtureEntity;
  readonly run_id: string;
};

export type RecorderOptions = {
  /** Absolute, or relative to home. Never resolved against the cwd. */
  readonly fixturesDir: string;
  /** TRIAGE_HOME, used only when fixturesDir is relative. */
  readonly home?: string;
  /** Defaults to the persisted profile from src/gate/redact.ts. */
  readonly redactPersisted?: RedactPersistedFn;
  /** Defaults to checkEgress from src/gate/redact.ts. */
  readonly checkPersisted?: CheckPersistedFn;
  /** Clock for meta.recorded_at. */
  readonly now?: () => Date;
  /** Told about every dropped candidate, so the run can list it as a gap. */
  readonly onGap?: (gap: string, at: RecordGapContext) => void;
};

/** Structurally a Recorder, with a narrower record() result. */
export type FixtureRecorder = {
  /** The resolved fixtures root; candidates go under <root>/_unreviewed/. */
  readonly fixturesDir: string;
  record(outcome: RealIoOutcome<unknown>, ctx: RecordContext): Promise<RecordResult>;
};

/** A path part that would leave _unreviewed/<run_id>/ or is not a known value. Names the field only. */
export class FixtureRecordRefusedError extends Error {
  override readonly name = 'FixtureRecordRefusedError';
  readonly field: string;

  constructor(field: string, reason: string) {
    super(`fixture recording refused: ${field} ${reason}`);
    this.field = field;
  }
}

export function createRecorder(options: RecorderOptions): FixtureRecorder {
  const root = resolveFixturesDir(options.fixturesDir, options.home);
  const redact = options.redactPersisted ?? defaultRedactPersisted;
  const check = options.checkPersisted ?? checkEgress;
  const now = options.now ?? (() => new Date());
  const { onGap } = options;

  async function record(outcome: RealIoOutcome<unknown>, ctx: RecordContext): Promise<RecordResult> {
    const { kind, entity, run_id } = checkPathParts(ctx);
    const names = ctx.redaction_names ?? [];

    const dropped = (gap: string): RecordResult => {
      if (onGap !== undefined) {
        try {
          onGap(gap, { kind, entity, run_id });
        } catch {
          // A broken gap sink must not turn a drop into a failure.
        }
      }
      return Object.freeze({ status: 'dropped', gap });
    };

    const result = redact(outcome.value === undefined ? null : outcome.value, { names }).value;
    const redactedKey = redact(ctx.key, { names }).value;
    let key: RecordContext['key'];
    try {
      key = semanticKey(kind, redactedKey as SemanticKeyFacts[typeof kind]);
    } catch (err) {
      if (!(err instanceof SemanticKeyError)) throw err;
      return dropped(`recorded ${kind} fixture dropped: the redacted key is not a valid key (${err.fields.join(', ')})`);
    }
    const key_string = keyString(key);
    const hash = hashKeyString(key_string);

    const verdict = check({ key, key_string, result }, { names });
    if (!verdict.ok) {
      return dropped(`recorded ${kind} fixture dropped: still unmasked after redaction: ${patternList(verdict.unmasked)}`);
    }

    const fixture: Fixture = {
      schema: 1,
      kind,
      entity,
      key,
      key_string,
      result,
      meta: { source: 'recorded', recorded_at: now().toISOString(), run_id },
    } as Fixture;

    const dir = join(root, UNREVIEWED_DIR, run_id, kind, entity);
    const path = join(dir, `${hash}.json`);
    const text = `${JSON.stringify(fixture, null, 2)}\n`;
    // The same checks the store runs on a promoted file, so a candidate that
    // could never be served is caught here and not at review time.
    parseFixture(path, text, { kind, entity, hash });

    const parts = [UNREVIEWED_DIR, run_id, kind, entity];
    await ensureRunDir(root, parts);
    await assertInsideRunDir(root, dir, parts);
    if (await exists(path)) return Object.freeze({ status: 'kept', path });
    const written = await writeNoClobber(dir, path, text, hash);
    return Object.freeze({ status: written ? 'written' : 'kept', path });
  }

  return Object.freeze({ fixturesDir: root, record }) satisfies Recorder;
}

function checkPathParts(ctx: RecordContext): { kind: FixtureKind; entity: FixtureEntity; run_id: string } {
  if (!v.is(FixtureKindSchema, ctx.kind)) {
    throw new FixtureRecordRefusedError('kind', 'is not a known fixture kind');
  }
  if (!v.is(FixtureEntitySchema, ctx.entity)) {
    throw new FixtureRecordRefusedError('entity', 'is not a known fixture entity');
  }
  if (ctx.run_id === undefined) throw new FixtureRecordRefusedError('run_id', 'is required to record');
  if (!v.is(RunIdSchema, ctx.run_id)) throw new FixtureRecordRefusedError('run_id', 'must match [A-Za-z0-9_-]{1,64}');
  return { kind: ctx.kind, entity: ctx.entity, run_id: ctx.run_id };
}

// Creates the run folder one level at a time and refuses a part that is a
// symlink or not a folder, so nothing is created outside the fixtures tree.
async function ensureRunDir(root: string, parts: readonly string[]): Promise<void> {
  await mkdir(root, { recursive: true });
  let at = root;
  for (const part of parts) {
    at = join(at, part);
    try {
      await mkdir(at, { mode: 0o700 });
    } catch (err) {
      if (codeOf(err) !== 'EEXIST') throw err;
    }
    const st = await lstat(at);
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new FixtureRecordRefusedError('path', `has a symlink or file where a folder under ${UNREVIEWED_DIR}/ should be`);
    }
  }
}

// The checks above already keep every part a single safe segment. This is a
// last check that the folder really resolves to the expected place.
async function assertInsideRunDir(root: string, dir: string, parts: readonly string[]): Promise<void> {
  const [realRoot, realDir] = await Promise.all([realpath(root), realpath(dir)]);
  if (relative(realRoot, realDir) !== parts.join(sep)) {
    throw new FixtureRecordRefusedError('path', `resolves outside ${UNREVIEWED_DIR}/<run_id>/`);
  }
}

// Only known pattern names get into the gap text, whatever the checker returned.
function patternList(unmasked: readonly string[]): string {
  const known = PATTERN_NAMES.filter((p) => unmasked.includes(p));
  const unknown = unmasked.some((p) => !(PATTERN_NAMES as readonly string[]).includes(p));
  const out: string[] = [...known];
  if (unknown || out.length === 0) out.push('unknown pattern');
  return out.join(', ');
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (err) {
    if (codeOf(err) === 'ENOENT') return false;
    throw err;
  }
}

// Returns false when another write got there first. link() fails on an
// existing target, unlike rename(); rename is the fallback only on file
// systems without hard links.
async function writeNoClobber(dir: string, path: string, text: string, hash: string): Promise<boolean> {
  const tmp = join(dir, `.${hash}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  await writeFile(tmp, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  try {
    try {
      await link(tmp, path);
      return true;
    } catch (err) {
      const code = codeOf(err);
      if (code === 'EEXIST') return false;
      if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'ENOSYS' && code !== 'EOPNOTSUPP') throw err;
    }
    if (await exists(path)) return false;
    await rename(tmp, path);
    return true;
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
}

function codeOf(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}
