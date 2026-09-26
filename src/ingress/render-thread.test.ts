import { describe, expect, test } from 'bun:test';
import type { TriageRequest } from '../types/request.ts';
import { renderAnswer, renderAsk, renderResume, renderThread } from './render-thread.ts';

const PAN = '4111111111111111';
const ACCOUNT = '918020012345678';
const AT = '2026-09-24T10:00:00.000Z';

function request(text: string): TriageRequest {
  return {
    request_id: '01JRENDERAAAAAAAAAAAAAAAAA',
    interface: 'cli',
    requested_by: 'ops.reviewer@example.com',
    source: { kind: 'thread_file' },
    messages: [
      { ts: '1695460000.123456', author: 'Asha Verma', text, is_parent: true },
      { ts: '1695460100.000001', author: '', text: 'any update?', is_parent: false },
    ],
    attachments: [],
    hints: {},
    window: { from: AT, to: AT },
    received_at: AT,
  };
}

describe('renderThread', () => {
  test('a PAN in the thread text is masked and the account number is kept', () => {
    const body = renderThread(request(`Card ${PAN} charged, account ${ACCOUNT} shows nothing, phone +91 98765 43210`));
    expect(body).not.toContain(PAN);
    expect(body).toContain('****1111');
    expect(body).toContain(ACCOUNT);
    // Phones and names are search keys in the model-facing profile.
    expect(body).toContain('+91 98765 43210');
    expect(body).toContain('Asha Verma');
  });

  test('the email local part of requested_by is masked', () => {
    const body = renderThread(request('hello'));
    expect(body).not.toContain('ops.reviewer@');
    expect(body).toContain('example.com');
  });

  test('messages are listed parent first with their ts and author', () => {
    const body = renderThread(request('first'));
    const parent = body.indexOf('--- parent · 1695460000.123456 · Asha Verma');
    const reply = body.indexOf('--- reply · 1695460100.000001 · unknown author');
    expect(parent).toBeGreaterThan(-1);
    expect(reply).toBeGreaterThan(parent);
    expect(body).toContain('Thread (2 messages, parent first)');
    expect(body).toContain(`Investigation window: ${AT} to ${AT}`);
  });

  test('image notes', () => {
    expect(renderThread(request('x'))).not.toContain('screenshot');
    expect(renderThread(request('x'), { attached: 2, dropped: 0 })).toContain('2 screenshots from the thread are attached');
    const dropped = renderThread(request('x'), { attached: 0, dropped: 1, dropReason: 'the model does not take images' });
    expect(dropped).toContain('1 screenshot was left out: the model does not take images');
    expect(dropped).toContain('screenshots were not analysed');
  });

  test('a secret pasted in the thread is masked', () => {
    const body = renderThread(request('db is postgresql://triage:hunter2secret@db.internal:5432/x'));
    expect(body).not.toContain('hunter2secret');
  });
});

describe('renderAsk', () => {
  test('masks a PAN in the question and keeps the account number', () => {
    const body = renderAsk(`Was card ${PAN} refunded to ${ACCOUNT}?`, 'ops@example.com');
    expect(body).not.toContain(PAN);
    expect(body).toContain(ACCOUNT);
    expect(body).toContain('finish_report');
  });
});

describe('renderAnswer', () => {
  const q = { question_id: 'q1', question: 'Which transfer: the one on 2 Sep or the one on 3 Sep?' };

  test('an answer names who answered, quotes the question, keeps the account number and masks a PAN', () => {
    const text = renderAnswer(q, { skip: false, answer: `card ${PAN} on account ${ACCOUNT}`, by: 'ops-reviewer', ids: {}, gaps: [] });
    expect(text).toContain('Answer from ops-reviewer to your question q1 ("Which transfer: the one on 2 Sep or the one on 3 Sep?"):');
    expect(text).not.toContain(PAN);
    expect(text).toContain(ACCOUNT);
    expect(text).toContain('call finish_report with the report');
    expect(text).not.toContain('Ids they gave');
    expect(text).not.toContain('Identity lookups');
  });

  test('a skip says so and asks for the gap', () => {
    const text = renderAnswer(q, { skip: true, answer: '', by: 'ops-reviewer', ids: {}, gaps: [] });
    expect(text).toContain('ops-reviewer skipped your question q1 ("Which transfer');
    expect(text).toContain('list the open question under gaps');
    expect(text).not.toContain('call finish_report with the report');
  });

  test('verified ids and identity gaps are listed, and a long question is cut', () => {
    const long = { question_id: 'q2', question: `${'x'.repeat(200)}\n  y` };
    const text = renderAnswer(long, {
      skip: false,
      answer: 'yes',
      by: 'ops',
      ids: { account_form_id: 'f-1', customer_id: 'c-1' },
      gaps: ['identity lookup unreachable: ssfb:harbor'],
    });
    expect(text).toContain('Ids they gave, resolved by the identity step and in scope: customer_id = c-1, account_form_id = f-1.');
    expect(text).toContain('Identity lookups: identity lookup unreachable: ssfb:harbor.');
    expect(text).toContain(`${'x'.repeat(120)}…`);
    expect(text).not.toContain('x'.repeat(121));
  });
});

describe('renderResume', () => {
  const block = {
    block_id: 'b1',
    systems: ['ssfb:harbor', 'global:codegraph'],
    reason: 'The account form lives in harbor.\n  Nothing else shows the payout state.',
  };
  const none = { by: 'ops', at: AT, note: '' };

  test('a blocked run: the block, the systems, the reason on one line, who resumed it and when, and the note', () => {
    const text = renderResume(
      { kind: 'blocked', block },
      { by: 'ops-reviewer', at: AT, note: `harbor is back; card ${PAN} was the test card on ${ACCOUNT}` },
    );
    expect(text).toContain(
      'This run was blocked (b1) because ssfb:harbor and global:codegraph did not answer: The account form lives in harbor. Nothing else shows the payout state.',
    );
    expect(text).toContain(`ops-reviewer resumed it at ${AT}.`);
    expect(text).toContain('Message from ops-reviewer:');
    expect(text).toContain('harbor is back');
    expect(text).toContain('Take the message into account');
    // Model-facing profile: the PAN is masked, the account number is kept.
    expect(text).not.toContain(PAN);
    expect(text).toContain(ACCOUNT);
    expect(text).toContain('ssfb:harbor and global:codegraph are expected to answer now.');
    expect(text).toContain('the evidence you noted stands');
    expect(text).toContain('call finish_report with the report');
    expect(text).toContain('call stop_blocked again');
  });

  test('one system reads as singular, and no note means no note line', () => {
    const text = renderResume({ kind: 'blocked', block: { ...block, systems: ['ssfb:harbor'] } }, none);
    expect(text).toContain('because ssfb:harbor did not answer');
    expect(text).toContain('ssfb:harbor is expected to answer now.');
    expect(text).not.toContain('Message from');
    expect(text).not.toContain('Take the message into account');
  });

  test('a failed run names the phase reason and a stopped run says so; both end with finish_report or stop_blocked', () => {
    const failed = renderResume({ kind: 'failed', reason: 'AgentRunError' }, none);
    expect(failed).toContain('This run failed (AgentRunError) before it finished.');
    expect(failed).toContain(`ops resumed it at ${AT}.`);
    expect(failed).not.toContain('expected to answer now');
    expect(failed).toContain('call finish_report with the report');
    expect(failed).toContain('call stop_blocked.');
    expect(renderResume({ kind: 'failed' }, none)).toContain('This run failed before it finished.');
    const stopped = renderResume({ kind: 'stopped' }, none);
    expect(stopped).toContain('This run was stopped before it finished.');
    expect(stopped).toContain('the evidence you noted stands');
  });

  test('the email local part of who resumed is masked', () => {
    const text = renderResume({ kind: 'stopped' }, { ...none, by: 'ops.reviewer@example.com' });
    expect(text).not.toContain('ops.reviewer@');
    expect(text).toContain('example.com');
  });
});

