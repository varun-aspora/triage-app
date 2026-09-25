// caseCardText and requestText over hand-built run records. Synthetic values only.

import { describe, expect, test } from 'bun:test';
import { checkEgress, isPersisted } from '../gate/redact.ts';
import { RUN_A, SYNTHETIC_EMAIL, SYNTHETIC_PHONE, sampleClassification, sampleReport, sampleRequest } from '../runstore/contract.ts';
import type { ClassificationRecord, RunRecord, Submission } from '../runstore/types.ts';
import type { Report } from '../types/report.ts';
import { LINE_CAP, REQUEST_LATEST_MESSAGES, caseCardText, requestText } from './case-text.ts';

const CUSTOMER_UUID = '3f1c9a52-7d0e-4b6a-9c11-2a4e8b5d7f90';
const FORM_UUID = '8a2b4c6d-1e3f-4a5b-8c7d-9e0f1a2b3c4d';
const HOP_SOURCE = 'ssfb:harbor.account_forms';

const idChain = {
  ids: { customer_id: CUSTOMER_UUID, form_id: FORM_UUID },
  hops: [{ from: 'customer_id', to: 'form_id', source: HOP_SOURCE, status: 'resolved', taken_at: '2026-09-01T10:00:00.000Z' }],
  basic_state: [{ item: 'form_status', value: 'PENDING_KYC', taken_at: '2026-09-01T10:00:00.000Z', source: HOP_SOURCE }],
} as const;

function classification(): ClassificationRecord {
  const c = sampleClassification();
  return { ...c, id_chain: structuredClone(idChain) as unknown as ClassificationRecord['id_chain'] };
}

function report(): Report {
  const r = sampleReport(RUN_A, 'the payout is waiting on the partner bank');
  return {
    ...r,
    id_chain: structuredClone(idChain) as unknown as Report['id_chain'],
    root_cause: { statement: 'the payout is waiting on the partner bank', code_refs: [], matched_pattern_id: 'payout-bank-wait' },
  };
}

function submission(seq: number, kind: 'initial' | 'ask' = 'initial', question?: string): Submission {
  return {
    seq,
    kind,
    ...(question !== undefined ? { question } : {}),
    created_at: '2026-09-01T10:00:00.000Z',
    report: null,
    report_md: null,
  };
}

describe('caseCardText', () => {
  test('a fixture run has category and status lines and no id_chain values', () => {
    const text = caseCardText({ classification: classification(), report: report() });
    expect(isPersisted(text)).toBe(true);
    const lines = text.value.split('\n');
    expect(lines).toContain('category: transfer_out');
    expect(lines).toContain('subcategory: stuck');
    expect(lines).toContain('current_ask: why is the transfer stuck');
    expect(lines).toContain('root_cause: the payout is waiting on the partner bank');
    expect(lines).toContain('status: root_cause_confirmed');
    expect(lines).toContain('matched_pattern_id: payout-bank-wait');
    for (const value of [CUSTOMER_UUID, FORM_UUID, HOP_SOURCE, 'PENDING_KYC', 'form_status', 'customer_id', 'form_id']) {
      expect(text.value).not.toContain(value);
    }
  });

  test('falls back to the classification when there is no report yet', () => {
    const text = caseCardText({ classification: classification(), report: null });
    expect(text.value).toBe(
      ['category: transfer_out', 'subcategory: stuck'].join('\n'),
    );
  });

  test('a run with neither gives an empty text', () => {
    expect(caseCardText({ classification: null, report: null }).value).toBe('');
  });

  test('the output passes the persisted-profile check even when a field was not masked', () => {
    const r = report();
    const text = caseCardText({
      classification: null,
      report: { ...r, root_cause: { statement: `customer ${SYNTHETIC_EMAIL} reports a stuck payout`, code_refs: [] } },
    });
    expect(text.value).not.toContain(SYNTHETIC_EMAIL);
    expect(checkEgress(text.value).ok).toBe(true);
  });
});

describe('requestText', () => {
  function run(messages: { text: string; is_parent: boolean }[], submissions: Submission[] = [submission(1)]) {
    const req = sampleRequest(RUN_A);
    return {
      request: { ...req, messages: messages.map((m, i) => ({ ts: `t${i}`, author: 'Asha Verma', ...m })) },
      submissions,
    } satisfies Pick<RunRecord, 'request' | 'submissions'>;
  }

  test('output passes the persisted-profile check', () => {
    const text = requestText(
      run([
        { text: `Customer on ${SYNTHETIC_PHONE} says the transfer is stuck`, is_parent: true },
        { text: `mail them at ${SYNTHETIC_EMAIL}`, is_parent: false },
      ]),
    );
    expect(isPersisted(text)).toBe(true);
    expect(checkEgress(text.value).ok).toBe(true);
    expect(text.value).not.toContain(SYNTHETIC_PHONE);
    expect(text.value).not.toContain(SYNTHETIC_EMAIL);
    expect(text.value.split('\n')[0]?.startsWith('parent: Customer on ')).toBe(true);
  });

  test('keeps the parent plus the newest messages, and no authors', () => {
    const messages = [{ text: 'the parent ask', is_parent: true }];
    for (let i = 1; i <= REQUEST_LATEST_MESSAGES + 2; i++) messages.push({ text: `reply ${i}`, is_parent: false });
    const text = requestText(run(messages));
    const lines = text.value.split('\n');
    expect(lines[0]).toBe('parent: the parent ask');
    expect(lines.slice(1)).toEqual(['message: reply 3', 'message: reply 4', 'message: reply 5']);
    expect(text.value).not.toContain('Asha');
  });

  test('a triage ask submission adds its question last', () => {
    const text = requestText(
      run([{ text: 'the parent ask', is_parent: true }], [submission(1), submission(2, 'ask', 'did the retry go through?')]),
    );
    expect(text.value.split('\n').at(-1)).toBe('ask: did the retry go through?');
  });

  test('collapses whitespace and caps long lines', () => {
    const text = requestText(run([{ text: `a\n\nb   ${'x'.repeat(LINE_CAP * 2)}`, is_parent: true }]));
    const line = text.value.split('\n')[0] as string;
    expect(line.startsWith('parent: a b x')).toBe(true);
    expect(line.length).toBe('parent: '.length + LINE_CAP);
  });
});
