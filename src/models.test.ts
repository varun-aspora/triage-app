import { afterAll, afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxProvider } from '@earendil-works/pi-ai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import * as runtime from '@flue/runtime';
import { hasProvider, resolveModel } from '@flue/runtime/internal';
import { configFromRecord, loadConfig, type Config } from './config/env.ts';
import { ConfigError } from './config/errors.ts';

// models.ts loads config at import. Clear TRIAGE_HOME first so a home exported
// in the shell is never read, then import it dynamically.
const savedHome = process.env.TRIAGE_HOME;
delete process.env.TRIAGE_HOME;
const models = await import('./models.ts');

const SEED = 'seed-fake-9c41';
const made: string[] = [];
const spies: Array<{ mockRestore(): void }> = [];

afterEach(() => {
  for (const s of spies.splice(0)) s.mockRestore();
  delete process.env.TRIAGE_HOME;
});

afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
  if (savedHome !== undefined) process.env.TRIAGE_HOME = savedHome;
});

function cfg(record: Record<string, string>): Config {
  return configFromRecord(record, '/triage/home');
}

const BASE = {
  MODEL_CLASSIFIER: 'anthropic/claude-haiku-4-5',
  MODEL_TIER_CHEAP: 'anthropic/claude-haiku-4-5',
  MODEL_TIER_MID: 'anthropic/claude-sonnet-4-6',
  MODEL_TIER_STRONG: 'openai/gpt-5.5',
};

function configError(fn: () => unknown): ConfigError {
  try {
    fn();
  } catch (err) {
    if (err instanceof ConfigError) return err;
    throw err;
  }
  throw new Error('expected a ConfigError');
}

function spySetProvider() {
  const spy = spyOn(runtime, 'setProvider');
  spies.push(spy);
  return spy;
}

type ModelsModule = typeof import('./models.ts');

// A query string gives a fresh module instance, so its import side effect runs again.
async function freshImport(tag: string): Promise<ModelsModule> {
  const specifier = `./models.ts?import=${tag}`;
  return (await import(specifier)) as ModelsModule;
}

function makeHome(envText: string): string {
  const home = mkdtempSync(join(tmpdir(), 'triage-models-test-'));
  made.push(home);
  writeFileSync(join(home, '.env'), envText);
  return home;
}

describe('tier mapping', () => {
  test('each tier returns its MODEL_TIER_* spec', () => {
    const c = cfg(BASE);
    expect(models.modelForTier('cheap', c)).toBe('anthropic/claude-haiku-4-5');
    expect(models.modelForTier('mid', c)).toBe('anthropic/claude-sonnet-4-6');
    expect(models.modelForTier('strong', c)).toBe('openai/gpt-5.5');
  });

  test('MODEL_TIER_CHEAP may equal MODEL_TIER_MID', () => {
    const c = cfg({ ...BASE, MODEL_TIER_CHEAP: BASE.MODEL_TIER_MID });
    expect(models.modelForTier('cheap', c)).toBe(models.modelForTier('mid', c));
  });

  test('thinking level per tier comes from MODEL_THINKING_*', () => {
    expect(['cheap', 'mid', 'strong'].map((t) => models.thinkingForTier(t as 'cheap', cfg(BASE)))).toEqual([
      'off',
      'low',
      'high',
    ]);
    const c = cfg({ ...BASE, MODEL_THINKING_CHEAP: 'minimal', MODEL_THINKING_MID: 'medium', MODEL_THINKING_STRONG: 'max' });
    expect(models.thinkingForTier('cheap', c)).toBe('minimal');
    expect(models.thinkingForTier('mid', c)).toBe('medium');
    expect(models.thinkingForTier('strong', c)).toBe('max');
  });

  test('blank MODEL_CODE_WALKER falls back to MODEL_TIER_STRONG', () => {
    expect(models.codeWalkerModel(cfg({ ...BASE, MODEL_CODE_WALKER: '' }))).toBe('openai/gpt-5.5');
    expect(models.codeWalkerModel(cfg({ ...BASE, MODEL_CODE_WALKER: 'anthropic/claude-opus-4-6' }))).toBe(
      'anthropic/claude-opus-4-6',
    );
  });

  test('the fallback reports MODEL_TIER_STRONG when the strong spec is refused', () => {
    const err = configError(() => models.codeWalkerModel(cfg({ ...BASE, MODEL_TIER_STRONG: `openrouter/${SEED}/x` })));
    expect(err.keys).toEqual(['MODEL_TIER_STRONG']);
  });

  test('classifier accepts anthropic, openai, openrouter and configured ollama', () => {
    for (const spec of ['anthropic/claude-haiku-4-5', 'openai/gpt-5-mini', 'openrouter/moonshotai/kimi-k2.6']) {
      expect(models.classifierModel(cfg({ ...BASE, MODEL_CLASSIFIER: spec }))).toBe(spec);
    }
    const c = cfg({ ...BASE, MODEL_CLASSIFIER: 'ollama/qwen3:8b', OLLAMA_BASE_URL: 'http://localhost:11434/v1' });
    expect(models.classifierModel(c)).toBe('ollama/qwen3:8b');
  });

  test('parseSpec splits at the first slash', () => {
    expect(models.parseSpec('openrouter/moonshotai/kimi-k2.6')).toEqual({
      provider: 'openrouter',
      modelId: 'moonshotai/kimi-k2.6',
    });
    expect(models.parseSpec('nope')).toBeUndefined();
  });
});

describe('refused specs', () => {
  const slots: Array<[string, (c: Config) => string]> = [
    ['MODEL_TIER_CHEAP', (c) => models.modelForTier('cheap', c)],
    ['MODEL_TIER_MID', (c) => models.modelForTier('mid', c)],
    ['MODEL_TIER_STRONG', (c) => models.modelForTier('strong', c)],
    ['MODEL_CODE_WALKER', (c) => models.codeWalkerModel(c)],
  ];

  for (const [key, call] of slots) {
    test(`openrouter in ${key} is refused and the error names the key only`, () => {
      const err = configError(() => call(cfg({ ...BASE, [key]: `openrouter/${SEED}/model` })));
      expect(err.keys).toEqual([key]);
      expect(err.message).toContain(key);
      expect(err.message).toContain('D41');
      expect(err.message).not.toContain(SEED);
    });
  }

  test('a spec without a slash, or with an empty side, is refused', () => {
    for (const bad of [SEED, `/${SEED}`, `${SEED}/`]) {
      const err = configError(() => models.modelForTier('mid', cfg({ ...BASE, MODEL_TIER_MID: bad })));
      expect(err.keys).toEqual(['MODEL_TIER_MID']);
      expect(err.message).not.toContain(SEED);
    }
  });

  test('an unknown, unregistered provider is refused', () => {
    const err = configError(() =>
      models.modelForTier('cheap', cfg({ ...BASE, MODEL_TIER_CHEAP: `unregistered-t061/${SEED}` })),
    );
    expect(err.keys).toEqual(['MODEL_TIER_CHEAP']);
    expect(err.message).toContain('not registered');
    expect(err.message).not.toContain(SEED);
    expect(err.message).not.toContain('unregistered-t061');
  });

  test('an unknown provider is refused for the classifier too', () => {
    const err = configError(() => models.classifierModel(cfg({ ...BASE, MODEL_CLASSIFIER: `unregistered-t061/${SEED}` })));
    expect(err.keys).toEqual(['MODEL_CLASSIFIER']);
  });

  test('an unset tier or classifier key is refused by name', () => {
    expect(configError(() => models.modelForTier('strong', cfg({}))).keys).toEqual(['MODEL_TIER_STRONG']);
    expect(configError(() => models.classifierModel(cfg({}))).keys).toEqual(['MODEL_CLASSIFIER']);
  });

  test('ollama with blank OLLAMA_BASE_URL fails with a named reason', () => {
    const err = configError(() =>
      models.modelForTier('cheap', cfg({ ...BASE, MODEL_TIER_CHEAP: `ollama/${SEED}`, OLLAMA_BASE_URL: '' })),
    );
    expect(err.keys).toEqual(['MODEL_TIER_CHEAP']);
    expect(err.message).toContain('OLLAMA_BASE_URL is blank');
    expect(err.message).not.toContain(SEED);
  });
});

describe('acceptsImages', () => {
  test('reads input from injected metadata', () => {
    const seen: string[] = [];
    const stub = (spec: string) => {
      seen.push(spec);
      return spec === 'x/vision' ? { input: ['text', 'image'] } : { input: ['text'] };
    };
    expect(models.acceptsImages('x/vision', stub)).toBe(true);
    expect(models.acceptsImages('x/plain', stub)).toBe(false);
    expect(seen).toEqual(['x/vision', 'x/plain']);
  });

  test('a model no catalog knows counts as text-only', () => {
    expect(models.acceptsImages('x/unknown', () => undefined)).toBe(false);
    expect(models.acceptsImages(`unregistered-t061/${SEED}`)).toBe(false);
    expect(models.acceptsImages('no-slash')).toBe(false);
  });

  test('the default lookup reads the pi-ai built-in catalog', () => {
    const catalog = anthropicProvider().getModels();
    const withImage = catalog.find((m) => m.input.includes('image'));
    expect(withImage).toBeDefined();
    if (withImage === undefined) return;
    expect(models.lookupModel(`anthropic/${withImage.id}`)?.input).toEqual(withImage.input);
    expect(models.acceptsImages(`anthropic/${withImage.id}`)).toBe(true);
    expect(models.acceptsImages('anthropic/not-a-real-model-t061')).toBe(false);
  });
});

describe('registered providers', () => {
  test('faux/* is accepted once a provider with id faux is registered', () => {
    const faux = fauxProvider({
      provider: 'faux',
      models: [
        { id: 'cheap', input: ['text'] },
        { id: 'mid', input: ['text'] },
        { id: 'strong', input: ['text', 'image'] },
      ],
    });
    runtime.setProvider(faux.provider);
    const c = cfg({ MODEL_TIER_CHEAP: 'faux/cheap', MODEL_TIER_MID: 'faux/mid', MODEL_TIER_STRONG: 'faux/strong' });
    expect(models.modelForTier('cheap', c)).toBe('faux/cheap');
    expect(models.modelForTier('mid', c)).toBe('faux/mid');
    expect(models.modelForTier('strong', c)).toBe('faux/strong');
    expect(models.acceptsImages('faux/strong')).toBe(true);
    expect(models.acceptsImages('faux/cheap')).toBe(false);
    expect(models.acceptsImages('faux/missing')).toBe(false);
  });

  test('registerProviders registers ollama once, with the configured models', () => {
    const spy = spySetProvider();
    const c = cfg({
      ...BASE,
      MODEL_CLASSIFIER: 'ollama/qwen3:8b',
      MODEL_TIER_CHEAP: 'ollama/llama3.1:8b',
      OLLAMA_BASE_URL: 'http://localhost:11434/v1',
    });
    expect(models.registerProviders(c)).toBe(true);
    expect(models.registerProviders(c)).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0].id).toBe('ollama');
    expect(hasProvider('ollama')).toBe(true);
    const m = resolveModel('ollama/llama3.1:8b');
    expect(m.baseUrl).toBe('http://localhost:11434/v1');
    expect(m.input).toEqual(['text']);
    expect(models.acceptsImages('ollama/qwen3:8b')).toBe(false);
  });

  test('registerProviders does nothing when OLLAMA_BASE_URL is blank', () => {
    const spy = spySetProvider();
    expect(models.registerProviders(cfg({ ...BASE, OLLAMA_BASE_URL: '' }))).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('no network', () => {
  test('no function in the module calls fetch', () => {
    const fetchSpy = spyOn(globalThis, 'fetch');
    spies.push(fetchSpy);
    const c = cfg({ ...BASE, MODEL_CODE_WALKER: 'ollama/nw-t061', OLLAMA_BASE_URL: 'http://localhost:11434/v1' });
    models.registerProviders(c);
    for (const t of ['cheap', 'mid', 'strong'] as const) {
      models.acceptsImages(models.modelForTier(t, c));
      models.thinkingForTier(t, c);
    }
    models.acceptsImages(models.classifierModel(c));
    models.acceptsImages(models.codeWalkerModel(c));
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('import side effect', () => {
  test('import with a test home registers ollama once', async () => {
    const home = makeHome(
      ['OLLAMA_BASE_URL=http://localhost:11434/v1', 'MODEL_TIER_CHEAP=ollama/sidefx-t061', ''].join('\n'),
    );
    process.env.TRIAGE_HOME = home;
    const spy = spySetProvider();
    const fresh = await freshImport('with-home');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0].id).toBe('ollama');
    expect(fresh.registerProviders(loadConfig({ home }))).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(fresh.modelForTier('cheap')).toBe('ollama/sidefx-t061');
    expect(resolveModel('ollama/sidefx-t061').id).toBe('sidefx-t061');
  });

  test('import with no TRIAGE_HOME registers nothing and does not throw', async () => {
    delete process.env.TRIAGE_HOME;
    const spy = spySetProvider();
    const fresh = await freshImport('no-home');
    expect(spy).not.toHaveBeenCalled();
    // Using the loaded config later still needs a home, and says so by key.
    expect(configError(() => fresh.modelForTier('cheap')).keys).toEqual(['TRIAGE_HOME']);
  });

  test('import with a home that is set but broken still throws', async () => {
    process.env.TRIAGE_HOME = makeHome(`TRIAGE_DB_PROVIDER=${SEED}\n`);
    const spy = spySetProvider();
    let caught: unknown;
    try {
      await freshImport('broken-home');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as ConfigError).keys).toContain('TRIAGE_DB_PROVIDER');
    expect((caught as ConfigError).message).not.toContain(SEED);
    expect(spy).not.toHaveBeenCalled();
  });
});
