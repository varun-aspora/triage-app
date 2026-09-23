// Model specs per tier, provider registration and image capability (HLD §1.1, §7 Providers).
//
// This is a side-effect module. Importing it loads config from TRIAGE_HOME and
// registers the Ollama provider with setProvider when OLLAMA_BASE_URL is set.
// The Triage agent module and the classifier import it, so start(), vite build
// and flue run all see the registration; start() is called without providers.
// With TRIAGE_HOME unset (vite build, --help) the import registers nothing and
// does not throw.
//
// Spec rules (D1, D41, D42):
// - A spec is 'provider/model', split at the first '/'.
// - anthropic and openai are pi-ai built-ins and always accepted.
// - openrouter is accepted for MODEL_CLASSIFIER only.
// - ollama needs OLLAMA_BASE_URL.
// - Any other provider must already be registered with setProvider (faux in tests).
// Errors name the env key, never its value. Nothing here makes a network call.

import { createProvider, type Model } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';
import { setProvider } from '@flue/runtime';
// Not in the public entry: hasProvider and resolveModel read the same registry setProvider writes.
import { hasProvider, resolveModel } from '@flue/runtime/internal';
import { loadConfig, type Config, type ThinkingLevel } from './config/env.ts';
import { ConfigError } from './config/errors.ts';
import { HOME_KEY } from './config/keys.ts';
import type { Tier } from './types/core.ts';

export type ModelSpec = { readonly provider: string; readonly modelId: string };

/** The part of pi-ai model metadata this module reads. */
export type ModelMetadata = { readonly input: readonly string[] };

/** Returns pi-ai metadata for a spec, or undefined when no catalog knows the model. */
export type ModelLookup = (spec: string) => ModelMetadata | undefined;

const OLLAMA = 'ollama';
const OPENROUTER = 'openrouter';
const OLLAMA_KEY = 'OLLAMA_BASE_URL';

// pi-ai built-in catalogs this project uses. Built lazily; they are static lists.
type Catalog = () => { getModels(): readonly Model<any>[] };
const BUILTIN_CATALOGS: ReadonlyMap<string, Catalog> = new Map<string, Catalog>([
  ['anthropic', anthropicProvider],
  ['openai', openaiProvider],
  ['openrouter', openrouterProvider],
]);

const TIER_KEYS: Readonly<Record<Tier, string>> = {
  cheap: 'MODEL_TIER_CHEAP',
  mid: 'MODEL_TIER_MID',
  strong: 'MODEL_TIER_STRONG',
};

/** Splits 'provider/model' at the first '/'. Undefined when either side is empty. */
export function parseSpec(spec: string): ModelSpec | undefined {
  const slash = spec.indexOf('/');
  if (slash <= 0 || slash === spec.length - 1) return undefined;
  return { provider: spec.slice(0, slash), modelId: spec.slice(slash + 1) };
}

/** The model spec for a tier, validated. */
export function modelForTier(tier: Tier, config: Config = activeConfig()): string {
  const models = config.models;
  const spec = tier === 'cheap' ? models.tierCheap : tier === 'mid' ? models.tierMid : models.tierStrong;
  return checkSpec(TIER_KEYS[tier], spec, config, false);
}

/** The thinking level for a tier, from MODEL_THINKING_*. */
export function thinkingForTier(tier: Tier, config: Config = activeConfig()): ThinkingLevel {
  const models = config.models;
  return tier === 'cheap' ? models.thinkingCheap : tier === 'mid' ? models.thinkingMid : models.thinkingStrong;
}

/** The classifier model spec. The only slot where openrouter is allowed (D41). */
export function classifierModel(config: Config = activeConfig()): string {
  return checkSpec('MODEL_CLASSIFIER', config.models.classifier, config, true);
}

/** The code_walker model spec. Blank MODEL_CODE_WALKER falls back to MODEL_TIER_STRONG. */
export function codeWalkerModel(config: Config = activeConfig()): string {
  if (config.models.codeWalker === undefined) return modelForTier('strong', config);
  return checkSpec('MODEL_CODE_WALKER', config.models.codeWalker, config, false);
}

/** Whether the model takes image input, read from pi-ai model metadata (D36). Unknown models count as text-only. */
export function acceptsImages(spec: string, lookup: ModelLookup = lookupModel): boolean {
  return lookup(spec)?.input.includes('image') ?? false;
}

/**
 * Metadata from the runtime registry when the provider is registered there,
 * otherwise from the pi-ai built-in catalog. Static data only, no network.
 */
export function lookupModel(spec: string): ModelMetadata | undefined {
  const parsed = parseSpec(spec);
  if (parsed === undefined) return undefined;
  if (hasProvider(parsed.provider)) {
    try {
      return resolveModel(spec);
    } catch {
      return undefined;
    }
  }
  const catalog = BUILTIN_CATALOGS.get(parsed.provider);
  return catalog?.().getModels().find((m) => m.id === parsed.modelId);
}

let registeredOllama: string | undefined;

/**
 * Registers the Ollama provider with setProvider when OLLAMA_BASE_URL is set.
 * Its model list is every ollama/* spec in the model keys. Calling it again
 * with the same settings does nothing. Returns true when it registered.
 */
export function registerProviders(config: Config): boolean {
  const baseUrl = config.providers.ollamaBaseUrl;
  if (baseUrl === undefined) return false;
  const ids = ollamaModelIds(config);
  const signature = JSON.stringify([baseUrl, ids]);
  if (registeredOllama === signature) return false;
  setProvider(ollamaProvider(baseUrl, ids));
  registeredOllama = signature;
  return true;
}

function ollamaModelIds(config: Config): string[] {
  const m = config.models;
  const ids = new Set<string>();
  for (const spec of [m.classifier, m.tierCheap, m.tierMid, m.tierStrong, m.codeWalker]) {
    const parsed = spec === undefined ? undefined : parseSpec(spec);
    if (parsed?.provider === OLLAMA) ids.add(parsed.modelId);
  }
  return [...ids].sort();
}

// Ollama's OpenAI-compatible endpoint, keyless. Models are declared text-only:
// Ollama does not report vision support up front, so the tier policy treats them
// as unable to take images. Context and output sizes follow the Flue guide example.
function ollamaProvider(baseUrl: string, ids: readonly string[]) {
  return createProvider({
    id: OLLAMA,
    name: 'Ollama (local)',
    baseUrl,
    auth: { apiKey: { name: 'Ollama (keyless)', resolve: async () => ({ auth: {} }) } },
    models: ids.map((id) => ({
      id,
      name: `${id} (ollama)`,
      api: 'openai-completions' as const,
      provider: OLLAMA,
      baseUrl,
      reasoning: false,
      input: ['text' as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 8192,
    })),
    api: openAICompletionsApi(),
  });
}

function checkSpec(key: string, spec: string | undefined, config: Config, allowOpenRouter: boolean): string {
  if (spec === undefined) throw ConfigError.of(key, 'is not set');
  const parsed = parseSpec(spec);
  if (parsed === undefined) throw ConfigError.of(key, "must be a 'provider/model' spec");
  const { provider } = parsed;
  if (provider === OPENROUTER) {
    if (allowOpenRouter) return spec;
    throw ConfigError.of(key, 'may not use openrouter; openrouter is allowed for MODEL_CLASSIFIER only (D41)');
  }
  if (provider === OLLAMA) {
    if (config.providers.ollamaBaseUrl === undefined) {
      throw ConfigError.of(key, `uses the ollama provider but ${OLLAMA_KEY} is blank`);
    }
    return spec;
  }
  if (BUILTIN_CATALOGS.has(provider) || hasProvider(provider)) return spec;
  throw ConfigError.of(key, 'names a provider that is not built in (anthropic, openai) and not registered with setProvider');
}

// ---------------------------------------------------------------- import side effect

let active: Config | undefined = loadAtImport();

function loadAtImport(): Config | undefined {
  try {
    const config = loadConfig();
    registerProviders(config);
    return config;
  } catch (err) {
    if (isHomeUnset(err)) return undefined;
    throw err;
  }
}

// Only an unset TRIAGE_HOME is skipped. A home that is set but broken still fails loudly.
function isHomeUnset(err: unknown): boolean {
  return (
    err instanceof ConfigError &&
    err.problems.length === 1 &&
    err.problems[0]?.key === HOME_KEY &&
    err.problems[0].reason.startsWith('is not set')
  );
}

// The config loaded at import, or loaded now if TRIAGE_HOME was unset then.
function activeConfig(): Config {
  if (active === undefined) {
    active = loadConfig();
    registerProviders(active);
  }
  return active;
}
