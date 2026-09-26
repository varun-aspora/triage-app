import { afterEach, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EVENTS_FILE, flushRunEventLog, installRunEventLog, logRunEvent, uninstallRunEventLog } from './event-log.ts';
import { lastRunEventAt, TAIL_BYTES } from './read.ts';

const RUN = '01J8ZQ7XK3PSEDRMNABCDEFGH1';

const dirs: string[] = [];
afterEach(() => {
  uninstallRunEventLog();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function runsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'triage-runlog-read-'));
  dirs.push(dir);
  return dir;
}

function writeLines(dir: string, text: string): void {
  mkdirSync(join(dir, RUN), { recursive: true });
  writeFileSync(join(dir, RUN, EVENTS_FILE), text);
}

const line = (ts: string, data: unknown = {}): string => `${JSON.stringify({ ts, source: 'pipeline', type: 'phase', data })}\n`;

describe('lastRunEventAt (D71)', () => {
  test('is null for a run with no log and for an empty log', async () => {
    const dir = runsDir();
    expect(await lastRunEventAt(dir, RUN)).toBeNull();
    writeLines(dir, '');
    expect(await lastRunEventAt(dir, RUN)).toBeNull();
  });

  test('is the ts of the last complete line; a partial last line is left out', async () => {
    const dir = runsDir();
    writeLines(dir, `${line('2026-09-25T10:00:00.000Z')}${line('2026-09-25T10:05:00.000Z')}{"ts":"2026-09-25T10:09:00.000Z","sou`);
    expect(await lastRunEventAt(dir, RUN)).toBe(Date.parse('2026-09-25T10:05:00.000Z'));
  });

  test('skips a last line that does not parse', async () => {
    const dir = runsDir();
    writeLines(dir, `${line('2026-09-25T10:00:00.000Z')}not json\n`);
    expect(await lastRunEventAt(dir, RUN)).toBe(Date.parse('2026-09-25T10:00:00.000Z'));
    writeLines(dir, 'not json\n');
    expect(await lastRunEventAt(dir, RUN)).toBeNull();
  });

  test('finds a last line longer than the tail window', async () => {
    const dir = runsDir();
    const big = 'x'.repeat(TAIL_BYTES * 3);
    writeLines(dir, `${line('2026-09-25T10:00:00.000Z')}${line('2026-09-25T10:07:00.000Z', { big })}`);
    expect(await lastRunEventAt(dir, RUN)).toBe(Date.parse('2026-09-25T10:07:00.000Z'));
  });

  test('reads only the end of a long log', async () => {
    const dir = runsDir();
    const many = Array.from({ length: 2000 }, (_, i) => line(new Date(Date.parse('2026-09-25T10:00:00.000Z') + i * 1000).toISOString())).join('');
    writeLines(dir, many);
    expect(await lastRunEventAt(dir, RUN)).toBe(Date.parse('2026-09-25T10:00:00.000Z') + 1999 * 1000);
    appendFileSync(join(dir, RUN, EVENTS_FILE), line('2026-09-26T08:00:00.000Z'));
    expect(await lastRunEventAt(dir, RUN)).toBe(Date.parse('2026-09-26T08:00:00.000Z'));
  });

  test('sees a line the event log wrote', async () => {
    const dir = runsDir();
    installRunEventLog({ runsDir: dir, now: () => new Date('2026-09-25T11:00:00.000Z'), observe: () => () => {} });
    logRunEvent(RUN, 'phase', { phase: 'investigating' });
    await flushRunEventLog();
    expect(await lastRunEventAt(dir, RUN)).toBe(Date.parse('2026-09-25T11:00:00.000Z'));
  });

  test('refuses a value that is not a run id', async () => {
    await expect(lastRunEventAt(runsDir(), '../escape')).rejects.toThrow('run id');
  });
});
