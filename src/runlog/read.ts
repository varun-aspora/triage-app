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
//
// lastRunEventAt reads only the end of the file: the time of the last
// complete line, for stalled detection (D71). It reads TAIL_BYTES from the
// end and widens the window only when one line is longer than that.

import { open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as v from 'valibot';
import { hasCode } from '../runstore/atomic.ts';
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
    if (hasCode(err, 'ENOENT')) return { events: [], next: after, more: false };
    throw err;
  }
  const lines = completeLines(text);
  const events: NumberedRunEvent[] = [];
  let index = after;
  for (; index < lines.length && events.length < limit; index++) {
    const parsed = parseLine(lines[index] ?? '');
    if (parsed === null) break;
    events.push({ ...parsed, index });
  }
  return { events, next: index, more: index < lines.length };
}

/** The lines that end in a newline; the text after the last one is not complete yet. */
function completeLines(text: string): string[] {
  const lines = text.split('\n');
  lines.pop();
  return lines;
}

function parseLine(line: string): RunEventLine | null {
  try {
    const r = v.safeParse(LineSchema, JSON.parse(line));
    return r.success ? r.output : null;
  } catch {
    return null;
  }
}

/** How much of the end of events.jsonl lastRunEventAt reads first. Most lines are far shorter. */
export const TAIL_BYTES = 16 * 1024;

/**
 * The ts of the run's last complete event line, in epoch ms. Null when the
 * run has no log yet or no complete line. A line that does not parse is
 * skipped for the one before it.
 */
export async function lastRunEventAt(runsDir: string, runId: string): Promise<number | null> {
  if (!v.is(RunIdSchema, runId)) throw new Error('run_id is not a run id');
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(join(runsDir, runId, EVENTS_FILE), 'r');
  } catch (err) {
    if (hasCode(err, 'ENOENT')) return null;
    throw err;
  }
  try {
    const { size } = await handle.stat();
    for (let window = TAIL_BYTES; ; window *= 4) {
      const start = Math.max(0, size - window);
      const bytes = Buffer.alloc(size - start);
      await handle.read(bytes, 0, bytes.length, start);
      const at = lastLineTime(bytes.toString('utf8'), start === 0);
      if (at !== undefined || start === 0) return at ?? null;
    }
  } finally {
    await handle.close();
  }
}

/**
 * The ts of the last complete line in a chunk of the file. The chunk's first
 * line counts only when the chunk starts the file; otherwise it may be the
 * tail of a longer line. Undefined when no line in the chunk can be read.
 */
function lastLineTime(text: string, fromFileStart: boolean): number | undefined {
  const lines = completeLines(text);
  const first = fromFileStart ? 0 : 1;
  for (let i = lines.length - 1; i >= first; i--) {
    const line = parseLine(lines[i] ?? '');
    const at = line === null ? Number.NaN : Date.parse(line.ts);
    if (Number.isFinite(at)) return at;
  }
  return undefined;
}
