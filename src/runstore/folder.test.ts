import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { redactPersisted, type Persisted } from '../gate/redact.ts';
import type { EntityFindings } from '../types/findings.ts';
import type { Report } from '../types/report.ts';
import type { TriageRequest } from '../types/request.ts';
import { makeTestHome } from '../../test/support/home.ts';
import {
  RUN_A,
  RUN_B,
  SYNTHETIC_PHONE,
  makeClock,
  runContractCase,
  runStoreContract,
  sampleFeedback,
  sampleFindings,
  sampleReport,
  sampleRequest,
  type ContractFactory,
} from './contract.ts';
import { createFolderRunStore, folderRunStoreFromConfig } from './folder.ts';
import { RunStoreRedactionError, type Feedback, type RunStore } from './types.ts';

const dirs: string[] = [];

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'runstore-folder-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeStore(now?: () => number): { store: RunStore; runsDir: string; dataDir: string } {
  const root = tempRoot();
  const runsDir = join(root, 'runs');
  const dataDir = join(root, 'data');
  return { store: createFolderRunStore({ runsDir, dataDir, ...(now ? { now } : {}) }), runsDir, dataDir };
}

const factory: ContractFactory = async (clock) => {
  const { store } = makeStore(clock.now);
  return { store, cleanup: async () => {} };
};

/** Every file under dir, relative, temp files included. */
function walk(dir: string, prefix = ''): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out.sort();
}

const p = <T>(value: T): Persisted<T> => redactPersisted(value);

describe('folder provider: shared contract', () => {
  for (const c of runStoreContract) {
    test(`contract: ${c.name}`, () => runContractCase(c, factory));
  }
});

describe('folder provider: layout', () => {
  test('evidence/ssfb.json layout matches HLD paths so other readers keep working', async () => {
    const { store, runsDir } = makeStore();
    await store.createRun(RUN_A, p(sampleRequest(RUN_A)));
    await store.putEvidence(RUN_A, 'ssfb', p(sampleFindings('first look')));
    await store.putEvidence(RUN_A, 'ssfb', p(sampleFindings('second look')));
    await store.putEvidence(RUN_A, 'code', p({ claims: [], confidence: 'low' as const }));
    const dir = join(runsDir, RUN_A);

    // The latest findings sit at evidence/<entity>.json as plain findings JSON.
    const latest = JSON.parse(readFileSync(join(dir, 'evidence', 'ssfb.json'), 'utf8')) as EntityFindings;
    expect(latest).toEqual(sampleFindings('second look'));
    expect(JSON.parse(readFileSync(join(dir, 'evidence', 'ssfb.v1.json'), 'utf8'))).toEqual(sampleFindings('first look'));
    expect(JSON.parse(readFileSync(join(dir, 'evidence', 'code.json'), 'utf8'))).toEqual({ claims: [], confidence: 'low' });
    expect(existsSync(join(dir, 'input.json'))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))).toMatchObject({
      schema_version: 1,
      run_id: RUN_A,
      phase: 'created',
    });
  });

  test('full run layout: submissions, root report, feedback and embeddings', async () => {
    const { store, runsDir } = makeStore();
    await store.createRun(RUN_A, p(sampleRequest(RUN_A)));
    const s1 = await store.addSubmission(RUN_A, p({ kind: 'initial' as const }));
    const s2 = await store.addSubmission(RUN_A, p({ kind: 'ask' as const, question: 'and now?' }));
    await store.putReport(RUN_A, s1, p(sampleReport(RUN_A, 'one')), p('# one\n'));
    await store.putReport(RUN_A, s2, p(sampleReport(RUN_A, 'two')), p('# two\n'));
    await store.putFeedback(RUN_A, p(sampleFeedback('wrong', '2026-09-02T00:00:00.000Z')));
    await store.putFeedback(RUN_A, p(sampleFeedback('correct', '2026-09-03T00:00:00.000Z')), p('# my feedback\n'));
    await store.putEmbedding(
      RUN_A,
      p({ kind: 'case' as const, model: 'ollama/x', text_sha256: 'cd'.repeat(32), source_text: 'case', vector: [1, 2] }),
    );

    const dir = join(runsDir, RUN_A);
    expect(walk(dir)).toEqual([
      'embeddings.json',
      'feedback.jsonl',
      'feedback.md',
      'input.json',
      'meta.json',
      'report.json',
      'report.md',
      'submissions/1/report.json',
      'submissions/1/report.md',
      'submissions/1/submission.json',
      'submissions/2/report.json',
      'submissions/2/report.md',
      'submissions/2/submission.json',
    ]);
    const root = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8')) as Report;
    expect(root.root_cause?.statement).toBe('two');
    expect(readFileSync(join(dir, 'report.md'), 'utf8')).toBe('# two\n');
    const lines = readFileSync(join(dir, 'feedback.jsonl'), 'utf8').trim().split('\n');
    expect(lines.map((l) => (JSON.parse(l) as Feedback).verdict)).toEqual(['wrong', 'correct']);
    expect(readFileSync(join(dir, 'feedback.md'), 'utf8')).toBe('# my feedback\n');
    const embeddings = JSON.parse(readFileSync(join(dir, 'embeddings.json'), 'utf8')) as unknown[];
    expect(embeddings).toEqual([
      { run_id: RUN_A, kind: 'case', model: 'ollama/x', text_sha256: 'cd'.repeat(32), source_text: 'case', vector: [1, 2] },
    ]);
  });

  test('default feedback.md names the latest verdict', async () => {
    const { store, runsDir } = makeStore();
    await store.createRun(RUN_A, p(sampleRequest(RUN_A)));
    await store.putFeedback(RUN_A, p(sampleFeedback('wrong', '2026-09-02T00:00:00.000Z')));
    await store.putFeedback(RUN_A, p({ ...sampleFeedback('partial', '2026-09-03T00:00:00.000Z'), actual_root_cause: 'bank delay' }));
    const md = readFileSync(join(runsDir, RUN_A, 'feedback.md'), 'utf8');
    expect(md).toContain('Latest verdict: partial');
    expect(md).toContain('Actual root cause: bank delay');
    expect(md).toContain('wrong');
  });

  test('folderRunStoreFromConfig uses TRIAGE_RUNS_DIR and TRIAGE_DATA_DIR from config', async () => {
    const home = makeTestHome({ overrides: { TRIAGE_RUNS_DIR: './custom-runs', TRIAGE_DATA_DIR: './custom-data' } });
    try {
      const store = folderRunStoreFromConfig(home.config);
      await store.createRun(RUN_A, p(sampleRequest(RUN_A)));
      await store.claimIdempotencyKey('k', RUN_A, 60_000);
      expect(existsSync(join(home.home, 'custom-runs', RUN_A, 'meta.json'))).toBe(true);
      expect(readdirSync(join(home.home, 'custom-data', 'idempotency')).filter((n) => n.endsWith('.json'))).toHaveLength(1);
    } finally {
      home.cleanup();
    }
  });

  test('idempotency claim files hold the run id and expiry, never the key', async () => {
    const { store, dataDir } = makeStore();
    const key = 'slack:C0SYNTHETIC:thread-key';
    await store.claimIdempotencyKey(key, RUN_A, 60_000);
    const files = readdirSync(join(dataDir, 'idempotency'));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[0-9a-f]{64}\.json$/);
    const body = readFileSync(join(dataDir, 'idempotency', files[0]!), 'utf8');
    expect(body).not.toContain(key);
    expect(JSON.parse(body)).toMatchObject({ run_id: RUN_A });
  });
});

describe('folder provider: refusals', () => {
  test('re-scan refusal on unmasked phone leaves no file on disk', async () => {
    const { store, runsDir } = makeStore();
    const request = redactPersisted(sampleRequest(RUN_A));
    request.value.messages[0]!.text = `please call ${SYNTHETIC_PHONE}`;
    let caught: unknown;
    try {
      await store.createRun(RUN_A, request);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RunStoreRedactionError);
    expect((caught as RunStoreRedactionError).patterns).toContain('phone');
    expect((caught as Error).message).not.toContain(SYNTHETIC_PHONE);
    expect(walk(runsDir)).toEqual([]);

    // Same for a write into an existing run: the evidence folder stays empty.
    await store.createRun(RUN_B, p(sampleRequest(RUN_B)));
    const before = walk(runsDir);
    const findings = redactPersisted(sampleFindings('ok'));
    findings.value.hypotheses[0] = `owner reachable on ${SYNTHETIC_PHONE}`;
    await expect(store.putEvidence(RUN_B, 'ssfb', findings)).rejects.toBeInstanceOf(RunStoreRedactionError);
    expect(walk(runsDir)).toEqual(before);
    for (const file of walk(runsDir)) {
      expect(readFileSync(join(runsDir, file), 'utf8')).not.toContain('98765');
    }
  });

  test('runtime re-scan rejects email and 6+ digit runs with pattern names only', async () => {
    const { store, runsDir } = makeStore();
    await store.createRun(RUN_A, p(sampleRequest(RUN_A)));
    const cases: [string, string][] = [
      ['email', 'someone.synthetic@example.org'],
      ['digits6', 'ref 777888999'],
      ['phone', SYNTHETIC_PHONE],
    ];
    for (const [pattern, text] of cases) {
      const fb = redactPersisted(sampleFeedback('wrong', '2026-09-02T00:00:00.000Z'));
      fb.value.faster_path = text;
      const err = await store.putFeedback(RUN_A, fb).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(RunStoreRedactionError);
      expect((err as RunStoreRedactionError).patterns).toContain(pattern as never);
      expect((err as Error).message).toContain(pattern);
      expect((err as Error).message).not.toContain(text);
      expect(JSON.stringify((err as RunStoreRedactionError).paths)).not.toContain(text);
    }
    expect(existsSync(join(runsDir, RUN_A, 'feedback.jsonl'))).toBe(false);
  });

  test('a path-like run id never reaches the file system', async () => {
    const { store, runsDir } = makeStore();
    await expect(store.createRun('../outside', p(sampleRequest(RUN_A)))).rejects.toThrow('invalid run id');
    expect(existsSync(join(runsDir, '..', 'outside'))).toBe(false);
  });
});

describe('folder provider: concurrency and atomicity', () => {
  test('concurrent claimIdempotencyKey calls with one key yield one winner (wx)', async () => {
    const root = tempRoot();
    const runsDir = join(root, 'runs');
    const dataDir = join(root, 'data');
    // Separate store instances share nothing in memory, like separate processes.
    const stores = Array.from({ length: 12 }, () => createFolderRunStore({ runsDir, dataDir }));
    const ids = stores.map((_, i) => `01JRUN${String.fromCharCode(65 + i).repeat(20)}`);
    const results = await Promise.all(stores.map((s, i) => s.claimIdempotencyKey('same-key', ids[i]!, 60_000)));
    const winners = new Set(results);
    expect(winners.size).toBe(1);
    expect(ids).toContain([...winners][0]!);
    const files = await readdir(join(dataDir, 'idempotency'));
    expect(files.filter((f) => f.endsWith('.json'))).toHaveLength(1);
    expect(files.some((f) => f.includes('.tmp-') || f.endsWith('.lock'))).toBe(false);
  });

  test('concurrent reclaims of an expired key yield one winner', async () => {
    const root = tempRoot();
    const clock = makeClock();
    const opts = { runsDir: join(root, 'runs'), dataDir: join(root, 'data'), now: clock.now };
    const first = createFolderRunStore(opts);
    await first.claimIdempotencyKey('k', RUN_A, 1000);
    clock.advance(5000);
    const stores = Array.from({ length: 10 }, () => createFolderRunStore(opts));
    const ids = stores.map((_, i) => `01JNEW${String.fromCharCode(65 + i).repeat(20)}`);
    const results = await Promise.all(stores.map((s, i) => s.claimIdempotencyKey('k', ids[i]!, 60_000)));
    expect(new Set(results).size).toBe(1);
    expect(results[0]).not.toBe(RUN_A);
  });

  test('concurrent addSubmission from two store instances never shares a seq', async () => {
    const root = tempRoot();
    const opts = { runsDir: join(root, 'runs'), dataDir: join(root, 'data') };
    const a = createFolderRunStore(opts);
    const b = createFolderRunStore(opts);
    await a.createRun(RUN_A, p(sampleRequest(RUN_A)));
    const seqs = await Promise.all(
      Array.from({ length: 8 }, (_, i) => (i % 2 ? a : b).addSubmission(RUN_A, p({ kind: 'ask' as const }))),
    );
    expect([...seqs].sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect((await a.getRun(RUN_A))?.submissions).toHaveLength(8);
  });

  test('no temp files are left behind after a busy run', async () => {
    const { store, runsDir, dataDir } = makeStore();
    await store.createRun(RUN_A, p(sampleRequest(RUN_A)));
    await Promise.all([
      store.putEvidence(RUN_A, 'ssfb', p(sampleFindings('a'))),
      store.putEvidence(RUN_A, 'ssfb', p(sampleFindings('b'))),
      store.putEvidence(RUN_A, 'rtl', p(sampleFindings('c'))),
      store.addSubmission(RUN_A, p({ kind: 'initial' as const })),
      store.setPhase(RUN_A, 'investigating'),
      store.putFeedback(RUN_A, p(sampleFeedback('pending', '2026-09-02T00:00:00.000Z'))),
      store.claimIdempotencyKey('k', RUN_A, 1000),
    ]);
    const all = [...walk(runsDir), ...walk(dataDir)];
    expect(all.filter((f) => f.includes('.tmp-') || f.endsWith('.lock'))).toEqual([]);
  });

  test('deleteRun leaves no trace in the runs dir', async () => {
    const { store, runsDir } = makeStore();
    await store.createRun(RUN_A, p(sampleRequest(RUN_A)));
    await store.putEvidence(RUN_A, 'ssfb', p(sampleFindings('a')));
    expect(await store.deleteRun(RUN_A)).toBe(true);
    expect(readdirSync(runsDir)).toEqual([]);
  });
});

// Compile-time checks. Each line below must fail to type-check; tsc reports
// an unused @ts-expect-error if one ever compiles. The function is never run.
function typeLevelChecks(store: RunStore): void {
  const rawRequest: TriageRequest = sampleRequest(RUN_A);
  const rawFindings: EntityFindings = sampleFindings('x');
  const rawReport: Report = sampleReport(RUN_A, 'x');
  const rawFeedback: Feedback = sampleFeedback('correct', '2026-09-02T00:00:00.000Z');

  // @ts-expect-error the raw thread type is not accepted by createRun
  void store.createRun(RUN_A, rawRequest);
  // @ts-expect-error a persisted value of another type is not a request
  void store.createRun(RUN_A, redactPersisted(rawFindings));
  // @ts-expect-error raw findings
  void store.putEvidence(RUN_A, 'ssfb', rawFindings);
  // @ts-expect-error raw report
  void store.putReport(RUN_A, 1, rawReport, redactPersisted('# md'));
  // @ts-expect-error raw markdown
  void store.putReport(RUN_A, 1, redactPersisted(rawReport), '# md');
  // @ts-expect-error raw feedback
  void store.putFeedback(RUN_A, rawFeedback);
  // @ts-expect-error a structural look-alike is not a Persisted value
  void store.putEvidence(RUN_A, 'ssfb', { value: rawFindings, toJSON: () => rawFindings });
  // @ts-expect-error 'shivalik' is an alias, not an evidence key
  void store.putEvidence(RUN_A, 'shivalik', redactPersisted(rawFindings));

  // These compile.
  void store.createRun(RUN_A, redactPersisted(rawRequest));
  void store.putEvidence(RUN_A, 'ssfb', redactPersisted(rawFindings));
  void store.putReport(RUN_A, 1, redactPersisted(rawReport), redactPersisted('# md'));
  void store.putFeedback(RUN_A, redactPersisted(rawFeedback));
}
void typeLevelChecks;
