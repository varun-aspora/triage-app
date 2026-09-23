import { describe, expect, test } from 'bun:test';
import type { TriageRequest } from '../types/request.ts';
import { renderAsk, renderThread } from './render-thread.ts';

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
