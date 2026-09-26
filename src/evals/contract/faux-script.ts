// Scripted faux turns for contract tests and the eval driver (D42, P1 §3.2).
//
// The fake provider (src/mock/fake-model.ts) has one response queue per
// process. Every model call draws from it: the classifier, the Triage root,
// each delegate the root starts through the task tool, and the harness.prompt()
// synthesis call inside finish_report. fauxScript() puts one router on that
// queue and keeps a queue of turns per caller, so a script says which agent a
// turn is for instead of guessing the order calls will arrive in. That order
// is not fixed once delegates run in parallel.
//
// Routing spike (test/contract/faux-routing.contract.ts). Result:
// - The signal is the system prompt. Each agent renders its own: the root's
//   method text ('## Fixed rules' and '## Brief skeleton for this run'), a
//   delegate's footer ('## This delegate', '- Entity: <e>. ', and the deep
//   line for _deep), code_walker's footer (no database, API or log tools) and
//   the classifier's CLASSIFIER_PROMPT_MARKER. The spike found them distinct
//   for every caller.
// - The tool set is not a usable signal. investigate_atspl and
//   investigate_rtl are given the same tools, so a tool-set route cannot tell
//   them apart.
// - harness.prompt() runs with the root's system prompt, so the system prompt
//   alone would send the synthesis turn to the root queue. That call is told
//   apart by its user message, which starts with the synthesis prompt's first
//   line (SYNTHESIS_MARK). It is checked before the system prompt.
// T10.5, T10.6 and T10.9 script their turns per caller with this module.
//
// A call whose caller has no turns left fails with a 'fake model:' message
// (FakeModelError), which Flue settles as a failed model turn. A call from an
// agent the router does not know fails the same way.

import type { AssistantMessage, Context, FauxResponseFactory, Message } from '@earendil-works/pi-ai';
import { CLASSIFIER_PROMPT_MARKER } from '../../classify/prompt.ts';
import { FakeModelError, text, type FakeModel, type FakeStep } from '../../mock/fake-model.ts';
import type { Classification } from '../../types/classification.ts';
import { ENTITIES, type Entity } from '../../types/core.ts';

/** How the router tells callers apart. Recorded from the routing spike. */
export const ROUTING_SIGNAL = 'system_prompt' as const;

/** First line of synthesisPrompt() in src/agents/synthesis.ts. The spike checks they agree. */
export const SYNTHESIS_MARK = 'You are writing the final triage report for a banking support case.';

/** Markers in the prompts each agent renders. The spike checks each one against a real run. */
export const PROMPT_MARKERS = Object.freeze({
  rootRules: '## Fixed rules',
  rootBrief: '## Brief skeleton for this run',
  delegate: '## This delegate',
  deep: 'You are the deep variant',
  codeWalker: 'You have no database, API or log tools',
});

/** Who a model call belongs to. 'synthesis' is the harness.prompt() call in finish_report. */
export type FauxCaller =
  | 'classifier'
  | 'root'
  | 'synthesis'
  | 'code_walker'
  | `investigate_${Entity}`
  | `investigate_${Entity}_deep`;

export const FAUX_CALLERS: readonly FauxCaller[] = Object.freeze([
  'classifier',
  'root',
  'synthesis',
  'code_walker',
  ...ENTITIES.flatMap((e) => [`investigate_${e}` as const, `investigate_${e}_deep` as const]),
]);

const KNOWN_CALLERS: ReadonlySet<string> = new Set(FAUX_CALLERS);

/** Turns per caller, in the order that caller will ask for them. */
export type FauxTurns = Partial<Record<FauxCaller, readonly FakeStep[]>>;

export type FauxToolResult = {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly isError: boolean;
  readonly text: string;
};

/** One model call as the router saw it. */
export type FauxCall = {
  readonly caller: FauxCaller;
  /** The faux model id: classifier, cheap, mid or strong. */
  readonly model: string;
  /** Tool names as rendered into the model context, sorted. */
  readonly tools: readonly string[];
  readonly systemPrompt: string;
  /** Text of every user message in the context, in order. */
  readonly userTexts: readonly string[];
  /** Every tool result in the context, in order. */
  readonly toolResults: readonly FauxToolResult[];
};

export type FauxScript = {
  /** The factory to put on the faux queue, once per scripted turn. */
  readonly router: FauxResponseFactory;
  /** Number of scripted turns across all callers. */
  readonly size: number;
  /** Every call the router saw, in order. */
  readonly calls: readonly FauxCall[];
  callsFor(caller: FauxCaller): FauxCall[];
  /** Every error the router raised, in order. */
  failures(): readonly string[];
  /** Turns not used yet, per caller that was scripted. */
  left(): Partial<Record<FauxCaller, number>>;
  /** Replaces the fake model's queue with this script, plus one guard entry. */
  install(fake: Pick<FakeModel, 'script'>): void;
};

// ------------------------------------------------------------------ routing

type Part = { type: string; text?: string };

function textOf(content: string | readonly Part[]): string {
  if (typeof content === 'string') return content;
  return content.map((part) => (part.type === 'text' ? (part.text ?? '') : '')).join('\n');
}

function userTextsOf(messages: readonly Message[]): string[] {
  return messages.flatMap((m) => (m.role === 'user' ? [textOf(m.content)] : []));
}

const DELEGATE_ENTITY = new RegExp(`^- Entity: (${ENTITIES.join('|')})\\. `, 'm');

/** The caller of one model call, read from its context. Throws FakeModelError for an unknown one. */
export function callerOf(context: Pick<Context, 'systemPrompt' | 'messages'>): FauxCaller {
  const system = context.systemPrompt ?? '';
  // harness.prompt() carries the root's system prompt, so check its user text first.
  if (userTextsOf(context.messages).some((t) => t.trimStart().startsWith(SYNTHESIS_MARK))) return 'synthesis';
  if (system.includes(CLASSIFIER_PROMPT_MARKER)) return 'classifier';
  if (system.includes(PROMPT_MARKERS.delegate)) {
    if (system.includes(PROMPT_MARKERS.codeWalker)) return 'code_walker';
    const entity = DELEGATE_ENTITY.exec(system)?.[1] as Entity | undefined;
    if (entity === undefined) throw new FakeModelError('a delegate prompt names no entity');
    return system.includes(PROMPT_MARKERS.deep) ? `investigate_${entity}_deep` : `investigate_${entity}`;
  }
  if (system.includes(PROMPT_MARKERS.rootRules) && system.includes(PROMPT_MARKERS.rootBrief)) return 'root';
  throw new FakeModelError('a model call came from an agent the faux script does not know');
}

function recordCall(caller: FauxCaller, context: Context, modelId: string): FauxCall {
  return Object.freeze({
    caller,
    model: modelId,
    tools: Object.freeze((context.tools ?? []).map((t) => t.name).sort()),
    systemPrompt: context.systemPrompt ?? '',
    userTexts: Object.freeze(userTextsOf(context.messages)),
    toolResults: Object.freeze(
      context.messages.flatMap((m) =>
        m.role === 'toolResult'
          ? [{ toolCallId: m.toolCallId, toolName: m.toolName, isError: m.isError, text: textOf(m.content) }]
          : [],
      ),
    ),
  });
}

// ------------------------------------------------------------------ script

/** Builds a script with one queue per caller. Unknown caller keys are refused. */
export function fauxScript(turns: FauxTurns): FauxScript {
  for (const key of Object.keys(turns)) {
    if (!KNOWN_CALLERS.has(key)) throw new FakeModelError(`faux script has an unknown caller "${key}"`);
  }
  const queues = new Map<FauxCaller, FakeStep[]>(
    Object.entries(turns).map(([k, steps]) => [k as FauxCaller, [...(steps ?? [])]]),
  );
  const size = [...queues.values()].reduce((n, q) => n + q.length, 0);
  const calls: FauxCall[] = [];
  const failures: string[] = [];
  const fail = (err: unknown): never => {
    failures.push(err instanceof Error ? err.message : String(err));
    throw err;
  };

  const router: FauxResponseFactory = (context, options, state, model) => {
    let caller: FauxCaller;
    try {
      caller = callerOf(context);
    } catch (err) {
      return fail(err);
    }
    calls.push(recordCall(caller, context, model.id));
    const step = queues.get(caller)?.shift();
    if (step === undefined) return fail(new FakeModelError(`no scripted turn left for ${caller}`));
    return typeof step === 'function' ? step(context, options, state, model) : step;
  };

  return Object.freeze({
    router,
    size,
    calls,
    callsFor: (caller: FauxCaller) => calls.filter((c) => c.caller === caller),
    failures: () => [...failures],
    left: () => Object.fromEntries([...queues].map(([k, q]) => [k, q.length])) as Partial<Record<FauxCaller, number>>,
    install(fake: Pick<FakeModel, 'script'>) {
      // One entry more than scripted, so the first extra call reaches the
      // router and fails with the caller's name. Later ones hit the fake
      // model's own exhausted guard.
      fake.script(Array.from({ length: size + 1 }, () => router));
    },
  });
}

// ------------------------------------------------------------------ helpers

// The fields classify() asks the model for (src/classify/classify.ts). The
// module sets images_seen and classifier_error itself and drops
// matched_pattern_id, so they are left out of the scripted answer.
const CLASSIFIER_FIELDS = [
  'category',
  'subcategory',
  'entities_likely',
  'money_moved',
  'misdirected_funds',
  'tier_proposed',
  'confidence',
] as const;

/** The classifier's answer for a classification, as one JSON object in a text turn. */
export function classifierTurn(classification: Classification): AssistantMessage {
  const answer = Object.fromEntries(CLASSIFIER_FIELDS.map((k) => [k, classification[k]]));
  return text(JSON.stringify(answer));
}
