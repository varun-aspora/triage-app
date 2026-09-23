// Fake model provider for contract tests and evals (D42). Test support only:
// nothing in the served app imports it.
//
// createFakeModel() wraps pi-ai's fauxProvider under provider id 'faux' with
// four models: faux/classifier, faux/cheap and faux/mid (text only) and
// faux/strong (text and image, so the D36 tier policy has an image-capable
// tier). modelEnv holds the MODEL_* overrides to pass to makeTestHome().
//
// Registration. install() calls setProvider(faux.provider) from
// '@flue/runtime'. setProvider replaces by provider id only, so the Ollama
// provider that src/models.ts registers at import stays registered, and
// start() without `providers` skips ids that are already present, so
// install() may run before or after start(). The alternative is
// start({ providers: [fake.provider] }), but that replaces the whole default
// set, which clashes with the rule that start() is called without providers
// (HLD §7, P1 "driver lifecycle"). Call install() before modelForTier() or
// classifierModel() read a faux/* spec, since they check the registry.
//
// One queue. faux has a single response queue per provider. Every model
// call in the process draws from it in call order: the root agent's turns,
// each delegate's turns and harness.prompt() calls. Verified by the spike in
// test/contract/fake-model.contract.ts: a delegate started through the task
// tool draws its turns from the same queue, between the parent turn that
// called task and the parent turn that reads the task result. So a script
// for a run with delegates lists the child's turns inline, or uses byAgent()
// to pick a queue per agent by its system prompt, which is safer once
// delegates run in parallel.
//
// Failures. A factory that throws becomes an assistant message with
// stopReason 'error' and the thrown message as errorMessage, which Flue
// settles as a failed run. The messages this module throws start with
// FAKE_MODEL_ERROR_PREFIX and are also kept in failures(), so a test can
// assert on them even when the runtime reports the run differently.
//
// No API key is read: faux's auth resolves to an empty credential and this
// module never reads the environment. Nothing here makes a network call.

import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type AssistantMessage,
  type Context,
  type FauxModelDefinition,
  type FauxProviderHandle,
  type FauxResponseFactory,
  type FauxResponseStep,
  type Provider,
  type ToolCall,
} from '@earendil-works/pi-ai';
import { setProvider } from '@flue/runtime';

export const FAKE_PROVIDER_ID = 'faux';
export const FAKE_MODEL_IDS = ['classifier', 'cheap', 'mid', 'strong'] as const;
export type FakeModelId = (typeof FAKE_MODEL_IDS)[number];

export const FAKE_MODEL_ERROR_PREFIX = 'fake model:';

/** The model env keys the helper overrides, each set to a 'faux/<id>' spec. */
export type FakeModelEnv = {
  readonly MODEL_CLASSIFIER: string;
  readonly MODEL_TIER_CHEAP: string;
  readonly MODEL_TIER_MID: string;
  readonly MODEL_TIER_STRONG: string;
  readonly MODEL_CODE_WALKER: string;
};

/** One scripted response: a fixed assistant message or a factory. */
export type FakeStep = FauxResponseStep;

/** Response queues keyed by a string that must appear in the agent's system prompt. */
export type FakeRoutes = Readonly<Record<string, readonly FakeStep[]>>;

/** A factory that routes each call by system prompt. size is the number of steps across all routes. */
export type FakeRouter = FauxResponseFactory & { readonly size: number };

export type FakeModelOptions = {
  /** Stream speed for faux; unset streams as fast as the event loop allows. */
  readonly tokensPerSecond?: number;
};

export type FakeModel = {
  readonly faux: FauxProviderHandle;
  readonly provider: Provider;
  readonly modelEnv: FakeModelEnv;
  /** Registers the provider with Flue's registry (setProvider, replace by id). */
  install(): void;
  /** Replaces the queue. A FakeRouter in steps is expanded to one entry per routed step. */
  script(steps: readonly (FakeStep | FakeRouter)[]): void;
  /** Builds a router over per-agent queues; pass it to script(). */
  byAgent(routes: FakeRoutes): FakeRouter;
  /** Queue entries not yet used, not counting the exhaustion guard. */
  pending(): number;
  /** Every error this helper raised, in order. */
  failures(): readonly string[];
};

export class FakeModelError extends Error {
  override readonly name = 'FakeModelError';
  constructor(message: string) {
    super(`${FAKE_MODEL_ERROR_PREFIX} ${message}`);
  }
}

const MODEL_DEFINITIONS: readonly FauxModelDefinition[] = [
  { id: 'classifier', name: 'Faux classifier', input: ['text'] },
  { id: 'cheap', name: 'Faux cheap tier', input: ['text'] },
  { id: 'mid', name: 'Faux mid tier', input: ['text'] },
  { id: 'strong', name: 'Faux strong tier', input: ['text', 'image'] },
];

const spec = (id: FakeModelId): string => `${FAKE_PROVIDER_ID}/${id}`;

const MODEL_ENV: FakeModelEnv = Object.freeze({
  MODEL_CLASSIFIER: spec('classifier'),
  MODEL_TIER_CHEAP: spec('cheap'),
  MODEL_TIER_MID: spec('mid'),
  MODEL_TIER_STRONG: spec('strong'),
  // code_walker runs on the strong tier by default (T06.1).
  MODEL_CODE_WALKER: spec('strong'),
});

const ROUTER = Symbol('fake-model-router');

export function createFakeModel(opts: FakeModelOptions = {}): FakeModel {
  const faux = fauxProvider({
    api: FAKE_PROVIDER_ID,
    provider: FAKE_PROVIDER_ID,
    models: MODEL_DEFINITIONS.map((m) => ({ ...m, input: [...(m.input ?? ['text'])] })),
    ...(opts.tokensPerSecond === undefined ? {} : { tokensPerSecond: opts.tokensPerSecond }),
  });
  const failures: string[] = [];
  let scripted = 0;

  const fail = (message: string): never => {
    const err = new FakeModelError(message);
    failures.push(err.message);
    throw err;
  };

  // Last entry of every script. It re-queues itself so each later call gets
  // the same clear error instead of faux's generic one.
  const exhausted: FauxResponseFactory = (context, _options, state) => {
    faux.appendResponses([exhausted]);
    return fail(
      `the scripted queue is exhausted: ${scripted} response(s) were scripted and call ${state.callCount} has none left. ` +
        `System prompt starts with "${firstLine(context)}"`,
    );
  };

  const byAgent = (routes: FakeRoutes): FakeRouter => {
    const keys = Object.keys(routes);
    if (keys.length === 0) throw new FakeModelError('byAgent needs at least one route');
    if (keys.some((k) => k.trim() === '')) throw new FakeModelError('byAgent route keys must be non-empty');
    const queues = new Map(keys.map((k) => [k, [...(routes[k] ?? [])]]));
    const router: FauxResponseFactory = async (context, options, state, model) => {
      const prompt = context.systemPrompt ?? '';
      const hits = keys.filter((k) => prompt.includes(k));
      if (hits.length === 0) {
        return fail(`no byAgent route matches the system prompt starting with "${firstLine(context)}" (routes: ${quoteAll(keys)})`);
      }
      if (hits.length > 1) {
        return fail(`more than one byAgent route matches the system prompt starting with "${firstLine(context)}" (${quoteAll(hits)})`);
      }
      const key = hits[0] as string;
      const step = queues.get(key)?.shift();
      if (step === undefined) {
        return fail(`byAgent route "${key}" has no responses left (system prompt starts with "${firstLine(context)}")`);
      }
      return typeof step === 'function' ? step(context, options, state, model) : step;
    };
    const size = keys.reduce((n, k) => n + (routes[k]?.length ?? 0), 0);
    return Object.assign(router, { size, [ROUTER]: true as const });
  };

  return {
    faux,
    provider: faux.provider,
    modelEnv: MODEL_ENV,
    install() {
      setProvider(faux.provider);
    },
    script(steps) {
      const expanded: FakeStep[] = [];
      for (const step of steps) {
        if (isRouter(step)) for (let i = 0; i < step.size; i++) expanded.push(step);
        else expanded.push(step);
      }
      scripted = expanded.length;
      faux.setResponses([...expanded, exhausted]);
    },
    byAgent,
    pending() {
      return Math.max(0, faux.getPendingResponseCount() - 1);
    },
    failures() {
      return [...failures];
    },
  };
}

// ---------------------------------------------------------------- step helpers

/** A turn that calls one tool. */
export function toolCall(name: string, args: ToolCall['arguments'], opts: { id?: string } = {}): AssistantMessage {
  return fauxAssistantMessage(fauxToolCall(name, args, opts), { stopReason: 'toolUse' });
}

/** A turn that calls several tools at once (parallel delegates, for example). */
export function toolCalls(calls: readonly { name: string; args: ToolCall['arguments'] }[]): AssistantMessage {
  if (calls.length === 0) throw new FakeModelError('toolCalls needs at least one call');
  return fauxAssistantMessage(
    calls.map((c) => fauxToolCall(c.name, c.args)),
    { stopReason: 'toolUse' },
  );
}

/** A final text turn. */
export function text(s: string): AssistantMessage {
  return fauxAssistantMessage(fauxText(s));
}

/** A turn that calls finish_report with the given Report draft (T06.9). */
export function finish(reportDraft: Record<string, unknown>): AssistantMessage {
  return toolCall('finish_report', reportDraft);
}

// ---------------------------------------------------------------- internals

function isRouter(step: FakeStep | FakeRouter): step is FakeRouter {
  return typeof step === 'function' && (step as unknown as Record<symbol, unknown>)[ROUTER] === true;
}

const FIRST_LINE_MAX = 120;

/** The first non-blank line of the system prompt, trimmed and capped. */
export function firstLine(context: Pick<Context, 'systemPrompt'>): string {
  const line = (context.systemPrompt ?? '').split('\n').map((l) => l.trim()).find((l) => l !== '');
  if (line === undefined) return '(no system prompt)';
  return line.length > FIRST_LINE_MAX ? `${line.slice(0, FIRST_LINE_MAX)}...` : line;
}

function quoteAll(keys: readonly string[]): string {
  return keys.map((k) => `"${k}"`).join(', ');
}
