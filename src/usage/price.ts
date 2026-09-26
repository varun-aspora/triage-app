// Prices model usage in USD (D42, D59). Rates come from the model's pi-ai cost
// metadata through calculateCost, never from a provider's own usage.cost, so
// a faux or local model costs 0 and a known model costs what pi-ai says.
//
// usageCostUsd prices one usage record on a model already in hand; the eval
// meter (src/evals/cost.ts) uses it. priceUsage prices by spec for the run
// meter: it resolves the spec through lookupModel and returns null when no
// rates are known, so the caller stores the row as unpriced instead of
// failing the run.
//
// - faux, ollama and hash (the mock embedder) are local or fake and price at 0.
// - pi-ai's catalog has no embedding models (checked against pi-ai 0.83.0 on
//   2026-09-26), so purpose 'embed' falls back to EMBEDDING_PRICES.
// - Decision models (typesafe/*, openrouter/typesafe/*) are not in any
//   catalog and come back null. The run meter presets their price from the
//   cost the provider reports (plan 3.5a); this module does not.
//
// Bad input fails loudly: a NaN or negative token count, or a model with no
// cost metadata passed to usageCostUsd, throws CostError.
import { calculateCost, type Api, type Model, type Usage } from '@earendil-works/pi-ai';

import { lookupModel, parseSpec } from '../models.ts';
import type { UsagePurpose } from '../types/usage.ts';

/** The parts of a pi-ai model the pricer reads. */
export type CostModel = Pick<Model<Api>, 'provider' | 'id' | 'cost'>;

/**
 * Token counts as pi-ai reports them. A usage.cost present on the input is
 * ignored. cacheWrite1h is the part of cacheWrite written with the 1-hour
 * retention, not an extra count.
 */
export type UsageTokens = Pick<Usage, 'input' | 'output' | 'cacheRead' | 'cacheWrite'> &
  Partial<Pick<Usage, 'cacheWrite1h'>>;

export class CostError extends Error {
  override readonly name = 'CostError';
}

const TOKEN_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite'] as const;

/** Providers that never charge: the faux test model, local Ollama and the mock hash embedder. */
const FREE_PROVIDERS: ReadonlySet<string> = new Set(['faux', 'ollama', 'hash']);

/**
 * USD per million input tokens for embedding models, keyed by MODEL_EMBEDDING
 * spec. Used only for purpose 'embed' and only when lookupModel has no rates.
 * A model missing here is unpriced (usd null), which makes a run's pricing
 * partial. Ollama embeddings are free through FREE_PROVIDERS.
 */
export const EMBEDDING_PRICES: Readonly<Record<string, number>> = Object.freeze({
  // https://developers.openai.com/api/docs/pricing (standard tier), read 2026-09-26.
  'openai/text-embedding-3-small': 0.02,
  // https://developers.openai.com/api/docs/pricing (standard tier), read 2026-09-26.
  'openai/text-embedding-3-large': 0.13,
  // https://developers.openai.com/api/docs/pricing (standard tier), read 2026-09-26.
  'openai/text-embedding-ada-002': 0.1,
});

const ZERO_RATES = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function count(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new CostError(`usage.${field} must be a finite number >= 0`);
  }
  return value;
}

function hasRates(cost: unknown): cost is CostModel['cost'] {
  if (typeof cost !== 'object' || cost === null) return false;
  const rates = cost as Record<string, unknown>;
  return TOKEN_FIELDS.every((f) => typeof rates[f] === 'number' && Number.isFinite(rates[f]));
}

/** The USD cost of one usage record on one model, from its cost metadata. */
export function usageCostUsd(model: CostModel, usage: UsageTokens): number {
  if (!hasRates(model?.cost)) {
    throw new CostError(`model ${model?.provider}/${model?.id} has no cost metadata`);
  }
  const [input, output, cacheRead, cacheWrite] = TOKEN_FIELDS.map((f) => count(usage?.[f], f)) as [
    number,
    number,
    number,
    number,
  ];
  const fresh: Usage = {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: { ...ZERO_RATES, total: 0 },
  };
  if (usage.cacheWrite1h !== undefined) fresh.cacheWrite1h = count(usage.cacheWrite1h, 'cacheWrite1h');
  // calculateCost writes into usage.cost, so it gets a fresh record. It reads
  // only model.cost.
  return calculateCost(model as Model<Api>, fresh).total;
}

/**
 * The USD cost of one usage record on the model a spec names, or null when no
 * rates are known for it. Token counts are checked first, so bad counts throw
 * even for an unpriced model.
 */
export function priceUsage(spec: string, tokens: UsageTokens, purpose?: UsagePurpose): number | null {
  for (const f of TOKEN_FIELDS) count(tokens?.[f], f);
  if (tokens.cacheWrite1h !== undefined) count(tokens.cacheWrite1h, 'cacheWrite1h');
  const parsed = parseSpec(spec);
  if (parsed === undefined) return null;
  const model = (cost: CostModel['cost']): CostModel => ({ provider: parsed.provider, id: parsed.modelId, cost });
  if (FREE_PROVIDERS.has(parsed.provider)) return usageCostUsd(model(ZERO_RATES), tokens);
  const cost = (lookupModel(spec) as { cost?: unknown } | undefined)?.cost;
  if (hasRates(cost)) return usageCostUsd(model(cost), tokens);
  if (purpose === 'embed') {
    const rate = EMBEDDING_PRICES[spec];
    if (rate !== undefined) return usageCostUsd(model({ ...ZERO_RATES, input: rate }), tokens);
  }
  return null;
}
