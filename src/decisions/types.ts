// Provider-neutral types for decision models: models that answer typed
// questions about a piece of state instead of writing text.
//
// A caller builds a DecisionRequest of named questions and gets back one
// answer per question, typed by the question's kind. Nothing here names a
// vendor; each provider in ./providers/ maps these shapes onto its own API.
//
// Question kinds:
// - choice: pick one option from a fixed set. Options are keyed by the value
//   the caller wants back; each key maps to a description the model reads.
// - yes_no: the probability that a single condition holds.
// - score: an ordered scale of levels, answered as a probability-weighted
//   level index.

/** Any JSON value: text, or structured content the model reads as is. */
export type DecisionContent = string | number | boolean | null | readonly DecisionContent[] | { readonly [key: string]: DecisionContent };

export type ChoiceQuestion<O extends string = string> = {
  readonly kind: 'choice';
  readonly instructions: DecisionContent;
  /** Option key -> what the option means. null means the key speaks for itself. */
  readonly options: { readonly [K in O]: DecisionContent };
};

export type YesNoQuestion = {
  readonly kind: 'yes_no';
  readonly instructions: DecisionContent;
  /** What yes and no mean, when the instructions alone are not enough. Both or neither. */
  readonly meaning?: { readonly yes: DecisionContent; readonly no: DecisionContent };
};

export type ScoreQuestion = {
  readonly kind: 'score';
  readonly instructions: DecisionContent;
  /** Lowest level first. Each level describes a situation, not a degree. */
  readonly levels: readonly [DecisionContent, DecisionContent, ...DecisionContent[]];
};

export type DecisionQuestion = ChoiceQuestion | YesNoQuestion | ScoreQuestion;

export type DecisionQuestions = { readonly [name: string]: DecisionQuestion };

export type ChoiceAnswer<O extends string = string> = {
  readonly kind: 'choice';
  readonly choice: O;
  /** Per option; sums to about 1. Undefined when the provider does not report it. */
  readonly probabilities?: { readonly [K in O]: number };
  /** 0-1: how peaked the distribution is, not whether the answer is right. */
  readonly confidence?: number;
};

export type YesNoAnswer = {
  readonly kind: 'yes_no';
  /** Probability of yes, 0-1. Near 0.5 means unsure. */
  readonly yes: number;
};

export type ScoreAnswer = {
  readonly kind: 'score';
  /** Probability-weighted level index, 0 to levels - 1. */
  readonly score: number;
  /** Per level, lowest first. Undefined when the provider does not report it. */
  readonly probabilities?: readonly number[];
  readonly confidence?: number;
};

export type DecisionAnswer = ChoiceAnswer | YesNoAnswer | ScoreAnswer;

export type AnswerFor<Q extends DecisionQuestion> = Q extends ChoiceQuestion<infer O>
  ? ChoiceAnswer<O>
  : Q extends YesNoQuestion
    ? YesNoAnswer
    : Q extends ScoreQuestion
      ? ScoreAnswer
      : never;

export type DecisionRequest<Q extends DecisionQuestions = DecisionQuestions> = {
  /** What the questions are about. Every question sees all of it. */
  readonly state: DecisionContent;
  readonly questions: Q;
};

export type DecisionUsage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Provider-reported cost in USD, when it reports one. */
  readonly costUsd?: number;
};

export type DecisionResult<Q extends DecisionQuestions = DecisionQuestions> = {
  readonly answers: { readonly [K in keyof Q]: AnswerFor<Q[K]> };
  /** The model that answered, as the provider names it (may carry a dated suffix). */
  readonly model: string;
  readonly usage: DecisionUsage;
};

/**
 * One decision model behind one vendor API. decide() is the only call; it
 * rejects with a DecisionError and never includes request content in it.
 * Callers go through decide() in ./decide.ts, which adds the time limit and
 * checks the answers against the questions.
 */
export type DecisionProvider = {
  /** Provider id, for errors and logs, e.g. 'typesafe' or 'openrouter'. */
  readonly id: string;
  /** The model the provider was built for, e.g. 'typesafe/jev-1.13'. */
  readonly model: string;
  decide(request: DecisionRequest, options: { readonly signal: AbortSignal }): Promise<DecisionResult>;
};
