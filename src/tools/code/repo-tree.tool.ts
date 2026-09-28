// repo_tree: the directories and files under one path of a checked-out repo,
// to a depth, with file and directory counts per directory (W10). depth 1 is
// ls, so there is no separate repo_ls. Same jail as repo_read; no file is
// opened. Mounted where repo_read is.
//
// The walk is breadth first, so when the entry cap cuts the listing the
// shallow levels are the ones kept. Dot names are skipped and symlinked
// directories are not followed, as in repo_grep.

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { defineTool } from '@flue/runtime/tool';
import * as v from 'valibot';
import type { ToolModule } from '../types.ts';
import { codeToolEnabled, type CodeOutcome, repoNamesFor, runCodeTool } from './_lib/code-tool.ts';
import { GREP_LIMITS, type GrepLimits, linkedFileInRepo } from './_lib/grep.ts';
import { childRel, MAX_PATH_CHARS, resolveInRepo } from './_lib/jail.ts';

export const TREE_LIMITS = Object.freeze({ defaultDepth: 2, maxDepth: 4, defaultLimit: 200, maxLimit: 500 });

const NAME = 'repo_tree';

export type TreeInput = { repo: string; path?: string | undefined; depth?: number | undefined; limit?: number | undefined };

/** A directory path ends in '/' and carries its counts; a file has the path only. */
export type TreeEntry = { readonly path: string; readonly files?: number; readonly dirs?: number };

type Listing = { readonly dirs: string[]; readonly files: string[] };

/** Lists the tree. Pure over the file system; the tool wraps it in runCodeTool. */
export async function listTree(
  reposDir: string | undefined,
  input: TreeInput,
  signal?: AbortSignal,
  limits: Partial<GrepLimits> = {},
): Promise<CodeOutcome> {
  const lim: GrepLimits = { ...GREP_LIMITS, ...limits };
  const start = resolveInRepo(reposDir, input.repo, input.path ?? '', { expect: 'dir' });
  if (!start.ok) return { ok: false, message: start.message, reason: `jail: ${start.code}` };
  const depth = Math.min(input.depth ?? TREE_LIMITS.defaultDepth, TREE_LIMITS.maxDepth);
  const limit = Math.min(input.limit ?? TREE_LIMITS.defaultLimit, TREE_LIMITS.maxLimit);
  const deadline = Date.now() + lim.timeBudgetMs;
  let seen = 0;
  let stop: 'limit' | 'entries' | 'time' | null = null;

  const list = async (rel: string): Promise<Listing> => {
    signal?.throwIfAborted();
    const out: Listing = { dirs: [], files: [] };
    let entries;
    try {
      entries = await readdir(join(start.root, rel), { withFileTypes: true });
    } catch {
      return out;
    }
    seen += entries.length;
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      if (e.isDirectory()) out.dirs.push(e.name);
      else if (e.isFile() || (e.isSymbolicLink() && linkedFileInRepo(start.root, join(start.root, rel, e.name)) !== null)) {
        out.files.push(e.name);
      }
    }
    out.dirs.sort();
    out.files.sort();
    return out;
  };

  const entries: TreeEntry[] = [];
  const top = await list(start.rel);
  const queue: { rel: string; level: number; listing: Listing }[] = [{ rel: start.rel, level: 1, listing: top }];
  walk: while (queue.length > 0) {
    const { rel, level, listing } = queue.shift() as (typeof queue)[number];
    for (const name of listing.dirs) {
      if (entries.length >= limit) stop = 'limit';
      else if (seen > lim.maxWalkEntries) stop = 'entries';
      else if (Date.now() > deadline) stop = 'time';
      if (stop !== null) break walk;
      const child = childRel(rel, name);
      const inner = await list(child);
      entries.push({ path: `${child}/`, files: inner.files.length, dirs: inner.dirs.length });
      if (level < depth) queue.push({ rel: child, level: level + 1, listing: inner });
    }
    for (const name of listing.files) {
      if (entries.length >= limit) {
        stop = 'limit';
        break walk;
      }
      entries.push({ path: childRel(rel, name) });
    }
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const notes: string[] = [];
  if (stop === 'limit') {
    const how = limit < TREE_LIMITS.maxLimit ? `narrow path, lower depth or raise limit (up to ${TREE_LIMITS.maxLimit})` : 'narrow path or lower depth';
    notes.push(`stopped at ${limit} entries; ${how} to see the rest`);
  }
  if (stop === 'entries') notes.push(`stopped after ${lim.maxWalkEntries} directory entries; narrow path or lower depth`);
  if (stop === 'time') notes.push(`stopped at the ${lim.timeBudgetMs} ms time budget; narrow path or lower depth`);
  return {
    ok: true,
    data: {
      repo: input.repo,
      path: start.rel,
      depth,
      files: top.files.length,
      dirs: top.dirs.length,
      entries,
      truncated: stop !== null,
      notes,
    },
    summary: `${NAME} ${input.repo}:${start.rel === '' ? '.' : start.rel} depth ${depth}: ${entries.length} entries${stop !== null ? ', truncated' : ''}`,
    docs: { repo: input.repo, dir: start.rel },
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
        'Show the directories and files under a path of a checked-out repo, to a depth. depth 1 = ls of that ' +
        `directory; default ${TREE_LIMITS.defaultDepth}, at most ${TREE_LIMITS.maxDepth}. path is relative to the ` +
        "repo root; leave it out for the root. Directory paths end in '/' and carry their files and dirs counts. " +
        'Paths are from the repo root, ready for repo_read. .git and other dot paths are skipped. Returns at most ' +
        `${TREE_LIMITS.maxLimit} entries (default ${TREE_LIMITS.defaultLimit}); when truncated, narrow path or ` +
        'lower depth.',
      input: v.object({
        repo: v.picklist(repos),
        path: v.optional(v.pipe(v.string(), v.maxLength(MAX_PATH_CHARS))),
        depth: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(TREE_LIMITS.maxDepth))),
        limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(TREE_LIMITS.maxLimit))),
      }),
      run: async ({ data, signal }) =>
        runCodeTool({
          tool: NAME,
          ctx,
          ...(signal !== undefined ? { signal } : {}),
          work: async () => {
            // The schema already holds the picklist; this is the second check.
            if (!repos.includes(data.repo)) return { ok: false, message: 'repo is not in the repo list', reason: 'unknown repo' };
            return listTree(ctx.config.paths.reposDir, data, signal);
          },
        }),
    });
  },
};
