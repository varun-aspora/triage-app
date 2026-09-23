// The result every tool returns, wrapped in Flue's { output } envelope. Tools
// build it only through the helpers below, so taken_at is always set and a
// bare object is never returned.
import * as v from 'valibot';
import { type Entity, TakenAtSchema } from './core.ts';

export const TOOL_RESULT_STATUSES = ['ok', 'refused', 'not_configured', 'unreachable'] as const;
export const ToolResultStatusSchema = v.picklist(TOOL_RESULT_STATUSES);
export type ToolResultStatus = v.InferOutput<typeof ToolResultStatusSchema>;

export const ToolResultSchema = v.object({
  status: ToolResultStatusSchema,
  taken_at: TakenAtSchema,
  data: v.optional(v.unknown()),
  message: v.optional(v.string()),
});
export type ToolResult = v.InferOutput<typeof ToolResultSchema>;

export const ToolEnvelopeSchema = v.object({ output: ToolResultSchema });
export type ToolEnvelope = v.InferOutput<typeof ToolEnvelopeSchema>;

type Clock = () => Date;
const systemClock: Clock = () => new Date();

function envelope(result: Omit<ToolResult, 'taken_at'>, now: Clock): ToolEnvelope {
  return { output: { ...result, taken_at: now().toISOString() } };
}

export function ok(data: unknown, now: Clock = systemClock): ToolEnvelope {
  return envelope({ status: 'ok', data }, now);
}

// A gate or policy refusal. The message is shown to the model, so keep it short
// and say what to do instead.
export function refused(message: string, now: Clock = systemClock): ToolEnvelope {
  return envelope({ status: 'refused', message }, now);
}

// The backing env var for this entity and service is blank.
export function notConfigured(entity: Entity, service: string, now: Clock = systemClock): ToolEnvelope {
  return envelope({ status: 'not_configured', message: `not configured for ${entity}:${service}` }, now);
}

// The backing system could not be reached (tunnel down, timeout).
export function unreachable(message: string, now: Clock = systemClock): ToolEnvelope {
  return envelope({ status: 'unreachable', message }, now);
}
