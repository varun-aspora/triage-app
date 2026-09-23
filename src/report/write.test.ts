import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as v from 'valibot';

import { redactPersisted, type Persisted } from '../gate/redact.ts';
import { sampleRequest } from '../runstore/contract.ts';
import { createFolderRunStore } from '../runstore/folder.ts';
import {
  RunNotFoundError,
  RunStoreError,
  assertPersisted,
  type RunRecord,
  type RunStore,
} from '../runstore/types.ts';
import { renderReportMarkdown } from './markdown.ts';
import { ReportSchema, type Report } from './schema.ts';
import { refusalMessage, writeReport, type WriteReportDraft, type WriteReportResult } from './write.ts';

// All values below are synthetic. The run id has no run of six digits, so the
// persisted profile leaves it alone.
const RUN_ID = '01JWRTRPTABCDEFGHJKMNPQRST';
const FIXED_NOW = new Date('2026-09-24T09:30:00.000Z');
const now = () => FIXED_NOW;
const CONFIG = { display: { envLabel: 'stage laptop' } } as const;

const FIXTURE_TEXT = readFileSync(join(import.meta.dir, '__fixtures__', 'sample-report.json'), 'utf8');

function sampleDraft(): WriteReportDraft {
  const { run_id: _r, env_label: _e, generated_at: _g, ...rest } = v.parse(ReportSchema, JSON.parse(FIXTURE_TEXT));
  return rest;
}

type Draft = ReturnType<typeof sampleDraft>;
const withDraft = (change: (d: Draft) => void): WriteReportDraft => {
  const d = sampleDraft();
  change(d);
  return d;
};

// ------------------------------------------------------------------ fake store

type Put = { runId: string; submissionId: number; report: Report; md: string };

// An in-memory store with the two methods writeReport uses. putReport runs
// the same write-side check the real providers run.
function fakeStore(seqs: number[] = [1]) {
  const puts: Put[] = [];
  const calls = { getRun: 0, putReport: 0 };
  const store: Pick<RunStore, 'getRun' | 'putReport'> = {
    async getRun(runId) {
      calls.getRun++;
      if (runId !== RUN_ID) return null;
      return {
        run_id: runId,
        submissions: seqs.map((seq) => ({ seq, kind: 'initial', created_at: FIXED_NOW.toISOString(), report: null, report_md: null })),
      } as unknown as RunRecord;
    },
    async putReport(runId, submissionId, report: Persisted<Report>, md: Persisted<string>) {
      calls.putReport++;
      puts.push({ runId, submissionId, report: assertPersisted(report, 'report'), md: assertPersisted(md, 'md') as string });
    },
  };
  return { store, puts, calls, total: () => calls.getRun + calls.putReport };
}

function write(draft: WriteReportDraft, extra: { names?: string[]; seqs?: number[]; label?: string } = {}) {
  const fake = fakeStore(extra.seqs);
  const config = extra.label === undefined ? CONFIG : { display: { envLabel: extra.label } };
  const result = writeReport({ runId: RUN_ID, draft, ingressNames: extra.names ?? [], store: fake.store, config, now });
  return { fake, result };
}

// Every 4-character window of the value, with and without its spaces. A
// refusal must contain none of them.
function windows(value: string): string[] {
  const out = new Set<string>();
  for (const s of [value, value.replace(/\s+/g, '')]) {
    for (let i = 0; i + 4 <= s.length; i++) {
      const w = s.slice(i, i + 4);
      if (/[A-Za-z0-9]/.test(w) && w.trim().length === 4) out.add(w);
    }
  }
  return [...out];
}

function expectNoPartOf(value: string, result: WriteReportResult): void {
  if (result.ok) throw new Error('expected a refusal');
  const texts = [JSON.stringify(result), refusalMessage(result)];
  for (const text of texts) {
    for (const w of windows(value)) expect(text).not.toContain(w);
  }
}

// ------------------------------------------------------------------ happy path

describe('writeReport: valid draft', () => {
  test('writes report.json and report.md through the store and returns their paths', async () => {
    const { fake, result } = write(sampleDraft(), { seqs: [1, 2] });
    const r = await result;
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.paths).toEqual({
      submissionId: 2,
      json: `${RUN_ID}/submissions/2/report.json`,
      md: `${RUN_ID}/submissions/2/report.md`,
    });
    expect(fake.calls).toEqual({ getRun: 1, putReport: 1 });
    const put = fake.puts[0]!;
    expect(put.runId).toBe(RUN_ID);
    expect(put.submissionId).toBe(2);
    expect(put.report).toEqual(r.report);
    expect(put.md).toBe(renderReportMarkdown(r.report));
  });

  test('fills run_id, env_label and generated_at, replacing anything the draft carried', async () => {
    const draft = { ...sampleDraft(), run_id: 'SOMETHINGELSE', env_label: 'prod', generated_at: '2020-01-01T00:00:00.000Z' };
    const { fake, result } = write(draft as WriteReportDraft);
    const r = await result;
    if (!r.ok) throw new Error('expected ok');
    expect(r.report.run_id).toBe(RUN_ID);
    expect(r.report.env_label).toBe('stage laptop');
    expect(r.report.generated_at).toBe(FIXED_NOW.toISOString());
    expect(fake.puts[0]!.md).toContain('stage laptop');
  });

  test('report.json round-trips through ReportSchema', async () => {
    const { fake, result } = write(sampleDraft());
    const r = await result;
    if (!r.ok) throw new Error('expected ok');
    const reread = v.parse(ReportSchema, JSON.parse(JSON.stringify(fake.puts[0]!.report)));
    expect(reread).toEqual(r.report);
  });

  test('drops fields the schema does not know', async () => {
    const draft = { ...sampleDraft(), notes_for_later: 'extra' };
    const { fake, result } = write(draft as WriteReportDraft);
    expect((await result).ok).toBe(true);
    expect(Object.keys(fake.puts[0]!.report)).not.toContain('notes_for_later');
  });

  test('an explicit submissionId is used without reading the run', async () => {
    const fake = fakeStore([1, 2, 3]);
    const r = await writeReport({ runId: RUN_ID, draft: sampleDraft(), ingressNames: [], store: fake.store, config: CONFIG, now, submissionId: 1 });
    expect(r.ok && r.paths.submissionId).toBe(1);
    expect(fake.calls).toEqual({ getRun: 0, putReport: 1 });
  });

  test('a run id with six digits in a row is not refused; the stored copy goes through the persisted profile', async () => {
    const runId = '01J8ZQ7XK3PSEUDRUN00000001';
    const fake = fakeStore();
    const store = { ...fake.store, getRun: async () => ({ submissions: [{ seq: 1 }] }) as unknown as RunRecord };
    const r = await writeReport({ runId, draft: sampleDraft(), ingressNames: [], store, config: CONFIG, now });
    expect(r.ok).toBe(true);
    expect(fake.puts[0]!.runId).toBe(runId);
    expect(fake.puts[0]!.report.run_id).not.toContain('00000001');
    // Known and accepted: the masked run id holds '*', which RunIdSchema does
    // not allow, so this stored report.json no longer parses through
    // ReportSchema. The run store keys the run by the unmasked id, so the run
    // is still found. Only run ids with six digits in a row are affected.
    const reread = v.safeParse(ReportSchema, JSON.parse(JSON.stringify(fake.puts[0]!.report)));
    expect(reread.success).toBe(false);
    if (!reread.success) expect(reread.issues.map((i) => i.path?.map((p) => p.key).join('.'))).toEqual(['run_id']);
  });

  test('a large affected_count is not refused and is stored whole', async () => {
    const draft = withDraft((d) => void (d.scope = { ...d.scope, kind: 'systemic', affected_count: 250000 }));
    const { fake, result } = write(draft);
    const r = await result;
    if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);
    expect(fake.puts[0]!.report.scope.affected_count).toBe(250000);
    expect(fake.puts[0]!.md).toContain('- Affected count: 250,000');
  });
});

describe('writeReport: env_label', () => {
  test('comes from config and changes nothing but the label', async () => {
    const a = await write(sampleDraft(), { label: 'label-one' }).result;
    const b = await write(sampleDraft(), { label: 'label-two' }).result;
    if (!a.ok || !b.ok) throw new Error('expected ok');
    expect(a.report.env_label).toBe('label-one');
    expect({ ...a.report, env_label: '' }).toEqual({ ...b.report, env_label: '' });
    expect(a.paths).toEqual(b.paths);
  });

  test('an unset label is written as empty display text', async () => {
    const fake = fakeStore();
    const r = await writeReport({ runId: RUN_ID, draft: sampleDraft(), ingressNames: [], store: fake.store, config: { display: {} }, now });
    expect(r.ok && r.report.env_label).toBe('');
  });

  test('no branch in write.ts reads it', () => {
    const code = readFileSync(join(import.meta.dir, 'write.ts'), 'utf8').replace(/\/\/.*$/gm, '');
    const lines = code.split('\n').filter((l) => /envLabel/.test(l));
    expect(lines.map((l) => l.trim())).toEqual(["env_label: config.display.envLabel ?? '',"]);
    expect(code).not.toMatch(/env_label\s*(?:===|!==|==|!=)/);
    expect(code).not.toMatch(/\b(?:if|switch|while)\s*\([^)]*env_?[lL]abel/);
  });
});

// ------------------------------------------------------------------ schema refusal

describe('writeReport: schema refusal', () => {
  test('returns issues and writes nothing', async () => {
    const draft = withDraft((d) => {
      d.escalated = true;
      d.escalation_reasons = [];
    });
    const { fake, result } = write(draft);
    const r = await result;
    expect(r).toMatchObject({ ok: false, reason: 'schema' });
    if (r.ok || r.reason !== 'schema') return;
    expect(r.issues.map((i) => i.path)).toContain('$.escalation_reasons');
    expect(fake.total()).toBe(0);
  });

  test('issue messages do not echo the value that failed', async () => {
    const phone = '+91 98765 43210';
    const draft = withDraft((d) => {
      d.current_state[0]!.taken_at = phone;
    });
    const { fake, result } = write(draft);
    const r = await result;
    expect(r).toMatchObject({ ok: false, reason: 'schema' });
    if (r.ok || r.reason !== 'schema') return;
    expect(r.issues[0]!.path).toBe('$.current_state[0].taken_at');
    expect(r.issues[0]!.message.length).toBeGreaterThan(0);
    expectNoPartOf(phone, r);
    expect(fake.total()).toBe(0);
  });

  test('a placeholder failure in a suggested_fix title with PII does not echo it', async () => {
    const email = 'asha.test@example.com';
    const draft = withDraft((d) => {
      d.suggested_fix[0]!.title = `Retry for ${email}`;
      d.suggested_fix[0]!.command = 'curl -sS https://api.example.test/v1/retry';
    });
    const r = await write(draft).result;
    expect(r).toMatchObject({ ok: false, reason: 'schema' });
    expectNoPartOf(email, r);
  });

  test('a draft without repo_commits or cost is a schema refusal', async () => {
    const { repo_commits: _c, cost: _k, ...partial } = sampleDraft();
    const { fake, result } = write(partial as WriteReportDraft);
    const r = await result;
    if (r.ok || r.reason !== 'schema') throw new Error('expected a schema refusal');
    expect(r.issues.map((i) => i.path).sort()).toEqual(['$.cost', '$.repo_commits']);
    expect(fake.total()).toBe(0);
  });

  test('refusalMessage lists the paths and asks for a retry', async () => {
    const draft = withDraft((d) => {
      d.escalated = true;
      d.escalation_reasons = [];
    });
    const r = await write(draft).result;
    if (r.ok) throw new Error('expected a refusal');
    const text = refusalMessage(r);
    expect(text).toContain('$.escalation_reasons');
    expect(text).toContain('call finish_report again');
  });
});

// ------------------------------------------------------------------ redaction refusal

describe('writeReport: redaction refusal', () => {
  const cases: { name: string; value: string; pattern: string; field: string; draft: (value: string) => WriteReportDraft }[] = [
    {
      name: 'phone in reply_text',
      value: '+91 98765 43210',
      pattern: 'phone',
      field: '$.cx_answer.reply_text',
      draft: (value) => withDraft((d) => void (d.cx_answer.reply_text = `Please call the customer on ${value} today.`)),
    },
    {
      name: '12-digit account number in a suggested_fix command',
      value: '301234567890',
      pattern: 'digits6',
      field: '$.suggested_fix[1].command',
      draft: (value) =>
        withDraft(
          (d) =>
            void (d.suggested_fix[1]!.command = `psql "$SSFB_RHYTHM_DB_URL" -c "SELECT status FROM accounts WHERE account_number = '${value}'"`),
        ),
    },
    {
      name: 'email in an eng action',
      value: 'asha.test@example.com',
      pattern: 'email',
      field: '$.actions.eng[0]',
      draft: (value) => withDraft((d) => void (d.actions.eng[0] = `Ask ${value} to confirm the address.`)),
    },
    {
      name: 'base64-encoded phone in a gap',
      value: Buffer.from('customer phone +91 98765 43210 on file').toString('base64'),
      pattern: 'phone',
      field: '$.gaps[0]',
      draft: (value) => withDraft((d) => void (d.gaps = [`raw vendor payload ${value}`])),
    },
    {
      name: 'account number in verify_with',
      value: '301234567890',
      pattern: 'digits6',
      field: '$.suggested_fix[0].verify_with',
      draft: (value) =>
        withDraft((d) => void (d.suggested_fix[0]!.verify_with = `SELECT status FROM accounts WHERE account_number = '${value}'`)),
    },
  ];

  for (const c of cases) {
    test(`${c.name}: pattern names only, nothing written`, async () => {
      const { fake, result } = write(c.draft(c.value));
      const r = await result;
      expect(r).toMatchObject({ ok: false, reason: 'unmasked' });
      if (r.ok || r.reason !== 'unmasked') return;
      expect(r.patterns).toContain(c.pattern as never);
      expect(r.fields).toContain(c.field);
      expectNoPartOf(c.value, r);
      expect(fake.total()).toBe(0);
    });
  }

  test('the phone behind the base64 is not echoed either', async () => {
    const encoded = Buffer.from('customer phone +91 98765 43210 on file').toString('base64');
    const r = await write(withDraft((d) => void (d.gaps = [`raw vendor payload ${encoded}`]))).result;
    expectNoPartOf('+91 98765 43210', r);
  });

  test('an ingress-collected name in reply_text is refused', async () => {
    const name = 'Asha Verma';
    const draft = withDraft((d) => void (d.cx_answer.reply_text = `Hi ${name}, your card will be dispatched again this week.`));
    const { fake, result } = write(draft, { names: [name] });
    const r = await result;
    expect(r).toMatchObject({ ok: false, reason: 'unmasked', patterns: ['name'], fields: ['$.cx_answer.reply_text'] });
    expectNoPartOf(name, r);
    expect(fake.total()).toBe(0);
  });

  test('the same text passes when ingress collected no such name', async () => {
    const draft = withDraft((d) => void (d.cx_answer.reply_text = 'Hi Asha Verma, your card will be dispatched again this week.'));
    expect((await write(draft).result).ok).toBe(true);
  });

  test('a masked value passes', async () => {
    const draft = withDraft((d) => void (d.cx_answer.reply_text = 'The account ending ****7890 is active.'));
    expect((await write(draft).result).ok).toBe(true);
  });

  test('refusalMessage names the patterns and fields', async () => {
    const r = await write(cases[0]!.draft(cases[0]!.value)).result;
    if (r.ok) throw new Error('expected a refusal');
    const text = refusalMessage(r);
    expect(text).toContain('phone');
    expect(text).toContain('$.cx_answer.reply_text');
    expect(text).toContain('call finish_report again');
  });

  test('a miss found only in the rendered Markdown names report.md as the field', async () => {
    // The JSON check does not scan object keys; the Markdown lists the cost
    // model names, so a key with six digits in a row is caught there only.
    const draft: WriteReportDraft = {
      ...sampleDraft(),
      cost: { wall_ms: 1000, models: { 'model-1234567': { calls: 1, input_tokens: 10, output_tokens: 5 } } },
    };
    const { fake, result } = write(draft);
    const r = await result;
    expect(r).toEqual({ ok: false, reason: 'unmasked', patterns: ['digits6'], fields: ['report.md'] });
    expect(fake.total()).toBe(0);
  });
});

// ------------------------------------------------------------------ store errors

describe('writeReport: store errors are thrown', () => {
  test('an unknown run throws RunNotFoundError', async () => {
    const fake = fakeStore();
    const p = writeReport({ runId: '01JUNKNWNRVNABCDEFGHJKMNPQ', draft: sampleDraft(), ingressNames: [], store: fake.store, config: CONFIG, now });
    await expect(p).rejects.toBeInstanceOf(RunNotFoundError);
    expect(fake.calls.putReport).toBe(0);
  });

  test('a run with no submission throws', async () => {
    const { fake, result } = write(sampleDraft(), { seqs: [] });
    await expect(result).rejects.toBeInstanceOf(RunStoreError);
    expect(fake.calls).toEqual({ getRun: 1, putReport: 0 });
  });

  test('an aborted signal stops before the write', async () => {
    const fake = fakeStore();
    const controller = new AbortController();
    controller.abort(new Error('run timed out'));
    const p = writeReport({ runId: RUN_ID, draft: sampleDraft(), ingressNames: [], store: fake.store, config: CONFIG, now, signal: controller.signal });
    await expect(p).rejects.toThrow('run timed out');
    expect(fake.total()).toBe(0);
  });
});

// ------------------------------------------------------------------ folder provider

describe('writeReport with the folder run store', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  test('files land at the returned paths and read back through ReportSchema', async () => {
    dir = mkdtempSync(join(tmpdir(), 'triage-write-'));
    const runsDir = join(dir, 'runs');
    const store = createFolderRunStore({ runsDir, dataDir: join(dir, 'data'), now: () => FIXED_NOW.getTime() });
    await store.createRun(RUN_ID, redactPersisted(sampleRequest(RUN_ID)));
    await store.addSubmission(RUN_ID, redactPersisted({ kind: 'initial' as const }));

    const r = await writeReport({ runId: RUN_ID, draft: sampleDraft(), ingressNames: ['Asha Verma'], store, config: CONFIG, now });
    if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);

    const json = JSON.parse(readFileSync(join(runsDir, r.paths.json), 'utf8'));
    expect(v.parse(ReportSchema, json)).toEqual(r.report);
    expect(readFileSync(join(runsDir, r.paths.md), 'utf8')).toBe(renderReportMarkdown(r.report));

    const run = await store.getRun(RUN_ID);
    expect(run?.report).toEqual(r.report);
  });

  test('a refusal leaves no report files', async () => {
    dir = mkdtempSync(join(tmpdir(), 'triage-write-'));
    const store = createFolderRunStore({ runsDir: join(dir, 'runs'), dataDir: join(dir, 'data') });
    await store.createRun(RUN_ID, redactPersisted(sampleRequest(RUN_ID)));
    await store.addSubmission(RUN_ID, redactPersisted({ kind: 'initial' as const }));
    const draft = withDraft((d) => void (d.cx_answer.reply_text = 'Call +91 98765 43210.'));
    const r = await writeReport({ runId: RUN_ID, draft, ingressNames: [], store, config: CONFIG, now });
    expect(r.ok).toBe(false);
    const run = await store.getRun(RUN_ID);
    expect(run?.report).toBeNull();
    expect(run?.report_md).toBeNull();
  });
});
