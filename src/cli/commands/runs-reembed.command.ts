// triage runs reembed [--missing]
//
// Rebuilds the case and request embeddings of every run in this deployment's
// run store (D43). With --missing it only embeds runs that have no row for
// the current MODEL_EMBEDDING model, which backfills after a failed
// post-settle step or a model change. A blank MODEL_EMBEDDING is a no-op.
//
// In mock mode the embedder is the hash embedder and the injected fetch is
// never called. Output is counts only; texts, vectors and config are never
// printed.
//
// tokens is the input tokens the embedding provider reported across the
// whole command (D59). These calls belong to no triage run, so they are only
// counted here. usage_missing (JSON, only when above 0) is how many calls
// came back without a count; those add 0 to tokens. The hash embedder
// reports 0.

import type { Config } from '../../config/env.ts';
import { createEmbedder, type Embedder, type EmbedUsage, type FetchLike } from '../../embed/index.ts';
import { reembed, type ReembedCounts, type ReembedResult } from '../../runstore/embed-run.ts';
import { createRunStore } from '../../runstore/index.ts';
import type { RunStore } from '../../runstore/types.ts';
import { EXIT, printError, printHuman, printJson } from '../output.ts';
import type { CliCommand } from '../types.ts';

export type RunsReembedOptions = {
  /** Builds the run store. Defaults to createRunStore(config). */
  readonly store?: (config: Config) => Promise<RunStore>;
  /** The fetch handed to the embedder. Defaults to the global fetch; unused in mock mode. */
  readonly fetch?: FetchLike;
  /** Builds the embedder. Defaults to createEmbedder(config, { fetch }). */
  readonly embedder?: (config: Config, fetch: FetchLike) => Embedder | null;
};

type TokenTally = { tokens: number; missing: number };

/** The embedder with every call's reported tokens added to tally. A caller's own onUsage still hears each call. */
function tallied(embedder: Embedder | null, tally: TokenTally): Embedder | null {
  if (embedder === null) return null;
  return {
    model: embedder.model,
    embed: (texts, opts = {}) =>
      embedder.embed(texts, {
        ...opts,
        onUsage: (u: EmbedUsage) => {
          tally.tokens += u.inputTokens;
          if (u.usageMissing === true) tally.missing++;
          opts.onUsage?.(u);
        },
      }),
  };
}

export function createRunsReembedCommand(options: RunsReembedOptions = {}): CliCommand {
  const buildStore = options.store ?? ((config: Config) => createRunStore(config));
  const fetchImpl: FetchLike = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const buildEmbedder = options.embedder ?? ((config: Config, fetch: FetchLike) => createEmbedder(config, { fetch }));

  return {
    path: ['runs', 'reembed'],
    summary: 'rebuild case and request embeddings for stored runs',
    configure(cmd) {
      cmd.option('--missing', 'only runs with no embedding for the current MODEL_EMBEDDING model');
    },
    async run(ctx, { opts }) {
      const json = opts.json;
      const missing = opts.missing === true;
      const config = ctx.config();
      // ConfigError (a refused MODEL_EMBEDDING or a missing provider key) is
      // left to the CLI, which prints key names only and exits 3.
      const tally: TokenTally = { tokens: 0, missing: 0 };
      const embedder = tallied(buildEmbedder(config, fetchImpl), tally);
      const store = await buildStore(config);

      let r: ReembedResult;
      try {
        r = await reembed(store, embedder, { missing });
      } catch (err) {
        printError(ctx.io, json, 'ERROR', `reembed failed: ${err instanceof Error ? err.name : 'unknown error'}`);
        return EXIT.ERROR;
      }

      const counts: ReembedCounts & { readonly tokens: number } = {
        runs: r.runs,
        embedded: r.embedded,
        unchanged: r.unchanged,
        skipped: r.skipped,
        failed: r.failed,
        tokens: tally.tokens,
      };
      const missingNote = tally.missing > 0 ? ` (${tally.missing} ${tally.missing === 1 ? 'call' : 'calls'} reported no count)` : '';
      if (json) {
        printJson(ctx.io, {
          ...(r.disabled ? { disabled: true } : {}),
          ...counts,
          ...(tally.missing > 0 ? { usage_missing: tally.missing } : {}),
        });
      } else if (r.disabled) {
        printHuman(ctx.io, 'embeddings disabled: MODEL_EMBEDDING is blank; nothing to do');
      } else {
        printHuman(ctx.io, [
          `runs ${counts.runs}, embedded ${counts.embedded}, unchanged ${counts.unchanged}, skipped ${counts.skipped}, failed ${counts.failed}, tokens ${counts.tokens}${missingNote}`,
          ...r.failures.map((f) => `  ${f.run_id}: ${f.gaps.join('; ')}`),
        ]);
      }
      return r.failed > 0 ? EXIT.ERROR : EXIT.OK;
    },
  };
}

export const command: CliCommand = createRunsReembedCommand();
