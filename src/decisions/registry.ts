// Model spec -> DecisionProvider. The one place that knows which vendor
// serves which spec, so callers only ever hold a spec string from config and
// a DecisionProvider. A new vendor is a new adapter in ./providers/ plus a
// case here.
//
// Specs:
// - typesafe/<model>              TypeSafe directly, TYPESAFE_API_KEY
// - openrouter/typesafe/<model>   TypeSafe through OpenRouter, OPENROUTER_API_KEY
// - openrouter/~typesafe/<alias>  an OpenRouter alias such as jev-latest
import type { Config } from '../config/env.ts';
import { DecisionError } from './decide.ts';
import { typesafeProvider, type TypeSafeProviderOptions } from './providers/typesafe.ts';
import type { DecisionProvider } from './types.ts';

export type DecisionRoute = {
  /** Provider id: who is called over HTTP. */
  readonly provider: 'typesafe' | 'openrouter';
  /** Model id as that provider names it. */
  readonly model: string;
  /** The config key the provider needs. */
  readonly keyName: 'TYPESAFE_API_KEY' | 'OPENROUTER_API_KEY';
};

/** How a spec is served, or undefined when it is not a decision model spec. */
export function decisionRoute(spec: string): DecisionRoute | undefined {
  const s = spec.trim();
  const direct = /^typesafe\/([^/\s]+)$/.exec(s);
  if (direct?.[1] !== undefined) return { provider: 'typesafe', model: direct[1], keyName: 'TYPESAFE_API_KEY' };
  const routed = /^openrouter\/(~?typesafe\/[^/\s]+)$/.exec(s);
  if (routed?.[1] !== undefined) return { provider: 'openrouter', model: routed[1], keyName: 'OPENROUTER_API_KEY' };
  return undefined;
}

export function isDecisionSpec(spec: string): boolean {
  return decisionRoute(spec) !== undefined;
}

export type DecisionProviderDeps = Pick<TypeSafeProviderOptions, 'fetch' | 'attemptTimeoutMs' | 'maxRetries'>;

/** Builds the provider for a spec. Throws DecisionError 'config' for an unknown spec or a missing key. */
export function decisionProviderFor(
  spec: string,
  config: Pick<Config, 'providers'>,
  deps: DecisionProviderDeps = {},
): DecisionProvider {
  const route = decisionRoute(spec);
  if (route === undefined) throw new DecisionError('config', 'decisions', { detail: 'not a decision model spec' });
  const apiKey = route.provider === 'typesafe' ? config.providers.typesafeApiKey : config.providers.openrouterApiKey;
  if (apiKey === undefined || apiKey.trim() === '') {
    throw new DecisionError('config', route.provider, { detail: `${route.keyName} is not set` });
  }
  return typesafeProvider({ id: route.provider, apiKey, model: route.model, ...deps });
}
