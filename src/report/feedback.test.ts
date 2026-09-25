// recordFeedback against the real folder run store in a temp TRIAGE_HOME.
// No real .env, no network: the store writes under the temp home only.

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { makeTestHome, type TestHome } from '../../test/support/home.ts';
import { checkEgress, redactPersisted, type Persisted } from '../gate/redact.ts';
import { sampleRequest } from '../runstore/contract.ts';
import { createFolderRunStore } from '../runstore/folder.ts';
import type { Feedback, RunStore } from '../runstore/types.ts';
import type { EntityFindings } from '../types/findings.ts';
import type { Report } from '../types/report.ts';
import {
  buildFrontMatter,
  FeedbackError,
  parseFeedbackInput,
  recordFeedback,
  renderFeedbackMd,
  type FeedbackDeps,
  type FeedbackInput,
} from './feedback.ts';
import sampleReport from './__fixtures__/sample-report.json' with { type: 'json' };

// Valid ULIDs with no run of 6+ digits, so the persisted profile leaves them alone.
const RUN = '01J8ZQ7XK3PSEDRMNABCDEFGH1';
const OTHER_RUN = '01J8ZQ7XK3PSEDRMNABCDEFGH2';
const NO_REPORT_RUN = '01J8ZQ7XK3PSEDRMNABCDEFGH3';

const PHONE = '+91 98765 43210';
const ACCOUNT = '123456789012';

const homes: TestHome[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) h.cleanup();
});

type PutCall = { runId: string; feedback: Feedback; md: string | undefined };

type Setup = { h: TestHome; store: RunStore; puts: PutCall[]; deps: FeedbackDeps; clock: { t: number } };

function report(runId: string): Report {
  return { ...(sampleReport as unknown as Report), run_id: runId };
}

const findings: EntityFindings = {
  evidence: [
    {
      source: 'db',
      at: '2026-09-20T10:00:00.000Z',
      query_or_path: 'select status from card_dispatch where form_id = $1',
      summary: 'dispatch rejected',
    },
    {
      source: 'logs',
      at: '2026-09-20T10:01:00.000Z',
      query_or_path: 'service:rhythm AND  "vendor callback"',
      summary: 'vendor rejected the address',
    },
    {
      source: 'db',
      at: '2026-09-20T10:02:00.000Z',
      query_or_path: 'select status from card_dispatch where form_id = $1',
      summary: 'same query again',
    },
  ],
  timeline: [],
  hypotheses: ['address rejected'],
  confidence: 'high',
  gaps: [],
};

async function seedRun(store: RunStore, runId: string, withReport = true): Promise<void> {
  await store.createRun(runId, redactPersisted(sampleRequest(runId)));
  await store.addSubmission(runId, redactPersisted({ kind: 'initial' as const }));
  await store.putEvidence(runId, 'ssfb', redactPersisted(findings));
  if (withReport) await store.putReport(runId, 1, redactPersisted(report(runId)), redactPersisted('# report\n'));
}

async function setup(): Promise<Setup> {
  const h = makeTestHome();
  homes.push(h);
  const folder = createFolderRunStore({ runsDir: h.config.paths.runsDir, dataDir: h.config.paths.dataDir });
  await seedRun(folder, RUN);
  await seedRun(folder, NO_REPORT_RUN, false);
  const puts: PutCall[] = [];
  // Spy: records what putFeedback receives, then forwards to the real store.
  const store = new Proxy(folder, {
    get(target, prop, receiver) {
      if (prop === 'putFeedback') {
        return async (runId: string, fb: Persisted<Feedback>, md?: Persisted<string>) => {
          puts.push({ runId, feedback: fb.value, md: md?.value });
          return target.putFeedback(runId, fb, md);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const clock = { t: Date.parse('2026-09-24T09:00:00.000Z') };
  const deps: FeedbackDeps = {
    store,
    home: h.config.home,
    now: () => {
      clock.t += 60_000;
      return new Date(clock.t);
    },
  };
  return { h, store, puts, deps, clock };
}

const valid: FeedbackInput = { verdict: 'correct', given_by: 'reviewer-a', interface: 'cli' };

function frontMatter(md: string): any {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(md);
  if (m === null) throw new Error('no front-matter');
  return parseYaml(m[1] as string, { strict: true, uniqueKeys: true });
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true }).map(String);
}

async function rejected(p: Promise<unknown>): Promise<FeedbackError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof FeedbackError) return err;
    throw err;
  }
  throw new Error('expected a FeedbackError');
}

// ------------------------------------------------------------------ verdicts

describe('verdict deny table', () => {
  const bad: [string, unknown][] = [
    ['empty', ''],
    ['uppercase', 'CORRECT'],
    ['capitalised', 'Correct'],
    ['padded', ' correct'],
    ['unknown word', 'right'],
    ['close miss', 'partially'],
    ['missing', undefined],
    ['null', null],
    ['number', 1],
    ['array', ['correct']],
  ];
  for (const [label, verdict] of bad) {
    test(`${label} is refused and nothing is written`, async () => {
      const s = await setup();
      const err = await rejected(recordFeedback(RUN, { ...valid, verdict } as unknown as FeedbackInput, s.deps));
      expect(err.code).toBe('invalid_input');
      expect(err.fields).toEqual(['verdict']);
      expect(err.message).toContain('correct, partial, wrong, pending');
      expect(s.puts).toHaveLength(0);
      expect((await s.store.getRun(RUN))?.feedback).toHaveLength(0);
      expect(existsSync(join(s.h.config.home, 'evals'))).toBe(false);
    });
  }

  for (const verdict of ['correct', 'partial', 'wrong', 'pending'] as const) {
    test(`${verdict} is accepted`, async () => {
      const s = await setup();
      const r = await recordFeedback(RUN, { ...valid, verdict }, s.deps);
      expect(r.record.verdict).toBe(verdict);
      expect(s.puts).toHaveLength(1);
    });
  }

  test('other bad fields are refused by name without echoing the value', () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ ...valid, interface: 'slack' }, 'interface'],
      [{ ...valid, interface: 'claude-code' }, 'interface'],
      [{ ...valid, given_by: '   ' }, 'given_by'],
      [{ ...valid, actual_root_cause: 'x'.repeat(4001) }, 'actual_root_cause'],
      [{ ...valid, faster_path: 42 }, 'faster_path'],
    ];
    for (const [input, field] of cases) {
      let err: unknown;
      try {
        parseFeedbackInput(input);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(FeedbackError);
      expect((err as FeedbackError).fields).toEqual([field]);
      expect((err as FeedbackError).message).not.toContain('xxxx');
    }
  });

  test('blank free text counts as not given', () => {
    const out = parseFeedbackInput({ ...valid, actual_root_cause: '  ', faster_path: '' });
    expect(out.actual_root_cause).toBeUndefined();
    expect(out.faster_path).toBeUndefined();
  });
});

// ------------------------------------------------------------------ runs

describe('run checks', () => {
  test('an unknown run_id is refused with a clear message and writes nothing', async () => {
    const s = await setup();
    const err = await rejected(recordFeedback(OTHER_RUN, valid, s.deps));
    expect(err.code).toBe('run_not_found');
    expect(err.message).toBe(`no run ${OTHER_RUN} in the run store`);
    expect(s.puts).toHaveLength(0);
    expect(existsSync(join(s.h.config.home, 'evals'))).toBe(false);
  });

  test('a run_id that is not a ULID is refused before the store is read', async () => {
    const s = await setup();
    for (const id of ['', '../escape', 'run-1', RUN.toLowerCase(), `${RUN}X`]) {
      const err = await rejected(recordFeedback(id, valid, s.deps));
      expect(err.code).toBe('invalid_run_id');
    }
    expect(s.puts).toHaveLength(0);
  });

  test('a run without a report takes the verdict, with no feedback.md and no eval draft', async () => {
    const s = await setup();
    const r = await recordFeedback(NO_REPORT_RUN, { ...valid, verdict: 'wrong', notes: 'looking at the wrong customer' }, s.deps);
    expect(r.count).toBe(1);
    expect(r.draft_dir).toBeNull();
    expect(r.draft_files).toBeNull();
    expect(s.puts).toHaveLength(1);
    expect(s.puts[0]?.md).toBeUndefined();
    expect(existsSync(join(s.h.config.home, 'evals', '_unreviewed', NO_REPORT_RUN))).toBe(false);
    const run = await s.store.getRun(NO_REPORT_RUN);
    expect(run?.feedback_latest).toEqual({
      verdict: 'wrong',
      notes: 'looking at the wrong customer',
      given_by: 'reviewer-a',
      given_at: '2026-09-24T09:01:00.000Z',
      interface: 'cli',
      phase: 'created',
      submission_seq: 1,
    });
  });

  test('input is checked before the run id and the store', async () => {
    const s = await setup();
    const err = await rejected(recordFeedback('nope', { ...valid, verdict: 'bad' } as unknown as FeedbackInput, s.deps));
    expect(err.code).toBe('invalid_input');
  });
});

// ------------------------------------------------------------------ notes, findings and context

describe('notes, finding verdicts and run context', () => {
  test('notes, finding verdicts with their text and the run context are recorded', async () => {
    const s = await setup();
    const r = await recordFeedback(
      RUN,
      {
        ...valid,
        verdict: 'wrong',
        notes: 'the dispatch was fine; the card was held',
        findings: [
          { id: 'ssfb.v1.e2', verdict: 'wrong', note: 'that log is for another form' },
          { id: 'ssfb.v1.h1', verdict: 'partial' },
          { id: 'root_cause', verdict: 'wrong' },
        ],
      },
      s.deps,
    );
    expect(r.record).toMatchObject({
      verdict: 'wrong',
      notes: 'the dispatch was fine; the card was held',
      phase: 'created',
      submission_seq: 1,
      report_seq: 1,
      findings: [
        { id: 'ssfb.v1.e2', verdict: 'wrong', note: 'that log is for another form', text: 'vendor rejected the address' },
        { id: 'ssfb.v1.h1', verdict: 'partial', text: 'address rejected' },
        { id: 'root_cause', verdict: 'wrong', text: (sampleReport as unknown as Report).root_cause?.statement },
      ],
    });
    expect(r.record.cancelled).toBeUndefined();
    const fm = frontMatter(readFileSync(r.draft_files!.feedback_md, 'utf8'));
    expect(fm.ground_truth.notes).toBe('the dispatch was fine; the card was held');
    expect(fm.ground_truth.findings).toHaveLength(3);
  });

  test('a finding id the run does not have, or one given twice, is refused and nothing is written', async () => {
    const s = await setup();
    for (const findingsIn of [
      [{ id: 'ssfb.v2.e1', verdict: 'wrong' as const }],
      [{ id: 'ssfb.v1.e9', verdict: 'wrong' as const }],
      [{ id: 'atspl.v1.e1', verdict: 'wrong' as const }],
      [{ id: 'ssfb.v1.c1', verdict: 'wrong' as const }],
      [{ id: 'not-an-id', verdict: 'wrong' as const }],
      [
        { id: 'ssfb.v1.e1', verdict: 'wrong' as const },
        { id: 'ssfb.v1.e1', verdict: 'correct' as const },
      ],
    ]) {
      const err = await rejected(recordFeedback(RUN, { ...valid, findings: findingsIn }, s.deps));
      expect(err.code).toBe('invalid_input');
      expect(err.fields[0]).toMatch(/^findings\.\d+\.id$/);
    }
    // root_cause needs a report.
    const noReport = await rejected(recordFeedback(NO_REPORT_RUN, { ...valid, findings: [{ id: 'root_cause', verdict: 'wrong' }] }, s.deps));
    expect(noReport.fields).toEqual(['findings.0.id']);
    expect(s.puts).toHaveLength(0);
  });

  test('an id from an older findings version is kept, without text', async () => {
    const s = await setup();
    await s.store.putEvidence(RUN, 'ssfb', redactPersisted({ ...findings, evidence: findings.evidence.slice(0, 1) }));
    const r = await recordFeedback(
      RUN,
      {
        ...valid,
        findings: [
          { id: 'ssfb.v1.e3', verdict: 'wrong' },
          { id: 'ssfb.v2.e1', verdict: 'correct' },
        ],
      },
      s.deps,
    );
    expect(r.record.findings).toEqual([
      { id: 'ssfb.v1.e3', verdict: 'wrong' },
      { id: 'ssfb.v2.e1', verdict: 'correct', text: 'dispatch rejected' },
    ]);
    await expect(recordFeedback(RUN, { ...valid, findings: [{ id: 'ssfb.v2.e2', verdict: 'wrong' }] }, s.deps)).rejects.toThrow(FeedbackError);
  });

  test('a cancel carries cancelled and the phase given by the caller', async () => {
    const s = await setup();
    const r = await recordFeedback(NO_REPORT_RUN, { ...valid, verdict: 'wrong', cancelled: true }, s.deps, { phase: 'investigating' });
    expect(r.record).toMatchObject({ verdict: 'wrong', cancelled: true, phase: 'investigating' });
    expect(r.record.notes).toBeUndefined();
  });

  test('bad finding verdicts and notes name the field', () => {
    const f = (x: unknown) => {
      try {
        parseFeedbackInput({ ...valid, ...(x as object) });
        return [];
      } catch (err) {
        return (err as FeedbackError).fields;
      }
    };
    expect(f({ findings: [{ id: 'ssfb.v1.e1', verdict: 'maybe' }] })).toEqual(['findings.0.verdict']);
    expect(f({ notes: 'x'.repeat(5000) })).toEqual(['notes']);
    expect(f({ findings: 'all' })).toEqual(['findings']);
  });
});

// ------------------------------------------------------------------ append and render

describe('append-then-render latest-wins', () => {
  test('two calls append two records and feedback.md reflects the second', async () => {
    const s = await setup();
    await recordFeedback(RUN, { ...valid, verdict: 'wrong', actual_root_cause: 'first guess' }, s.deps);
    const second = await recordFeedback(
      RUN,
      { verdict: 'partial', faster_path: 'check the vendor callback log first', given_by: 'reviewer-b', interface: 'http' },
      s.deps,
    );
    expect(second.count).toBe(2);

    const run = await s.store.getRun(RUN);
    expect(run?.feedback.map((f) => f.verdict)).toEqual(['wrong', 'partial']);
    expect(run?.feedback_latest?.verdict).toBe('partial');
    expect(run?.feedback[1]?.interface).toBe('http');

    const jsonl = readFileSync(join(s.h.config.paths.runsDir, RUN, 'feedback.jsonl'), 'utf8').trim().split('\n');
    expect(jsonl).toHaveLength(2);

    for (const path of [join(s.h.config.paths.runsDir, RUN, 'feedback.md'), second.draft_files!.feedback_md]) {
      const md = readFileSync(path, 'utf8');
      const fm = frontMatter(md);
      expect(fm.ground_truth).toEqual({ verdict: 'partial', faster_path: 'check the vendor callback log first' });
      expect(fm.type).toBe('resolved');
      expect(fm.captured_at).toBe(second.record.given_at);
      expect(md).toContain('1. 2026-09-24T09:01:00.000Z via cli: wrong');
      expect(md).toContain('2. 2026-09-24T09:02:00.000Z via http: partial (latest)');
    }

    // The second putFeedback carried the rendering of both records.
    expect(s.puts).toHaveLength(2);
    expect(s.puts[1]?.md).toBe(readFileSync(second.draft_files!.feedback_md, 'utf8'));
  });

  test('a pending verdict gives type pending', async () => {
    const s = await setup();
    const r = await recordFeedback(RUN, { ...valid, verdict: 'pending' }, s.deps);
    expect(frontMatter(readFileSync(r.draft_files!.feedback_md, 'utf8')).type).toBe('pending');
  });

  test('renderFeedbackMd refuses an empty record list', () => {
    expect(() => renderFeedbackMd(RUN, { report: report(RUN), evidence: {} }, [])).toThrow(FeedbackError);
  });
});

// ------------------------------------------------------------------ redaction

describe('redaction of free text before write', () => {
  test('the store spy sees masked text only', async () => {
    const s = await setup();
    const r = await recordFeedback(
      RUN,
      {
        ...valid,
        verdict: 'wrong',
        actual_root_cause: `customer on ${PHONE} was debited twice from account ${ACCOUNT}`,
        faster_path: `grep the ledger for ${ACCOUNT}`,
      },
      s.deps,
    );
    expect(s.puts).toHaveLength(1);
    const put = s.puts[0] as PutCall;
    const seen = JSON.stringify(put);
    for (const raw of [PHONE, ACCOUNT, '98765', '43210']) expect(seen).not.toContain(raw);
    expect(put.feedback.actual_root_cause).toContain('****');
    expect(put.feedback.faster_path).toContain('****9012');
    expect(checkEgress(put.feedback).ok).toBe(true);
    expect(checkEgress(put.md).ok).toBe(true);
    expect(r.record.actual_root_cause).toBe(put.feedback.actual_root_cause);

    // Every file the call wrote holds masked text only.
    const written = [
      join(s.h.config.paths.runsDir, RUN, 'feedback.jsonl'),
      join(s.h.config.paths.runsDir, RUN, 'feedback.md'),
      r.draft_files!.feedback_md,
      r.draft_files!.report_json,
    ];
    for (const path of written) {
      const text = readFileSync(path, 'utf8');
      expect(text).not.toContain(ACCOUNT);
      expect(text).not.toContain(PHONE);
    }
  });

  test('a run id with a long digit run is masked in the front-matter id but not in the draft folder name', async () => {
    const s = await setup();
    const digitRun = '01J8ZQ7XK3PSEDRMN000000001';
    await seedRun(s.store, digitRun);
    const r = await recordFeedback(digitRun, valid, s.deps);
    expect(r.draft_dir!.endsWith(digitRun)).toBe(true);
    const fm = frontMatter(readFileSync(r.draft_files!.feedback_md, 'utf8'));
    expect(fm.id).not.toContain('000000001');
    expect(fm.id).toContain('****');
  });
});

// ------------------------------------------------------------------ draft

describe('draft path', () => {
  test('the draft lands only under evals/_unreviewed/<run_id>/ of the temp TRIAGE_HOME', async () => {
    const s = await setup();
    const r = await recordFeedback(RUN, valid, s.deps);
    const home = s.h.config.home;
    expect(r.draft_dir).toBe(join(home, 'evals', '_unreviewed', RUN));
    expect(r.draft_files).toEqual({
      feedback_md: join(home, 'evals', '_unreviewed', RUN, 'feedback.md'),
      report_json: join(home, 'evals', '_unreviewed', RUN, 'report.json'),
    });
    expect(filesUnder(join(home, 'evals')).sort()).toEqual(
      ['_unreviewed', `_unreviewed/${RUN}`, `_unreviewed/${RUN}/feedback.md`, `_unreviewed/${RUN}/report.json`].sort(),
    );
    expect(existsSync(join(home, 'evals', 'cases'))).toBe(false);

    const copy = JSON.parse(readFileSync(r.draft_files!.report_json, 'utf8'));
    expect(copy).toEqual((await s.store.getRun(RUN))?.report);
  });

  test('a second call rewrites the same draft and still writes nothing under evals/cases', async () => {
    const s = await setup();
    await recordFeedback(RUN, valid, s.deps);
    const r = await recordFeedback(RUN, { ...valid, verdict: 'wrong' }, s.deps);
    expect(frontMatter(readFileSync(r.draft_files!.feedback_md, 'utf8')).ground_truth.verdict).toBe('wrong');
    expect(readdirSync(join(s.h.config.home, 'evals'))).toEqual(['_unreviewed']);
  });
});

// ------------------------------------------------------------------ front-matter

describe('front-matter parse round trip', () => {
  test('the YAML parses back to the eval capture keys with no service fields', async () => {
    const s = await setup();
    const r = await recordFeedback(
      RUN,
      { ...valid, verdict: 'partial', actual_root_cause: 'the pincode: was blank', faster_path: 'look at "vendor callback" logs' },
      s.deps,
    );
    const md = readFileSync(r.draft_files!.feedback_md, 'utf8');
    const fm = frontMatter(md);

    expect(Object.keys(fm)).toEqual(['id', 'type', 'input', 'investigation', 'ground_truth', 'captured_at']);
    expect(Object.keys(fm.input)).toEqual(['problem', 'identifiers', 'ref']);
    expect(Object.keys(fm.investigation)).toEqual(['root_cause', 'queries']);
    expect(Object.keys(fm.ground_truth)).toEqual(['verdict', 'actual_root_cause', 'faster_path']);
    expect(md).not.toMatch(/^\s*(service|actual_service|db_evidence):/m);

    const rep = report(RUN);
    expect(fm).toEqual({
      id: RUN,
      type: 'resolved',
      input: {
        problem: rep.request.current_ask,
        identifiers: rep.id_chain.ids,
        ref: 'none',
      },
      investigation: {
        root_cause: rep.root_cause?.statement,
        queries: ['select status from card_dispatch where form_id = $1', 'service:rhythm AND "vendor callback"'],
      },
      ground_truth: {
        verdict: 'partial',
        actual_root_cause: 'the pincode: was blank',
        faster_path: 'look at "vendor callback" logs',
      },
      captured_at: r.record.given_at,
    });
  });

  test('buildFrontMatter falls back for a report with no root cause, ask or permalink', () => {
    const rep: Report = {
      ...report(RUN),
      root_cause: null,
      request: { current_ask: '  ', requested_by: 'cx', permalink: 'https://example.invalid/archives/C1/p1' },
    };
    const latest: Feedback = { verdict: 'pending', given_by: 'r', given_at: '2026-09-24T09:00:00.000Z', interface: 'cli' };
    const fm = buildFrontMatter(RUN, rep, { evidence: {} }, latest);
    expect(fm.investigation).toEqual({ root_cause: 'inconclusive', queries: [] });
    expect(fm.input.problem).toBe('none');
    expect(fm.input.ref).toBe('https://example.invalid/archives/C1/p1');
    expect(fm.ground_truth).toEqual({ verdict: 'pending' });
  });
});
