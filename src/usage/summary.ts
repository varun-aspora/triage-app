// Totals and breakdowns of a run's usage rows, for the HTTP API, the CLI and
// the web console (D59). Pure: the caller reads the rows from the store and
// says whether the run is still running.
//
// - pricing: 'full' when every row has a price, 'none' when rows exist but
//   none has one, 'partial' otherwise. With no rows it is 'full' (nothing is
//   unpriced) and recorded is false, which is what the surfaces check first.
// - fake: every row is on a faux/* model. With no rows it is false.
// - live / incomplete: some submission is not final, and the run is running
//   (live) or not (incomplete). A stalled worker counts as not running; the
//   caller passes running: false for it.
import type { RunUsageView, SubmissionUsage, UsageRow, UsageTotals } from '../types/usage.ts';

const FAKE_PREFIX = 'faux/';

export type SummariseOptions = {
  /** True only when the run's status is running and its worker is alive. */
  readonly running: boolean;
};

export function summariseUsage(usage: readonly SubmissionUsage[], opts: SummariseOptions): RunUsageView {
  const total = new Totals();
  const byModel = new Map<string, Totals>();
  const byAgent = new Map<string, Totals>();
  const bySubmission = new Map<number, Totals>();
  let rows = 0;
  let priced = 0;
  let fake = true;
  let open = false;
  let updatedAt: string | null = null;

  for (const submission of usage) {
    if (!submission.final) open = true;
    if (updatedAt === null || Date.parse(submission.updated_at) > Date.parse(updatedAt)) {
      updatedAt = submission.updated_at;
    }
    for (const row of submission.rows) {
      rows += 1;
      if (row.usd !== null) priced += 1;
      if (!row.model.startsWith(FAKE_PREFIX)) fake = false;
      total.add(row);
      bucket(byModel, row.model).add(row);
      bucket(byAgent, row.agent).add(row);
      bucket(bySubmission, submission.seq).add(row);
    }
  }

  return {
    recorded: rows > 0,
    total: total.view(),
    by_model: record(byModel),
    by_agent: record(byAgent),
    by_submission: Object.fromEntries(
      [...bySubmission].sort(([a], [b]) => a - b).map(([seq, t]) => [String(seq), t.view()]),
    ),
    pricing: priced === rows ? 'full' : priced === 0 ? 'none' : 'partial',
    fake: rows > 0 && fake,
    live: open && opts.running,
    incomplete: open && !opts.running,
    updated_at: updatedAt,
  };
}

class Totals {
  calls = 0;
  failedCalls = 0;
  input = 0;
  output = 0;
  cacheRead = 0;
  cacheWrite = 0;
  usd = 0;
  readonly unpriced = new Set<string>();

  add(row: UsageRow): void {
    this.calls += row.calls;
    this.failedCalls += row.failed_calls;
    this.input += row.input_tokens;
    this.output += row.output_tokens;
    this.cacheRead += row.cache_read_tokens;
    this.cacheWrite += row.cache_write_tokens;
    if (row.usd === null) this.unpriced.add(row.model);
    else this.usd += row.usd;
  }

  view(): UsageTotals {
    return {
      calls: this.calls,
      failed_calls: this.failedCalls,
      input_tokens: this.input,
      output_tokens: this.output,
      cache_read_tokens: this.cacheRead,
      cache_write_tokens: this.cacheWrite,
      usd: this.usd,
      unpriced_models: [...this.unpriced].sort(),
    };
  }
}

function bucket<K>(map: Map<K, Totals>, key: K): Totals {
  let totals = map.get(key);
  if (totals === undefined) {
    totals = new Totals();
    map.set(key, totals);
  }
  return totals;
}

/** Keys sorted, so the JSON output is stable. */
function record(map: Map<string, Totals>): Record<string, UsageTotals> {
  return Object.fromEntries(
    [...map].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, t]) => [key, t.view()]),
  );
}
