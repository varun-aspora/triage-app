// The event types an events.jsonl line can have, by source. `triage logs`
// lists them in its help, since --type is an exact match on the name.
//
//   - pipeline: the type argument of every logRunEvent call under src/.
//     event-types.test.ts greps src/ for them, so a new call without an
//     entry here fails the test.
//   - flue: every FlueObservation type from @flue/runtime, less the
//     streaming deltas trimObservation drops (DROPPED_EVENT_TYPES in
//     serialize.ts). The type check below fails when a Flue upgrade adds or
//     removes a type.

import type { FlueObservation } from '@flue/runtime';
import type { RunEventSource } from './event-log.ts';

export const PIPELINE_EVENT_TYPES = [
  'run_created',
  'preflight',
  'identity',
  'classifier',
  'classification',
  'phase',
  'dispatch',
  'sql_retry',
  'blocked',
  'settled',
  'failed',
  'stop_seen',
  'stop',
  'resume_preflight',
  'resume',
  'feedback',
  'usage_flush_failed',
  'usage_write_failed',
  'usage_missing',
  'usage_unassigned',
  'server_shutdown',
] as const;

export const FLUE_EVENT_TYPES = [
  'agent_start',
  'agent_end',
  'submission_queued',
  'submission_running',
  'submission_recovery',
  'submission_settled',
  'operation_start',
  'operation',
  'turn_start',
  'turn_request',
  'turn',
  'turn_messages',
  'message_start',
  'message_end',
  'thinking_start',
  'thinking_end',
  'tool_start',
  'tool',
  'task_start',
  'task',
  'compaction_start',
  'compaction',
  'log',
  'idle',
] as const;

/** Every type a line of events.jsonl can have, by source. */
export const RUN_EVENT_TYPES: Readonly<Record<RunEventSource, readonly string[]>> = {
  pipeline: PIPELINE_EVENT_TYPES,
  flue: FLUE_EVENT_TYPES,
};

// Keep in step with DROPPED_EVENT_TYPES in serialize.ts.
type DroppedFlueType = 'text_delta' | 'thinking_delta' | 'toolcall_delta';
type WrittenFlueType = Exclude<FlueObservation['type'], DroppedFlueType>;
type Listed = (typeof FLUE_EVENT_TYPES)[number];
// Both are `true` only while the list and Flue's union match exactly.
const _noneMissing: [Exclude<WrittenFlueType, Listed>] extends [never] ? true : false = true;
const _noneExtra: [Exclude<Listed, WrittenFlueType>] extends [never] ? true : false = true;
void _noneMissing;
void _noneExtra;
