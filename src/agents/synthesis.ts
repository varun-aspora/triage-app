// Strong-model synthesis pass (HLD 02 §2 finish_report row, LLD 04 §2.8, D23).
//
// When escalation fires on a run that is not already strong, finish_report
// hands the cheap draft, the evidence and the reasons to synthesizeOnStrong().
// It runs one harness.prompt() on MODEL_TIER_STRONG with the tier's thinking
// level and a structured result, and returns the strong report marked
// escalated with the reasons. If the model gives up (ResultUnavailableError)
// the draft is kept and a gap says the synthesis failed. Other errors, such as
// an abort, are thrown.
//
// The result schema is ReportDraftSchema, the ReportSchema minus the fields
// the harness fills itself (run_id, env_label, generated_at, repo_commits,
// cost). Asking the model for those would let it invent them.
import { type FlueHarness, ResultUnavailableError } from '@flue/runtime';
import type { Config } from '../config/env.ts';
import { modelForTier, thinkingForTier } from '../models.ts';
import { type ReportDraft, ReportDraftSchema } from '../types/report.ts';
import type { RecordedFindings } from './escalation.ts';

/** The one harness method this module uses. */
export type SynthesisHarness = Pick<FlueHarness, 'prompt'>;

export interface SynthesisInput {
  readonly draft: ReportDraft;
  readonly evidence: readonly RecordedFindings[];
  readonly reasons: readonly string[];
  readonly signal?: AbortSignal;
}

export interface SynthesisOptions {
  /** Config to read the strong model from; defaults to the active config. */
  readonly config?: Config;
}

export const SYNTHESIS_FAILED_GAP = 'strong-model synthesis failed; this report is the orchestrator draft';

const MAX_REASON_CHARS = 200;

// Fields the synthesis may not change: they are facts set before the
// investigation, not conclusions drawn from it.
type PinnedField = 'request' | 'classification' | 'id_chain' | 'images_seen';

/** The prompt for the strong model. Evidence is already persisted-profile redacted. */
export function synthesisPrompt(input: Omit<SynthesisInput, 'signal'>): string {
  return [
    'You are writing the final triage report for a banking support case.',
    'An automatic escalation rule fired, so the report is rebuilt on a stronger model.',
    `Escalation reasons: ${input.reasons.join(', ') || 'none given'}.`,
    '',
    'Base every conclusion on the evidence below. The draft was written by a cheaper model:',
    'use it for the request, classification and id chain, but do not trust its root cause,',
    'status, confidence or customer answer. If the evidence does not support a root cause,',
    'set root_cause to null, status to inconclusive and list what is missing in gaps.',
    'Never invent ids, timestamps or code references that are not in the evidence.',
    'Suggested fixes are for a human to run; use $VAR placeholders for hosts and tokens.',
    '',
    '<evidence>',
    JSON.stringify(input.evidence, null, 2),
    '</evidence>',
    '',
    '<draft>',
    JSON.stringify(input.draft, null, 2),
    '</draft>',
    '',
    'Return the full report through the finish tool.',
  ].join('\n');
}

function mergeGaps(...lists: readonly (readonly string[])[]): string[] {
  return [...new Set(lists.flat())];
}

function failureGap(err: ResultUnavailableError): string {
  const reason = err.reason.trim().slice(0, MAX_REASON_CHARS);
  return reason === '' ? SYNTHESIS_FAILED_GAP : `${SYNTHESIS_FAILED_GAP} (${reason})`;
}

/** Rebuilds the report on the strong model, or keeps the draft with a gap if that fails. */
export async function synthesizeOnStrong(
  harness: SynthesisHarness,
  input: SynthesisInput,
  options: SynthesisOptions = {},
): Promise<ReportDraft> {
  const reasons = [...input.reasons];
  const model = modelForTier('strong', options.config);
  const thinkingLevel = thinkingForTier('strong', options.config);

  let strong: ReportDraft;
  try {
    const response = await harness.prompt(synthesisPrompt(input), {
      model,
      thinkingLevel,
      result: ReportDraftSchema,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    strong = response.data;
  } catch (err) {
    if (!(err instanceof ResultUnavailableError)) throw err;
    return {
      ...input.draft,
      gaps: mergeGaps(input.draft.gaps, [failureGap(err)]),
      escalated: true,
      escalation_reasons: reasons,
    };
  }

  const pinned: Pick<ReportDraft, PinnedField> = {
    request: input.draft.request,
    classification: input.draft.classification,
    id_chain: input.draft.id_chain,
    images_seen: input.draft.images_seen,
  };
  return {
    ...strong,
    ...pinned,
    gaps: mergeGaps(input.draft.gaps, strong.gaps),
    escalated: true,
    escalation_reasons: reasons,
  };
}
