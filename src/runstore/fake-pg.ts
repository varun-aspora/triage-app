// An in-memory stand-in for Postgres, for run store tests. No socket is
// opened and no database is needed.
//
// It is a pg pool (PgPoolLike), so tests build the real runner from
// src/db/pg.ts over it and BEGIN, COMMIT and ROLLBACK come from production
// code. It understands exactly the statements the postgres provider and the
// migrator issue, matched by their full text, and throws on anything else, so
// a changed statement cannot pass silently. Each call is checked the way
// Postgres would: the parameter count must match the highest $n, parameters
// must be plain values, and casts (::timestamptz, ::jsonb, ::vector) must
// parse. Primary keys, unique columns and CHECK constraints are enforced.
// Foreign keys are not, and nothing cascades, because the run store has
// neither (D60): an insert for a run or submission that does not exist is
// stored as asked, and a DELETE removes rows from its own table only, so a
// test sees exactly what the provider's own checks and deletes do.
//
// Transactions are serialised by one lock, which stands in for the row and
// advisory locks the real statements take. A ROLLBACK restores the state
// from before BEGIN. Every call is recorded for tests to inspect.

import type { PostgresParameter } from '@flue/postgres';
import { createPgRunner, type PgClientLike, type PgPoolLike, type PgRunner, type PoolFactory } from '../db/pg.ts';
import { embeddingSql, embeddingTableDdl, SQL, type ModelTable } from './postgres.ts';

// ------------------------------------------------------------------ state

type RunRow = {
  run_id: string;
  schema_version: number;
  created_at: Date;
  updated_at: Date;
  phase: string;
  phase_reason: string | null;
  worker_pid: number | null;
  category: string | null;
  subcategory: string | null;
  tier_proposed: string | null;
  tier_final: string | null;
  rule_fired: string | null;
  matched_pattern_id: string | null;
  report_status: string | null;
  escalated: boolean | null;
  request: unknown;
  classification: unknown;
  id_chain: unknown;
  input_request: unknown;
  input_history: unknown[];
  block: unknown;
  block_history: unknown[];
};

type EmbRow = {
  run_id: string;
  submission_seq: number;
  kind: string;
  text_sha256: string;
  source_text: string;
  embedding: number[];
  created_at: Date;
};

type UsageRow = {
  run_id: string;
  seq: number;
  model: string;
  agent: string;
  purpose: string;
  calls: number;
  failed_calls: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  usd: number | null;
  final: boolean;
  updated_at: Date;
};

type State = {
  migrated: boolean;
  /** 0002_submission_flue_id.sql has run: triage.submissions has flue_submission_id (D71). */
  flueIdColumn: boolean;
  /** 0003_submission_trace_span.sql has run: triage.submissions has trace_span_id (D82). */
  traceSpanColumn: boolean;
  versions: string[];
  runs: Map<string, RunRow>;
  submissions: {
    run_id: string;
    seq: number;
    kind: string;
    question: string | null;
    created_at: Date;
    question_id: string | null;
    answer: string | null;
    block_id: string | null;
    note: string | null;
    flue_submission_id: string | null;
    trace_span_id: string | null;
  }[];
  evidence: { run_id: string; key: string; version: number; findings: unknown; created_at: Date }[];
  reports: { run_id: string; seq: number; report: unknown; report_md: string; created_at: Date }[];
  feedback: {
    id: number;
    run_id: string;
    verdict: string;
    given_by: string;
    given_at: Date;
    body: unknown;
    body_md: string | null;
  }[];
  nextFeedbackId: number;
  idempotency: Map<string, { run_id: string; expires_at: Date }>;
  models: Map<string, { model: string; table_name: string; dims: number; created_at: Date }>;
  emb: Map<string, { dims: number; rows: EmbRow[] }>;
  usage: UsageRow[];
};

function emptyState(migrated: boolean): State {
  return {
    migrated,
    flueIdColumn: migrated,
    traceSpanColumn: migrated,
    versions: [],
    runs: new Map(),
    submissions: [],
    evidence: [],
    reports: [],
    feedback: [],
    nextFeedbackId: 1,
    idempotency: new Map(),
    models: new Map(),
    emb: new Map(),
    usage: [],
  };
}

// ------------------------------------------------------------------ errors

/** A Postgres-style error with its SQLSTATE code. */
export class FakePgError extends Error {
  override name = 'FakePgError';
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const unique = (what: string) => new FakePgError('23505', `duplicate key value violates unique constraint on ${what}`);
const missingRelation = (name: string) => new FakePgError('42P01', `relation "${name}" does not exist`);
const missingColumn = (name: string) => new FakePgError('42703', `column "${name}" does not exist`);

// ------------------------------------------------------------------ parameters

type Param = PostgresParameter;

function isParam(value: unknown): value is Param {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value instanceof Uint8Array
  );
}

function highestPlaceholder(text: string): number {
  let max = 0;
  for (const m of text.matchAll(/\$(\d+)/g)) max = Math.max(max, Number(m[1]));
  return max;
}

function str(p: Param | undefined, label: string): string {
  if (typeof p !== 'string') throw new FakePgError('22P02', `${label}: expected text, got ${typeof p}`);
  return p;
}

function strOrNull(p: Param | undefined, label: string): string | null {
  return p === null ? null : str(p, label);
}

function int(p: Param | undefined, label: string): number {
  const n = typeof p === 'string' && /^-?\d+$/.test(p) ? Number(p) : p;
  if (typeof n !== 'number' || !Number.isSafeInteger(n)) throw new FakePgError('22P02', `${label}: expected integer`);
  return n;
}

function intOrNull(p: Param | undefined, label: string): number | null {
  return p === null ? null : int(p, label);
}

function ts(p: Param | undefined, label: string): Date {
  const d = new Date(str(p, label));
  if (Number.isNaN(d.getTime())) throw new FakePgError('22007', `${label}: invalid timestamptz`);
  return d;
}

function tsOrNull(p: Param | undefined, label: string): Date | null {
  return p === null ? null : ts(p, label);
}

function jsonb(p: Param | undefined, label: string): unknown {
  try {
    return JSON.parse(str(p, label)) as unknown;
  } catch (err) {
    if (err instanceof FakePgError) throw err;
    throw new FakePgError('22P02', `${label}: invalid input syntax for type json`);
  }
}

function vector(p: Param | undefined, label: string): number[] {
  const text = str(p, label);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every((x) => typeof x === 'number' && Number.isFinite(x))) {
    throw new FakePgError('22P02', `${label}: invalid input syntax for type vector`);
  }
  return parsed as number[];
}

/** double precision: a number, or its text form. */
function floatOrNull(p: Param | undefined, label: string): number | null {
  if (p === null) return null;
  const n = typeof p === 'string' ? Number(p) : p;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new FakePgError('22P02', `${label}: expected double precision`);
  return n;
}

/** Postgres integer: a checked int that fits in 32 bits. */
function int4(p: Param | undefined, label: string): number {
  const n = int(p, label);
  if (n < -2_147_483_648 || n > 2_147_483_647) throw new FakePgError('22003', `${label}: integer out of range`);
  return n;
}

/** jsonb_array_elements_text($n::jsonb): a JSON array of text. */
function textArray(p: Param | undefined, label: string): string[] {
  const value = jsonb(p, label);
  if (!Array.isArray(value) || !value.every((x) => typeof x === 'string')) {
    throw new FakePgError('22023', `${label}: expected a JSON array of text`);
  }
  return value;
}

function bool(p: Param | undefined, label: string): boolean {
  if (typeof p !== 'boolean') throw new FakePgError('22P02', `${label}: expected boolean`);
  return p;
}

const clone = <T>(value: T): T => structuredClone(value);

// ------------------------------------------------------------------ vectors

/** pgvector's <=> operator. NaN when either vector has zero length. */
function cosineDistance(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) throw new FakePgError('22000', `different vector dimensions ${a.length} and ${b.length}`);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return Number.NaN;
  return 1 - dot / Math.sqrt(na * nb);
}

/** Postgres sorts NaN above every number. */
function compareFloat(a: number, b: number): number {
  if (Number.isNaN(a)) return Number.isNaN(b) ? 0 : 1;
  if (Number.isNaN(b)) return -1;
  return a - b;
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// ------------------------------------------------------------------ statements

type Handler = (p: readonly Param[], db: State) => Record<string, unknown>[];

// The migrator's own statements, kept in step with src/runstore/migrate.ts.
const MIGRATOR = {
  lock: 'SELECT pg_advisory_xact_lock(7426150093)',
  schema: 'CREATE SCHEMA IF NOT EXISTS triage',
  versions: 'SELECT version FROM triage.schema_migrations',
  one: 'SELECT version FROM triage.schema_migrations WHERE version = $1',
  record: 'INSERT INTO triage.schema_migrations (version) VALUES ($1)',
} as const;

function runRow(db: State, id: string): RunRow | undefined {
  return db.runs.get(id);
}

const storeHandlers: Record<keyof typeof SQL, Handler> = {
  createRun(p, db) {
    const id = str(p[0], 'run_id');
    if (db.runs.has(id)) return [];
    const at = ts(p[2], 'created_at');
    db.runs.set(id, {
      run_id: id,
      schema_version: int(p[1], 'schema_version'),
      created_at: at,
      updated_at: at,
      phase: str(p[3], 'phase'),
      phase_reason: null,
      worker_pid: null,
      category: null,
      subcategory: null,
      tier_proposed: null,
      tier_final: null,
      rule_fired: null,
      matched_pattern_id: null,
      report_status: null,
      escalated: null,
      request: jsonb(p[4], 'request'),
      classification: null,
      id_chain: null,
      input_request: null,
      input_history: [],
      block: null,
      block_history: [],
    });
    return [];
  },
  lockRun(p, db) {
    const id = str(p[0], 'run_id');
    return db.runs.has(id) ? [{ run_id: id }] : [];
  },
  runExists(p, db) {
    const id = str(p[0], 'run_id');
    return db.runs.has(id) ? [{ run_id: id }] : [];
  },
  shareRun(p, db) {
    const id = str(p[0], 'run_id');
    return db.runs.has(id) ? [{ run_id: id }] : [];
  },
  setPhase(p, db) {
    const row = runRow(db, str(p[0], 'run_id'));
    if (!row) return [];
    if (row.phase === str(p[6], 'stopped') && bool(p[5], 'resume') !== true) return [];
    row.phase = str(p[1], 'phase');
    row.phase_reason = strOrNull(p[2], 'phase_reason');
    row.worker_pid = bool(p[7], 'pid_given') ? intOrNull(p[3], 'worker_pid') : row.worker_pid;
    row.updated_at = ts(p[4], 'updated_at');
    return [{ run_id: row.run_id }];
  },
  setPhaseIf(p, db) {
    const row = runRow(db, str(p[0], 'run_id'));
    if (!row) return [];
    if (!textArray(p[5], 'from_phases').includes(row.phase)) return [];
    row.phase = str(p[1], 'phase');
    row.phase_reason = strOrNull(p[2], 'phase_reason');
    row.worker_pid = bool(p[6], 'pid_given') ? intOrNull(p[3], 'worker_pid') : row.worker_pid;
    row.updated_at = ts(p[4], 'updated_at');
    return [{ run_id: row.run_id }];
  },
  putClassification(p, db) {
    const row = runRow(db, str(p[0], 'run_id'));
    if (!row) return [];
    row.classification = jsonb(p[1], 'classification');
    row.id_chain = jsonb(p[2], 'id_chain');
    row.category = strOrNull(p[3], 'category');
    row.subcategory = strOrNull(p[4], 'subcategory');
    row.tier_proposed = strOrNull(p[5], 'tier_proposed');
    row.tier_final = strOrNull(p[6], 'tier_final');
    row.rule_fired = strOrNull(p[7], 'rule_fired');
    row.matched_pattern_id = strOrNull(p[8], 'matched_pattern_id');
    return [{ run_id: row.run_id }];
  },
  putInputRequest(p, db) {
    const row = runRow(db, str(p[0], 'run_id'));
    if (!row || row.input_request !== null || row.phase === 'stopped') return [];
    row.input_request = jsonb(p[1], 'input_request');
    row.phase = 'needs_input';
    row.phase_reason = null;
    row.updated_at = ts(p[2], 'updated_at');
    return [{ run_id: row.run_id }];
  },
  resolveInputRequest(p, db) {
    const row = runRow(db, str(p[0], 'run_id'));
    if (!row) return [];
    const open = row.input_request as { question_id?: unknown } | null;
    if (open === null || open.question_id !== str(p[1], 'question_id')) return [];
    row.input_history = [...row.input_history, { ...open, ...(jsonb(p[2], 'resolution') as object) }];
    row.input_request = null;
    row.updated_at = ts(p[3], 'updated_at');
    return [{ run_id: row.run_id }];
  },
  putBlock(p, db) {
    const row = runRow(db, str(p[0], 'run_id'));
    if (!row || row.block !== null || row.input_request !== null || row.phase === 'stopped') return [];
    row.block = jsonb(p[1], 'block');
    row.phase = 'blocked';
    row.phase_reason = null;
    row.updated_at = ts(p[2], 'updated_at');
    return [{ run_id: row.run_id }];
  },
  resolveBlock(p, db) {
    const row = runRow(db, str(p[0], 'run_id'));
    if (!row) return [];
    const open = row.block as { block_id?: unknown } | null;
    if (open === null || open.block_id !== str(p[1], 'block_id')) return [];
    row.block_history = [...row.block_history, { ...open, ...(jsonb(p[2], 'resolution') as object) }];
    row.block = null;
    row.updated_at = ts(p[3], 'updated_at');
    return [{ run_id: row.run_id }];
  },
  phaseForUpdate(p, db) {
    const row = runRow(db, str(p[0], 'run_id'));
    return row ? [{ phase: row.phase }] : [];
  },
  markStopped(p, db) {
    const row = runRow(db, str(p[0], 'run_id'));
    if (!row) return [];
    row.phase = str(p[4], 'phase');
    row.phase_reason = str(p[1], 'phase_reason');
    row.updated_at = ts(p[2], 'updated_at');
    if (row.input_request !== null) {
      row.input_history = [...row.input_history, { ...(row.input_request as object), ...(jsonb(p[3], 'resolution') as object) }];
      row.input_request = null;
    }
    if (row.block !== null) {
      row.block_history = [...row.block_history, { ...(row.block as object), ...(jsonb(p[5], 'block resolution') as object) }];
      row.block = null;
    }
    return [{ run_id: row.run_id }];
  },
  nextSubmissionSeq(p, db) {
    const id = str(p[0], 'run_id');
    const max = db.submissions.filter((s) => s.run_id === id).reduce((m, s) => Math.max(m, s.seq), 0);
    return [{ seq: max + 1 }];
  },
  insertSubmission(p, db) {
    const id = str(p[0], 'run_id');
    const seq = int(p[1], 'seq');
    if (seq < 1) throw new FakePgError('23514', 'submissions.seq check failed');
    if (db.submissions.some((s) => s.run_id === id && s.seq === seq)) throw unique('submissions_pkey');
    db.submissions.push({
      run_id: id,
      seq,
      kind: str(p[2], 'kind'),
      question: strOrNull(p[3], 'question'),
      created_at: ts(p[4], 'created_at'),
      question_id: strOrNull(p[5], 'question_id'),
      answer: strOrNull(p[6], 'answer'),
      block_id: strOrNull(p[7], 'block_id'),
      note: strOrNull(p[8], 'note'),
      flue_submission_id: null,
      trace_span_id: null,
    });
    return [];
  },
  setSubmissionFlueId(p, db) {
    if (!db.flueIdColumn) throw missingColumn('flue_submission_id');
    const id = str(p[0], 'run_id');
    const seq = int(p[1], 'seq');
    const row = db.submissions.find((s) => s.run_id === id && s.seq === seq);
    if (!row) return [];
    row.flue_submission_id = str(p[2], 'flue_submission_id');
    return [{ seq }];
  },
  setSubmissionTraceSpanId(p, db) {
    if (!db.traceSpanColumn) throw missingColumn('trace_span_id');
    const id = str(p[0], 'run_id');
    const seq = int(p[1], 'seq');
    const row = db.submissions.find((s) => s.run_id === id && s.seq === seq);
    if (!row) return [];
    row.trace_span_id = str(p[2], 'trace_span_id');
    return [{ seq }];
  },
  nextEvidenceVersion(p, db) {
    const id = str(p[0], 'run_id');
    const key = str(p[1], 'key');
    const max = db.evidence.filter((e) => e.run_id === id && e.key === key).reduce((m, e) => Math.max(m, e.version), 0);
    return [{ version: max + 1 }];
  },
  insertEvidence(p, db) {
    const id = str(p[0], 'run_id');
    const key = str(p[1], 'key');
    const version = int(p[2], 'version');
    if (db.evidence.some((e) => e.run_id === id && e.key === key && e.version === version)) throw unique('evidence_pkey');
    db.evidence.push({ run_id: id, key, version, findings: jsonb(p[3], 'findings'), created_at: ts(p[4], 'created_at') });
    return [];
  },
  upsertReport(p, db) {
    const id = str(p[0], 'run_id');
    const seq = int(p[1], 'seq');
    if (!db.submissions.some((s) => s.run_id === id && s.seq === seq)) return [];
    const report = jsonb(p[2], 'report');
    const md = str(p[3], 'report_md');
    const at = ts(p[4], 'created_at');
    const existing = db.reports.find((r) => r.run_id === id && r.seq === seq);
    if (existing) Object.assign(existing, { report, report_md: md, created_at: at });
    else db.reports.push({ run_id: id, seq, report, report_md: md, created_at: at });
    return [{ seq }];
  },
  latestReportSeq(p, db) {
    const id = str(p[0], 'run_id');
    const seqs = db.reports.filter((r) => r.run_id === id).map((r) => r.seq);
    return [{ seq: seqs.length === 0 ? null : Math.max(...seqs) }];
  },
  setRunReport(p, db) {
    const row = runRow(db, str(p[0], 'run_id'));
    if (row) {
      row.report_status = strOrNull(p[1], 'report_status');
      row.escalated = bool(p[2], 'escalated');
    }
    return [];
  },
  insertFeedback(p, db) {
    db.feedback.push({
      id: db.nextFeedbackId++,
      run_id: str(p[0], 'run_id'),
      verdict: str(p[1], 'verdict'),
      given_by: str(p[2], 'given_by'),
      given_at: ts(p[3], 'given_at'),
      body: jsonb(p[4], 'body'),
      body_md: strOrNull(p[5], 'body_md'),
    });
    return [];
  },
  claimKey(p, db) {
    const hash = str(p[0], 'key_sha256');
    const runId = str(p[1], 'run_id');
    const expires = ts(p[2], 'expires_at');
    const now = ts(p[3], 'now');
    const held = db.idempotency.get(hash);
    if (held && held.expires_at.getTime() > now.getTime()) return [];
    db.idempotency.set(hash, { run_id: runId, expires_at: expires });
    return [{ run_id: runId }];
  },
  heldKey(p, db) {
    const held = db.idempotency.get(str(p[0], 'key_sha256'));
    return held ? [{ run_id: held.run_id, expires_at: new Date(held.expires_at) }] : [];
  },
  clearExpiredKeys(p, db) {
    const now = ts(p[0], 'now').getTime();
    const out: Record<string, unknown>[] = [];
    for (const [hash, held] of [...db.idempotency]) {
      if (held.expires_at.getTime() <= now) {
        db.idempotency.delete(hash);
        out.push({ key_sha256: hash });
      }
    }
    return out;
  },
  dropKeysForRun(p, db) {
    const id = str(p[0], 'run_id');
    for (const [hash, held] of [...db.idempotency]) if (held.run_id === id) db.idempotency.delete(hash);
    return [];
  },
  getRun(p, db) {
    const row = runRow(db, str(p[0], 'run_id'));
    if (!row) return [];
    return [
      clone({
        run_id: row.run_id,
        schema_version: row.schema_version,
        created_at: row.created_at,
        updated_at: row.updated_at,
        phase: row.phase,
        phase_reason: row.phase_reason,
        worker_pid: row.worker_pid,
        request: row.request,
        classification: row.classification,
        input_request: row.input_request,
        input_history: row.input_history,
        block: row.block,
        block_history: row.block_history,
      }),
    ];
  },
  latestEvidence(p, db) {
    const id = str(p[0], 'run_id');
    const latest = new Map<string, State['evidence'][number]>();
    for (const e of db.evidence) {
      if (e.run_id !== id) continue;
      const cur = latest.get(e.key);
      if (!cur || e.version > cur.version) latest.set(e.key, e);
    }
    return [...latest.values()]
      .sort((a, b) => byText(a.key, b.key))
      .map((e) => clone({ key: e.key, version: e.version, findings: e.findings }));
  },
  submissions(p, db) {
    if (!db.flueIdColumn) throw missingColumn('s.flue_submission_id');
    if (!db.traceSpanColumn) throw missingColumn('s.trace_span_id');
    const id = str(p[0], 'run_id');
    return db.submissions
      .filter((s) => s.run_id === id)
      .sort((a, b) => a.seq - b.seq)
      .map((s) => {
        const r = db.reports.find((x) => x.run_id === id && x.seq === s.seq);
        return clone({
          seq: s.seq,
          kind: s.kind,
          question: s.question,
          question_id: s.question_id,
          answer: s.answer,
          block_id: s.block_id,
          note: s.note,
          created_at: s.created_at,
          flue_submission_id: s.flue_submission_id,
          trace_span_id: s.trace_span_id,
          report: r?.report ?? null,
          report_md: r?.report_md ?? null,
        });
      });
  },
  feedback(p, db) {
    const id = str(p[0], 'run_id');
    return db.feedback
      .filter((f) => f.run_id === id)
      .sort((a, b) => a.id - b.id)
      .map((f) => clone({ body: f.body }));
  },
  listRuns(p, db) {
    if (!db.flueIdColumn) throw missingColumn('s.flue_submission_id');
    const since = tsOrNull(p[0], 'since');
    const phase = strOrNull(p[1], 'phase');
    const category = strOrNull(p[2], 'category');
    const limit = intOrNull(p[3], 'limit');
    const working = textArray(p[4], 'working_phases');
    const steerKind = str(p[5], 'steer_kind');
    const rows = [...db.runs.values()]
      .filter((r) => since === null || r.created_at.getTime() >= since.getTime())
      .filter((r) => phase === null || r.phase === phase)
      .filter((r) => category === null || r.category === category)
      .sort((a, b) => b.created_at.getTime() - a.created_at.getTime() || byText(b.run_id, a.run_id));
    return (limit === null ? rows : rows.slice(0, limit)).map((r) => {
      const latest = db.feedback.filter((f) => f.run_id === r.run_id).sort((a, b) => b.id - a.id)[0];
      const usage = db.usage.filter((u) => u.run_id === r.run_id);
      const priced = usage.filter((u) => u.usd !== null);
      return {
        run_id: r.run_id,
        created_at: new Date(r.created_at),
        updated_at: new Date(r.updated_at),
        phase: r.phase,
        category: r.category,
        tier_final: r.tier_final,
        report_status: r.report_status,
        // COUNT(*) is bigint, which pg returns as text.
        submissions: String(db.submissions.filter((s) => s.run_id === r.run_id).length),
        feedback_verdict: latest?.verdict ?? null,
        // SUM over no non-null value is null; double precision comes back as a number.
        usd_total: priced.length === 0 ? null : priced.reduce((sum, u) => sum + (u.usd as number), 0),
        // SUM(...)::bigint, which pg returns as text.
        tokens_total:
          usage.length === 0
            ? null
            : String(
                usage.reduce((sum, u) => sum + u.input_tokens + u.output_tokens + u.cache_read_tokens + u.cache_write_tokens, 0),
              ),
        // EXISTS gives a boolean.
        usd_unpriced: usage.some((u) => u.usd === null),
        ...stalledInputs(db, r, working, steerKind),
      };
    });
  },
  listExpired(p, db) {
    const before = ts(p[0], 'before').getTime();
    return [...db.runs.values()]
      .filter((r) => r.created_at.getTime() < before)
      .sort((a, b) => a.created_at.getTime() - b.created_at.getTime() || byText(a.run_id, b.run_id))
      .map((r) => ({ run_id: r.run_id }));
  },
  deleteRun(p, db) {
    const id = str(p[0], 'run_id');
    // The run row only: nothing cascades.
    return db.runs.delete(id) ? [{ run_id: id }] : [];
  },
  deleteSubmissions(p, db) {
    const id = str(p[0], 'run_id');
    db.submissions = db.submissions.filter((s) => s.run_id !== id);
    return [];
  },
  deleteEvidence(p, db) {
    const id = str(p[0], 'run_id');
    db.evidence = db.evidence.filter((e) => e.run_id !== id);
    return [];
  },
  deleteReports(p, db) {
    const id = str(p[0], 'run_id');
    db.reports = db.reports.filter((r) => r.run_id !== id);
    return [];
  },
  deleteFeedback(p, db) {
    const id = str(p[0], 'run_id');
    db.feedback = db.feedback.filter((f) => f.run_id !== id);
    return [];
  },
  deleteRunUsage(p, db) {
    const id = str(p[0], 'run_id');
    db.usage = db.usage.filter((u) => u.run_id !== id);
    return [];
  },
  usageFinal(p, db) {
    const id = str(p[0], 'run_id');
    const seq = int(p[1], 'seq');
    return db.usage.some((u) => u.run_id === id && u.seq === seq && u.final) ? [{ '?column?': 1 }] : [];
  },
  deleteUsage(p, db) {
    const id = str(p[0], 'run_id');
    const seq = int(p[1], 'seq');
    db.usage = db.usage.filter((u) => !(u.run_id === id && u.seq === seq));
    return [];
  },
  insertUsage(p, db) {
    const id = str(p[0], 'run_id');
    const row: UsageRow = {
      run_id: id,
      seq: int4(p[1], 'seq'),
      model: str(p[2], 'model'),
      agent: str(p[3], 'agent'),
      purpose: str(p[4], 'purpose'),
      calls: int4(p[5], 'calls'),
      failed_calls: int4(p[6], 'failed_calls'),
      input_tokens: int4(p[7], 'input_tokens'),
      output_tokens: int4(p[8], 'output_tokens'),
      cache_read_tokens: int4(p[9], 'cache_read_tokens'),
      cache_write_tokens: int4(p[10], 'cache_write_tokens'),
      usd: floatOrNull(p[11], 'usd'),
      final: bool(p[12], 'final'),
      updated_at: ts(p[13], 'updated_at'),
    };
    if (row.seq < 0) throw new FakePgError('23514', 'run_usage.seq check failed');
    if (
      db.usage.some(
        (u) => u.run_id === id && u.seq === row.seq && u.model === row.model && u.agent === row.agent && u.purpose === row.purpose,
      )
    ) {
      throw unique('run_usage_pkey');
    }
    db.usage.push(row);
    return [];
  },
  usage(p, db) {
    const id = str(p[0], 'run_id');
    return db.usage
      .filter((u) => u.run_id === id)
      .sort((a, b) => a.seq - b.seq || byText(a.model, b.model) || byText(a.agent, b.agent) || byText(a.purpose, b.purpose))
      .map(({ run_id: _run, ...u }) => clone(u));
  },
  lockEmbeddingModels() {
    return [{ pg_advisory_xact_lock: '' }];
  },
  embeddingModels(_p, db) {
    return [...db.models.values()]
      .sort((a, b) => byText(a.model, b.model))
      .map((m) => ({ model: m.model, table_name: m.table_name, dims: m.dims }));
  },
  embeddingModel(p, db) {
    const m = db.models.get(str(p[0], 'model'));
    return m ? [{ model: m.model, table_name: m.table_name, dims: m.dims }] : [];
  },
  embeddingTableOwner(p, db) {
    const table = str(p[0], 'table_name');
    return [...db.models.values()].filter((m) => m.table_name === table).map((m) => ({ model: m.model }));
  },
  registerModel(p, db) {
    const model = str(p[0], 'model');
    const table = str(p[1], 'table_name');
    if (db.models.has(model)) throw unique('embedding_models_pkey');
    if ([...db.models.values()].some((m) => m.table_name === table)) throw unique('embedding_models_table_name_key');
    const dims = int(p[2], 'dims');
    if (dims < 1) throw new FakePgError('23514', 'embedding_models.dims check failed');
    db.models.set(model, { model, table_name: table, dims, created_at: ts(p[3], 'created_at') });
    return [];
  },
};

const STATIC = new Map<string, Handler>(
  (Object.keys(SQL) as (keyof typeof SQL)[]).map((name) => [SQL[name], storeHandlers[name]]),
);

// ---------------------------------------------------------------- per-model tables

const DDL_HEAD = /^CREATE TABLE IF NOT EXISTS triage\.(emb_[a-z0-9_]+) \(/;
const EMB_TABLE = /triage\.(emb_[a-z0-9_]+)\b/;

function embTable(db: State, name: string): { dims: number; rows: EmbRow[] } {
  const table = db.emb.get(name);
  if (!table) throw missingRelation(`triage.${name}`);
  return table;
}

function embeddingHandler(text: string): Handler | undefined {
  const ddl = DDL_HEAD.exec(text);
  if (ddl) {
    const name = ddl[1] as ModelTable;
    const dims = Number(/embedding vector\((\d+)\)/.exec(text)?.[1]);
    if (!Number.isSafeInteger(dims) || text !== embeddingTableDdl(name, dims)) return undefined;
    return (_p, db) => {
      if (!db.emb.has(name)) db.emb.set(name, { dims, rows: [] });
      return [];
    };
  }
  const match = EMB_TABLE.exec(text);
  if (!match) return undefined;
  const name = match[1] as ModelTable;
  const sql = embeddingSql(name);
  if (text === sql.upsert) {
    return (p, db) => {
      const table = embTable(db, name);
      const id = str(p[0], 'run_id');
      const embedding = vector(p[5], 'embedding');
      if (embedding.length !== table.dims) {
        throw new FakePgError('22000', `expected ${table.dims} dimensions, not ${embedding.length}`);
      }
      const row: EmbRow = {
        run_id: id,
        submission_seq: int(p[1], 'submission_seq'),
        kind: str(p[2], 'kind'),
        text_sha256: str(p[3], 'text_sha256'),
        source_text: str(p[4], 'source_text'),
        embedding,
        created_at: ts(p[6], 'created_at'),
      };
      table.rows = table.rows.filter(
        (r) => !(r.run_id === row.run_id && r.kind === row.kind && r.submission_seq === row.submission_seq),
      );
      table.rows.push(row);
      return [];
    };
  }
  if (text === sql.listForRun) {
    return (p, db) => {
      const id = str(p[0], 'run_id');
      return embTable(db, name)
        .rows.filter((r) => r.run_id === id)
        .sort((a, b) => byText(a.kind, b.kind) || a.submission_seq - b.submission_seq)
        .map((r) => ({ submission_seq: r.submission_seq, kind: r.kind, text_sha256: r.text_sha256 }));
    };
  }
  if (text === sql.deleteForRun) {
    return (p, db) => {
      const table = embTable(db, name);
      const id = str(p[0], 'run_id');
      table.rows = table.rows.filter((r) => r.run_id !== id);
      return [];
    };
  }
  if (text === sql.similar) {
    return (p, db) => {
      const table = embTable(db, name);
      const q = vector(p[0], 'query vector');
      const kinds = new Set([str(p[1], 'kind'), str(p[2], 'kind')]);
      const exclude = strOrNull(p[3], 'exclude');
      const limit = int(p[4], 'limit');
      return table.rows
        .filter((r) => kinds.has(r.kind) && (exclude === null || r.run_id !== exclude))
        .map((r) => ({ r, distance: cosineDistance(r.embedding, q) }))
        .sort(
          (a, b) =>
            compareFloat(a.distance, b.distance) ||
            byText(a.r.run_id, b.r.run_id) ||
            byText(a.r.kind, b.r.kind) ||
            a.r.submission_seq - b.r.submission_seq,
        )
        .slice(0, limit)
        .map(({ r, distance }) => ({
          run_id: r.run_id,
          submission_seq: r.submission_seq,
          kind: r.kind,
          similarity: 1 - distance,
        }));
    };
  }
  return undefined;
}

// ---------------------------------------------------------------- migrator statements

function migratorHandler(text: string): Handler | undefined {
  if (text === MIGRATOR.lock || text === MIGRATOR.schema) return () => [];
  if (text.startsWith('CREATE TABLE IF NOT EXISTS triage.schema_migrations (')) return () => [];
  if (text === MIGRATOR.versions) return (_p, db) => db.versions.map((version) => ({ version }));
  if (text === MIGRATOR.one) {
    return (p, db) => {
      const version = str(p[0], 'version');
      return db.versions.includes(version) ? [{ version }] : [];
    };
  }
  if (text === MIGRATOR.record) {
    return (p, db) => {
      const version = str(p[0], 'version');
      if (db.versions.includes(version)) throw unique('schema_migrations_pkey');
      db.versions.push(version);
      return [];
    };
  }
  // The body of 0001_init.sql: it is what creates the run store tables.
  if (text.includes('CREATE TABLE triage.runs (') && text.includes('CREATE TABLE triage.embedding_models (')) {
    return (_p, db) => {
      if (db.migrated) throw new FakePgError('42P07', 'relation "runs" already exists');
      db.migrated = true;
      return [];
    };
  }
  // 0002_submission_flue_id.sql (D71).
  if (text.includes('ALTER TABLE triage.submissions ADD COLUMN flue_submission_id text;')) {
    return (_p, db) => {
      if (!db.migrated) throw missingRelation('triage.submissions');
      if (db.flueIdColumn) throw new FakePgError('42701', 'column "flue_submission_id" of relation "submissions" already exists');
      db.flueIdColumn = true;
      return [];
    };
  }
  // 0003_submission_trace_span.sql (D82).
  if (text.includes('ALTER TABLE triage.submissions ADD COLUMN trace_span_id text;')) {
    return (_p, db) => {
      if (!db.migrated) throw missingRelation('triage.submissions');
      if (db.traceSpanColumn) throw new FakePgError('42701', 'column "trace_span_id" of relation "submissions" already exists');
      db.traceSpanColumn = true;
      return [];
    };
  }
  return undefined;
}

/** The lateral join of listRuns (D71): the stalled check's inputs on a row in a working phase, nulls on any other. */
function stalledInputs(db: State, r: RunRow, working: readonly string[], steerKind: string): Record<string, unknown> {
  if (!working.includes(r.phase)) return { flue_submission_id: null, steer_flue_submission_id: null, worker_pid: null };
  const subs = db.submissions.filter((s) => s.run_id === r.run_id).sort((a, b) => b.seq - a.seq);
  const head = subs.find((s) => s.kind !== steerKind);
  const steer = subs.find((s) => s.kind === steerKind && s.flue_submission_id !== null && s.seq > (head?.seq ?? 0));
  return {
    flue_submission_id: head?.flue_submission_id ?? null,
    steer_flue_submission_id: steer?.flue_submission_id ?? null,
    worker_pid: r.worker_pid,
  };
}

// ------------------------------------------------------------------ the fake

export type FakePgCall = {
  /** 'pool' for a pool query, 'client<n>' for a checked-out client. */
  readonly on: string;
  readonly text: string;
  readonly params: readonly Param[];
};

export type FakePgOptions = {
  /**
   * false starts with no run store tables, so every run store statement fails
   * until the init migration runs. Defaults to true.
   */
  readonly migrated?: boolean;
  /** Throws a FakePgError for a statement this returns true for. */
  readonly failOn?: (text: string) => boolean;
};

export type FakePg = {
  readonly calls: FakePgCall[];
  /** Hands the fake pool to createPgRunner or getSharedPgRunner. */
  readonly poolFactory: PoolFactory;
  /** How many pools were built through poolFactory. */
  readonly poolsCreated: () => number;
  /** A runner from src/db/pg.ts over the fake pool. */
  runner(): PgRunner;
  /** Row counts per table, for assertions. */
  counts(): Record<string, number>;
  /** Per-model embedding tables and their dims. */
  embeddingTables(): Record<string, number>;
  isMigrated(): boolean;
};

/** A DSN that never resolves; the fake pool ignores it. */
export const FAKE_PG_DSN = 'postgresql://fake:fake@fake-pg.invalid:5432/triage';

export function createFakePg(options: FakePgOptions = {}): FakePg {
  let db = emptyState(options.migrated ?? true);
  const calls: FakePgCall[] = [];
  let pools = 0;
  let clients = 0;

  // One lock for every transaction and every autocommit statement.
  let tail: Promise<void> = Promise.resolve();
  const acquire = (): Promise<() => void> => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prev = tail;
    tail = prev.then(() => held);
    return prev.then(() => release);
  };

  const exec = (on: string, text: string, params: readonly unknown[] | undefined): Record<string, unknown>[] => {
    const list = params ?? [];
    calls.push({ on, text, params: list as Param[] });
    if (!list.every(isParam)) throw new FakePgError('08P01', 'parameter of an unsupported type');
    const needed = highestPlaceholder(text);
    if (list.length !== needed) {
      throw new FakePgError('08P01', `statement uses ${needed} parameters but ${list.length} were sent`);
    }
    if (options.failOn?.(text)) throw new FakePgError('XX000', 'injected failure');
    const migrator = migratorHandler(text);
    if (migrator) return migrator(list as Param[], db);
    const handler = STATIC.get(text) ?? embeddingHandler(text);
    if (!handler) throw new FakePgError('42601', 'fake-pg does not know this statement');
    if (!db.migrated) throw missingRelation('triage.runs');
    return handler(list as Param[], db);
  };

  const pool: PgPoolLike = {
    async query(text, params) {
      const release = await acquire();
      try {
        return { rows: exec('pool', text, params) };
      } finally {
        release();
      }
    },
    async connect(): Promise<PgClientLike> {
      const on = `client${++clients}`;
      let release: (() => void) | undefined;
      let snapshot: State | undefined;
      const end = (): void => {
        release?.();
        release = undefined;
        snapshot = undefined;
      };
      return {
        async query(text, params) {
          if (text === 'BEGIN') {
            calls.push({ on, text, params: [] });
            release = await acquire();
            snapshot = clone(db);
            return { rows: [] };
          }
          if (text === 'COMMIT') {
            calls.push({ on, text, params: [] });
            end();
            return { rows: [] };
          }
          if (text === 'ROLLBACK') {
            calls.push({ on, text, params: [] });
            if (snapshot) db = snapshot;
            end();
            return { rows: [] };
          }
          if (release === undefined) {
            const once = await acquire();
            try {
              return { rows: exec(on, text, params) };
            } finally {
              once();
            }
          }
          return { rows: exec(on, text, params) };
        },
        release() {
          // A client given back mid-transaction loses its changes.
          if (release !== undefined && snapshot) db = snapshot;
          end();
        },
      };
    },
    async end() {},
    on() {
      return undefined;
    },
  };

  return {
    calls,
    poolFactory: () => {
      pools++;
      return pool;
    },
    poolsCreated: () => pools,
    runner() {
      return createPgRunner(FAKE_PG_DSN, { poolFactory: this.poolFactory });
    },
    counts() {
      let emb = 0;
      for (const t of db.emb.values()) emb += t.rows.length;
      return {
        runs: db.runs.size,
        submissions: db.submissions.length,
        evidence: db.evidence.length,
        reports: db.reports.length,
        feedback: db.feedback.length,
        idempotency: db.idempotency.size,
        embedding_models: db.models.size,
        embeddings: emb,
        run_usage: db.usage.length,
      };
    },
    embeddingTables() {
      return Object.fromEntries([...db.emb].map(([name, t]) => [name, t.dims]));
    },
    isMigrated: () => db.migrated && db.flueIdColumn && db.traceSpanColumn,
  };
}
