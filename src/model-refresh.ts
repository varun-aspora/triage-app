// Refresh the model catalog when a configured model is not found.
//
// ensureConfiguredModels() checks every model key against the registered
// providers and the installed pi-ai catalog. When an anthropic/* or openai/*
// spec is missing, it refreshes that provider's catalog once (src/model-catalog.ts)
// and checks again. Nothing is fetched when every model is found.
//
// bootRuntime() calls it before start(), so a CLI run, the server and the eval
// driver all pick up models released after the installed pi-ai. The explicit
// form is `triage models refresh`.

import type { Config } from './config/env.ts';
import { REFRESHABLE_PROVIDERS, refreshCatalog, type FetchFn, type RefreshResult } from './model-catalog.ts';
import { lookupModel, parseSpec, type ModelLookup } from './models.ts';

/** Model keys and their specs, blank keys left out. */
export function configuredModels(config: Config): { key: string; spec: string }[] {
  const m = config.models;
  const pairs: [string, string | undefined][] = [
    ['MODEL_DECISION', m.decision],
    ['MODEL_TIER_CHEAP', m.tierCheap],
    ['MODEL_TIER_MID', m.tierMid],
    ['MODEL_TIER_STRONG', m.tierStrong],
    ['MODEL_CODE_WALKER', m.codeWalker],
    ['TRIAGE_EVAL_JUDGE_MODEL', config.evals.judgeModel],
  ];
  return pairs.flatMap(([key, spec]) => (spec === undefined ? [] : [{ key, spec }]));
}

export type EnsureResult = {
  /** Providers that were refreshed, with the models each one added. */
  readonly refreshed: readonly RefreshResult[];
  /** Keys whose refreshable model is still unknown after the refresh. */
  readonly missing: readonly { key: string; spec: string }[];
};

function missingModels(config: Config, lookup: ModelLookup): { key: string; spec: string }[] {
  return configuredModels(config).filter(({ spec }) => {
    const provider = parseSpec(spec)?.provider;
    return provider !== undefined && REFRESHABLE_PROVIDERS.includes(provider) && lookup(spec) === undefined;
  });
}

/** Refreshes the providers of any configured model that is not found. No network when all are found. */
export async function ensureConfiguredModels(
  config: Config,
  deps: { readonly fetch?: FetchFn; readonly lookup?: ModelLookup } = {},
): Promise<EnsureResult> {
  const lookup = deps.lookup ?? lookupModel;
  const before = missingModels(config, lookup);
  if (before.length === 0) return { refreshed: [], missing: [] };
  const providers = [...new Set(before.map(({ spec }) => parseSpec(spec)?.provider ?? ''))].sort();
  const refreshed = await refreshCatalog(config, { providers, ...(deps.fetch !== undefined ? { fetch: deps.fetch } : {}) });
  return { refreshed, missing: missingModels(config, lookup) };
}

/** One stderr line per outcome worth reporting. Keys only, never values beyond the model id. */
export function describeEnsure(result: EnsureResult): string[] {
  const lines: string[] = [];
  for (const r of result.refreshed) {
    if (r.ok) lines.push(`models: refreshed ${r.provider} catalog (${r.added.length} models beyond the installed pi-ai)`);
    else lines.push(`models: ${r.provider} catalog refresh failed: ${r.error}`);
  }
  for (const m of result.missing) lines.push(`models: ${m.key} (${m.spec}) is not in the pi-ai catalog, even after a refresh`);
  return lines;
}
