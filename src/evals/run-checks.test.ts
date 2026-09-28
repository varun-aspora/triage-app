import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { REUSED_MARK } from '../runlog/actions.ts';
import type { RunEventLine } from '../runlog/event-log.ts';
import type { AuditLine } from '../types/audit.ts';
import type { Report } from '../types/report.ts';
import {
  countNotConfigured,
  journeyKeyedCitations,
  productionCalls,
  ranAgainRepeats,
  untracedLogValues,
} from './run-checks.ts';

const SAMPLE = fileURLToPath(new URL('../report/__fixtures__/sample-report.json', import.meta.url));
const DEVICE = '0d0d0d0d-1111-4222-8333-444444444444';
const USER = '0a0a0a0a-1111-4222-8333-555555555555';

const baseReport = (): Report => JSON.parse(readFileSync(SAMPLE, 'utf8')) as Report;

// A run log in the shape Flue writes: args on tool_start, the envelope as JSON text on tool.
let n = 0;
function call(name: string, args: unknown, output: Record<string, unknown> = { status: 'ok', data: {} }, id = `c${++n}`): RunEventLine[] {
  return [
    { ts: '2026-09-28T00:00:00.000Z', source: 'flue', type: 'tool_start', data: { toolName: name, toolCallId: id, args } },
    {
      ts: '2026-09-28T00:00:01.000Z',
      source: 'flue',
      type: 'tool',
      data: { toolName: name, toolCallId: id, isError: false, result: { content: [{ type: 'text', text: JSON.stringify(output) }] } },
    },
  ];
}

const line = (tool: string, exit: string, decision: 'allow' | 'deny' = 'allow') => ({ tool, exit, decision }) as unknown as AuditLine;

describe('ranAgainRepeats', () => {
  const q = { service: 'guardian', message: 'Processing Twilio callback' };

  test('an exact repeat of an ok call that ran again is counted; a reused one is not', () => {
    const reused = { status: 'ok', data: {}, message: `Already run by investigate_ssfb at 10:00:00Z; ${REUSED_MARK}.` };
    expect(ranAgainRepeats([...call('logs_search', q), ...call('logs_search', q, reused)])).toEqual([]);
    expect(ranAgainRepeats([...call('logs_search', q), ...call('logs_search', q)]).map((c) => c.name)).toEqual(['logs_search']);
  });

  test('a repeat after a refusal, different args and wrap-up tools are not counted', () => {
    const refused = { status: 'refused', message: 'Refused: no.' };
    expect(ranAgainRepeats([...call('logs_search', q, refused), ...call('logs_search', q)])).toEqual([]);
    expect(ranAgainRepeats([...call('logs_search', q), ...call('logs_search', { ...q, order: 'oldest' })])).toEqual([]);
    expect(ranAgainRepeats([...call('note_evidence', {}), ...call('note_evidence', {})])).toEqual([]);
  });
});

describe('untracedLogValues', () => {
  const knowledge = ['harbor logs `checking verification status` once per poll.'];

  test('a label from a knowledge file or an earlier result is traced, in any case and spacing', () => {
    const events = [
      ...call('repo_grep', { pattern: 'callback' }, { status: 'ok', data: { matches: ['log.Info("Processing Twilio callback")'] } }),
      ...call('logs_search', { message: 'Checking  verification status' }),
      ...call('logs_search', { any_of: [{ message: ['processing twilio callback'] }] }),
    ];
    expect(untracedLogValues(events, knowledge)).toEqual([]);
  });

  test('a made-up value, or one seen only in a later result, is reported by call and field, not by value', () => {
    const events = [
      ...call('logs_search', { error: 'sim not found' }, { status: 'ok', data: {} }, 'guess'),
      ...call('logs_search', { terms: [USER] }, { status: 'ok', data: { hits: [{ error: 'sim not found' }] } }),
    ];
    expect(untracedLogValues(events, knowledge)).toEqual([{ tool_call: 'guess', field: 'error' }]);
  });
});

describe('audit counts', () => {
  test('not configured lines are counted', () => {
    expect(countNotConfigured([line('sql_select', 'not_configured', 'deny'), line('sql_select', 'ok')])).toBe(1);
  });

  test('production calls leave out code tools, wrap-up tools, reused results and refusals', () => {
    const audit = [
      line('sql_select', 'ok'),
      line('logs_search', 'ok'),
      line('logs_search', 'reused'),
      line('http_call', 'refused', 'deny'),
      line('repo_grep', 'ok'),
      line('note_evidence', 'ok'),
      line('finish_report', 'ok'),
    ];
    expect(productionCalls(audit)).toBe(2);
  });
});

describe('journeyKeyedCitations', () => {
  const guardian = { entity: 'ssfb', service: 'guardian' };
  const withSource = (raw_ref: string): Report => {
    const r = baseReport();
    return { ...r, current_state: [{ ...r.current_state[0]!, source: { source: 'db', entity: 'ssfb', service: 'guardian', raw_ref } }] };
  };

  test('a row whose staged call was keyed by device_id counts; one keyed by the user id does not', () => {
    const events = [
      ...call('sql_select', { sql: 'SELECT status FROM device_auth_attempts WHERE device_id = $1', params: [DEVICE] }, undefined, 'dev'),
      ...call('sql_select', { sql: 'SELECT verification_id, device_id FROM refresh_tokens WHERE subject = $1', params: [USER] }, undefined, 'usr'),
    ];
    expect(journeyKeyedCitations(withSource('/data/dev.json'), events, guardian)).toBe(1);
    expect(journeyKeyedCitations(withSource('usr'), events, guardian)).toBe(0);
  });

  test('a raw_ref that names the device filter itself counts, and another service does not', () => {
    expect(journeyKeyedCitations(withSource('guardian.device_auth_attempts WHERE device_id = <device>'), [], guardian)).toBe(1);
    expect(journeyKeyedCitations(withSource('/data/dev.json'), [], { entity: 'ssfb', service: 'harbor' })).toBe(0);
  });
});
