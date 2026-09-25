// triage models refresh [--provider <id>] [--json]
//
// Fetches the latest pi-ai catalog for anthropic and openai (or the one named)
// and caches the models the installed pi-ai lacks under
// <TRIAGE_DATA_DIR>/cache/models/, where every later process picks them up
// (src/model-catalog.ts). A run refreshes on its own when a configured model
// is not found; this command does it ahead of time.
//
// Prints one line per provider. Exits 1 when any provider failed and 2 when
// --provider names one that cannot be refreshed.
//
// --json prints {results: [{provider, ok, added} | {provider, ok: false, error}], cache_dir}.

import { REFRESHABLE_PROVIDERS, modelCacheDir, refreshCatalog, type FetchFn } from '../../model-catalog.ts';
import { EXIT, printError, printHuman, printJson } from '../output.ts';
import type { CliCommand } from '../types.ts';

export type ModelsRefreshCommandOptions = {
  /** Defaults to the global fetch. */
  readonly fetch?: FetchFn;
};

export function createModelsRefreshCommand(options: ModelsRefreshCommandOptions = {}): CliCommand {
  return {
    path: ['models', 'refresh'],
    summary: 'cache anthropic and openai models released after the installed pi-ai',
    configure(cmd) {
      cmd
        .option('--provider <id>', `refresh only this provider (${REFRESHABLE_PROVIDERS.join(', ')})`)
        .option('--json', 'print machine-readable JSON');
    },
    async run(ctx, { opts }) {
      const { io } = ctx;
      const provider = typeof opts.provider === 'string' ? opts.provider : undefined;
      if (provider !== undefined && !REFRESHABLE_PROVIDERS.includes(provider)) {
        printError(io, opts.json, 'USAGE', `--provider must be one of ${REFRESHABLE_PROVIDERS.join(', ')}`);
        return EXIT.USAGE;
      }
      const config = ctx.config();
      const results = await refreshCatalog(config, {
        ...(provider !== undefined ? { providers: [provider] } : {}),
        ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
      });
      if (opts.json) {
        printJson(io, { results, cache_dir: modelCacheDir(config) });
      } else {
        printHuman(
          io,
          results.map((r) =>
            r.ok
              ? `${r.provider}: ${r.added.length === 0 ? 'no models beyond the installed pi-ai' : r.added.join(', ')}`
              : `${r.provider}: failed: ${r.error}`,
          ),
        );
      }
      return results.every((r) => r.ok) ? EXIT.OK : EXIT.ERROR;
    },
  };
}

export const command: CliCommand = createModelsRefreshCommand();
