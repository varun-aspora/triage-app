// Model catalog refresh for the pi-ai built-in providers (anthropic, openai).
//
// pi-ai's built-in providers are static: their catalog is the one bundled
// with the installed pi-ai, and Models.refresh() skips them. Flue pins pi-ai,
// so a model released after that version (gpt-6-*, claude-opus-5-5 on 0.83)
// is unknown and the run fails at resolveModel.
//
// This module rebuilds each built-in provider with createProvider and a
// fetchModels, so pi-ai's own refreshModels() works for it:
// - fetchModels reads the latest published pi-ai catalog for the provider
//   (the same generated data pi-ai ships, served by jsDelivr) and keeps only
//   models the installed catalog lacks, on an API the provider already serves.
// - The result is stored under <TRIAGE_DATA_DIR>/cache/models/<provider>.json.
// - registerCachedModels() reads that file (no network) and registers the
//   provider with the extra models, so later processes see them too.
// Streaming is delegated to the built-in provider unchanged.
//
// Only refreshCatalog() touches the network, through an injected fetch.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createProvider, type Api, type Model, type Provider, type ProviderModelsStore } from '@earendil-works/pi-ai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { setProvider } from '@flue/runtime';
import type { Config } from './config/env.ts';

/** Where the latest pi-ai provider catalogs are read from: <base><provider>.json. */
export const PI_AI_CATALOG_BASE = 'https://cdn.jsdelivr.net/npm/@earendil-works/pi-ai/dist/providers/data/';

type BuiltinFactory = () => Provider;
const BUILTINS: ReadonlyMap<string, BuiltinFactory> = new Map<string, BuiltinFactory>([
  ['anthropic', anthropicProvider],
  ['openai', openaiProvider],
]);

/** Providers whose catalog can be refreshed. */
export const REFRESHABLE_PROVIDERS: readonly string[] = Object.freeze([...BUILTINS.keys()]);

export type FetchFn = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

export type RefreshResult =
  | { readonly provider: string; readonly ok: true; readonly added: readonly string[] }
  | { readonly provider: string; readonly ok: false; readonly error: string };

/** The cache folder for refreshed models. */
export function modelCacheDir(config: Config): string {
  return join(config.paths.dataDir, 'cache', 'models');
}

function cacheFile(config: Config, provider: string): string {
  return join(modelCacheDir(config), `${provider}.json`);
}

/** Extra models stored by the last refresh, or [] when there is no readable cache. Sync, no network. */
export function readCachedModels(config: Config, provider: string): Model<Api>[] {
  const file = cacheFile(config, provider);
  if (!existsSync(file)) return [];
  try {
    const entry = JSON.parse(readFileSync(file, 'utf8')) as { models?: unknown };
    return Array.isArray(entry.models) ? entry.models.filter((m): m is Model<Api> => isModel(m, provider)) : [];
  } catch {
    return [];
  }
}

function fileStore(config: Config, provider: string): ProviderModelsStore {
  const file = cacheFile(config, provider);
  return {
    read: async () => (existsSync(file) ? { models: readCachedModels(config, provider) } : undefined),
    write: async (entry) => {
      mkdirSync(modelCacheDir(config), { recursive: true });
      writeFileSync(file, `${JSON.stringify({ models: entry.models, checkedAt: entry.checkedAt }, null, 2)}\n`);
    },
    delete: async () => {
      writeFileSync(file, '{"models":[]}\n');
    },
  };
}

// The Model fields the installed pi-ai reads. Newer catalogs carry more; those are dropped.
function pick(m: Model<Api>): Model<Api> {
  const out: Model<Api> = {
    id: m.id,
    name: m.name,
    api: m.api,
    provider: m.provider,
    baseUrl: m.baseUrl,
    reasoning: m.reasoning,
    input: m.input,
    cost: m.cost,
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
  };
  if (m.thinkingLevelMap !== undefined) out.thinkingLevelMap = m.thinkingLevelMap;
  if (m.headers !== undefined) out.headers = m.headers;
  if (m.compat !== undefined) out.compat = m.compat;
  return out;
}

function isModel(value: unknown, provider: string): value is Model<Api> {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as Record<string, unknown>;
  return (
    typeof m.id === 'string' &&
    m.id !== '' &&
    m.provider === provider &&
    typeof m.api === 'string' &&
    typeof m.baseUrl === 'string' &&
    Array.isArray(m.input) &&
    typeof m.cost === 'object' &&
    m.cost !== null &&
    typeof m.contextWindow === 'number' &&
    typeof m.maxTokens === 'number'
  );
}

/** Models in a published catalog file that the base provider lacks, on an API it serves. */
export function extraModels(base: Provider, catalog: unknown): Model<Api>[] {
  if (typeof catalog !== 'object' || catalog === null) return [];
  const known = new Set(base.getModels().map((m) => m.id));
  const apis = new Set(base.getModels().map((m) => m.api));
  const out: Model<Api>[] = [];
  for (const group of Object.values(catalog as Record<string, unknown>)) {
    if (typeof group !== 'object' || group === null) continue;
    for (const value of Object.values(group as Record<string, unknown>)) {
      if (!isModel(value, base.id) || known.has(value.id) || !apis.has(value.api)) continue;
      known.add(value.id);
      out.push(pick(value));
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

type BuildOptions = { readonly fetch?: FetchFn; readonly timeoutMs?: number };

// The built-in provider plus the extra models, refreshable through pi-ai's refreshModels().
function buildProvider(id: string, extras: readonly Model<Api>[], options: BuildOptions = {}): Provider {
  const factory = BUILTINS.get(id);
  if (factory === undefined) throw new Error(`no built-in provider '${id}'`);
  const base = factory();
  const doFetch = options.fetch;
  return createProvider({
    id: base.id,
    name: base.name,
    ...(base.baseUrl !== undefined ? { baseUrl: base.baseUrl } : {}),
    ...(base.headers !== undefined ? { headers: base.headers } : {}),
    auth: base.auth,
    models: [...base.getModels(), ...extras],
    ...(doFetch !== undefined
      ? {
          fetchModels: async (ctx) => {
            const signal = options.timeoutMs !== undefined ? AbortSignal.timeout(options.timeoutMs) : ctx.signal;
            const res = await doFetch(`${PI_AI_CATALOG_BASE}${id}.json`, signal !== undefined ? { signal } : {});
            if (!res.ok) throw new Error(`catalog fetch for ${id} answered HTTP ${res.status}`);
            return extraModels(base, await res.json());
          },
        }
      : {}),
    api: {
      stream: (model, context, opts) => base.stream(model, context, opts),
      streamSimple: (model, context, opts) => base.streamSimple(model, context, opts),
    },
  });
}

/**
 * Registers each refreshable provider that has cached extra models. No network.
 * Returns the provider ids it registered.
 */
export function registerCachedModels(config: Config): string[] {
  const registered: string[] = [];
  for (const id of REFRESHABLE_PROVIDERS) {
    const extras = readCachedModels(config, id);
    if (extras.length === 0) continue;
    setProvider(buildProvider(id, extras));
    registered.push(id);
  }
  return registered;
}

/**
 * Fetches the latest pi-ai catalog for each provider through pi-ai's
 * refreshModels(), stores the extra models and registers the provider.
 * A failed provider keeps its previous cache and registration.
 */
export async function refreshCatalog(
  config: Config,
  options: { readonly providers?: readonly string[]; readonly fetch?: FetchFn } = {},
): Promise<RefreshResult[]> {
  const ids = options.providers ?? REFRESHABLE_PROVIDERS;
  const doFetch = options.fetch ?? ((url, init) => fetch(url, init));
  return Promise.all(
    ids.map(async (id): Promise<RefreshResult> => {
      if (!BUILTINS.has(id)) return { provider: id, ok: false, error: `'${id}' is not a refreshable provider` };
      const store = fileStore(config, id);
      const provider = buildProvider(id, [], { fetch: doFetch, timeoutMs: config.budgets.httpTimeoutMs });
      try {
        await provider.refreshModels?.({ store, allowNetwork: true, force: true });
      } catch (err) {
        return { provider: id, ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      const added = readCachedModels(config, id);
      setProvider(buildProvider(id, added));
      return { provider: id, ok: true, added: added.map((m) => m.id) };
    }),
  );
}
