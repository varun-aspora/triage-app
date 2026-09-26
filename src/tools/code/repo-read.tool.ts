// repo_read: read a line range of one file in a checked-out repo, under the
// realpath jail in _lib/jail.ts (HLD 02 §2, D11). Local disk only.
// Mounted on code_walker and on both investigators (the deep variant gets
// the investigator set); on an investigator the repo list is its entity's.

import { readFile } from 'node:fs/promises';
import { defineTool } from '@flue/runtime/tool';
import * as v from 'valibot';
import type { ToolModule } from '../types.ts';
import { codeToolEnabled, type CodeOutcome, repoNamesFor, runCodeTool } from './_lib/code-tool.ts';
import { MAX_FILE_BYTES, MAX_PATH_CHARS, resolveInRepo } from './_lib/jail.ts';

export const READ_LIMITS = Object.freeze({
  maxFileBytes: MAX_FILE_BYTES,
  /** Lines returned by one call. */
  maxLines: 400,
  /** Characters kept of one line. */
  maxLineChars: 2000,
  /** Characters of text returned by one call. */
  maxOutputChars: 64 * 1024,
});

const NAME = 'repo_read';

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export type ReadInput = { repo: string; path: string; start_line?: number | undefined; end_line?: number | undefined };

/** Reads the range. Pure over the file system; the tool wraps it in runCodeTool. */
export async function readRange(reposDir: string | undefined, input: ReadInput, signal?: AbortSignal): Promise<CodeOutcome> {
  const jailed = resolveInRepo(reposDir, input.repo, input.path, { expect: 'file', maxBytes: READ_LIMITS.maxFileBytes });
  if (!jailed.ok) return { ok: false, message: jailed.message, reason: `jail: ${jailed.code}` };

  let buf: Buffer;
  try {
    buf = await readFile(jailed.path, signal !== undefined ? { signal } : {});
  } catch (err) {
    signal?.throwIfAborted();
    // The errno code is the reason (EACCES, EISDIR); the message is left out
    // because it holds the absolute path, which jail messages never echo.
    const code = (err as { code?: unknown } | null)?.code;
    const why = typeof code === 'string' && /^E[A-Z0-9_]{1,20}$/.test(code) ? code : err instanceof Error ? err.name : 'error';
    return {
      ok: false,
      message: `file could not be read (${why}). Check the path with repo_grep, or read another file.`,
      reason: `read failed (${why})`,
    };
  }
  if (looksBinary(buf)) return { ok: false, message: 'file looks binary and is not read', reason: 'binary file' };

  const lines = buf.toString('utf8').split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const total = lines.length;
  const start = input.start_line ?? 1;
  if (start > total) {
    return { ok: false, message: `start_line is past the end of the file (${total} lines)`, reason: 'range: start past end' };
  }
  if (input.end_line !== undefined && input.end_line < start) {
    return { ok: false, message: 'end_line must not be before start_line', reason: 'range: end before start' };
  }
  const wanted = Math.min(input.end_line ?? total, total);
  let end = Math.min(wanted, start + READ_LIMITS.maxLines - 1);

  const out: string[] = [];
  let chars = 0;
  for (let n = start; n <= end; n++) {
    let line = lines[n - 1] as string;
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line.length > READ_LIMITS.maxLineChars) line = `${line.slice(0, READ_LIMITS.maxLineChars)} [cut]`;
    const row = `${n}\t${line}`;
    if (chars + row.length + 1 > READ_LIMITS.maxOutputChars && out.length > 0) {
      end = n - 1;
      break;
    }
    chars += row.length + 1;
    out.push(row);
  }
  const truncated = end < wanted;
  return {
    ok: true,
    data: {
      repo: input.repo,
      path: jailed.rel,
      start_line: start,
      end_line: end,
      total_lines: total,
      text: out.join('\n'),
      truncated,
      ...(truncated ? { note: `output capped; call again with start_line ${end + 1} for more` } : {}),
    },
    summary: `${NAME} ${input.repo}:${jailed.rel} lines ${start}-${end} of ${total}`,
  };
}

export const toolModule: ToolModule = {
  name: NAME,
  mounts: ['code_walker', 'investigator'],
  entities: 'all',
  enabled: (ctx) => codeToolEnabled(ctx),
  create: (ctx) => {
    const repos = repoNamesFor(ctx);
    return defineTool({
      name: NAME,
      description:
        'Read lines from one file in a checked-out repo. path is relative to the repo root; .git, .env and ' +
        `other dot paths are refused. Returns at most ${READ_LIMITS.maxLines} numbered lines per call; use ` +
        'start_line and end_line to page. Files over 1 MB are refused; use repo_grep to find lines first.',
      input: v.object({
        repo: v.picklist(repos),
        path: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_PATH_CHARS)),
        start_line: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
        end_line: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
      }),
      run: async ({ data, signal }) =>
        runCodeTool({
          tool: NAME,
          ctx,
          ...(signal !== undefined ? { signal } : {}),
          work: async () => {
            // The schema already holds the picklist; this is the second check.
            if (!repos.includes(data.repo)) return { ok: false, message: 'repo is not in the repo list', reason: 'unknown repo' };
            return readRange(ctx.config.paths.reposDir, data, signal);
          },
        }),
    });
  },
};
