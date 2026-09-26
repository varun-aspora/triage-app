// The first redaction layer for Braintrust tracing (D82): what a Flue event
// may carry before Braintrust's Flue bridge sees it.
//
// projectEvent() builds a new object from the event (observations are frozen,
// and the bridge ignores an event object it has seen, so the input is never
// changed). Only the event types the bridge reads pass; everything else
// (deltas, messages, logs, submission lifecycle) returns null.
//
// Two kinds of field:
//   - kept as sent: the envelope and correlation fields the bridge pairs spans
//     on (type, instanceId, submissionId, session, operationId, turnId,
//     toolCallId, taskId, ...), model and provider names, timings, token usage
//     (numbers only), finish reasons and error codes. They are copied from the
//     original event and never go through redactPersisted, so its 6+ digit
//     rule cannot change a ULID, a dated model id or a provider tool-call id
//     and break span pairing.
//   - content: messages, the system prompt, tool args and results, operation
//     input and output, task prompts and results, error messages. In
//     'metadata' mode each is replaced by its type and size. In 'redacted'
//     mode it goes through toPlain and redactPersisted with the run's ingress
//     names. Error stacks are dropped in both modes: they carry filesystem
//     layout, and Braintrust's error column is never masked.
//
// Images never leave in either mode. redactPersisted cannot mask a picture,
// and a screenshot (D36) rides inline in the dispatch message and in every
// turn's messages as { type: 'image', data, mimeType }. withoutBinary()
// replaces each such part with its type and size before redaction, and any
// other long base64 string that does not decode to text the same way.
//
// Pure: no I/O and no state. The second layer (the masking function in
// braintrust.ts) runs on every exported span field as well.

import type { TracingContentMode } from '../config/env.ts';
import { redactPersisted } from '../gate/redact.ts';
import { decodeBase64Text } from '../gate/redact-decode.ts';
import { toPlain } from '../runlog/serialize.ts';

/** The Flue event types Braintrust's bridge reads (braintrust 3.35.0). */
export const BRIDGE_EVENT_TYPES: readonly string[] = Object.freeze([
  'run_start',
  'run_resume',
  'run_end',
  'operation_start',
  'operation',
  'turn_request',
  'turn',
  'tool_start',
  'tool_call',
  'tool',
  'task_start',
  'task',
  'compaction_start',
  'compaction',
]);

const BRIDGE_TYPES = new Set(BRIDGE_EVENT_TYPES);

/** Envelope and correlation fields, copied as sent on every event. */
const ENVELOPE_FIELDS = [
  'type',
  'v',
  'eventIndex',
  'timestamp',
  'instanceId',
  'runId',
  'submissionId',
  'dispatchId',
  'agentName',
  'conversationId',
  'session',
  'parentSession',
  'harness',
  'taskId',
  'operationId',
  'turnId',
] as const;

/** Per-type fields that are not content, copied as sent. */
const KEPT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  run_start: ['workflowName', 'startedAt'],
  run_resume: ['workflowName', 'startedAt'],
  run_end: ['workflowName', 'isError', 'durationMs'],
  operation_start: ['operationKind'],
  operation: ['operationKind', 'isError', 'durationMs'],
  turn_request: ['purpose'],
  turn: ['purpose', 'isError', 'durationMs'],
  tool_start: ['toolName', 'toolCallId'],
  tool_call: ['toolName', 'toolCallId', 'isError', 'durationMs'],
  tool: ['toolName', 'toolCallId', 'isError', 'durationMs'],
  task_start: ['agent'],
  task: ['agent', 'isError', 'durationMs'],
  compaction_start: ['reason', 'estimatedTokens'],
  compaction: ['messagesBefore', 'messagesAfter', 'isError', 'durationMs'],
};

/** Per-type content fields, projected under the content mode. */
const CONTENT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  run_start: ['input', 'payload'],
  run_resume: [],
  run_end: ['result'],
  operation_start: [],
  operation: ['agentInput', 'agentOutput', 'result'],
  turn_request: [],
  turn: [],
  tool_start: ['args', 'arguments', 'input'],
  tool_call: ['result', 'output', 'effectiveResult'],
  tool: ['result', 'output', 'effectiveResult'],
  task_start: ['prompt', 'cwd'],
  task: ['result'],
  compaction_start: [],
  compaction: [],
};

/** Error fields: errorInfo keeps only its classification in 'metadata' mode. */
const ERROR_FIELDS = ['errorInfo', 'error'] as const;

/** Model request fields that name the model and provider (ModelRequestInfo). */
const REQUEST_INFO_FIELDS = ['providerId', 'providerName', 'requestedModel', 'api', 'reasoningLevel'] as const;

/** Model response fields that are not content (ModelResponse). */
const RESPONSE_INFO_FIELDS = ['responseModel', 'finishReason'] as const;

/** An error classification value (type, name, code) short and plain enough to send as is. */
const CLASSIFIER = /^[A-Za-z0-9_.:-]{1,100}$/;

/** An image part's MIME type, kept as sent. */
const MIME_TYPE = /^[a-z]+\/[a-z0-9.+-]{1,64}$/;

/** A string this long or longer made of base64 characters only is treated as binary unless it decodes to text. */
const MIN_BINARY_LENGTH = 1024;

const BASE64_ONLY = /^[A-Za-z0-9+/_-]+={0,2}$/;

type Plain = Record<string, unknown>;

/**
 * The event as Braintrust may see it, or null when the bridge does not read
 * its type. names are the run's ingress names; they matter only in
 * 'redacted' mode.
 */
export function projectEvent(event: unknown, mode: TracingContentMode, names: readonly string[] = []): Plain | null {
  if (!isRecord(event)) return null;
  const type = event.type;
  if (typeof type !== 'string' || !BRIDGE_TYPES.has(type)) return null;
  const content = (value: unknown): unknown => projectContent(value, mode, names);
  const out: Plain = {};
  for (const key of ENVELOPE_FIELDS) copyScalar(event, out, key);
  for (const key of KEPT_FIELDS[type] ?? []) copyScalar(event, out, key);
  for (const key of CONTENT_FIELDS[type] ?? []) {
    // effectiveResult is read when the key exists, even with an undefined value.
    if (Object.hasOwn(event, key)) out[key] = content(event[key]);
  }
  for (const key of ERROR_FIELDS) {
    if (event[key] !== undefined) out[key] = projectError(event[key], mode, names);
  }
  if (event.usage !== undefined) out.usage = numbersOnly(event.usage);
  if (type === 'operation') projectOperation(event, out, mode, names);
  if (type === 'turn_request' || type === 'turn') projectTurn(event, out, mode, names);
  return out;
}

/** A content value under the mode: its type and size, or its persisted-profile copy. */
export function projectContent(value: unknown, mode: TracingContentMode, names: readonly string[] = []): unknown {
  if (value === undefined) return undefined;
  if (mode === 'redacted') return redactPersisted(withoutBinary(toPlain(value)), { names }).value;
  return describe(value);
}

/**
 * The value with every image part ({ type: 'image', data }) replaced by
 * { type: 'image', mimeType, omitted: 'image', length }, and every other
 * long base64 string that is not text by a size note. Expects a plain value
 * (toPlain's output); anything else is returned as it is.
 */
export function withoutBinary(value: unknown): unknown {
  if (typeof value === 'string') return isBinary(value) ? `[binary omitted, ${value.length} chars]` : value;
  if (Array.isArray(value)) return value.map(withoutBinary);
  if (!isRecord(value)) return value;
  if (value.type === 'image' && typeof value.data === 'string') {
    const mimeType = typeof value.mimeType === 'string' && MIME_TYPE.test(value.mimeType) ? value.mimeType : undefined;
    return { type: 'image', ...(mimeType !== undefined ? { mimeType } : {}), omitted: 'image', length: value.data.length };
  }
  const out: Plain = {};
  for (const [key, v] of Object.entries(value)) out[key] = withoutBinary(v);
  return out;
}

// The first MIN_BINARY_LENGTH characters decide, so a large screenshot is not decoded whole.
function isBinary(s: string): boolean {
  return s.length >= MIN_BINARY_LENGTH && BASE64_ONLY.test(s) && decodeBase64Text(s.slice(0, MIN_BINARY_LENGTH)) === null;
}

/** What 'metadata' mode sends in place of content: the type and size, never the value. */
export function describe(value: unknown): unknown {
  if (value === undefined || value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return { omitted: 'string', length: value.length };
  if (Array.isArray(value)) return { omitted: 'array', length: value.length };
  if (typeof value === 'object') return { omitted: 'object', keys: Object.keys(value).length };
  return { omitted: typeof value };
}

// ------------------------------------------------------------------ internals

function projectOperation(event: Plain, out: Plain, mode: TracingContentMode, names: readonly string[]): void {
  // agentOutput keeps its shape (type, finishReason) so the bridge still picks text or data.
  const agentOutput = event.agentOutput;
  if (isRecord(agentOutput)) {
    const projected: Plain = {};
    copyScalar(agentOutput, projected, 'type');
    copyScalar(agentOutput, projected, 'finishReason');
    if (agentOutput.text !== undefined) projected.text = projectContent(agentOutput.text, mode, names);
    if (agentOutput.data !== undefined) projected.data = projectContent(agentOutput.data, mode, names);
    out.agentOutput = projected;
  }
  // The bridge reads result.usage to close turns an operation left open.
  const result = event.result;
  if (mode === 'metadata' && isRecord(result) && result.usage !== undefined && isRecord(out.result)) {
    out.result = { ...out.result, usage: numbersOnly(result.usage) };
  }
}

function projectTurn(event: Plain, out: Plain, mode: TracingContentMode, names: readonly string[]): void {
  const request = event.request;
  if (isRecord(request)) {
    const projected: Plain = {};
    for (const key of REQUEST_INFO_FIELDS) copyScalar(request, projected, key);
    if (isRecord(request.input)) projected.input = projectRequestInput(request.input, mode, names);
    out.request = projected;
  }
  const response = event.response;
  if (isRecord(response)) {
    const projected: Plain = {};
    for (const key of RESPONSE_INFO_FIELDS) copyScalar(response, projected, key);
    if (response.usage !== undefined) projected.usage = numbersOnly(response.usage);
    if (response.output !== undefined) projected.output = projectContent(response.output, mode, names);
    if (response.error !== undefined) projected.error = projectError(response.error, mode, names);
    if (response.errorInfo !== undefined) projected.errorInfo = projectError(response.errorInfo, mode, names);
    out.response = projected;
  }
}

function projectRequestInput(input: Plain, mode: TracingContentMode, names: readonly string[]): Plain {
  const out: Plain = {};
  if (input.systemPrompt !== undefined) out.systemPrompt = projectContent(input.systemPrompt, mode, names);
  if (Array.isArray(input.tools)) {
    // Tool names are ours, not run data; descriptions and schemas are only sent in 'redacted' mode.
    out.tools = mode === 'redacted' ? projectContent(input.tools, mode, names) : input.tools.map(toolName);
  }
  if (Array.isArray(input.messages)) {
    // Each message keeps its role, so the bridge still finds the latest user message.
    out.messages =
      mode === 'redacted' ? projectContent(input.messages, mode, names) : input.messages.map(describeMessage);
  } else if (input.messages !== undefined) {
    out.messages = projectContent(input.messages, mode, names);
  }
  return out;
}

function describeMessage(message: unknown): unknown {
  if (!isRecord(message)) return describe(message);
  const role = typeof message.role === 'string' && CLASSIFIER.test(message.role) ? message.role : undefined;
  return role === undefined ? { content: describe(message.content) } : { role, content: describe(message.content) };
}

function toolName(tool: unknown): unknown {
  if (isRecord(tool) && typeof tool.name === 'string' && CLASSIFIER.test(tool.name)) return { name: tool.name };
  return describe(tool);
}

/**
 * An error under the mode. 'metadata' keeps only the classification
 * (type, name, code); 'redacted' also keeps the message and meta, redacted.
 * The stack is dropped in both.
 */
function projectError(value: unknown, mode: TracingContentMode, names: readonly string[]): unknown {
  const plain = withoutBinary(toPlain(value));
  if (!isRecord(plain)) return mode === 'redacted' ? redactPersisted(plain, { names }).value : describe(plain);
  const out: Plain = {};
  for (const key of ['type', 'name', 'code'] as const) {
    const v = plain[key];
    if (typeof v === 'string' && CLASSIFIER.test(v)) out[key] = v;
  }
  if (mode === 'redacted') {
    const { stack: _stack, type: _type, name: _name, code: _code, ...rest } = plain;
    Object.assign(out, redactPersisted(dropStacks(rest), { names }).value as Plain);
  }
  return out;
}

function dropStacks(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(dropStacks);
  if (!isRecord(value)) return value;
  const out: Plain = {};
  for (const [key, v] of Object.entries(value)) if (key !== 'stack') out[key] = dropStacks(v);
  return out;
}

/** A usage record with its numbers only (PromptUsage: input, output, cache, totalTokens, cost.*). */
function numbersOnly(value: unknown): unknown {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (!isRecord(value)) return undefined;
  const out: Plain = {};
  for (const [key, v] of Object.entries(value)) {
    const n = numbersOnly(v);
    if (n !== undefined) out[key] = n;
  }
  return out;
}

/** Copies a string, number or boolean field as sent. Anything else is left out. */
function copyScalar(from: Plain, to: Plain, key: string): void {
  const value = from[key];
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') to[key] = value;
}

function isRecord(value: unknown): value is Plain {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
