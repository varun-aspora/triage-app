// embedRun and reembed over the folder store in a temp dir, with the mock
// hash embedder or a scripted fake. No network: every embedder gets a fetch
// spy that must stay at zero calls.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { caseCardText, requestText } from '../embed/case-text.ts';
import { EmbeddingError, HASH_MODEL, createEmbedder, type Embedder, type EmbedConfig } from '../embed/index.ts';
import { checkEgress, redactPersisted, type Persisted } from '../gate/redact.ts';
import {
  RUN_A,
  RUN_B,
  RUN_C,
  SYNTHETIC_PHONE,
  sampleClassification,
  sampleEmbedding,
  sampleReport,
  sampleRequest,
} from './contract.ts';
import { EMBEDDINGS_DISABLED, embedRun, reembed } from './embed-run.ts';
import { createFolderRunStore } from './folder.ts';
import type { RunStore } from './types.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const p = <T>(value: T): Persisted<T> => redactPersisted(value);

function folderStore(): RunStore {
  const dir = mkdtempSync(join(tmpdir(), 'triage-embed-run-'));
  dirs.push(dir);
  return createFolderRunStore({ runsDir: join(dir, 'runs'), dataDir: join(dir, 'data') });
}

type Calls = Record<string, number>;

/** Counts calls per method. The folder store uses private fields, so methods run with the real target as this. */
function spyStore(inner: RunStore, fail: Partial<Record<keyof RunStore, Error>> = {}): { store: RunStore; calls: Calls } {
  const calls: Calls = {};
  const store = new Proxy(inner, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        calls[String(prop)] = (calls[String(prop)] ?? 0) + 1;
        const err = fail[prop as keyof RunStore];
        if (err !== undefined) return Promise.reject(err);
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { store, calls };
}

type FetchSpy = { count: number; fetch: (url: string, init: RequestInit) => Promise<Response> };

function fetchSpy(): FetchSpy {
  const spy: FetchSpy = {
    count: 0,
    fetch: async () => {
      spy.count++;
      throw new Error('fetch must not be called in these tests');
    },
  };
  return spy;
}

function embedConfig(embedding: string, mock = true): EmbedConfig {
  return { mock: { enabled: mock }, models: { embedding }, providers: {}, budgets: { httpTimeoutMs: 1000 } };
}

/** The mock hash embedder, with its embed calls counted and the texts it saw kept. */
function hashEmbedder(spy = fetchSpy()): { embedder: Embedder; spy: FetchSpy; calls: string[][] } {
  const inner = createEmbedder(embedConfig('ollama/nomic-embed-text'), { fetch: spy.fetch });
  if (inner === null) throw new Error('expected an embedder');
  const calls: string[][] = [];
  const embedder: Embedder = {
    model: inner.model,
    embed: (texts, opts) => {
      calls.push(texts.map((t) => t.value));
      return inner.embed(texts, opts);
    },
  };
  return { embedder, spy, calls };
}

function throwingEmbedder(err: unknown): Embedder {
  return { model: 'ollama/nomic-embed-text', embed: () => Promise.reject(err) };
}

/** A run with a masked request, a classification and one or two reported submissions. */
async function seedRun(store: RunStore, runId: string, opts: { submissions?: 1 | 2; statement?: string } = {}): Promise<void> {
  const request = sampleRequest(runId);
  request.messages.push({ ts: 't2', author: 'support', text: 'still pending after two days', is_parent: false });
  await store.createRun(runId, p(request));
  await store.putClassification(runId, p(sampleClassification()));
  const n = opts.submissions ?? 1;
  for (let i = 1; i <= n; i++) {
    const seq = await store.addSubmission(runId, p(i === 1 ? { kind: 'initial' as const } : { kind: 'ask' as const, question: 'did the retry land?' }));
    const statement = opts.statement ?? `the payout is waiting on the bank (${seq})`;
    await store.putReport(runId, seq, p(sampleReport(runId, statement)), p(`# report ${seq}`));
  }
}

async function snapshot(store: RunStore, runId: string): Promise<{ embeddings: unknown[]; report: unknown }> {
  const run = await store.getRun(runId);
  return JSON.parse(JSON.stringify(run));
}

describe('embedRun', () => {
  test('writes one case and one request row for the latest submission', async () => {
    const store = folderStore();
    await seedRun(store, RUN_A, { submissions: 2 });
    const { embedder, spy } = hashEmbedder();

    const r = await embedRun(store, embedder, RUN_A);
    expect(r.gaps).toEqual([]);
    expect([...r.written].sort()).toEqual(['case', 'request']);

    const run = await store.getRun(RUN_A);
    const rows = run?.embeddings ?? [];
    expect(rows).toHaveLength(2);
    expect(rows.map((e) => e.kind).sort()).toEqual(['case', 'request']);
    for (const row of rows) {
      expect(row.submission_id).toBe(2);
      expect(row.model).toBe(HASH_MODEL);
      expect(row.dims).toBe(512);
    }
    expect(spy.count).toBe(0);
  });

  test('embeds the texts built from the stored record, not the raw request', async () => {
    const store = folderStore();
    await seedRun(store, RUN_A);
    const { embedder, calls } = hashEmbedder();
    await embedRun(store, embedder, RUN_A);

    const run = await store.getRun(RUN_A);
    if (run === null) throw new Error('run missing');
    expect(calls).toEqual([[caseCardText(run).value, requestText(run).value]]);
    const all = calls.flat().join('\n');
    expect(all).not.toContain(SYNTHETIC_PHONE);
    expect(checkEgress(all).ok).toBe(true);
    expect(all).toContain('category: transfer_out');
    expect(all).toContain('message: still pending after two days');
  });

  test('a second call with unchanged text writes nothing', async () => {
    const inner = folderStore();
    await seedRun(inner, RUN_A);
    const { embedder, calls } = hashEmbedder();
    await embedRun(inner, embedder, RUN_A);

    const { store, calls: storeCalls } = spyStore(inner);
    const before = await snapshot(inner, RUN_A);
    const r = await embedRun(store, embedder, RUN_A);
    expect(r.written).toEqual([]);
    expect([...r.unchanged].sort()).toEqual(['case', 'request']);
    expect(r.gaps).toEqual([]);
    expect(storeCalls.putEmbedding ?? 0).toBe(0);
    expect(calls).toHaveLength(1);
    expect(await snapshot(inner, RUN_A)).toEqual(before);
  });

  test('only the kind whose text changed is written again', async () => {
    const store = folderStore();
    await seedRun(store, RUN_A);
    const { embedder } = hashEmbedder();
    await embedRun(store, embedder, RUN_A);

    const seq = await store.addSubmission(RUN_A, p({ kind: 'initial' as const }));
    await store.putReport(RUN_A, seq, p(sampleReport(RUN_A, 'a different root cause')), p('# report'));
    const r = await embedRun(store, embedder, RUN_A);
    expect(r.written).toEqual(['case']);
    expect(r.unchanged).toEqual(['request']);
    const rows = (await store.getRun(RUN_A))?.embeddings ?? [];
    expect(rows.filter((e) => e.kind === 'case').map((e) => e.submission_id).sort()).toEqual([1, 2]);
  });

  test('force rewrites rows even when the text is unchanged', async () => {
    const inner = folderStore();
    await seedRun(inner, RUN_A);
    const { embedder } = hashEmbedder();
    await embedRun(inner, embedder, RUN_A);
    const { store, calls } = spyStore(inner);
    const r = await embedRun(store, embedder, RUN_A, { force: true });
    expect([...r.written].sort()).toEqual(['case', 'request']);
    expect(calls.putEmbedding).toBe(2);
  });

  test('embedder throws -> resolves with a gap and the store is unchanged apart from the missing rows', async () => {
    const inner = folderStore();
    await seedRun(inner, RUN_A);
    const { store, calls } = spyStore(inner);
    const before = await snapshot(inner, RUN_A);

    const r = await embedRun(store, throwingEmbedder(new EmbeddingError('ollama', 'status', 503)), RUN_A);
    expect(r.written).toEqual([]);
    expect(r.gaps).toEqual(['embeddings failed: ollama embeddings request failed: status 503']);
    expect(calls.putEmbedding ?? 0).toBe(0);
    expect(Object.keys(calls)).toEqual(['getRun']);
    const after = await snapshot(inner, RUN_A);
    expect(after).toEqual(before);
    expect(after.embeddings).toEqual([]);
    expect(after.report).not.toBeNull();
  });

  test('a plain error puts its name in the gap, never its message', async () => {
    const store = folderStore();
    await seedRun(store, RUN_A);
    const r = await embedRun(store, throwingEmbedder(new TypeError(`bad input ${SYNTHETIC_PHONE}`)), RUN_A);
    expect(r.gaps).toEqual(['embeddings failed: TypeError']);
    expect(r.gaps.join(' ')).not.toContain(SYNTHETIC_PHONE);
    const thrown = await embedRun(store, throwingEmbedder('not an error'), RUN_A);
    expect(thrown.gaps).toEqual(['embeddings failed: unknown error']);
  });

  test('a wrong number of vectors is a gap, and nothing is stored', async () => {
    const inner = folderStore();
    await seedRun(inner, RUN_A);
    const { store, calls } = spyStore(inner);
    const embedder: Embedder = { model: 'ollama/m', embed: async () => [[1, 0, 0]] };
    const r = await embedRun(store, embedder, RUN_A);
    expect(r.gaps).toEqual(['embeddings failed: embedder returned the wrong number of vectors']);
    expect(calls.putEmbedding ?? 0).toBe(0);
  });

  test('a store write failure is a gap per kind, not a throw', async () => {
    const inner = folderStore();
    await seedRun(inner, RUN_A);
    const { store } = spyStore(inner, { putEmbedding: new RangeError('disk full') });
    const r = await embedRun(store, hashEmbedder().embedder, RUN_A);
    expect(r.written).toEqual([]);
    expect(r.gaps).toEqual(['case embedding not stored (RangeError)', 'request embedding not stored (RangeError)']);
  });

  test('a store read failure and a missing run are gaps, not throws', async () => {
    const { store } = spyStore(folderStore(), { getRun: new Error('boom') });
    const { embedder, calls } = hashEmbedder();
    expect((await embedRun(store, embedder, RUN_A)).gaps).toEqual(['embeddings skipped: run store read failed (Error)']);
    expect((await embedRun(folderStore(), embedder, RUN_B)).gaps).toEqual(['embeddings skipped: run not found']);
    expect(calls).toEqual([]);
  });

  test('blank MODEL_EMBEDDING: a no-op returning embeddings disabled', async () => {
    const spy = fetchSpy();
    const embedder = createEmbedder(embedConfig('   '), { fetch: spy.fetch });
    expect(embedder).toBeNull();
    const { store, calls } = spyStore(folderStore());
    const r = await embedRun(store, embedder, RUN_A);
    expect(r.gaps).toEqual([EMBEDDINGS_DISABLED]);
    expect(r.gaps).toEqual(['embeddings disabled']);
    expect(r.written).toEqual([]);
    expect(calls).toEqual({});
    expect(spy.count).toBe(0);
  });

  test('a run with no classification or report writes only the request row', async () => {
    const store = folderStore();
    await store.createRun(RUN_A, p(sampleRequest(RUN_A)));
    const r = await embedRun(store, hashEmbedder().embedder, RUN_A);
    expect(r.written).toEqual(['request']);
    expect(r.empty).toEqual(['case']);
    expect(r.gaps).toEqual([]);
    const rows = (await store.getRun(RUN_A))?.embeddings ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.submission_id).toBeUndefined();
  });
});

describe('reembed', () => {
  test('--missing over three runs, one already embedded -> two embed calls', async () => {
    const inner = folderStore();
    for (const id of [RUN_A, RUN_B, RUN_C]) await seedRun(inner, id);
    const { embedder, calls, spy } = hashEmbedder();
    await embedRun(inner, embedder, RUN_B);
    calls.length = 0;

    const { store, calls: storeCalls } = spyStore(inner);
    const r = await reembed(store, embedder, { missing: true });
    expect(calls).toHaveLength(2);
    expect(storeCalls.putEmbedding).toBe(4);
    expect(r).toEqual({ runs: 3, embedded: 2, unchanged: 0, skipped: 1, failed: 0, disabled: false, failures: [] });
    expect(spy.count).toBe(0);
  });

  test('--missing treats a row for another model as missing', async () => {
    const store = folderStore();
    await seedRun(store, RUN_A);
    await store.putEmbedding(RUN_A, p(sampleEmbedding('case', 'ollama/old-model', [1, 0, 0], 1)));
    const { embedder, calls } = hashEmbedder();
    const r = await reembed(store, embedder, { missing: true });
    expect(calls).toHaveLength(1);
    expect(r.embedded).toBe(1);
    const models = ((await store.getRun(RUN_A))?.embeddings ?? []).map((e) => e.model).sort();
    expect(models).toEqual([HASH_MODEL, HASH_MODEL, 'ollama/old-model']);
  });

  test('without --missing every run is rebuilt, embedded or not', async () => {
    const store = folderStore();
    for (const id of [RUN_A, RUN_B, RUN_C]) await seedRun(store, id);
    const { embedder, calls } = hashEmbedder();
    await embedRun(store, embedder, RUN_B);
    calls.length = 0;
    const r = await reembed(store, embedder);
    expect(calls).toHaveLength(3);
    expect(r.embedded).toBe(3);
    expect(r.skipped).toBe(0);
  });

  test('a failing run is counted and the others still embed', async () => {
    const store = folderStore();
    for (const id of [RUN_A, RUN_B]) await seedRun(store, id);
    let n = 0;
    const inner = hashEmbedder().embedder;
    const flaky: Embedder = {
      model: inner.model,
      embed: (texts, opts) => (n++ === 0 ? Promise.reject(new EmbeddingError('ollama', 'timeout')) : inner.embed(texts, opts)),
    };
    const r = await reembed(store, flaky, { missing: true });
    expect(r.runs).toBe(2);
    expect(r.embedded).toBe(1);
    expect(r.failed).toBe(1);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]?.gaps).toEqual(['embeddings failed: ollama embeddings request failed: timeout']);
  });

  test('null embedder: disabled, nothing read', async () => {
    const { store, calls } = spyStore(folderStore());
    const r = await reembed(store, null, { missing: true });
    expect(r).toEqual({ runs: 0, embedded: 0, unchanged: 0, skipped: 0, failed: 0, disabled: true, failures: [] });
    expect(calls).toEqual({});
  });
});
