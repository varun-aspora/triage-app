// A scripted DecisionProvider for tests and evals: no network. The answer
// function sees the request and returns the answers (or throws), so a test
// can check what was asked and decide what comes back.
import type { DecisionAnswer, DecisionProvider, DecisionRequest, DecisionResult } from './types.ts';

export type FakeAnswers = (request: DecisionRequest) => Record<string, DecisionAnswer> | Promise<Record<string, DecisionAnswer>>;

export type FakeDecisionProvider = DecisionProvider & {
  /** Every request received, in order. */
  readonly requests: DecisionRequest[];
};

export function fakeDecisionProvider(answers: FakeAnswers, options: { id?: string; model?: string } = {}): FakeDecisionProvider {
  const requests: DecisionRequest[] = [];
  const model = options.model ?? 'fake/decider';
  return {
    id: options.id ?? 'fake',
    model,
    requests,
    async decide(request): Promise<DecisionResult> {
      requests.push(request);
      return { answers: await answers(request), model, usage: { inputTokens: 0, outputTokens: 0 } } as DecisionResult;
    },
  };
}
