// priorCasesFor over the folder store in a temp dir. The query embedder is a
// scripted fake that returns a fixed unit vector, and fixture runs get
// embedding rows whose cosine with it is chosen by the test. No network.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as v from 'valibot';
import type { ClientOptions, EmbedUsage, Embedder } from '../embed/index.ts';
import { redactPersisted, type Persisted } from '../gate/redact.ts';
import {
  CONTRACT_EPOCH,
  RUN_A,
  RUN_B,
  RUN_C,
  sampleClassification,
  sampleEmbedding,
  sampleFeedback,
  sampleReport,
  sampleRequest,
} from './contract.ts';
import { createFolderRunStore } from './folder.ts';
import {
  PRIOR_CASES_MIN_SIMILARITY,
  PRIOR_CASES_NO_EMBEDDER,
  PRIOR_CASES_TOP_K,
  PRIOR_CASES_UNAVAILABLE,
  PriorCaseSchema,
  priorCasesFor,
  type PriorCasesConfig,
} from './prior-cases.ts';
import type { RunStore, SimilarQuery } from './types.ts';

// More run ids without digit runs, so the persisted profile leaves them alone.
const RUN_D = '01JDDDDDDDDDDDDDDDDDDDDDDD';
const RUN_E = '01JEEEEEEEEEEEEEEEEEEEEEEE';

const MODEL = 'ollama/nomic-embed-text';
const DAY = 86_400_000;
const NOW = CONTRACT_EPOCH + 3 * DAY + 1000;

const ON: PriorCasesConfig = { runs: { priorCases: true } };
const OFF: PriorCasesConfig = { runs: { priorCases: false } };

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const p = <T>(value: T): Persisted<T> => redactPersisted(value);

function folderStore(): RunStore {
  const dir = mkdtempSync(join(tmpdir(), 'triage-prior-cases-'));
  dirs.push(dir);
  return createFolderRunStore({ runsDir: join(dir, 'runs'), dataDir: join(dir, 'data'), now: () => CONTRACT_EPOCH });
}

type Calls = Record<string, number>;

/** Counts calls per method and can fail one. Methods run with the real target as this. */
function spyStore(
  inner: RunStore,
  fail: Partial<Record<keyof RunStore, Error>> = {},
): { store: RunStore; calls: Calls; queries: SimilarQuery[] } {
  const calls: Calls = {};
  const queries: SimilarQuery[] = [];
  const store = new Proxy(inner, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        calls[String(prop)] = (calls[String(prop)] ?? 0) + 1;
        if (prop === 'findSimilar') queries.push(args[0] as SimilarQuery);
        const err = fail[prop as keyof RunStore];
        if (err !== undefined) return Promise.reject(err);
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { store, calls, queries };
}

/** Returns the unit vector [1, 0, 0] for every text and records what it saw. */
function fakeEmbedder(fail?: Error): { embedder: Embedder; calls: string[][] } {
  const calls: string[][] = [];
  const embedder: Embedder = {
    model: MODEL,
    embed: async (texts) => {
      calls.push(texts.map((t) => t.value));
      if (fail !== undefined) throw fail;
      return texts.map(() => [1, 0, 0]);
    },
  };
  return { embedder, calls };
}

/** A vector whose cosine with [1, 0, 0] is exactly sim. */
function at(sim: number): number[] {
  return [sim, Math.sqrt(1 - sim * sim), 0];
}

type Seed = {
  readonly sim?: number;
  readonly requestSim?: number;
  readonly verdict?: 'correct' | 'partial' | 'wrong' | 'pending';
  readonly patternId?: string;
  readonly subcategory?: string;
  readonly escalated?: boolean;
};

/** A reported run with a case embedding at seed.sim and, optionally, a request embedding. */
async function seedRun(store: RunStore, runId: string, seed: Seed = {}): Promise<void> {
  await store.createRun(runId, p(sampleRequest(runId)));
  const classification = sampleClassification();
  if (seed.subcategory !== undefined) classification.decision.proposed.subcategory = seed.subcategory;
  await store.putClassification(runId, p(classification));
  const seq = await store.addSubmission(runId, p({ kind: 'initial' as const }));
  const report = sampleReport(runId, 'the payout is waiting on the bank');
  report.classification = classification.decision;
  if (seed.patternId !== undefined && report.root_cause !== null) report.root_cause.matched_pattern_id = seed.patternId;
  if (seed.escalated !== undefined) report.escalated = seed.escalated;
  await store.putReport(runId, seq, p(report), p('# report'));
  if (seed.verdict !== undefined) {
    await store.putFeedback(runId, p(sampleFeedback(seed.verdict, '2026-09-02T10:00:00.000Z')));
  }
  if (seed.sim !== undefined) await store.putEmbedding(runId, p(sampleEmbedding('case', MODEL, at(seed.sim), seq)));
  if (seed.requestSim !== undefined) {
    await store.putEmbedding(runId, p(sampleEmbedding('request', MODEL, at(seed.requestSim), seq)));
  }
}

/** The current run: a request only, with a request embedding identical to the query. */
async function seedCurrent(store: RunStore): Promise<void> {
  await store.createRun(RUN_A, p(sampleRequest(RUN_A)));
  await store.putEmbedding(RUN_A, p(sampleEmbedding('request', MODEL, at(1))));
}

const UUID_SHAPED = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

describe('priorCasesFor', () => {
  test('flag false returns [] and touches neither the store nor the embedder', async () => {
    const { store, calls } = spyStore(folderStore());
    const { embedder, calls: embedCalls } = fakeEmbedder();
    const r = await priorCasesFor(OFF, store, embedder, RUN_A);
    expect(r).toEqual({ cases: [], gaps: [] });
    expect(calls).toEqual({});
    expect(embedCalls).toEqual([]);
  });

  test('a null embedder returns [] without a store read', async () => {
    const { store, calls } = spyStore(folderStore());
    const r = await priorCasesFor(ON, store, null, RUN_A);
    expect(r.cases).toEqual([]);
    expect(r.gaps).toEqual([PRIOR_CASES_NO_EMBEDDER]);
    expect(calls).toEqual({});
  });

  test('flag true: the top 3 by similarity, all above the floor', async () => {
    const inner = folderStore();
    await seedCurrent(inner);
    await seedRun(inner, RUN_B, { sim: 0.8 });
    await seedRun(inner, RUN_C, { sim: 0.95 });
    await seedRun(inner, RUN_D, { sim: 0.9 });
    await seedRun(inner, RUN_E, { sim: 0.78 });
    const { store, calls, queries } = spyStore(inner);
    const { embedder, calls: embedCalls } = fakeEmbedder();

    const r = await priorCasesFor(ON, store, embedder, RUN_A, { now: () => NOW });
    expect(r.gaps).toEqual([]);
    expect(r.cases).toHaveLength(PRIOR_CASES_TOP_K);
    expect(r.cases.map((c) => c.similarity)).toEqual([0.95, 0.9, 0.8].map((s) => expect.closeTo(s, 9)));
    for (const c of r.cases) expect(c.similarity).toBeGreaterThanOrEqual(PRIOR_CASES_MIN_SIMILARITY);

    expect(r.cases[0]).toEqual({
      category: 'transfer_out',
      subcategory: 'stuck',
      report_status: 'root_cause_confirmed',
      escalated: false,
      age_days: 3,
      similarity: expect.closeTo(0.95, 9),
    });

    // The current run's request text was embedded, and the store was asked
    // for both kinds under the embedder's model, without this run.
    expect(embedCalls).toHaveLength(1);
    expect(embedCalls[0]?.[0]).toContain('parent:');
    expect(calls.findSimilar).toBe(1);
    expect(queries[0]).toMatchObject({ model: MODEL, kinds: ['case', 'request'], excludeRunId: RUN_A });
  });

  test('one case per run, at its best row', async () => {
    const store = folderStore();
    await seedCurrent(store);
    await seedRun(store, RUN_B, { sim: 0.8, requestSim: 0.92 });
    const { embedder } = fakeEmbedder();
    const r = await priorCasesFor(ON, store, embedder, RUN_A, { now: () => NOW });
    expect(r.cases).toHaveLength(1);
    expect(r.cases[0]?.similarity).toBeCloseTo(0.92, 9);
  });

  test('a hit below 0.75 is dropped', async () => {
    const store = folderStore();
    await seedCurrent(store);
    await seedRun(store, RUN_B, { sim: 0.9 });
    await seedRun(store, RUN_C, { sim: 0.74 });
    const { embedder } = fakeEmbedder();
    const r = await priorCasesFor(ON, store, embedder, RUN_A, { now: () => NOW });
    expect(r.cases).toHaveLength(1);
    expect(r.cases[0]?.similarity).toBeCloseTo(0.9, 9);
  });

  test('a wrong-verdict run and the current run are excluded', async () => {
    const store = folderStore();
    await seedCurrent(store);
    await seedRun(store, RUN_B, { sim: 0.99, verdict: 'wrong' });
    await seedRun(store, RUN_C, { sim: 0.85, verdict: 'correct' });
    const { embedder } = fakeEmbedder();
    const r = await priorCasesFor(ON, store, embedder, RUN_A, { now: () => NOW });
    expect(r.cases).toHaveLength(1);
    expect(r.cases[0]?.feedback_verdict).toBe('correct');
    expect(r.cases[0]?.similarity).toBeCloseTo(0.85, 9);
  });

  test('the current run is dropped even when the store returns it', async () => {
    const inner = folderStore();
    await seedCurrent(inner);
    await seedRun(inner, RUN_B, { sim: 0.8 });
    // A store that ignores excludeRunId.
    const store = new Proxy(inner, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
        if (prop === 'findSimilar') {
          return (q: SimilarQuery) => target.findSimilar({ ...q, excludeRunId: undefined });
        }
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    expect((await inner.findSimilar({ vector: [1, 0, 0], model: MODEL }))[0]?.run_id).toBe(RUN_A);
    const { embedder } = fakeEmbedder();
    const r = await priorCasesFor(ON, store, embedder, RUN_A, { now: () => NOW });
    expect(r.cases).toHaveLength(1);
    expect(r.cases[0]?.similarity).toBeCloseTo(0.8, 9);
  });

  test('a run whose latest feedback is no longer wrong is kept', async () => {
    const store = folderStore();
    await seedCurrent(store);
    await seedRun(store, RUN_B, { sim: 0.9, verdict: 'wrong' });
    await store.putFeedback(RUN_B, p(sampleFeedback('partial', '2026-09-03T10:00:00.000Z')));
    const { embedder } = fakeEmbedder();
    const r = await priorCasesFor(ON, store, embedder, RUN_A, { now: () => NOW });
    expect(r.cases.map((c) => c.feedback_verdict)).toEqual(['partial']);
  });

  test('the projection passes PriorCaseSchema and holds no ids, free text or number runs', async () => {
    const store = folderStore();
    await seedCurrent(store);
    await seedRun(store, RUN_B, { sim: 0.9, patternId: 'payout-bank-pending', escalated: true, verdict: 'pending' });
    await seedRun(store, RUN_C, { sim: 0.88 });
    const { embedder } = fakeEmbedder();
    const r = await priorCasesFor(ON, store, embedder, RUN_A, { now: () => NOW });
    expect(r.cases).toHaveLength(2);
    expect(r.cases[0]).toMatchObject({ matched_pattern_id: 'payout-bank-pending', escalated: true, feedback_verdict: 'pending' });

    const allowed = new Set(Object.keys(PriorCaseSchema.entries));
    for (const c of r.cases) {
      expect(v.is(PriorCaseSchema, c)).toBe(true);
      for (const key of Object.keys(c)) expect(allowed.has(key)).toBe(true);
    }
    const json = JSON.stringify(r);
    for (const id of [RUN_A, RUN_B, RUN_C]) expect(json).not.toContain(id);
    for (const leak of ['"run_id"', '"id_chain"', '"root_cause"', '"statement"', '"reply_text"', 'waiting on the bank', 'The bank is processing it']) {
      expect(json).not.toContain(leak);
    }
    expect(json).not.toMatch(UUID_SHAPED);
    expect(json).not.toMatch(/\d{6,}/);
  });

  test('a case with a UUID-shaped pattern id is scrubbed out', async () => {
    const store = folderStore();
    await seedCurrent(store);
    // Kebab-case, so it passes the pattern id shape; the final scrub catches it.
    await seedRun(store, RUN_B, { sim: 0.95, patternId: '123e4567-e89b-42d3-a456-426614174000' });
    await seedRun(store, RUN_C, { sim: 0.85 });
    const { embedder } = fakeEmbedder();
    const r = await priorCasesFor(ON, store, embedder, RUN_A, { now: () => NOW });
    expect(r.cases).toHaveLength(1);
    expect(r.cases[0]?.similarity).toBeCloseTo(0.85, 9);
    expect(JSON.stringify(r)).not.toMatch(UUID_SHAPED);
  });

  test('a subcategory that is not a short label is left out', async () => {
    const store = folderStore();
    await seedCurrent(store);
    await seedRun(store, RUN_B, { sim: 0.9, subcategory: 'customer said: "it is stuck, please help!"' });
    const { embedder } = fakeEmbedder();
    const r = await priorCasesFor(ON, store, embedder, RUN_A, { now: () => NOW });
    expect(r.cases).toHaveLength(1);
    expect(r.cases[0]).not.toHaveProperty('subcategory');
  });

  test('findSimilar throws: [] plus the gap, never a throw', async () => {
    const inner = folderStore();
    await seedCurrent(inner);
    await seedRun(inner, RUN_B, { sim: 0.9 });
    const { store } = spyStore(inner, { findSimilar: new Error('connection to db.internal:5432 refused') });
    const { embedder } = fakeEmbedder();
    const r = await priorCasesFor(ON, store, embedder, RUN_A);
    expect(r).toEqual({ cases: [], gaps: [PRIOR_CASES_UNAVAILABLE] });
    expect(PRIOR_CASES_UNAVAILABLE).toBe('prior cases unavailable');
  });

  test('embedder throws: [] plus the gap, and findSimilar is not called', async () => {
    const inner = folderStore();
    await seedCurrent(inner);
    const { store, calls } = spyStore(inner);
    const { embedder } = fakeEmbedder(new Error('ollama down'));
    const r = await priorCasesFor(ON, store, embedder, RUN_A);
    expect(r).toEqual({ cases: [], gaps: [PRIOR_CASES_UNAVAILABLE] });
    expect(calls.findSimilar).toBeUndefined();
  });

  test('getRun throws or the current run is missing: [] plus the gap', async () => {
    const { store } = spyStore(folderStore(), { getRun: new Error('disk read failed') });
    const { embedder } = fakeEmbedder();
    expect(await priorCasesFor(ON, store, embedder, RUN_A)).toEqual({ cases: [], gaps: [PRIOR_CASES_UNAVAILABLE] });
    expect(await priorCasesFor(ON, folderStore(), embedder, RUN_A)).toEqual({ cases: [], gaps: [PRIOR_CASES_UNAVAILABLE] });
  });

  test('an embedder that returns the wrong number of vectors gives the gap', async () => {
    const store = folderStore();
    await seedCurrent(store);
    const embedder: Embedder = { model: MODEL, embed: async () => [] };
    expect(await priorCasesFor(ON, store, embedder, RUN_A)).toEqual({ cases: [], gaps: [PRIOR_CASES_UNAVAILABLE] });
  });
});

describe('priorCasesFor usage (D59)', () => {
  // A fake that reports usage the way createEmbedder does: once per call, after it settles.
  function meteredEmbedder(fail?: Error): Embedder {
    return {
      model: MODEL,
      embed: async (texts, opts) => {
        if (fail !== undefined) {
          opts?.onUsage?.({ model: MODEL, inputTokens: 0, failed: true });
          throw fail;
        }
        opts?.onUsage?.({ model: MODEL, inputTokens: 7 * texts.length, failed: false });
        return texts.map(() => [1, 0, 0]);
      },
    };
  }

  test('onUsage reaches the one embed call', async () => {
    const store = folderStore();
    await seedCurrent(store);
    await seedRun(store, RUN_B, { sim: 0.9 });
    const seen: EmbedUsage[] = [];
    const r = await priorCasesFor(ON, store, meteredEmbedder(), RUN_A, { now: () => NOW, onUsage: (u) => seen.push(u) });
    expect(r.cases).toHaveLength(1);
    expect(seen).toEqual([{ model: MODEL, inputTokens: 7, failed: false }]);
  });

  test('a failed embed call is still reported, and the result is the usual gap', async () => {
    const store = folderStore();
    await seedCurrent(store);
    const seen: EmbedUsage[] = [];
    const r = await priorCasesFor(ON, store, meteredEmbedder(new Error('down')), RUN_A, { onUsage: (u) => seen.push(u) });
    expect(r).toEqual({ cases: [], gaps: [PRIOR_CASES_UNAVAILABLE] });
    expect(seen).toEqual([{ model: MODEL, inputTokens: 0, failed: true }]);
  });

  test('flag off: no embed call, so no usage', async () => {
    const seen: EmbedUsage[] = [];
    await priorCasesFor(OFF, folderStore(), meteredEmbedder(), RUN_A, { onUsage: (u) => seen.push(u) });
    expect(seen).toEqual([]);
  });
});

describe('priorCasesFor tracing (D82)', () => {
  // Records the options each embed call got; the span itself is tested in src/embed/embed.test.ts.
  function optionsEmbedder(): { embedder: Embedder; seen: (ClientOptions | undefined)[] } {
    const seen: (ClientOptions | undefined)[] = [];
    const embedder: Embedder = {
      model: MODEL,
      embed: async (texts, opts) => {
        seen.push(opts);
        return texts.map(() => [1, 0, 0]);
      },
    };
    return { embedder, seen };
  }

  test('traced asks embed() to trace the call for the current run', async () => {
    const store = folderStore();
    await seedCurrent(store);
    const { embedder, seen } = optionsEmbedder();
    await priorCasesFor(ON, store, embedder, RUN_A, { traced: true });
    expect(seen.map((o) => o?.trace)).toEqual([{ runId: RUN_A, purpose: 'prior_cases' }]);
  });

  test('without traced the embed call carries no trace option', async () => {
    const store = folderStore();
    await seedCurrent(store);
    const { embedder, seen } = optionsEmbedder();
    await priorCasesFor(ON, store, embedder, RUN_A);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.trace).toBeUndefined();
  });
});

describe('PriorCaseSchema', () => {
  const valid = { category: 'transfer_out', age_days: 2, similarity: 0.8 };

  test('accepts the structured fields', () => {
    expect(v.is(PriorCaseSchema, valid)).toBe(true);
    expect(
      v.is(PriorCaseSchema, {
        ...valid,
        subcategory: 'stuck',
        report_status: 'root_cause_confirmed',
        matched_pattern_id: 'payout-bank-pending',
        escalated: false,
        feedback_verdict: 'correct',
      }),
    ).toBe(true);
  });

  test('rejects an extra free-text field', () => {
    expect(v.is(PriorCaseSchema, { ...valid, root_cause: 'the payout is waiting on the bank' })).toBe(false);
    expect(v.is(PriorCaseSchema, { ...valid, run_id: RUN_B })).toBe(false);
  });

  test('rejects a wrong verdict, a similarity below the floor and a free-text subcategory', () => {
    expect(v.is(PriorCaseSchema, { ...valid, feedback_verdict: 'wrong' })).toBe(false);
    expect(v.is(PriorCaseSchema, { ...valid, similarity: 0.5 })).toBe(false);
    expect(v.is(PriorCaseSchema, { ...valid, subcategory: 'said "help!" twice' })).toBe(false);
  });
});

describe('classifier isolation', () => {
  test('no file under src/classify imports src/runstore/prior-cases', () => {
    const root = join(import.meta.dir, '..', 'classify');
    const files = readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile() && /\.(ts|mts|js|mjs|json)$/.test(d.name))
      .map((d) => join(d.parentPath, d.name));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      expect({ file, imports: /prior-cases/.test(text) }).toEqual({ file, imports: false });
    }
  });
});
