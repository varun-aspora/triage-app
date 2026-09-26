// Embeds a run after a submission settles, and rebuilds embeddings for
// `triage runs reembed` (D43, P2 3.4 and 3.5).
//
// Two kinds only: 'case' and 'request'. Their texts come from the stored run
// record (src/embed/case-text.ts), never from the raw thread or the Flue
// stream.
//
// Embeddings are derived data, so nothing here may block a run: every
// failure (store read, embedder call, store write) comes back as a gap
// string and embedRun never throws. The gap text is a fixed phrase plus the
// error's name, or an EmbeddingError's message, which carries the provider
// and a fixed reason only.

import { createHash } from 'node:crypto';
import { caseCardText, requestText } from '../embed/case-text.ts';
import { EmbeddingError, type EmbedUsage, type Embedder } from '../embed/index.ts';
import { redactPersisted, type Persisted } from '../gate/redact.ts';
import type { RunId } from '../types/core.ts';
import type { EmbeddingKind, EmbeddingMeta, RunRecord, RunStore } from './types.ts';

export const EMBEDDINGS_DISABLED = 'embeddings disabled';

export type EmbedRunOptions = {
  readonly signal?: AbortSignal;
  /** Embed even when the stored text hash matches. reembed without --missing sets it. */
  readonly force?: boolean;
  /** Passed to embed(): what the embedding call used (D59). Not called when nothing needed embedding. */
  readonly onUsage?: (u: EmbedUsage) => void;
  /** Records the embedding call as a trace span for runId (D82). Set after a settle only; reembed never sets it. */
  readonly traced?: boolean;
};

export type EmbedRunResult = {
  /** Kinds written by this call. */
  readonly written: readonly EmbeddingKind[];
  /** Kinds skipped because a row with the same model and text hash exists. */
  readonly unchanged: readonly EmbeddingKind[];
  /** Kinds skipped because the run has no text for them yet. */
  readonly empty: readonly EmbeddingKind[];
  /** Why something was not embedded. Empty when everything that had text was stored. */
  readonly gaps: readonly string[];
};

type Pending = { readonly kind: EmbeddingKind; readonly text: Persisted<string>; readonly sha: string };

/**
 * Writes the case and request embeddings for the run's latest submission.
 * A null embedder (blank MODEL_EMBEDDING) is a no-op with the gap
 * 'embeddings disabled'.
 */
export async function embedRun(
  store: RunStore,
  embedder: Embedder | null,
  runId: RunId,
  options: EmbedRunOptions = {},
): Promise<EmbedRunResult> {
  if (embedder === null) return result({ gaps: [EMBEDDINGS_DISABLED] });

  let run: RunRecord | null;
  try {
    run = await store.getRun(runId);
  } catch (err) {
    return result({ gaps: [`embeddings skipped: run store read failed (${label(err)})`] });
  }
  if (run === null) return result({ gaps: ['embeddings skipped: run not found'] });

  const submissionId = run.submissions.at(-1)?.seq;
  const texts: Record<EmbeddingKind, Persisted<string>> = { case: caseCardText(run), request: requestText(run) };

  const empty: EmbeddingKind[] = [];
  const unchanged: EmbeddingKind[] = [];
  const pending: Pending[] = [];
  for (const kind of ['case', 'request'] as const) {
    const text = texts[kind];
    if (text.value === '') {
      empty.push(kind);
      continue;
    }
    const sha = sha256(text.value);
    if (options.force !== true && hasRow(run.embeddings, kind, embedder.model, sha)) {
      unchanged.push(kind);
      continue;
    }
    pending.push({ kind, text, sha });
  }
  if (pending.length === 0) return result({ unchanged, empty });

  let vectors: number[][];
  try {
    vectors = await embedder.embed(pending.map((p) => p.text), {
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(options.onUsage !== undefined ? { onUsage: options.onUsage } : {}),
      ...(options.traced === true ? { trace: { runId, purpose: 'embed_run' } } : {}),
    });
  } catch (err) {
    return result({ unchanged, empty, gaps: [`embeddings failed: ${label(err)}`] });
  }
  if (vectors.length !== pending.length) {
    return result({ unchanged, empty, gaps: ['embeddings failed: embedder returned the wrong number of vectors'] });
  }

  const written: EmbeddingKind[] = [];
  const gaps: string[] = [];
  for (const [i, p] of pending.entries()) {
    try {
      await store.putEmbedding(
        runId,
        redactPersisted({
          ...(submissionId !== undefined ? { submission_id: submissionId } : {}),
          kind: p.kind,
          model: embedder.model,
          text_sha256: p.sha,
          source_text: p.text.value,
          vector: vectors[i] as number[],
        }),
      );
      written.push(p.kind);
    } catch (err) {
      gaps.push(`${p.kind} embedding not stored (${label(err)})`);
    }
  }
  return result({ written, unchanged, empty, gaps });
}

export type ReembedOptions = {
  /** Only runs with no embedding row for the embedder's model. */
  readonly missing?: boolean;
  readonly signal?: AbortSignal;
};

export type ReembedCounts = {
  /** Runs the store listed. */
  readonly runs: number;
  /** Runs where at least one row was written and nothing failed. */
  readonly embedded: number;
  /** Runs where nothing needed writing. */
  readonly unchanged: number;
  /** Runs left alone because they already had a row for the model (--missing). */
  readonly skipped: number;
  /** Runs with at least one gap. */
  readonly failed: number;
};

export type ReembedResult = ReembedCounts & {
  readonly disabled: boolean;
  /** One entry per failed run: the run id and its gaps. */
  readonly failures: readonly { readonly run_id: RunId; readonly gaps: readonly string[] }[];
};

/**
 * Rebuilds embeddings for every run, or with missing only for runs that have
 * no row for the current model. Without missing, rows are rewritten even when
 * the text is unchanged. Listing the runs can throw; each run's own failure
 * is counted, not thrown.
 */
export async function reembed(
  store: RunStore,
  embedder: Embedder | null,
  options: ReembedOptions = {},
): Promise<ReembedResult> {
  const counts = { runs: 0, embedded: 0, unchanged: 0, skipped: 0, failed: 0 };
  const failures: { run_id: RunId; gaps: readonly string[] }[] = [];
  if (embedder === null) return { ...counts, disabled: true, failures };

  const runs = await store.listRuns();
  counts.runs = runs.length;
  for (const { run_id } of runs) {
    options.signal?.throwIfAborted();
    if (options.missing === true) {
      let has: boolean;
      try {
        const record = await store.getRun(run_id);
        has = record !== null && record.embeddings.some((e) => e.model === embedder.model);
      } catch (err) {
        counts.failed++;
        failures.push({ run_id, gaps: [`embeddings skipped: run store read failed (${label(err)})`] });
        continue;
      }
      if (has) {
        counts.skipped++;
        continue;
      }
    }
    const r = await embedRun(store, embedder, run_id, {
      force: options.missing !== true,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
    if (r.gaps.length > 0) {
      counts.failed++;
      failures.push({ run_id, gaps: r.gaps });
    } else if (r.written.length > 0) counts.embedded++;
    else counts.unchanged++;
  }
  return { ...counts, disabled: false, failures };
}

function hasRow(rows: readonly EmbeddingMeta[], kind: EmbeddingKind, model: string, sha: string): boolean {
  return rows.some((r) => r.kind === kind && r.model === model && r.text_sha256 === sha);
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** A gap label that cannot carry request data: EmbeddingError's fixed message, else the error name. */
function label(err: unknown): string {
  if (err instanceof EmbeddingError) return err.message;
  if (err instanceof Error) return err.name;
  return 'unknown error';
}

function result(parts: Partial<EmbedRunResult>): EmbedRunResult {
  return {
    written: parts.written ?? [],
    unchanged: parts.unchanged ?? [],
    empty: parts.empty ?? [],
    gaps: parts.gaps ?? [],
  };
}
