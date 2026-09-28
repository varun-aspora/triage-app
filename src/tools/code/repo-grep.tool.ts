// repo_grep: search one checked-out repo with a regular expression, in
// process over the jailed tree (HLD 02 §2, D11). No grep binary is run.
// Mounted on code_walker and on both investigators (the deep variant gets
// the investigator set); on an investigator the repo list is its entity's.

import { defineTool } from '@flue/runtime/tool';
import * as v from 'valibot';
import type { ToolModule } from '../types.ts';
import { codeToolEnabled, repoNamesFor, runCodeTool } from './_lib/code-tool.ts';
import { GREP_LIMITS, grepRepo } from './_lib/grep.ts';

const NAME = 'repo_grep';

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
        'Search one checked-out repo line by line with a JavaScript regular expression. path_glob narrows the ' +
        "files: '*.go' matches file names, 'src/**/*.ts' matches paths from the repo root. .git, dotfiles and " +
        `binary files are skipped. Returns at most ${GREP_LIMITS.maxMatches} matches (default ` +
        `${GREP_LIMITS.defaultMatches}) and stops at a ${GREP_LIMITS.timeBudgetMs} ms time budget; ` +
        'truncated is true when it stopped early. ' +
        `context_lines (0-${GREP_LIMITS.maxContextLines}, like grep -C) adds before and after lines to each match. ` +
        'files_only returns just the unique paths with a match (like grep -l); count_only returns matches per ' +
        'file and a total. max_matches caps files in those two modes. Use one mode at a time. To list files by ' +
        'name use repo_find; to see a directory use repo_tree; use repo_read on a match to see more.',
      input: v.object({
        repo: v.picklist(repos),
        pattern: v.pipe(v.string(), v.minLength(1), v.maxLength(GREP_LIMITS.maxPatternChars)),
        path_glob: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(GREP_LIMITS.maxGlobChars))),
        max_matches: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(GREP_LIMITS.maxMatches))),
        context_lines: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(GREP_LIMITS.maxContextLines))),
        files_only: v.optional(v.boolean()),
        count_only: v.optional(v.boolean()),
      }),
      run: async ({ data, signal }) =>
        runCodeTool({
          tool: NAME,
          ctx,
          ...(signal !== undefined ? { signal } : {}),
          work: async () => {
            // The schema already holds the picklist; this is the second check.
            if (!repos.includes(data.repo)) return { ok: false, message: 'repo is not in the repo list', reason: 'unknown repo' };
            if (data.files_only === true && data.count_only === true) {
              return { ok: false, message: 'files_only and count_only cannot both be set; pick one', reason: 'grep: both modes' };
            }
            const mode = data.files_only === true ? 'files' : data.count_only === true ? 'count' : 'content';
            if (mode !== 'content' && (data.context_lines ?? 0) > 0) {
              return {
                ok: false,
                message: 'context_lines applies to matching lines only; drop it or drop files_only / count_only',
                reason: 'grep: context with a list mode',
              };
            }
            const outcome = await grepRepo({
              reposDir: ctx.config.paths.reposDir,
              repo: data.repo,
              pattern: data.pattern,
              ...(data.path_glob !== undefined ? { glob: data.path_glob } : {}),
              ...(data.max_matches !== undefined ? { maxMatches: data.max_matches } : {}),
              ...(data.context_lines !== undefined ? { contextLines: data.context_lines } : {}),
              mode,
              ...(signal !== undefined ? { signal } : {}),
            });
            if (!outcome.ok) return { ok: false, message: outcome.message, reason: `grep: ${outcome.code}` };
            const r = outcome.result;
            const found =
              r.matches !== undefined ? `${r.matches.length} matches` : r.files !== undefined ? `${r.files.length} files` : `${r.total} matches in ${r.counts?.length} files`;
            return {
              ok: true,
              data: { repo: data.repo, ...r },
              summary: `${NAME} ${data.repo}: ${found}, ${r.files_scanned} files scanned${r.truncated ? ', truncated' : ''}`,
              // The root docs only; matched directories with docs are listed.
              docs: { repo: data.repo, dir: '', matched: r.matches?.map((m) => m.path) ?? r.files ?? r.counts?.map((c) => c.path) ?? [] },
            };
          },
        }),
    });
  },
};
