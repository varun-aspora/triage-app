// Turns a Flue observation or a pipeline payload into a JSON-safe value
// before it is redacted and written to a run's events.jsonl.
//
// toPlain copies any value into plain objects, arrays, strings, numbers,
// booleans and null, so the persisted redaction profile sees every string
// (it leaves class instances alone) and JSON.stringify cannot throw:
//   - a cycle becomes '[circular]';
//   - an Error becomes {name, message, stack?, cause?};
//   - bytes become '[<n> bytes]', a Date its ISO text, a bigint its digits,
//     a Map an array of [key, value], a Set an array;
//   - functions and symbols are dropped;
//   - a string longer than MAX_STRING_CHARS keeps its head and says how much was cut.
//
// trimObservation removes what would repeat on every line and adds nothing
// for debugging (see src/runlog/event-log.ts for the list).

/** Longest string kept whole in one event. */
export const MAX_STRING_CHARS = 64_000;

const CIRCULAR = '[circular]';

export function toPlain(value: unknown, maxString = MAX_STRING_CHARS): unknown {
  return copy(value, new WeakSet(), maxString);
}

function copy(value: unknown, seen: WeakSet<object>, maxString: number): unknown {
  if (value === null || value === undefined) return value ?? null;
  switch (typeof value) {
    case 'string':
      return clip(value, maxString);
    case 'number':
      return Number.isFinite(value) ? value : String(value);
    case 'boolean':
      return value;
    case 'bigint':
      return value.toString();
    case 'function':
    case 'symbol':
      return undefined;
  }
  const obj = value as object;
  if (seen.has(obj)) return CIRCULAR;
  if (obj instanceof Date) return Number.isNaN(obj.getTime()) ? null : obj.toISOString();
  if (obj instanceof ArrayBuffer) return `[${obj.byteLength} bytes]`;
  if (ArrayBuffer.isView(obj)) return `[${obj.byteLength} bytes]`;
  seen.add(obj);
  try {
    if (obj instanceof Error) {
      const out: Record<string, unknown> = { name: obj.name, message: clip(obj.message, maxString) };
      if (typeof obj.stack === 'string') out.stack = clip(obj.stack, maxString);
      if (obj.cause !== undefined) out.cause = copy(obj.cause, seen, maxString);
      for (const key of Object.keys(obj)) {
        if (!(key in out)) out[key] = copy((obj as unknown as Record<string, unknown>)[key], seen, maxString);
      }
      return out;
    }
    if (Array.isArray(obj)) return obj.map((item) => copy(item, seen, maxString) ?? null);
    if (obj instanceof Map) return [...obj.entries()].map(([k, v]) => [copy(k, seen, maxString), copy(v, seen, maxString)]);
    if (obj instanceof Set) return [...obj.values()].map((item) => copy(item, seen, maxString));
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj)) {
      const item = copy((obj as Record<string, unknown>)[key], seen, maxString);
      if (item !== undefined) out[key] = item;
    }
    return out;
  } finally {
    seen.delete(obj);
  }
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…[${text.length - max} more characters cut]`;
}

// ------------------------------------------------------------------ trimming

/** Streaming fragments: the completed message, thinking block or tool call carries the same text. */
export const DROPPED_EVENT_TYPES: ReadonlySet<string> = new Set(['text_delta', 'thinking_delta', 'toolcall_delta']);

/** What was last written for one session, so the system prompt and tool list are written only when they change. */
export type SessionMemory = { systemPrompt?: string; tools?: string };

type Message = { role?: unknown };

/**
 * The observation to write, or null to drop it. memory is per run and
 * session and is updated in place.
 *   - turn_request: the system prompt and the tool definitions only when
 *     they differ from the last ones written for the session, else
 *     `system_prompt_unchanged` / the tool names; the messages as a count,
 *     since each one is written by its own message_end;
 *   - agent_end: the messages as a count (the run's output is in message_end);
 *   - turn_messages: the roles and counts (the same messages as message_end);
 *   - message_start: the role only (the finished message is in message_end).
 */
export function trimObservation(event: Record<string, unknown>, memory: SessionMemory): Record<string, unknown> | null {
  const type = event.type;
  if (typeof type !== 'string' || DROPPED_EVENT_TYPES.has(type)) return null;
  switch (type) {
    case 'turn_request':
      return trimTurnRequest(event, memory);
    case 'agent_end': {
      const { messages, ...rest } = event;
      return { ...rest, message_count: Array.isArray(messages) ? messages.length : 0 };
    }
    case 'turn_messages': {
      const { message, toolResults, ...rest } = event;
      return {
        ...rest,
        message_role: (message as Message | undefined)?.role ?? null,
        tool_result_count: Array.isArray(toolResults) ? toolResults.length : 0,
      };
    }
    case 'message_start': {
      const { message, ...rest } = event;
      return { ...rest, message_role: (message as Message | undefined)?.role ?? null };
    }
    default:
      return event;
  }
}

function trimTurnRequest(event: Record<string, unknown>, memory: SessionMemory): Record<string, unknown> {
  const request = (event.request ?? {}) as Record<string, unknown>;
  const input = (request.input ?? {}) as { systemPrompt?: unknown; messages?: unknown; tools?: unknown };
  const out: Record<string, unknown> = {};
  const system = typeof input.systemPrompt === 'string' ? input.systemPrompt : undefined;
  if (system !== undefined) {
    if (system !== memory.systemPrompt) {
      out.systemPrompt = system;
      memory.systemPrompt = system;
    } else {
      out.system_prompt_unchanged = true;
    }
  }
  if (Array.isArray(input.tools)) {
    const key = safeJson(input.tools);
    if (key !== memory.tools) {
      out.tools = input.tools;
      memory.tools = key;
    } else {
      out.tool_names = input.tools.map((t) => (t as { name?: unknown }).name ?? null);
    }
  }
  out.message_count = Array.isArray(input.messages) ? input.messages.length : 0;
  return { ...event, request: { ...request, input: out } };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(toPlain(value));
  } catch {
    return '';
  }
}
