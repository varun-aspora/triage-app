// repo_find: file paths in one checked-out repo that match a glob, in path
// order, paged with offset and limit (W10). Same jail, walk and glob as
// repo_grep; no file is opened. Mounted where repo_read is.
//
// There is no name-regex input: a glob with {a,b} covers the cases, and a
// regex run here would skip the worker that guards repo_grep against
// catastrophic backtracking.

import { defineTool } from '@flue/runtime/tool';
import * as v from 'valibot';
import type { ToolModule } from '../types.ts';
import { codeToolEnabled, type CodeOutcome, repoNamesFor, runCodeTool } from './_lib/code-tool.ts';
import { compileGlob, GREP_LIMITS, type GrepLimits, MISSING_BASE_NOTE, walkFiles, type WalkState } from './_lib/grep.ts';
import { resolveInRepo } from './_lib/jail.ts';

export const FIND_LIMITS = Object.freeze({ defaultLimit: 100, maxLimit: 200 });

const NAME = 'repo_find';

export type FindInput = { repo: string; glob: string; offset?: number | undefined; limit?: number | undefined };

/** Lists the matching paths. Pure over the file system; the tool wraps it in runCodeTool. */
export async function findPaths(
  reposDir: string | undefined,
  input: FindInput,
  signal?: AbortSignal,
  limits: Partial<GrepLimits> = {},
): Promise<CodeOutcome> {
  const lim: GrepLimits = { ...GREP_LIMITS, ...limits };
  const glob = compileGlob(input.glob, lim.maxGlobChars, 'glob');
  if ('ok' in glob) return { ok: false, message: glob.message, reason: `find: ${glob.code}` };
  const offset = input.offset ?? 0;
  const limit = Math.min(input.limit ?? FIND_LIMITS.defaultLimit, FIND_LIMITS.maxLimit);
  const notes: string[] = [];
  const result = (paths: string[], next: number | null, truncated: boolean, dir?: string): CodeOutcome => ({
    ok: true,
    data: { repo: input.repo, paths, offset, next_offset: next, truncated, notes },
    summary: `${NAME} ${input.repo}: ${paths.length} paths from ${offset}${truncated ? ', truncated' : ''}`,
    ...(dir !== undefined ? { docs: { repo: input.repo, dir } } : {}),
  });

  const start = resolveInRepo(reposDir, input.repo, glob.baseDir, { expect: 'dir' });
  if (!start.ok) {
    if (start.code !== 'not_found' && start.code !== 'not_dir') return { ok: false, message: start.message, reason: `jail: ${start.code}` };
    notes.push(MISSING_BASE_NOTE);
    return result([], null, false);
  }

  const deadline = Date.now() + lim.timeBudgetMs;
  const walk: WalkState = { entries: 0, stoppedBy: null };
  const paths: string[] = [];
  let seen = 0;
  let more = false;
  for await (const file of walkFiles(start.root, start.rel, walk, lim.maxWalkEntries, () => Date.now() > deadline, signal)) {
    if (!glob.test(file.rel)) continue;
    seen += 1;
    if (seen <= offset) continue;
    if (paths.length === limit) {
      more = true;
      break;
    }
    paths.push(file.rel);
  }
  if (more) notes.push(`more paths match; call again with offset ${offset + limit}`);
  if (seen === 0 && walk.stoppedBy === null && !/[*?{]/.test(input.glob)) {
    const name = input.glob.slice(input.glob.lastIndexOf('/') + 1);
    notes.push(`a glob without * ? or { matches whole names only; try '*${name}*'`);
  }
  if (walk.stoppedBy !== null) {
    notes.push(
      walk.stoppedBy === 'time'
        ? `the walk stopped at the ${lim.timeBudgetMs} ms time budget; start the glob with a directory to narrow it`
        : `the walk stopped after ${lim.maxWalkEntries} directory entries; start the glob with a directory to narrow it`,
    );
  }
  return result(paths, more ? offset + limit : null, more || walk.stoppedBy !== null, start.rel);
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
        'List file paths in a checked-out repo that match a glob, in path order; no file is opened. ' +
        "A glob without '/' matches file names anywhere ('*Transfer*.go', '*.{yml,yaml}'); one with '/' matches " +
        "paths from the repo root ('src/**/handler*.ts'). .git and other dot paths are skipped. Returns at most " +
        `${FIND_LIMITS.maxLimit} paths (default ${FIND_LIMITS.defaultLimit}); when next_offset is set, call again ` +
        'with offset = next_offset. truncated with next_offset null means the walk cap was hit, so start the glob ' +
        'with a directory. Use this instead of guessing a path for repo_read.',
      input: v.object({
        repo: v.picklist(repos),
        glob: v.pipe(v.string(), v.minLength(1), v.maxLength(GREP_LIMITS.maxGlobChars)),
        offset: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
        limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(FIND_LIMITS.maxLimit))),
      }),
      run: async ({ data, signal }) =>
        runCodeTool({
          tool: NAME,
          ctx,
          ...(signal !== undefined ? { signal } : {}),
          work: async () => {
            // The schema already holds the picklist; this is the second check.
            if (!repos.includes(data.repo)) return { ok: false, message: 'repo is not in the repo list', reason: 'unknown repo' };
            return findPaths(ctx.config.paths.reposDir, data, signal);
          },
        }),
    });
  },
};
