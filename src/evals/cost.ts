// Suite spend meter (D42, P1 §3.7). Prices come from the model's pi-ai cost
// metadata through calculateCost (usageCostUsd in src/usage/price.ts), never
// from a provider's own usage.cost, so a faux or local model costs 0 and a
// known model costs what pi-ai says.
// The one exception is a decision model (src/decisions/): pi-ai has no entry
// for it, so addUsd meters the cost its provider reports.
//
// Bad input fails loudly: a NaN or negative token count, a model with no cost
// metadata or a cap that is not a number would otherwise make overCap quietly
// return false and let a suite spend without limit.
import { CostError, usageCostUsd, type CostModel, type UsageTokens } from '../usage/price.ts';

// The pricer moved to src/usage/price.ts (D59) so the run meter shares it.
// These re-exports keep the eval providers and their tests unchanged.
export { CostError, usageCostUsd, type CostModel, type UsageTokens };

/**
 * Parses a cap. Blank (undefined, null, empty or whitespace) means no cap and
 * returns undefined. Anything else must be a finite number >= 0.
 */
export function parseCapUsd(cap: number | string | null | undefined): number | undefined {
  if (cap === undefined || cap === null) return undefined;
  if (typeof cap === 'string') {
    if (cap.trim() === '') return undefined;
    const n = Number(cap.trim());
    if (!Number.isFinite(n) || n < 0) throw new CostError('cost cap must be a number >= 0');
    return n;
  }
  if (!Number.isFinite(cap) || cap < 0) throw new CostError('cost cap must be a number >= 0');
  return cap;
}

export type ModelSpend = { readonly model: string; readonly calls: number; readonly usd: number };

export class CostMeter {
  private total = 0;
  private readonly perModel = new Map<string, { calls: number; usd: number }>();

  /** Adds one call's usage and returns its cost in USD. */
  add(model: CostModel, usage: UsageTokens): number {
    const usd = usageCostUsd(model, usage);
    const key = `${model.provider}/${model.id}`;
    const entry = this.perModel.get(key) ?? { calls: 0, usd: 0 };
    entry.calls += 1;
    entry.usd += usd;
    this.perModel.set(key, entry);
    this.total += usd;
    return usd;
  }

  /** Adds one call whose provider reported its own USD cost (decision models). */
  addUsd(model: string, usd: number | undefined): number {
    if (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0) {
      throw new CostError(`model ${model} reported no usable cost`);
    }
    const entry = this.perModel.get(model) ?? { calls: 0, usd: 0 };
    entry.calls += 1;
    entry.usd += usd;
    this.perModel.set(model, entry);
    this.total += usd;
    return usd;
  }

  totalUsd(): number {
    return this.total;
  }

  /** Spend per model spec, sorted by spec. */
  byModel(): ModelSpend[] {
    return [...this.perModel.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([model, e]) => ({ model, calls: e.calls, usd: e.usd }));
  }

  /** False when the cap is blank; true once the total is strictly above it. */
  overCap(capUsd: number | string | null | undefined): boolean {
    const cap = parseCapUsd(capUsd);
    return cap !== undefined && this.total > cap;
  }
}
