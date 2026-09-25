import { afterAll, afterEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import * as runtime from '@flue/runtime';
import { resolveModel } from '@flue/runtime/internal';
import { configFromRecord, type Config } from './config/env.ts';
import {
  PI_AI_CATALOG_BASE,
  extraModels,
  modelCacheDir,
  readCachedModels,
  refreshCatalog,
  registerCachedModels,
  type FetchFn,
} from './model-catalog.ts';
import { ensureConfiguredModels } from './model-refresh.ts';

const made: string[] = [];
const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  for (const s of spies.splice(0)) s.mockRestore();
});
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function home(record: Record<string, string> = {}): Config {
  const dir = mkdtempSync(join(tmpdir(), 'triage-model-catalog-test-'));
  made.push(dir);
  return configFromRecord(record, dir);
}

const NEW_OPENAI = 'gpt-t9-new';
const NEW_ANTHROPIC = 'claude-t9-new';

function modelEntry(id: string, provider: string, api: string, baseUrl: string) {
  return {
    id,
    name: id,
    api,
    provider,
    baseUrl,
    reasoning: true,
    input: ['text', 'image'],
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 272000,
    maxTokens: 128000,
    thinkingLevelMap: { low: 'low', high: 'high' },
    compat: { supportsStrictMode: true },
    promptCache: { short: 300 },
  };
}

// A published catalog: one known model, one new model, one on an API the provider does not serve.
function catalogFor(provider: string): unknown {
  if (provider === 'openai') {
    const known = openaiProvider().getModels()[0]!;
    return {
      'openai-responses': {
        [known.id]: { ...known, name: 'changed upstream' },
        [NEW_OPENAI]: modelEntry(NEW_OPENAI, 'openai', 'openai-responses', 'https://api.openai.com/v1'),
      },
      'openai-realtime': { 'rt-t9': modelEntry('rt-t9', 'openai', 'openai-realtime', 'https://api.openai.com/v1') },
    };
  }
  return {
    'anthropic-messages': {
      [NEW_ANTHROPIC]: modelEntry(NEW_ANTHROPIC, 'anthropic', 'anthropic-messages', 'https://api.anthropic.com'),
    },
  };
}

function fakeFetch(calls: string[], status = 200): FetchFn {
  return async (url) => {
    calls.push(url);
    const provider = url.slice(PI_AI_CATALOG_BASE.length).replace(/\.json$/, '');
    return new Response(JSON.stringify(catalogFor(provider)), { status });
  };
}

describe('extraModels', () => {
  test('keeps only models the installed catalog lacks, on an API the provider serves, with known fields', () => {
    const extras = extraModels(openaiProvider(), catalogFor('openai'));
    expect(extras.map((m) => m.id)).toEqual([NEW_OPENAI]);
    expect(extras[0]).not.toHaveProperty('promptCache');
    expect(extras[0]?.thinkingLevelMap).toEqual({ low: 'low', high: 'high' });
    expect(extraModels(anthropicProvider(), catalogFor('openai'))).toEqual([]);
  });

  test('a malformed catalog yields no models', () => {
    expect(extraModels(openaiProvider(), null)).toEqual([]);
    expect(extraModels(openaiProvider(), { 'openai-responses': { x: { id: 'x' } } })).toEqual([]);
  });
});

describe('refreshCatalog', () => {
  test('fetches each provider, caches the extras and registers them', async () => {
    const config = home();
    const calls: string[] = [];
    const results = await refreshCatalog(config, { fetch: fakeFetch(calls) });
    expect(calls.sort()).toEqual([`${PI_AI_CATALOG_BASE}anthropic.json`, `${PI_AI_CATALOG_BASE}openai.json`]);
    expect(results).toEqual([
      { provider: 'anthropic', ok: true, added: [NEW_ANTHROPIC] },
      { provider: 'openai', ok: true, added: [NEW_OPENAI] },
    ]);
    expect(readCachedModels(config, 'openai').map((m) => m.id)).toEqual([NEW_OPENAI]);
    expect(resolveModel(`openai/${NEW_OPENAI}`).contextWindow).toBe(272000);
    expect(resolveModel(`anthropic/${NEW_ANTHROPIC}`).input).toEqual(['text', 'image']);
    // Built-in models stay resolvable, with the installed metadata.
    const known = openaiProvider().getModels()[0]!;
    expect(resolveModel(`openai/${known.id}`).name).toBe(known.name);
  });

  test('a failed fetch reports the provider and keeps the previous cache', async () => {
    const config = home();
    await refreshCatalog(config, { providers: ['openai'], fetch: fakeFetch([]) });
    const results = await refreshCatalog(config, { providers: ['openai'], fetch: fakeFetch([], 503) });
    expect(results).toEqual([{ provider: 'openai', ok: false, error: 'catalog fetch for openai answered HTTP 503' }]);
    expect(readCachedModels(config, 'openai').map((m) => m.id)).toEqual([NEW_OPENAI]);
  });

  test('an unknown provider is refused without a fetch', async () => {
    const calls: string[] = [];
    const results = await refreshCatalog(home(), { providers: ['ollama'], fetch: fakeFetch(calls) });
    expect(results).toEqual([{ provider: 'ollama', ok: false, error: "'ollama' is not a refreshable provider" }]);
    expect(calls).toEqual([]);
  });
});

describe('registerCachedModels', () => {
  test('registers nothing and reads nothing from the network without a cache', () => {
    const spy = spyOn(runtime, 'setProvider');
    spies.push(spy);
    const config = home();
    expect(registerCachedModels(config)).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
    expect(existsSync(modelCacheDir(config))).toBe(false);
  });

  test('registers the cached extras from an earlier refresh', async () => {
    const config = home();
    await refreshCatalog(config, { providers: ['anthropic'], fetch: fakeFetch([]) });
    const stored = JSON.parse(readFileSync(join(modelCacheDir(config), 'anthropic.json'), 'utf8'));
    expect(stored.models.map((m: { id: string }) => m.id)).toEqual([NEW_ANTHROPIC]);
    const spy = spyOn(runtime, 'setProvider');
    spies.push(spy);
    expect(registerCachedModels(config)).toEqual(['anthropic']);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('ensureConfiguredModels', () => {
  const lookupNone = () => undefined;

  test('does not fetch when every configured model is found', async () => {
    const calls: string[] = [];
    const config = home({ MODEL_TIER_STRONG: 'anthropic/claude-sonnet-5', MODEL_CLASSIFIER: 'ollama/qwen3:8b' });
    expect(await ensureConfiguredModels(config, { fetch: fakeFetch(calls) })).toEqual({ refreshed: [], missing: [] });
    expect(calls).toEqual([]);
  });

  test('refreshes only the providers of missing models, then reports what is still missing', async () => {
    const calls: string[] = [];
    const config = home({ MODEL_TIER_MID: `openai/${NEW_OPENAI}`, MODEL_TIER_STRONG: 'openai/gpt-t9-never' });
    const result = await ensureConfiguredModels(config, { fetch: fakeFetch(calls) });
    expect(calls).toEqual([`${PI_AI_CATALOG_BASE}openai.json`]);
    expect(result.refreshed).toEqual([{ provider: 'openai', ok: true, added: [NEW_OPENAI] }]);
    expect(result.missing).toEqual([{ key: 'MODEL_TIER_STRONG', spec: 'openai/gpt-t9-never' }]);
  });

  test('ignores providers it cannot refresh', async () => {
    const calls: string[] = [];
    const config = home({ MODEL_CLASSIFIER: 'openrouter/x/y' });
    expect(await ensureConfiguredModels(config, { fetch: fakeFetch(calls), lookup: lookupNone })).toEqual({
      refreshed: [],
      missing: [],
    });
    expect(calls).toEqual([]);
  });
});
