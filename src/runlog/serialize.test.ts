import { describe, expect, test } from 'bun:test';
import { MAX_STRING_CHARS, toPlain, trimObservation, type SessionMemory } from './serialize.ts';

describe('toPlain', () => {
  test('copies into JSON-safe values: cycles, errors, bytes, dates, maps, sets, bigints, functions', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    const shared = { x: 1 };
    const err = new TypeError('bad thing');
    (err as unknown as { code: string }).code = 'E1';
    const out = toPlain({
      a,
      twice: [shared, shared],
      err,
      bytes: new Uint8Array(12),
      at: new Date('2026-09-25T10:00:00.000Z'),
      map: new Map([['k', 1]]),
      set: new Set(['s']),
      big: 10n,
      fn: () => 1,
      nan: Number.NaN,
      nothing: undefined,
    }) as Record<string, any>;
    expect(out.a).toEqual({ name: 'a', self: '[circular]' });
    // A value seen twice but not in a cycle is copied both times.
    expect(out.twice).toEqual([{ x: 1 }, { x: 1 }]);
    expect(out.err).toMatchObject({ name: 'TypeError', message: 'bad thing', code: 'E1' });
    expect(typeof out.err.stack).toBe('string');
    expect(out.bytes).toBe('[12 bytes]');
    expect(out.at).toBe('2026-09-25T10:00:00.000Z');
    expect(out.map).toEqual([['k', 1]]);
    expect(out.set).toEqual(['s']);
    expect(out.big).toBe('10');
    expect('fn' in out).toBe(false);
    expect(out.nan).toBe('NaN');
    expect(out.nothing).toBeNull();
    expect(() => JSON.stringify(out)).not.toThrow();
  });

  test('a long string keeps its head and says how much was cut', () => {
    const out = toPlain('x'.repeat(MAX_STRING_CHARS + 10)) as string;
    expect(out.startsWith('x'.repeat(MAX_STRING_CHARS))).toBe(true);
    expect(out.endsWith('…[10 more characters cut]')).toBe(true);
  });

  test('frozen input is read, not changed', () => {
    const input = Object.freeze({ list: Object.freeze([Object.freeze({ a: 'b' })]) });
    expect(toPlain(input)).toEqual({ list: [{ a: 'b' }] });
  });
});

describe('trimObservation', () => {
  test('streaming deltas are dropped', () => {
    for (const type of ['text_delta', 'thinking_delta', 'toolcall_delta']) expect(trimObservation({ type }, {})).toBeNull();
  });

  test('turn_request keeps the system prompt and tools once per session, and counts the messages', () => {
    const memory: SessionMemory = {};
    const request = (system: string, tools: { name: string }[]) => ({
      type: 'turn_request',
      turnId: 't',
      request: { requestedModel: 'm', input: { systemPrompt: system, tools, messages: [{}, {}, {}] } },
    });
    const first = trimObservation(request('you are triage', [{ name: 'sql_select' }]), memory) as any;
    expect(first.request.requestedModel).toBe('m');
    expect(first.request.input).toEqual({ systemPrompt: 'you are triage', tools: [{ name: 'sql_select' }], message_count: 3 });
    const second = trimObservation(request('you are triage', [{ name: 'sql_select' }]), memory) as any;
    expect(second.request.input).toEqual({ system_prompt_unchanged: true, tool_names: ['sql_select'], message_count: 3 });
    const third = trimObservation(request('you are triage, v2', [{ name: 'sql_select' }, { name: 'http_call' }]), memory) as any;
    expect(third.request.input.systemPrompt).toBe('you are triage, v2');
    expect(third.request.input.tools).toHaveLength(2);
  });

  test('repeated message lists become counts and roles; other events pass through whole', () => {
    expect(trimObservation({ type: 'agent_end', messages: [{}, {}] }, {})).toEqual({ type: 'agent_end', message_count: 2 });
    expect(trimObservation({ type: 'turn_messages', turnId: 't', message: { role: 'assistant' }, toolResults: [{}] }, {})).toEqual({
      type: 'turn_messages',
      turnId: 't',
      message_role: 'assistant',
      tool_result_count: 1,
    });
    expect(trimObservation({ type: 'message_start', message: { role: 'user', content: 'x' } }, {})).toEqual({
      type: 'message_start',
      message_role: 'user',
    });
    const tool = { type: 'tool', toolName: 'sql_select', result: { rows: 3 }, args: { sql: 'select 1' }, durationMs: 4 };
    expect(trimObservation(tool, {})).toBe(tool);
  });
});
