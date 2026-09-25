// The postgres provider against the in-repo fake pool (fake-pg.ts). No
// database is opened: the real runner from src/db/pg.ts runs over the fake,
// so BEGIN, COMMIT and ROLLBACK come from production code.

import { beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadModule, parseSync } from 'libpg-query';
import { redactPersisted, type Persisted } from '../gate/redact.ts';
import {
  RUN_A,
  RUN_B,
  SYNTHETIC_PHONE,
  runContractCase,
  runStoreContract,
  sampleEmbedding,
  sampleFeedback,
  sampleFindings,
  sampleReport,
  sampleRequest,
  type ContractFactory,
} from './contract.ts';
import { createFakePg, type FakePg, type FakePgCall } from './fake-pg.ts';
import {
  EmbeddingDimsMismatchError,
  InvalidModelTableError,
  MODEL_TABLE_MAX_LENGTH,
  SQL,
  createPostgresRunStore,
  embeddingSql,
  embeddingTableDdl,
  sanitiseModelTable,
} from './postgres.ts';
import { RunNotFoundError, RunStoreError, RunStoreRedactionError, type RunStore } from './types.ts';

const p = <T>(value: T): Persisted<T> => redactPersisted(value);

function setup(now?: () => number): { fake: FakePg; store: RunStore } {
  const fake = createFakePg();
  const store = createPostgresRunStore({ runner: fake.runner(), ...(now ? { now } : {}) });
  return { fake, store };
}

const factory: ContractFactory = async (clock) => {
  const { store } = setup(clock.now);
  return { store, cleanup: async () => {} };
};

function callsOf(fake: FakePg, text: string): FakePgCall[] {
  return fake.calls.filter((c) => c.text === text);
}

/** The statements one checked-out client ran between BEGIN and COMMIT or ROLLBACK. */
function transactions(fake: FakePg): { on: string; statements: string[]; end: string }[] {
  const open = new Map<string, string[]>();
  const done: { on: string; statements: string[]; end: string }[] = [];
  for (const c of fake.calls) {
    if (c.text === 'BEGIN') open.set(c.on, []);
    else if (c.text === 'COMMIT' || c.text === 'ROLLBACK') {
      done.push({ on: c.on, statements: open.get(c.on) ?? [], end: c.text });
      open.delete(c.on);
    } else open.get(c.on)?.push(c.text);
  }
  return done;
}

// ------------------------------------------------------------------ contract

describe('postgres provider: shared contract against fake-pg', () => {
  for (const c of runStoreContract) {
    test(`contract: ${c.name}`, () => runContractCase(c, factory));
  }
});

// ------------------------------------------------------------------ statements

describe('postgres provider: statements', () => {
  test('createRun issues INSERT ... ON CONFLICT (run_id) DO NOTHING with params', async () => {
    const { fake, store } = setup(() => Date.parse('2026-09-01T00:00:00.000Z'));
    await store.createRun(RUN_A, p(sampleRequest(RUN_A)));
    await store.createRun(RUN_A, p(sampleRequest(RUN_A)));
    const inserts = callsOf(fake, SQL.createRun);
    expect(inserts).toHaveLength(2);
    expect(SQL.createRun).toStartWith('INSERT INTO triage.runs');
    expect(SQL.createRun).toContain('ON CONFLICT (run_id) DO NOTHING');
    const [first] = inserts;
    expect(first?.on).toBe('pool');
    expect(first?.params[0]).toBe(RUN_A);
    expect(first?.params[1]).toBe(1);
    expect(first?.params[2]).toBe('2026-09-01T00:00:00.000Z');
    expect(first?.params[3]).toBe('created');
    // The request goes as one jsonb parameter, persisted profile only.
    const request = JSON.parse(String(first?.params[4])) as { request_id: string };
    expect(request.request_id).toBe(RUN_A);
    expect(String(first?.params[4])).not.toContain(SYNTHETIC_PHONE);
    expect(first?.text).not.toContain(RUN_A);
    expect(fake.counts().runs).toBe(1);
  });

  test('claimIdempotencyKey uses key_sha256 and expires_at; raw key never sent', async () => {
    let now = Date.parse('2026-09-01T00:00:00.000Z');
    const { fake, store } = setup(() => now);
    const key = 'slack:C0SYNTHETIC:1726000000.000100';
    const hash = createHash('sha256').update(key).digest('hex');

    expect(await store.claimIdempotencyKey(key, RUN_A, 60_000)).toBe(RUN_A);
    const [claim] = callsOf(fake, SQL.claimKey);
    expect(SQL.claimKey).toContain('key_sha256');
    expect(SQL.claimKey).toContain('expires_at');
    expect(claim?.params).toEqual([hash, RUN_A, '2026-09-01T00:01:00.000Z', '2026-09-01T00:00:00.000Z']);

    now += 30_000;
    expect(await store.claimIdempotencyKey(key, RUN_B, 60_000)).toBe(RUN_A);
    expect(callsOf(fake, SQL.heldKey).at(-1)?.params).toEqual([hash]);
    now += 30_000;
    expect(await store.clearExpiredIdempotencyKeys()).toBe(1);

    for (const c of fake.calls) {
      expect(c.text).not.toContain(key);
      expect(c.text).not.toContain('slack:');
      for (const param of c.params) expect(String(param)).not.toContain('slack:');
    }
  });

  test('findSimilar SQL uses <=> and LIMIT $n with model filter and run_id <> $self', async () => {
    const { fake, store } = setup();
    const model = 'ollama/nomic-embed-text';
    await store.createRun(RUN_A, p(sampleRequest(RUN_A)));
    await store.createRun(RUN_B, p(sampleRequest(RUN_B)));
    await store.putEmbedding(RUN_A, p(sampleEmbedding('case', model, [1, 0])));
    await store.putEmbedding(RUN_B, p(sampleEmbedding('case', model, [1, 0])));

    const fresh = createPostgresRunStore({ runner: fake.runner() });
    const hits = await fresh.findSimilar({ vector: [1, 0], model, excludeRunId: RUN_A, limit: 3, kinds: ['case'] });
    expect(hits.map((h) => h.run_id)).toEqual([RUN_B]);

    // The model picks the table through the registry, by parameter.
    expect(callsOf(fake, SQL.embeddingModel).at(-1)?.params).toEqual([model]);
    expect(SQL.embeddingModel).toContain('WHERE model = $1');

    const similar = embeddingSql(sanitiseModelTable(model)).similar;
    const [scan] = callsOf(fake, similar);
    expect(similar).toContain('embedding <=> $1::vector');
    expect(similar).toMatch(/ORDER BY embedding <=> \$1::vector/);
    expect(similar).toMatch(/LIMIT \$5::bigint$/);
    expect(similar).toContain('run_id <> $4::text');
    expect(similar).toContain('FROM triage.emb_ollama_nomic_embed_text');
    expect(scan?.params).toEqual(['[1,0]', 'case', 'case', RUN_A, 3]);
  });

  test('findSimilar for an unregistered model or other dims returns [] without a scan', async () => {
    const { fake, store } = setup();
    await store.createRun(RUN_A, p(sampleRequest(RUN_A)));
    await store.putEmbedding(RUN_A, p(sampleEmbedding('case', 'ollama/x', [1, 0])));
    expect(await store.findSimilar({ vector: [1, 0], model: 'ollama/never-used' })).toEqual([]);
    expect(await store.findSimilar({ vector: [1, 0, 0], model: 'ollama/x' })).toEqual([]);
    expect(await store.findSimilar({ vector: [1, 0], model: 'ollama/x', kinds: [] })).toEqual([]);
    expect(await store.findSimilar({ vector: [1, 0], model: 'ollama/x', limit: 0 })).toEqual([]);
    expect(callsOf(fake, embeddingSql(sanitiseModelTable('ollama/x')).similar)).toHaveLength(0);
    await expect(store.findSimilar({ vector: [1, 0], model: 'ollama/x', kinds: ['root_cause' as never] })).rejects.toThrow(
      RunStoreError,
    );
  });

  test('deleteRun runs in one transaction', async () => {
    const { fake, store } = setup();
    await store.createRun(RUN_A, p(sampleRequest(RUN_A)));
    const seq = await store.addSubmission(RUN_A, p({ kind: 'initial' as const }));
    await store.putReport(RUN_A, seq, p(sampleReport(RUN_A, 'answer')), p('# answer'));
    await store.putEvidence(RUN_A, 'ssfb', p(sampleFindings('look')));
    await store.putFeedback(RUN_A, p(sampleFeedback('correct', '2026-09-01T10:00:00.000Z')));
    await store.putEmbedding(RUN_A, p(sampleEmbedding('case', 'ollama/x', [1, 0])));
    await store.claimIdempotencyKey('key-a', RUN_A, 60_000);
    const before = fake.calls.length;

    expect(await store.deleteRun(RUN_A)).toBe(true);
    const own = fake.calls.slice(before);
    expect(own.map((c) => c.text)).toEqual(['BEGIN', SQL.deleteRun, SQL.dropKeysForRun, 'COMMIT']);
    expect(new Set(own.map((c) => c.on)).size).toBe(1);
    expect(own.every((c) => c.on !== 'pool')).toBe(true);
    // The cascade cleared every child row, the embedding rows included.
    expect(fake.counts()).toEqual({
      runs: 0,
      submissions: 0,
      evidence: 0,
      reports: 0,
      feedback: 0,
      idempotency: 0,
      embedding_models: 1,
      embeddings: 0,
    });
  });

  test('deleteRun rolls back as a whole when a statement fails', async () => {
    const fake = createFakePg({ failOn: (text) => text === SQL.dropKeysForRun });
    const store = createPostgresRunStore({ runner: fake.runner() });
    await store.createRun(RUN_A, p(sampleRequest(RUN_A)));
    await store.claimIdempotencyKey('key-a', RUN_A, 60_000);
    await expect(store.deleteRun(RUN_A)).rejects.toThrow('injected failure');
    expect(transactions(fake).at(-1)?.end).toBe('ROLLBACK');
    expect(await store.getRun(RUN_A)).not.toBeNull();
    expect(fake.counts().idempotency).toBe(1);
  });

  test('allocating writes run in a transaction that locks the run row first', async () => {
    const { fake, store } = setup();
    await store.createRun(RUN_A, p(sampleRequest(RUN_A)));
    const seq = await store.addSubmission(RUN_A, p({ kind: 'initial' as const }));
    await store.putEvidence(RUN_A, 'ssfb', p(sampleFindings('look')));
    await store.putReport(RUN_A, seq, p(sampleReport(RUN_A, 'answer')), p('# answer'));
    const txs = transactions(fake);
    expect(txs.map((t) => t.statements)).toEqual([
      [SQL.lockRun, SQL.nextSubmissionSeq, SQL.insertSubmission],
      [SQL.lockRun, SQL.nextEvidenceVersion, SQL.insertEvidence],
      [SQL.lockRun, SQL.upsertReport, SQL.latestReportSeq, SQL.setRunReport],
    ]);
    expect(SQL.lockRun).toEndWith('FOR UPDATE');
    expect(txs.every((t) => t.end === 'COMMIT')).toBe(true);
  });

  test('a failed write inside a transaction leaves nothing behind', async () => {
    const fake = createFakePg({ failOn: (text) => text === SQL.insertEvidence });
    const store = createPostgresRunStore({ runner: fake.runner() });
    await store.createRun(RUN_A, p(sampleRequest(RUN_A)));
    await expect(store.putEvidence(RUN_A, 'ssfb', p(sampleFindings('look')))).rejects.toThrow('injected failure');
    expect(fake.counts().evidence).toBe(0);
    expect(transactions(fake).at(-1)?.end).toBe('ROLLBACK');
  });

  test('putReport on an unknown run is RunNotFoundError; on an unknown submission a RunStoreError', async () => {
    const { store } = setup();
    await expect(store.putReport(RUN_B, 1, p(sampleReport(RUN_B, 'x')), p('# x'))).rejects.toThrow(RunNotFoundError);
    await store.createRun(RUN_A, p(sampleRequest(RUN_A)));
    const err = await store.putReport(RUN_A, 3, p(sampleReport(RUN_A, 'x')), p('# x')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunStoreError);
    expect(err).not.toBeInstanceOf(RunNotFoundError);
    expect(String(err)).toContain('submission 3 not found');
  });

  test('putClassification fills the summary columns used by listRuns', async () => {
    const { fake, store } = setup();
    await store.createRun(RUN_A, p(sampleRequest(RUN_A)));
    await store.putClassification(RUN_A, p({
      decision: {
        proposed: {
          category: 'transfer_out',
          subcategory: 'stuck',
          entities_likely: ['ssfb'],
          current_ask: 'why is the transfer stuck',
          money_moved: true,
          misdirected_funds: false,
          tier_proposed: 'mid',
          confidence: 0.8,
          matched_pattern_id: 'payout-stuck',
          missing_info: [],
          images_seen: false,
        },
        tier_final: 'strong',
        rule_fired: 'money_moved',
      },
      id_chain: { ids: {}, hops: [], basic_state: [] },
    }));
    const [call] = callsOf(fake, SQL.putClassification);
    expect(call?.params.slice(3)).toEqual(['transfer_out', 'stuck', 'mid', 'strong', 'money_moved', 'payout-stuck']);
    expect(JSON.parse(String(call?.params[2]))).toEqual({ ids: {}, hops: [], basic_state: [] });
  });
});

// ------------------------------------------------------------------ embedding tables

describe('postgres provider: per-model embedding tables', () => {
  test("sanitiseModelTable('ollama/nomic-embed-text') -> 'emb_ollama_nomic_embed_text'", () => {
    expect(sanitiseModelTable('ollama/nomic-embed-text')).toBe('emb_ollama_nomic_embed_text' as never);
    expect(sanitiseModelTable('openai/text_embedding_3_small')).toBe('emb_openai_text_embedding_3_small' as never);
  });

  test("sanitiseModelTable refuses 'x\"; drop', quotes, dots, spaces, semicolons and names over the cap", () => {
    const refused = [
      'x"; drop',
      'x"; DROP TABLE triage.runs; --',
      "ollama/o'brien",
      'ollama/nomic"embed',
      'ollama/nomic-embed-text:v1.5',
      'triage.runs',
      'ollama/nomic embed',
      'a;b',
      'ollama/Nomic',
      'ollama/nómic',
      'a\nb',
      '',
      'x'.repeat(MODEL_TABLE_MAX_LENGTH - 'emb_'.length + 1),
    ];
    for (const name of refused) {
      expect(() => sanitiseModelTable(name)).toThrow(InvalidModelTableError);
    }
    // The cap is inclusive.
    const longest = 'x'.repeat(MODEL_TABLE_MAX_LENGTH - 'emb_'.length);
    expect(sanitiseModelTable(longest)).toHaveLength(MODEL_TABLE_MAX_LENGTH);
    // The error does not echo the name.
    try {
      sanitiseModelTable('x"; drop');
    } catch (err) {
      expect(String(err)).not.toContain('drop');
    }
  });

  test('a refused model name sends no statement', async () => {
    const { fake, store } = setup();
    await store.createRun(RUN_A, p(sampleRequest(RUN_A)));
    const before = fake.calls.length;
    await expect(store.putEmbedding(RUN_A, p(sampleEmbedding('case', 'x"; drop', [1, 0])))).rejects.toThrow(
      InvalidModelTableError,
    );
    // Only the run check and the registry lookup ran; both carry the name as a parameter.
    const own = fake.calls.slice(before);
    expect(own.map((c) => c.text)).toEqual([SQL.runExists, SQL.embeddingModel]);
    for (const c of own) expect(c.text).not.toContain('drop');
    expect(fake.embeddingTables()).toEqual({});
  });

  test('first putEmbedding creates the table with the first vector dims and registers the model', async () => {
    const { fake, store } = setup();
    await store.createRun(RUN_A, p(sampleRequest(RUN_A)));
    await store.putEmbedding(RUN_A, p(sampleEmbedding('case', 'ollama/nomic-embed-text', [1, 0, 0])));
    expect(fake.embeddingTables()).toEqual({ emb_ollama_nomic_embed_text: 3 });
    const ddl = embeddingTableDdl(sanitiseModelTable('ollama/nomic-embed-text'), 3);
    expect(callsOf(fake, ddl)).toHaveLength(1);
    expect(ddl).toContain('run_id text NOT NULL REFERENCES triage.runs (run_id) ON DELETE CASCADE');
    expect(ddl).toContain('embedding vector(3) NOT NULL');
    expect(ddl).not.toMatch(/USING (hnsw|ivfflat)/i);
    const [register] = callsOf(fake, SQL.registerModel);
    expect(register?.params.slice(0, 3)).toEqual(['ollama/nomic-embed-text', 'emb_ollama_nomic_embed_text', 3]);
    // Registration and DDL share one transaction behind the advisory lock.
    const tx = transactions(fake).find((t) => t.statements.includes(ddl));
    expect(tx?.statements).toEqual([SQL.lockEmbeddingModels, SQL.embeddingModel, SQL.embeddingTableOwner, ddl, SQL.registerModel]);

    // A second model gets its own table.
    await store.putEmbedding(RUN_A, p(sampleEmbedding('case', 'openai/text-embedding-3-small', [1, 0])));
    expect(fake.embeddingTables()).toEqual({ emb_ollama_nomic_embed_text: 3, emb_openai_text_embedding_3_small: 2 });
    const run = await store.getRun(RUN_A);
    expect(run?.embeddings.map((e) => [e.model, e.dims]).sort()).toEqual([
      ['ollama/nomic-embed-text', 3],
      ['openai/text-embedding-3-small', 2],
    ]);
  });

  test('dims mismatch on second putEmbedding refused with a named error', async () => {
    const { fake, store } = setup();
    const model = 'ollama/nomic-embed-text';
    await store.createRun(RUN_A, p(sampleRequest(RUN_A)));
    await store.putEmbedding(RUN_A, p(sampleEmbedding('case', model, [1, 0, 0])));

    const err = await store.putEmbedding(RUN_A, p(sampleEmbedding('request', model, [1, 0], 1))).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmbeddingDimsMismatchError);
    expect(err).toBeInstanceOf(RunStoreError);
    expect((err as EmbeddingDimsMismatchError).name).toBe('EmbeddingDimsMismatchError');
    expect((err as EmbeddingDimsMismatchError).expected).toBe(3);
    expect((err as EmbeddingDimsMismatchError).got).toBe(2);

    // A longer vector is refused too, not truncated.
    await expect(store.putEmbedding(RUN_A, p(sampleEmbedding('request', model, [1, 0, 0, 0], 1)))).rejects.toThrow(
      EmbeddingDimsMismatchError,
    );
    // A new process reads the registered dims from the registry and refuses the same way.
    const fresh = createPostgresRunStore({ runner: fake.runner() });
    await expect(fresh.putEmbedding(RUN_A, p(sampleEmbedding('request', model, [1, 0], 1)))).rejects.toThrow(
      EmbeddingDimsMismatchError,
    );
    expect(fake.counts().embeddings).toBe(1);
    expect(fake.embeddingTables()).toEqual({ emb_ollama_nomic_embed_text: 3 });
  });

  test('two models that map to one table name are refused', async () => {
    const { store } = setup();
    await store.createRun(RUN_A, p(sampleRequest(RUN_A)));
    await store.putEmbedding(RUN_A, p(sampleEmbedding('case', 'ollama/a-b', [1, 0])));
    await expect(store.putEmbedding(RUN_A, p(sampleEmbedding('case', 'ollama/a_b', [1, 0])))).rejects.toThrow(
      InvalidModelTableError,
    );
  });

  test('putEmbedding on an unknown run registers no model', async () => {
    const { fake, store } = setup();
    await expect(store.putEmbedding(RUN_B, p(sampleEmbedding('case', 'ollama/x', [1, 0])))).rejects.toThrow(
      RunNotFoundError,
    );
    expect(fake.counts().embedding_models).toBe(0);
    expect(fake.embeddingTables()).toEqual({});
  });

  test('embeddingSql and embeddingTableDdl re-check the table name and dims', () => {
    expect(() => embeddingSql('emb_x"; drop' as never)).toThrow(InvalidModelTableError);
    expect(() => embeddingSql('runs' as never)).toThrow(InvalidModelTableError);
    const t = sanitiseModelTable('ollama/x');
    for (const dims of [0, -1, 1.5, Number.NaN, 16_001]) expect(() => embeddingTableDdl(t, dims)).toThrow(RunStoreError);
  });
});

// ------------------------------------------------------------------ write checks

describe('postgres provider: persisted re-scan before every write', () => {
  test('a tampered value is refused before any statement is sent', async () => {
    const { fake, store } = setup();
    await store.createRun(RUN_A, p(sampleRequest(RUN_A)));
    const seq = await store.addSubmission(RUN_A, p({ kind: 'initial' as const }));
    const before = fake.calls.length;

    const findings = redactPersisted(sampleFindings('ok'));
    findings.value.evidence[0]!.summary = `call ${SYNTHETIC_PHONE}`;
    await expect(store.putEvidence(RUN_A, 'ssfb', findings)).rejects.toThrow(RunStoreRedactionError);

    const report = redactPersisted(sampleReport(RUN_A, 'ok'));
    report.value.cx_answer.reply_text = `call ${SYNTHETIC_PHONE}`;
    await expect(store.putReport(RUN_A, seq, report, p('# ok'))).rejects.toThrow(RunStoreRedactionError);

    const request = redactPersisted(sampleRequest(RUN_B));
    request.value.messages[0]!.text = `call ${SYNTHETIC_PHONE}`;
    await expect(store.createRun(RUN_B, request)).rejects.toThrow(RunStoreRedactionError);

    const embedding = redactPersisted(sampleEmbedding('case', 'ollama/x', [1, 0]));
    embedding.value.source_text = `call ${SYNTHETIC_PHONE}`;
    await expect(store.putEmbedding(RUN_A, embedding)).rejects.toThrow(RunStoreRedactionError);

    await expect(store.setPhase(RUN_A, 'failed', { reason: `call ${SYNTHETIC_PHONE}` })).rejects.toThrow(
      RunStoreRedactionError,
    );
    await expect(
      store.putEvidence(RUN_A, 'ssfb', sampleFindings('raw') as unknown as Persisted<ReturnType<typeof sampleFindings>>),
    ).rejects.toThrow(RunStoreError);

    expect(fake.calls.slice(before)).toEqual([]);
  });
});

// ------------------------------------------------------------------ parameterisation

describe('postgres provider: every statement is parameterised', () => {
  test('no value from a workload appears in any statement text, and param counts match', async () => {
    const { fake, store } = setup();
    const model = 'ollama/nomic-embed-text';
    for (const id of [RUN_A, RUN_B]) await store.createRun(id, p(sampleRequest(id)));
    const seq = await store.addSubmission(RUN_A, p({ kind: 'ask' as const, question: 'was the refund sent?' }));
    await store.putReport(RUN_A, seq, p(sampleReport(RUN_A, 'the refund landed')), p('# the refund landed'));
    await store.putEvidence(RUN_A, 'ssfb', p(sampleFindings('look')));
    await store.putFeedback(RUN_A, p(sampleFeedback('partial', '2026-09-01T10:00:00.000Z')), p('# fb'));
    await store.setPhase(RUN_A, 'failed', { reason: 'AgentRunError', worker_pid: 4242 });
    await store.putEmbedding(RUN_A, p(sampleEmbedding('request', model, [1, 0], seq)));
    await store.claimIdempotencyKey('key-a', RUN_A, 60_000);
    await store.findSimilar({ vector: [1, 0], model, excludeRunId: RUN_B });
    await store.getRun(RUN_A);
    await store.listRuns({ phase: 'failed', category: 'transfer_out', since: new Date(0), limit: 5 });
    await store.listExpired(new Date());
    await store.deleteRun(RUN_B);

    const values = [RUN_A, RUN_B, 'was the refund sent?', 'AgentRunError', 'the refund landed', 'look', 'key-a', 'partial', model];
    const statements = fake.calls.filter((c) => !['BEGIN', 'COMMIT', 'ROLLBACK'].includes(c.text));
    expect(statements.length).toBeGreaterThan(20);
    for (const c of statements) {
      for (const value of values) expect(c.text.includes(value)).toBe(false);
      // No quoted literal carries a value into the text.
      expect(c.text).not.toMatch(/'[^']*'/);
      const highest = Math.max(0, ...[...c.text.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
      expect(c.params.length).toBe(highest);
    }
  });

  test('every statement parses as Postgres SQL', async () => {
    await loadModule();
    const t = sanitiseModelTable('ollama/nomic-embed-text');
    const texts = [...Object.values(SQL), embeddingTableDdl(t, 768), ...Object.values(embeddingSql(t))];
    for (const text of texts) {
      const parsed = parseSync(text) as { stmts?: unknown[] };
      expect(parsed.stmts?.length).toBe(1);
    }
  });
});

// ------------------------------------------------------------------ source check

const SOURCE = readFileSync(fileURLToPath(new URL('./postgres.ts', import.meta.url)), 'utf8');

const SQL_WORD = /\b(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|FROM|WHERE|VALUES|ORDER BY|LIMIT|SET)\b/;
// The only interpolations allowed inside SQL: the re-checked table name and the checked dims.
const ALLOWED_INTERPOLATIONS = new Set(['t', 'dims']);

/** Problems with how SQL text is built in a source file. */
function sqlBuildProblems(source: string): string[] {
  const problems: string[] = [];
  // Comments may mention SQL words; they are not code.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  for (const m of code.matchAll(/`((?:[^`\\]|\\.)*)`/g)) {
    const body = m[1] as string;
    if (!SQL_WORD.test(body)) continue;
    for (const i of body.matchAll(/\$\{([^}]*)\}/g)) {
      const expr = (i[1] as string).trim();
      if (!ALLOWED_INTERPOLATIONS.has(expr)) problems.push(`interpolation \${${expr}} in SQL`);
    }
  }
  // String concatenation next to a SQL-looking literal, in either order.
  const literal = String.raw`(?:'[^'\n]*'|"[^"\n]*"|\x60[^\x60]*\x60)`;
  for (const m of code.matchAll(new RegExp(String.raw`(${literal})\s*\+|\+\s*(${literal})`, 'g'))) {
    const text = (m[1] ?? m[2]) as string;
    if (SQL_WORD.test(text)) problems.push(`concatenation with ${text.slice(0, 40)}`);
  }
  return problems;
}

describe('postgres provider: source check', () => {
  test('grep test: postgres.ts has no string concatenation into SQL other than the sanitised table name', () => {
    expect(sqlBuildProblems(SOURCE)).toEqual([]);
    // Every interpolation that does appear in SQL is the re-checked table or the checked dims.
    expect(SOURCE).toContain('const t = tableIdent(table);');
    expect(SOURCE).toContain('const dims = checkDims(dimensions);');
    // Time comes from the injected clock, never from the database.
    for (const text of Object.values(SQL)) expect(text).not.toMatch(/\bnow\(\)/i);
  });

  test('the checker flags interpolated values and concatenated SQL', () => {
    const bad = [
      "const q = `SELECT * FROM triage.runs WHERE run_id = '${runId}'`;",
      "const q = 'SELECT * FROM triage.runs WHERE run_id = ' + runId;",
      'const q = prefix + "DELETE FROM triage.runs";',
      'const q = `UPDATE triage.runs SET phase = ${phase}`;',
    ];
    for (const source of bad) expect(sqlBuildProblems(source).length).toBeGreaterThan(0);
    const good = [
      'const q = `INSERT INTO triage.${t} (run_id) VALUES ($1)`;',
      "const msg = `submission ${seq} not found`;",
      "const q = 'SELECT run_id FROM triage.runs WHERE run_id = $1';",
    ];
    for (const source of good) expect(sqlBuildProblems(source)).toEqual([]);
  });
});
