// Pure helpers for the run pages, kept apart from the components so bun can
// test them without a DOM.

import type {
  Entity,
  EvidenceKey,
  KnownIdKey,
  ReportStatus,
  RunDetail,
  RunPhase,
  RunSummary,
  RunUsageView,
  StartRunBody,
  SubmissionView,
  Tier,
  UsageTotals,
} from '../../api/types.ts';
import { ENTITY_LABELS } from '../../lib/constants.ts';
import { formatRelative, formatTokens } from '../../lib/format.ts';
import { runStatusOf, type StatusLook } from '../../lib/status.ts';

// ------------------------------------------------------------------ list

export const CREATED_RANGES = [
  { value: '24h', label: 'Last 24 hours', ms: 24 * 3_600_000 },
  { value: '7d', label: 'Last 7 days', ms: 7 * 24 * 3_600_000 },
  { value: '30d', label: 'Last 30 days', ms: 30 * 24 * 3_600_000 },
  { value: 'any', label: 'Any time', ms: null },
] as const;
export type CreatedRange = (typeof CREATED_RANGES)[number]['value'];
export const DEFAULT_CREATED: CreatedRange = '7d';

export function isCreatedRange(value: string | null): value is CreatedRange {
  return CREATED_RANGES.some((r) => r.value === value);
}

/** The ISO lower bound for a Created filter, or undefined for any time. */
export function sinceFor(range: CreatedRange, now: number): string | undefined {
  const ms = CREATED_RANGES.find((r) => r.value === range)?.ms ?? null;
  return ms === null ? undefined : new Date(now - ms).toISOString();
}

/** Report statuses that mean the run is waiting on someone read amber; the rest neutral. */
export function reportStatusLook(status: ReportStatus): StatusLook {
  switch (status) {
    case 'root_cause_confirmed':
    case 'resolved':
      return { tone: 'neutral', icon: 'check' };
    case 'pending_user':
    case 'pending_bank':
      return { tone: 'amber', icon: 'clock' };
    case 'inconclusive':
      return { tone: 'muted', icon: 'dash' };
  }
}

// ------------------------------------------------------------------ new run

export type IdRow = { key: KnownIdKey; value: string };

/** The server's limit on context (MAX_CONTEXT_CHARS). */
export const MAX_CONTEXT = 20_000;

export type NewRunForm = {
  source: 'slack' | 'paste';
  slackUrl: string;
  pasted: string;
  /** Extra notes sent with either source. */
  context: string;
  requestedBy: string;
  entitiesMode: 'auto' | 'choose';
  entities: readonly Entity[];
  tierMode: 'auto' | 'choose';
  tier: Tier;
  ids: readonly IdRow[];
  /** datetime-local values, in the viewer's time zone. */
  from: string;
  to: string;
};

/** Form sections a 400 field or a local check points at. */
export type FormField = 'thread' | 'context' | 'requested_by' | 'entities' | 'tier' | 'ids' | 'time_window';

export type BuildResult = { ok: true; body: StartRunBody } | { ok: false; errors: Partial<Record<FormField, string>> };

/** datetime-local value to ISO, or undefined when it does not parse. */
export function localToIso(value: string): string | undefined {
  if (value.trim() === '') return undefined;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/**
 * The POST /triage body. Auto fields are left out so the agent decides; empty
 * ID rows and blank context are dropped.
 */
export function buildStartBody(form: NewRunForm, now: number): BuildResult {
  const errors: Partial<Record<FormField, string>> = {};
  const requestedBy = form.requestedBy.trim();
  if (requestedBy === '') errors.requested_by = 'Enter your name.';

  let thread: Pick<StartRunBody, 'slack_url' | 'messages'> | undefined;
  if (form.source === 'slack') {
    const url = form.slackUrl.trim();
    if (url === '') errors.thread = 'Paste the Slack thread URL.';
    else thread = { slack_url: url };
  } else {
    const text = form.pasted.trim();
    if (text === '') errors.thread = 'Paste the thread messages.';
    // Pasted text arrives as one message: the thread author and timestamps
    // are not known, and the agent only needs the words.
    else thread = { messages: [{ ts: (now / 1000).toFixed(6), author: 'pasted', text, is_parent: true }] };
  }

  const context = form.context.trim();
  if (context.length > MAX_CONTEXT) errors.context = `Keep it under ${MAX_CONTEXT.toLocaleString('en')} characters.`;

  let entities: Entity[] | undefined;
  if (form.entitiesMode === 'choose') {
    if (form.entities.length === 0) errors.entities = 'Tick at least one entity, or switch back to Auto.';
    else entities = [...form.entities];
  }

  const ids: Partial<Record<KnownIdKey, string>> = {};
  for (const row of form.ids) {
    const value = row.value.trim();
    if (value === '') continue;
    if (ids[row.key] !== undefined && ids[row.key] !== value) {
      errors.ids = `${row.key} is listed twice with different values.`;
      break;
    }
    ids[row.key] = value;
  }

  let timeWindow: { from: string; to: string } | undefined;
  const hasFrom = form.from.trim() !== '';
  const hasTo = form.to.trim() !== '';
  if (hasFrom || hasTo) {
    const from = localToIso(form.from);
    const to = localToIso(form.to);
    if (from === undefined || to === undefined) errors.time_window = 'Fill in both ends of the time window, or neither.';
    else if (Date.parse(from) > Date.parse(to)) errors.time_window = 'The start of the window is after the end.';
    else timeWindow = { from, to };
  }

  if (Object.keys(errors).length > 0 || thread === undefined) return { ok: false, errors };
  const body = {
    ...thread,
    requested_by: requestedBy,
    ...(context !== '' ? { context } : {}),
    ...(Object.keys(ids).length > 0 ? { ids } : {}),
    ...(entities !== undefined ? { entities } : {}),
    ...(form.tierMode === 'choose' ? { tier: form.tier } : {}),
    ...(timeWindow !== undefined ? { time_window: timeWindow } : {}),
  } as StartRunBody;
  return { ok: true, body };
}

/** Maps a field named in a 400 body ('messages.0.text', 'ids.utr', 'time_window.from') to its form section. */
export function formFieldOf(field: string): FormField | undefined {
  const head = field.split('.')[0] ?? '';
  switch (head) {
    case 'slack_url':
    case 'messages':
    case 'thread':
    case 'url':
      return 'thread';
    case 'context':
      return 'context';
    case 'requested_by':
      return 'requested_by';
    case 'entities':
      return 'entities';
    case 'tier':
      return 'tier';
    case 'ids':
      return 'ids';
    case 'time_window':
    case 'window':
      return 'time_window';
    default:
      return undefined;
  }
}

/**
 * A UUID v4 for the Idempotency-Key. crypto.randomUUID only exists in secure
 * contexts, and the console may be served over plain http on an internal
 * host, so fall back to getRandomValues, which works everywhere.
 */
export function newIdempotencyKey(c: Pick<Crypto, 'getRandomValues'> & { randomUUID?: () => string } = globalThis.crypto): string {
  if (typeof c.randomUUID === 'function') return c.randomUUID();
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** 'SSFB, ATSPL and RTL'. */
export function joinEntityLabels(entities: readonly Entity[]): string {
  const labels = entities.map((e) => ENTITY_LABELS[e]);
  if (labels.length <= 1) return labels.join('');
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

// ------------------------------------------------------------------ detail

/** The phases the stepper shows; 'created' counts as not started. */
export const STEPPER_PHASES = ['preflight', 'identity', 'classifying', 'dispatched', 'investigating', 'completed'] as const;
export type StepperPhase = (typeof STEPPER_PHASES)[number];
/** waiting: the run is parked on this phase (blocked on a system that did not answer). */
export type StepState = 'done' | 'current' | 'waiting' | 'failed' | 'todo';

/** Step states for a run that is still going: everything before the current phase is done. */
export function runningSteps(phase: RunPhase): Record<StepperPhase, StepState> {
  const current = phase === 'created' ? 0 : STEPPER_PHASES.indexOf(phase as StepperPhase);
  return stepsFrom((i) => (current < 0 ? 'todo' : i < current ? 'done' : i === current ? (phase === 'completed' ? 'done' : 'current') : 'todo'));
}

/** Step states for a blocked run: it parks while investigating, so that step waits and the ones before are done. */
export function blockedSteps(): Record<StepperPhase, StepState> {
  const at = STEPPER_PHASES.indexOf('investigating');
  return stepsFrom((i) => (i < at ? 'done' : i === at ? 'waiting' : 'todo'));
}

function stepsFrom(fn: (index: number) => StepState): Record<StepperPhase, StepState> {
  const out = {} as Record<StepperPhase, StepState>;
  STEPPER_PHASES.forEach((p, i) => {
    out[p] = fn(i);
  });
  return out;
}

export type FailureGuess = {
  title: string;
  hint: string;
  steps: Record<StepperPhase, StepState>;
};

/**
 * Where a failed run most likely stopped. The store records only a reason on
 * failure, not the phase, so this reads what the run left behind: no
 * classification means it never got past preflight or identity, and no
 * evidence means no investigator stored findings.
 */
export function inferFailure(run: Pick<RunDetail, 'classification' | 'evidence'>): FailureGuess {
  if (run.classification === null) {
    return {
      title: 'Failed before classification (preflight or identity)',
      hint: 'Preflight checks the tools and credentials the run needs. Doctor shows which one is off.',
      steps: stepsFrom((i) => (i <= 1 ? 'failed' : 'todo')),
    };
  }
  if (run.evidence.length === 0) {
    return {
      title: 'Failed after classification',
      hint: 'The run was classified but no investigator stored findings. Doctor shows whether a tool or credential is off.',
      steps: stepsFrom((i) => (i <= 2 ? 'done' : i === 3 ? 'failed' : 'todo')),
    };
  }
  return {
    title: 'Failed while investigating',
    hint: 'At least one investigator stored findings before the run stopped. Doctor shows whether a tool or credential is off.',
    steps: stepsFrom((i) => (i <= 3 ? 'done' : i === 4 ? 'failed' : 'todo')),
  };
}

export type InvestigatorRow = {
  key: EvidenceKey;
  label: string;
  state: 'findings in' | 'working' | 'waiting';
  detail: string;
};

const BEFORE_DISPATCH: readonly RunPhase[] = ['created', 'preflight', 'identity', 'classifying'];

/**
 * One row per investigator for the running view: the entities the classifier
 * expects plus any entity that has already stored evidence, then the code
 * walker. There is no live per-agent status, so this is inferred from stored
 * evidence versions.
 */
export function deriveInvestigators(run: Pick<RunDetail, 'classification' | 'evidence' | 'phase'>): InvestigatorRow[] {
  const version = new Map(run.evidence.map((e) => [e.key, e.version]));
  const likely = run.classification?.proposed.entities_likely ?? [];
  const entities = (Object.keys(ENTITY_LABELS) as Entity[]).filter((e) => likely.includes(e) || version.has(e));
  if (entities.length === 0 && !version.has('code')) return [];
  const started = !BEFORE_DISPATCH.includes(run.phase);
  const rows: InvestigatorRow[] = entities.map((e) => {
    const v = version.get(e);
    if (v !== undefined) return { key: e, label: `${ENTITY_LABELS[e]} investigator`, state: 'findings in', detail: `Version ${v} stored` };
    return started
      ? { key: e, label: `${ENTITY_LABELS[e]} investigator`, state: 'working', detail: 'No findings stored yet' }
      : { key: e, label: `${ENTITY_LABELS[e]} investigator`, state: 'waiting', detail: 'Starts after classification' };
  });
  const code = version.get('code');
  rows.push(
    code !== undefined
      ? { key: 'code', label: 'Code walker', state: 'findings in', detail: `Version ${code} stored` }
      : { key: 'code', label: 'Code walker', state: 'waiting', detail: 'Starts when an investigator asks for code' },
  );
  return rows;
}

export function investigatorLook(state: InvestigatorRow['state']): StatusLook {
  switch (state) {
    case 'findings in':
      return { tone: 'neutral', icon: 'check' };
    case 'working':
      return { tone: 'info', icon: 'spinner' };
    case 'waiting':
      return { tone: 'muted', icon: 'clock' };
  }
}

/**
 * The stored permalink is the redacted copy, so its digits are usually masked
 * with '*'. A masked link would open the wrong thread, so it is only a link
 * when nothing was masked.
 */
export function permalinkHref(permalink: string | undefined): string | undefined {
  if (permalink === undefined || permalink.includes('*')) return undefined;
  return /^https:\/\//.test(permalink) ? permalink : undefined;
}

/** 'Report v2 of 3': submissions with a report, out of all submissions. Undefined when none has a report. */
export function reportVersionLabel(submissions: readonly SubmissionView[]): string | undefined {
  const withReport = submissions.filter((s) => s.has_report).length;
  if (withReport === 0) return undefined;
  return `Report v${withReport} of ${submissions.length}`;
}

// ------------------------------------------------------------------ usage (D59)

export type UsageNote = { readonly text: string; readonly look: StatusLook };

/**
 * The labels above the usage totals. Nothing counted yet reads "waiting" while
 * the run is running and "not recorded" otherwise; "no pricing" and "no usage"
 * are kept apart.
 */
export function usageNotes(usage: RunUsageView | undefined, running: boolean, now: number): UsageNote[] {
  if (usage === undefined || !usage.recorded) {
    return [
      running
        ? { text: 'waiting for the first count', look: { tone: 'info', icon: 'clock' } }
        : { text: 'not recorded', look: { tone: 'muted', icon: 'dash' } },
    ];
  }
  const notes: UsageNote[] = [];
  if (usage.live) {
    const updated = usage.updated_at !== null ? `, updated ${formatRelative(usage.updated_at, now)}` : '';
    notes.push({ text: `live${updated}`, look: { tone: 'info', icon: 'spinner' } });
  }
  if (usage.incomplete) notes.push({ text: 'incomplete: the worker ended before the final count', look: { tone: 'amber', icon: 'alert' } });
  if (usage.pricing !== 'full') {
    const names = usage.total.unpriced_models.join(', ');
    notes.push({ text: usage.pricing === 'partial' ? `partial: no pricing for ${names}` : `no pricing for ${names}`, look: { tone: 'amber', icon: 'alert' } });
  }
  if (usage.fake) notes.push({ text: 'estimates, fake model', look: { tone: 'muted', icon: 'dash' } });
  return notes;
}

/** The cost of one totals bucket: '$0.42', '$0.42 (partial)' when some rows have no price, 'not priced' when none has. */
export function formatCost(t: Pick<UsageTotals, 'usd' | 'unpriced_models'>, pricing?: RunUsageView['pricing']): string {
  const unpriced = pricing !== undefined ? pricing !== 'full' : t.unpriced_models.length > 0;
  if (!unpriced) return formatUsd(t.usd);
  // A bucket's totals cannot tell $0 of priced rows from no priced rows, so $0 plus an unpriced model reads 'not priced'.
  const none = pricing !== undefined ? pricing === 'none' : t.usd === 0;
  return none ? 'not priced' : `${formatUsd(t.usd)} (partial)`;
}

/** '37' or '37 (1 failed)'. */
export function formatCalls(t: Pick<UsageTotals, 'calls' | 'failed_calls'>): string {
  return t.failed_calls > 0 ? `${t.calls} (${t.failed_calls} failed)` : String(t.calls);
}

export function totalTokens(t: Pick<UsageTotals, 'input_tokens' | 'output_tokens' | 'cache_read_tokens' | 'cache_write_tokens'>): number {
  return t.input_tokens + t.cache_read_tokens + t.cache_write_tokens + t.output_tokens;
}

/** '120k in / 90k cache read / 4k cache write / 8k out'. */
export function formatTokenSplit(t: Pick<UsageTotals, 'input_tokens' | 'output_tokens' | 'cache_read_tokens' | 'cache_write_tokens'>): string {
  return `${formatTokens(t.input_tokens)} in / ${formatTokens(t.cache_read_tokens)} cache read / ${formatTokens(t.cache_write_tokens)} cache write / ${formatTokens(t.output_tokens)} out`;
}

export type UsageBreakdown = 'model' | 'agent';
export type UsageLine = { readonly key: string; readonly totals: UsageTotals };

/** One line per model or agent, the most expensive first, then the most tokens, then by name. */
export function usageLines(usage: RunUsageView, by: UsageBreakdown): UsageLine[] {
  const source = by === 'model' ? usage.by_model : usage.by_agent;
  return Object.entries(source)
    .map(([key, totals]) => ({ key, totals }))
    .sort((a, b) => b.totals.usd - a.totals.usd || totalTokens(b.totals) - totalTokens(a.totals) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** The Cost cell of one submission (seq 0 is the intake); a dash when nothing was counted for it. */
export function submissionCost(usage: RunUsageView | undefined, seq: number): string {
  const t = usage?.by_submission[String(seq)];
  return t === undefined ? '—' : formatCost(t);
}

/**
 * The Cost cell of a runs-list row: the priced sum, marked '(partial)' when
 * some rows have no price, or 'not priced' when the run has tokens and no
 * priced row. live marks a running run, whose total is still growing.
 */
export function listCost(row: Pick<RunSummary, 'phase' | 'usd_total' | 'tokens_total' | 'usd_partial'>): { text: string; live: boolean } {
  const text =
    row.usd_total !== undefined
      ? `${formatUsd(row.usd_total)}${row.usd_partial === true ? ' (partial)' : ''}`
      : row.tokens_total !== undefined
        ? 'not priced'
        : '—';
  return { text, live: runStatusOf(row.phase) === 'running' };
}

export function formatUsd(usd: number | undefined): string {
  if (usd === undefined || !Number.isFinite(usd)) return '—';
  return usd < 0.01 && usd > 0 ? '<$0.01' : `$${usd.toFixed(2)}`;
}

/**
 * True while a follow-up or a resume sent from this page has not settled: its
 * submission is not stored yet, or the run is still going. A newer submission
 * on a run that is not running settled without a report (it blocked, failed
 * or was stopped), so polling stops.
 */
export function followUpPending(run: Pick<RunDetail, 'status' | 'submissions'>, afterSeq: number): boolean {
  const newer = run.submissions.filter((s) => s.seq > afterSeq);
  if (newer.length === 0) return true;
  return run.status === 'running';
}

export const YES_NO = (b: boolean): string => (b ? 'Yes' : 'No');

export function capitalise(s: string): string {
  return s === '' ? s : `${s[0]?.toUpperCase()}${s.slice(1)}`;
}
