// repo_grep: search one checked-out repo with a regular expression, in
// process over the jailed tree (HLD 02 §2, D11). No grep binary is run.

import { defineTool } from '@flue/runtime/tool';
import * as v from 'valibot';
import type { ToolModule } from '../types.ts';
import { codeToolEnabled, repoNamesFor, runCodeTool } from './_lib/code-tool.ts';
import { GREP_LIMITS, grepRepo } from './_lib/grep.ts';

const NAME = 'repo_grep';

export const toolModule: ToolModule = {
  name: NAME,
  mounts: ['code_walker', 'investigator_deep'],
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
        'truncated is true when it stopped early. Use repo_read on a match to see its context.',
      input: v.object({
        repo: v.picklist(repos),
        pattern: v.pipe(v.string(), v.minLength(1), v.maxLength(GREP_LIMITS.maxPatternChars)),
        path_glob: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(GREP_LIMITS.maxGlobChars))),
        max_matches: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(GREP_LIMITS.maxMatches))),
      }),
      run: async ({ data, signal }) =>
        runCodeTool({
          tool: NAME,
          ctx,
          ...(signal !== undefined ? { signal } : {}),
          work: async () => {
            // The schema already holds the picklist; this is the second check.
            if (!repos.includes(data.repo)) return { ok: false, message: 'repo is not in the repo list', reason: 'unknown repo' };
            const outcome = await grepRepo({
              reposDir: ctx.config.paths.reposDir,
              repo: data.repo,
              pattern: data.pattern,
              ...(data.path_glob !== undefined ? { glob: data.path_glob } : {}),
              ...(data.max_matches !== undefined ? { maxMatches: data.max_matches } : {}),
              ...(signal !== undefined ? { signal } : {}),
            });
            if (!outcome.ok) return { ok: false, message: outcome.message, reason: `grep: ${outcome.code}` };
            const r = outcome.result;
            return {
              ok: true,
              data: { repo: data.repo, ...r },
              summary: `${NAME} ${data.repo}: ${r.matches.length} matches in ${r.files_scanned} files${r.truncated ? ', truncated' : ''}`,
            };
          },
        }),
    });
  },
};
