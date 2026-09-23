// The llm-rubric grader for the classifier suite, on TRIAGE_EVAL_JUDGE_MODEL
// (D42). Built only by resolveJudge in judge.ts, which checks the spec first.
//
// promptfoo sends the rendered rubric prompt, a JSON array of {role, content}
// messages, and parses a {reason, pass, score} object from the reply. System
// messages become the pi-ai system prompt and user messages the user turns.
//
// The call goes through pi-ai with the judge's own provider and API key from
// config (defaultComplete from the classifier). Its spend counts against the
// same suite budget as the classifier calls, so once the cap is passed the
// judge refuses too.
import type { AssistantMessage, Context, Message } from '@earendil-works/pi-ai';
import type { ApiProvider, CallApiContextParams, CallApiOptionsParams, ProviderResponse } from 'promptfoo';

import { defaultComplete, type CompleteFn } from '../../src/classify/classify.ts';
import type { Config } from '../../src/config/env.ts';
import { CostError, type CostModel } from '../../src/evals/cost.ts';
import { COST_CAP_EXCEEDED, defaultCostModel, type SuiteBudget } from './provider-classifier.ts';

export const JUDGE_ID_PREFIX = 'triage-judge:';
export const JUDGE_TIMEOUT_MS = 60_000;

export type JudgeProviderDeps = {
  readonly budget: SuiteBudget;
  /** Default: defaultComplete(config). */
  readonly complete?: CompleteFn;
  /** Default: defaultCostModel. */
  readonly costModel?: (spec: string) => CostModel;
  readonly timeoutMs?: number;
};

export class JudgeProvider implements ApiProvider {
  readonly model: string;
  private readonly complete: CompleteFn;
  private readonly deps: JudgeProviderDeps;

  constructor(model: string, config: Config, deps: JudgeProviderDeps) {
    this.model = model;
    this.complete = deps.complete ?? defaultComplete(config);
    this.deps = deps;
  }

  id(): string {
    return `${JUDGE_ID_PREFIX}${this.model}`;
  }

  async callApi(prompt: string, _context?: CallApiContextParams, options?: CallApiOptionsParams): Promise<ProviderResponse> {
    const refusal = this.deps.budget.refusal();
    if (refusal !== undefined) return { error: refusal, metadata: { judge: this.model, [COST_CAP_EXCEEDED]: true } };

    const context = rubricContext(prompt);
    if (typeof context === 'string') return { error: `judge: ${context}` };

    const timeout = AbortSignal.timeout(this.deps.timeoutMs ?? JUDGE_TIMEOUT_MS);
    const signal = options?.abortSignal ? AbortSignal.any([options.abortSignal, timeout]) : timeout;
    let reply: AssistantMessage;
    try {
      reply = await this.complete(this.model, context, { signal });
    } catch (err) {
      return { error: `judge call failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (reply.stopReason === 'error' || reply.stopReason === 'aborted') {
      return { error: `judge call failed: ${reply.errorMessage ?? reply.stopReason}` };
    }

    let cost: number;
    try {
      cost = this.deps.budget.add((this.deps.costModel ?? defaultCostModel)(this.model), reply.usage);
    } catch (err) {
      return { error: `cost meter: ${err instanceof CostError ? err.message : 'cost could not be computed'}` };
    }

    const output = reply.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    return {
      output,
      cost,
      tokenUsage: {
        prompt: reply.usage.input + reply.usage.cacheRead + reply.usage.cacheWrite,
        completion: reply.usage.output,
        total: reply.usage.totalTokens,
        numRequests: 1,
      },
      metadata: { judge: this.model },
    };
  }
}

/**
 * Turns a promptfoo grading prompt into a pi-ai context. A JSON message array
 * keeps its roles (system and user only); any other string is one user turn.
 * Returns an error string for a message array it cannot use.
 */
export function rubricContext(prompt: string): Context | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(prompt);
  } catch {
    parsed = undefined;
  }
  if (!Array.isArray(parsed)) return { messages: [userTurn(prompt)] };

  const system: string[] = [];
  const messages: Message[] = [];
  for (const entry of parsed as unknown[]) {
    const role = (entry as { role?: unknown })?.role;
    const content = (entry as { content?: unknown })?.content;
    if (typeof content !== 'string') return 'grading prompt message has no text content';
    if (role === 'system') system.push(content);
    else if (role === 'user') messages.push(userTurn(content));
    else return 'grading prompt may hold system and user messages only';
  }
  if (messages.length === 0) return 'grading prompt has no user message';
  return system.length > 0 ? { systemPrompt: system.join('\n\n'), messages } : { messages };
}

function userTurn(content: string): Message {
  return { role: 'user', content, timestamp: Date.now() };
}
