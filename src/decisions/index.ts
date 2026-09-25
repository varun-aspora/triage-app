// Decision models: typed questions in, typed answers out (see ./types.ts).
// Callers import from here; only ./providers/ imports a vendor SDK.
export { choice, decide, DecisionError, DEFAULT_DECISION_TIMEOUT_MS, score, yesNo } from './decide.ts';
export type { DecideOptions, DecisionErrorCode } from './decide.ts';
export { decisionProviderFor, decisionRoute, isDecisionSpec } from './registry.ts';
export type { DecisionRoute } from './registry.ts';
export type * from './types.ts';
