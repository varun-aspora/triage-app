// run_log: reads the run's action log (D79), the same lines a delegate's
// brief ends with, filtered and paged.
//
// Every agent has it. It reads memory only (src/runlog/actions.ts), never
// asks the budget and writes no audit line. The lines passed the persisted
// profile when they were recorded, so it returns nothing the run event log
// could not hold. An investigator sees its own entity's lines and the
// entity-free ones (root, code_walker), as in its brief; the root and
// code_walker see every line.

import { defineTool, type ToolDefinition } from '@flue/runtime/tool';
import * as v from 'valibot';
import { actionLine, actionsFor, visibleTo } from '../runlog/actions.ts';
import { ENTITIES } from '../types/core.ts';
import { ok, type ToolEnvelope } from '../types/tool-result.ts';
import type { ToolContext, ToolModule } from './types.ts';
import type {} from './_lib/context.ts';

export const RUN_LOG = 'run_log';

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;

export const RunLogInputSchema = v.strictObject({
  tool: v.optional(v.pipe(v.string(), v.maxLength(64), v.description('Only calls of this tool, for example sql_select.'))),
  agent: v.optional(
    v.pipe(v.string(), v.maxLength(64), v.description('Only calls by this agent: triage, investigate_<entity>, investigate_<entity>_deep or code_walker.')),
  ),
  for_entity: v.optional(v.pipe(v.picklist(ENTITIES), v.description('Only calls made for this entity.'))),
  offset: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.description('Lines to skip, oldest first. Default 0.'))),
  limit: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(MAX_LIMIT), v.description(`Lines to return, at most ${MAX_LIMIT}. Default ${DEFAULT_LIMIT}.`)),
  ),
});
export type RunLogInput = v.InferOutput<typeof RunLogInputSchema>;

const DESCRIPTION =
  'Read the tool calls already made in this run, by every agent: one line each with time (UTC), agent, tool, ' +
  'arguments (personal values masked) and outcome (rows, hits, groups, status or the refusal reason). Filter by tool, agent ' +
  'or for_entity; page with offset and limit, oldest first. Check it before a query that another agent may ' +
  'already have run. Returns total, offset, lines and next_offset when more remain. Uses no tool budget.';

/** The page of log lines this context may see. Pure over the run's current log. */
export function runLogPage(ctx: ToolContext, input: RunLogInput): { total: number; offset: number; lines: string[]; next_offset?: number } {
  const matching = actionsFor(ctx.runId)
    .filter(visibleTo(ctx.entity))
    .filter((a) => input.tool === undefined || a.tool === input.tool)
    .filter((a) => input.agent === undefined || a.agent === input.agent)
    .filter((a) => input.for_entity === undefined || a.entity === input.for_entity);
  const offset = input.offset ?? 0;
  const page = matching.slice(offset, offset + (input.limit ?? DEFAULT_LIMIT));
  const next = offset + page.length;
  return {
    total: matching.length,
    offset,
    lines: page.map(actionLine),
    ...(next < matching.length ? { next_offset: next } : {}),
  };
}

function create(ctx: ToolContext): ToolDefinition {
  return defineTool({
    name: RUN_LOG,
    description: DESCRIPTION,
    input: RunLogInputSchema,
    run: async ({ data, signal }): Promise<ToolEnvelope> => {
      signal?.throwIfAborted();
      return ok(runLogPage(ctx, data), ctx.deps.now);
    },
  });
}

export const toolModule: ToolModule = {
  name: RUN_LOG,
  mounts: ['triage', 'investigator', 'investigator_deep', 'code_walker'],
  entities: 'all',
  enabled: () => ({ on: true }),
  create,
};
