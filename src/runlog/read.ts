// Reads a run's events.jsonl for GET /triage/:run_id/events and `triage logs`.
//
// Lines are numbered from 0 in file order; `after` is the number of lines
// the caller already has, so polling with the returned `next` gets only new
// lines. A missing file is an empty log (the run has not logged yet, or the
// log was not installed). A line that does not parse, such as a partial last
// line while a write is in progress, ends the page there and is read again
// on the next call.
//
// The whole file is read on each call. That is fine at v1 sizes; a long run
// writes a few MB.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as v from 'valibot';
import { RunIdSchema } from '../types/core.ts';
import { EVENTS_FILE, RUN_EVENT_SOURCES, type RunEventLine } from './event-log.ts';

export const DEFAULT_EVENTS_LIMIT = 500;
export const MAX_EVENTS_LIMIT = 5000;

const LineSchema = v.object({
  ts: v.string(),
  source: v.picklist(RUN_EVENT_SOURCES),
  type: v.string(),
  data: v.unknown(),
});

export type NumberedRunEvent = RunEventLine & { readonly index: number };

export type RunEventsPage = {
  readonly events: NumberedRunEvent[];
  /** Pass as `after` to get the lines written since. */
  readonly next: number;
  /** Whether more complete lines follow this page. */
  readonly more: boolean;
};

export type ReadRunEventsOptions = {
  readonly after?: number;
  readonly limit?: number;
};

export async function readRunEvents(runsDir: string, runId: string, options: ReadRunEventsOptions = {}): Promise<RunEventsPage> {
  if (!v.is(RunIdSchema, runId)) throw new Error('run_id is not a run id');
  const after = Math.max(0, Math.floor(options.after ?? 0));
  const limit = Math.min(MAX_EVENTS_LIMIT, Math.max(1, Math.floor(options.limit ?? DEFAULT_EVENTS_LIMIT)));
  let text: string;
  try {
    text = await readFile(join(runsDir, runId, EVENTS_FILE), 'utf8');
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code === 'ENOENT') return { events: [], next: after, more: false };
    throw err;
  }
  // Only lines that end in a newline are complete.
  const lines = text.split('\n');
  lines.pop();
  const events: NumberedRunEvent[] = [];
  let index = after;
  for (; index < lines.length && events.length < limit; index++) {
    const parsed = parseLine(lines[index] ?? '');
    if (parsed === null) break;
    events.push({ ...parsed, index });
  }
  return { events, next: index, more: index < lines.length };
}

function parseLine(line: string): RunEventLine | null {
  try {
    const r = v.safeParse(LineSchema, JSON.parse(line));
    return r.success ? r.output : null;
  } catch {
    return null;
  }
}
