// All values below are synthetic: example.com addresses, made-up names,
// phones and account numbers.
import { describe, expect, test } from 'bun:test';
import { checkEgress } from '../gate/redact.ts';
import { BRIDGE_EVENT_TYPES, describe as describeValue, projectContent, projectEvent, withoutBinary } from './redact-event.ts';

const NAME = 'Asha Verma';
const EMAIL = 'asha.verma@example.com';
const PHONE = '+91 98765 43210';
const ACCOUNT = '918020012345';
const PII = `${NAME} (${EMAIL}, ${PHONE}) says account ${ACCOUNT} was debited twice`;
const CONTENT_MARKERS = ['Asha', 'Verma', EMAIL, '98765', ACCOUNT, 'debited'];

// Ids with 6+ digit runs, which the persisted profile would mask.
const RUN = '01M3EN7034701234ABCDEFGHJK';
const SUBMISSION = 'sub_01M3EN7034703470QRSTVWXYZ0';
const TASK = '01M3EN7034709999ABCDEFGHJK';
const SESSION = `task-${TASK}`;
const TOOL_CALL = 'toolu_01234567890123';
const MODEL = 'claude-sonnet-4-5-20250929';

const envelope = {
  v: 3,
  eventIndex: 7,
  timestamp: '2026-09-26T10:00:00.000Z',
  instanceId: RUN,
  submissionId: SUBMISSION,
  agentName: 'triage',
  session: SESSION,
  harness: 'default',
  taskId: TASK,
  operationId: 'op_01M3EN7034701111',
  turnId: 'turn_01M3EN7034702222',
};

const usage = { input: 1200, output: 300, cacheRead: 100, cacheWrite: 0, totalTokens: 1600, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 } };
const errorInfo = { type: 'tool_error', name: 'SqlGateError', code: 'refused', message: `refused for ${EMAIL}`, meta: { phone: PHONE }, stack: 'Error: x\n    at /Users/someone/app/src/x.ts:1:1' };

/** One event of every type the bridge reads, each carrying PII in its content fields. */
const EVENTS: Record<string, Record<string, unknown>> = {
  operation_start: { ...envelope, type: 'operation_start', operationKind: 'prompt' },
  operation: {
    ...envelope,
    type: 'operation',
    operationKind: 'prompt',
    durationMs: 900,
    isError: true,
    usage,
    agentInput: { text: PII },
    agentOutput: { type: 'text', text: PII, finishReason: 'stop' },
    result: { text: PII, usage },
    error: new Error(`failed for ${NAME}`),
    errorInfo,
  },
  turn_request: {
    ...envelope,
    type: 'turn_request',
    purpose: 'agent',
    request: {
      providerId: 'anthropic',
      providerName: 'anthropic',
      requestedModel: MODEL,
      api: 'anthropic-messages',
      reasoningLevel: 'medium',
      serverAddress: 'api.example.com',
      input: {
        systemPrompt: `You help ${NAME}`,
        messages: [
          { role: 'user', content: PII },
          { role: 'assistant', content: [{ type: 'toolCall', id: TOOL_CALL, name: 'sql_select', arguments: { q: PII } }] },
          { role: 'toolResult', toolCallId: TOOL_CALL, toolName: 'sql_select', content: [{ type: 'text', text: PII }], isError: false },
        ],
        tools: [{ name: 'sql_select', description: `lookups for ${NAME}`, parameters: { type: 'object' } }],
      },
    },
  },
  turn: {
    ...envelope,
    type: 'turn',
    purpose: 'agent',
    durationMs: 400,
    isError: true,
    request: { providerId: 'anthropic', providerName: 'anthropic', requestedModel: MODEL, api: 'anthropic-messages' },
    response: {
      responseId: 'msg_1',
      responseModel: MODEL,
      finishReason: 'error',
      usage,
      output: { role: 'assistant', content: [{ type: 'text', text: PII }] },
      error: errorInfo,
    },
  },
  tool_start: { ...envelope, type: 'tool_start', toolName: 'sql_select', toolCallId: TOOL_CALL, args: { sql: `select * from t where email = '${EMAIL}'` }, description: PII, origin: 'model' },
  tool: {
    ...envelope,
    type: 'tool',
    toolName: 'sql_select',
    toolCallId: TOOL_CALL,
    isError: true,
    durationMs: 12,
    result: { rows: [{ name: NAME, account: ACCOUNT }] },
    effectiveResult: { rows: [{ phone: PHONE }] },
    errorInfo,
  },
  task_start: { ...envelope, type: 'task_start', prompt: PII, agent: 'investigate_ssfb', cwd: '/Users/someone/home' },
  task: { ...envelope, type: 'task', agent: 'investigate_ssfb', isError: false, durationMs: 50, result: { text: PII } },
  compaction_start: { ...envelope, type: 'compaction_start', reason: 'threshold', estimatedTokens: 90000 },
  compaction: { ...envelope, type: 'compaction', messagesBefore: 40, messagesAfter: 8, durationMs: 30, isError: true, error: new Error(`compaction failed on ${PHONE}`), usage },
};

function project(type: string, mode: 'metadata' | 'redacted', names: readonly string[] = []): Record<string, unknown> {
  const out = projectEvent(Object.freeze(EVENTS[type]), mode, names);
  if (out === null) throw new Error(`${type} was dropped`);
  return out;
}

describe('projectEvent: which events pass', () => {
  test('only the event types the bridge reads pass; everything else is null', () => {
    for (const type of ['text_delta', 'thinking_delta', 'toolcall_delta', 'message_end', 'turn_messages', 'turn_start', 'log', 'idle', 'submission_settled', 'agent_end']) {
      expect(projectEvent({ ...envelope, type, text: PII }, 'metadata')).toBeNull();
      expect(projectEvent({ ...envelope, type, text: PII }, 'redacted')).toBeNull();
    }
    for (const bad of [null, undefined, 'turn', 42, [], { type: 7 }]) expect(projectEvent(bad, 'metadata')).toBeNull();
    for (const type of Object.keys(EVENTS)) expect(BRIDGE_EVENT_TYPES).toContain(type);
  });

  test('the event is never changed, and the result is a new object', () => {
    const event = Object.freeze({ ...EVENTS.tool, result: Object.freeze({ rows: [] }) });
    const before = JSON.stringify(event);
    const out = projectEvent(event, 'redacted');
    expect(out).not.toBe(event);
    expect(JSON.stringify(event)).toBe(before);
  });
});

describe("projectEvent: 'metadata' mode", () => {
  test('no content survives in any event type', () => {
    for (const type of Object.keys(EVENTS)) {
      const json = JSON.stringify(project(type, 'metadata'));
      for (const marker of CONTENT_MARKERS) expect(json).not.toContain(marker);
      expect(json).not.toContain('/Users/someone');
      expect(json).not.toContain('api.example.com');
    }
  });

  test('ids, model names, timings, usage and finish reasons survive as sent', () => {
    for (const type of Object.keys(EVENTS)) {
      const out = project(type, 'metadata');
      for (const key of Object.keys(envelope)) expect(out[key]).toBe((envelope as Record<string, unknown>)[key]);
      expect(out.type).toBe(type);
    }
    const turn = project('turn', 'metadata') as any;
    expect(turn.request).toEqual({ providerId: 'anthropic', providerName: 'anthropic', requestedModel: MODEL, api: 'anthropic-messages' });
    expect(turn.response.responseModel).toBe(MODEL);
    expect(turn.response.finishReason).toBe('error');
    expect(turn.response.usage).toEqual(usage);
    expect(turn.durationMs).toBe(400);
    const tool = project('tool', 'metadata');
    expect(tool.toolCallId).toBe(TOOL_CALL);
    expect(tool.toolName).toBe('sql_select');
    expect(project('operation', 'metadata').usage).toEqual(usage);
    expect(project('compaction_start', 'metadata')).toMatchObject({ reason: 'threshold', estimatedTokens: 90000 });
    expect(project('task_start', 'metadata').agent).toBe('investigate_ssfb');
  });

  test('content becomes its type and size, and messages keep their roles', () => {
    const request = (project('turn_request', 'metadata') as any).request;
    expect(request.input.systemPrompt).toEqual({ omitted: 'string', length: `You help ${NAME}`.length });
    expect(request.input.messages.map((m: any) => m.role)).toEqual(['user', 'assistant', 'toolResult']);
    expect(request.input.messages[0].content).toEqual({ omitted: 'string', length: PII.length });
    expect(request.input.tools).toEqual([{ name: 'sql_select' }]);
    expect(project('tool_start', 'metadata').args).toEqual({ omitted: 'object', keys: 1 });
    const op = project('operation', 'metadata') as any;
    expect(op.agentInput).toEqual({ omitted: 'object', keys: 1 });
    expect(op.agentOutput).toEqual({ type: 'text', finishReason: 'stop', text: { omitted: 'string', length: PII.length } });
    expect(op.result).toEqual({ omitted: 'object', keys: 2, usage });
  });

  test('an error keeps only its type, name and code, never the message, meta or stack', () => {
    expect(project('tool', 'metadata').errorInfo).toEqual({ type: 'tool_error', name: 'SqlGateError', code: 'refused' });
    expect((project('turn', 'metadata') as any).response.error).toEqual({ type: 'tool_error', name: 'SqlGateError', code: 'refused' });
    expect(project('operation', 'metadata').error).toEqual({ name: 'Error' });
  });

  test('effectiveResult stays an own key when it was one, even undefined', () => {
    const out = projectEvent({ ...EVENTS.tool, effectiveResult: undefined }, 'metadata');
    expect(out !== null && Object.hasOwn(out, 'effectiveResult')).toBe(true);
    const without = { ...EVENTS.tool };
    delete without.effectiveResult;
    const out2 = projectEvent(without, 'metadata');
    expect(out2 !== null && Object.hasOwn(out2, 'effectiveResult')).toBe(false);
  });
});

describe("projectEvent: 'redacted' mode", () => {
  test('checkEgress is ok on every content field, with the run names', () => {
    const names = [NAME];
    for (const type of Object.keys(EVENTS)) {
      const out = project(type, 'redacted', names);
      const content = { ...out };
      // The ids are kept as sent on purpose; the check is on everything else.
      for (const key of [...Object.keys(envelope), 'toolCallId', 'type']) delete content[key];
      if (typeof content.request === 'object' && content.request !== null) {
        const { requestedModel: _m, ...rest } = content.request as Record<string, unknown>;
        content.request = rest;
      }
      if (typeof content.response === 'object' && content.response !== null) {
        const { responseModel: _m, ...rest } = content.response as Record<string, unknown>;
        content.response = rest;
      }
      expect({ type, egress: checkEgress(content, { names }) }).toEqual({ type, egress: { ok: true } });
    }
  });

  test('content is kept, redacted, and the correlation fields are unchanged', () => {
    const out = project('turn_request', 'redacted', [NAME]) as any;
    const text = JSON.stringify(out.request.input.messages);
    expect(text).toContain('was debited twice');
    expect(text).toContain('****2345');
    expect(text).not.toContain(EMAIL);
    expect(text).not.toContain(NAME);
    expect(out.request.requestedModel).toBe(MODEL);
    expect(out.submissionId).toBe(SUBMISSION);
    expect(out.session).toBe(SESSION);
    expect(out.instanceId).toBe(RUN);
    const tool = project('tool', 'redacted', [NAME]);
    expect(tool.toolCallId).toBe(TOOL_CALL);
    expect(tool.taskId).toBe(TASK);
  });

  test('an error keeps its redacted message and meta, never its stack', () => {
    const info = project('tool', 'redacted') as any;
    expect(info.errorInfo.type).toBe('tool_error');
    expect(info.errorInfo.message).toContain('refused for');
    expect(info.errorInfo.message).not.toContain(EMAIL);
    expect(info.errorInfo.meta.phone).not.toContain('98765');
    expect(JSON.stringify(info)).not.toContain('stack');
    const op = project('operation', 'redacted', [NAME]) as any;
    expect(op.error.name).toBe('Error');
    expect(op.error.message).toContain('failed for');
    expect(op.error.message).not.toContain(NAME);
    expect(JSON.stringify(op)).not.toContain('/Users/someone');
  });

  test('tool definitions and the system prompt are sent redacted', () => {
    const out = project('turn_request', 'redacted', [NAME]) as any;
    expect(out.request.input.tools[0].name).toBe('sql_select');
    expect(out.request.input.tools[0].description).not.toContain(NAME);
    expect(out.request.input.systemPrompt).toContain('You help');
    expect(out.request.input.systemPrompt).not.toContain(NAME);
  });
});

describe('describe and projectContent', () => {
  test('describe gives the type and size only', () => {
    expect(describeValue('abc')).toEqual({ omitted: 'string', length: 3 });
    expect(describeValue([1, 2])).toEqual({ omitted: 'array', length: 2 });
    expect(describeValue({ a: 1 })).toEqual({ omitted: 'object', keys: 1 });
    expect(describeValue(918020012345)).toEqual({ omitted: 'number' });
    expect(describeValue(true)).toBe(true);
    expect(describeValue(null)).toBeNull();
    expect(describeValue(undefined)).toBeUndefined();
  });

  test('projectContent redacts in redacted mode and describes otherwise', () => {
    expect(projectContent(PII, 'metadata')).toEqual({ omitted: 'string', length: PII.length });
    expect(checkEgress(projectContent({ text: PII }, 'redacted', [NAME]), { names: [NAME] })).toEqual({ ok: true });
    expect(projectContent(undefined, 'redacted')).toBeUndefined();
  });
});

describe('images and binary', () => {
  // Stands in for a screenshot: PNG header bytes and noise, base64, which does not decode to text.
  const bytes = new Uint8Array(3000).map((_, i) => (i < 8 ? [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a][i]! : (i * 131 + 7) % 256));
  const IMAGE = Buffer.from(bytes).toString('base64');

  test("'redacted' mode: an image part in a turn's messages and in the operation's agentInput is replaced by its type and size", () => {
    const turn = projectEvent(
      {
        ...envelope,
        type: 'turn_request',
        purpose: 'agent',
        request: {
          requestedModel: MODEL,
          input: { messages: [{ role: 'user', content: [{ type: 'text', text: PII }, { type: 'image', data: IMAGE, mimeType: 'image/png' }] }] },
        },
      },
      'redacted',
      [NAME],
    );
    const operation = projectEvent(
      {
        ...envelope,
        type: 'operation',
        operationKind: 'prompt',
        agentInput: { kind: 'user', body: PII, attachments: [{ type: 'image', data: IMAGE, mimeType: 'image/png' }] },
      },
      'redacted',
      [NAME],
    );
    const request = (turn as Record<string, any>).request;
    // The content fields only: the ids are kept as sent.
    for (const content of [request.input, (operation as Record<string, any>).agentInput]) {
      const json = JSON.stringify(content);
      expect(json).not.toContain(IMAGE.slice(0, 64));
      expect(json).toContain('"omitted":"image"');
      expect(checkEgress(content, { names: [NAME] })).toEqual({ ok: true });
    }
    expect(request.input.messages[0].content[1]).toEqual({ type: 'image', mimeType: 'image/png', omitted: 'image', length: IMAGE.length });
    expect((operation as Record<string, any>).agentInput.attachments[0]).toEqual({ type: 'image', mimeType: 'image/png', omitted: 'image', length: IMAGE.length });
  });

  test("'metadata' mode sends no image data either", () => {
    const out = projectEvent({ ...envelope, type: 'operation', operationKind: 'prompt', agentInput: { attachments: [{ type: 'image', data: IMAGE }] } }, 'metadata');
    expect(JSON.stringify(out)).not.toContain(IMAGE.slice(0, 64));
  });

  test('withoutBinary replaces a long base64 string that is not text, and keeps text, short strings and base64 text', () => {
    expect(withoutBinary({ blob: IMAGE })).toEqual({ blob: `[binary omitted, ${IMAGE.length} chars]` });
    const textB64 = Buffer.from(PII.repeat(20)).toString('base64');
    expect(withoutBinary(textB64)).toBe(textB64);
    expect(withoutBinary('short')).toBe('short');
    expect(withoutBinary(PII.repeat(40))).toBe(PII.repeat(40));
    // A made-up MIME type is left off, never sent as free text.
    expect(withoutBinary({ type: 'image', data: 'abc', mimeType: `image ${EMAIL}` })).toEqual({ type: 'image', omitted: 'image', length: 3 });
  });
});
