// Pure helpers for the run pages, kept apart from the components so bun can
// test them without a DOM.

import type {
  Entity,
  EvidenceKey,
  KnownIdKey,
  ReportStatus,
  RunDetail,
  RunPhase,
  StartRunBody,
  SubmissionView,
  Tier,
} from '../../api/types.ts';
import { ENTITY_LABELS } from '../../lib/constants.ts';
import type { StatusLook } from '../../lib/status.ts';

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
export type StepState = 'done' | 'current' | 'failed' | 'todo';

/** Step states for a run that is still going: everything before the current phase is done. */
export function runningSteps(phase: RunPhase): Record<StepperPhase, StepState> {
  const current = phase === 'created' ? 0 : STEPPER_PHASES.indexOf(phase as StepperPhase);
  return stepsFrom((i) => (current < 0 ? 'todo' : i < current ? 'done' : i === current ? (phase === 'completed' ? 'done' : 'current') : 'todo'));
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

export type CostTotals = { calls: number; input: number; output: number };

export function costTotals(models: Readonly<Record<string, { calls: number; input_tokens: number; output_tokens: number }>>): CostTotals {
  let calls = 0;
  let input = 0;
  let output = 0;
  for (const m of Object.values(models)) {
    calls += m.calls;
    input += m.input_tokens;
    output += m.output_tokens;
  }
  return { calls, input, output };
}

export function formatUsd(usd: number | undefined): string {
  if (usd === undefined || !Number.isFinite(usd)) return '—';
  return usd < 0.01 && usd > 0 ? '<$0.01' : `$${usd.toFixed(2)}`;
}

/** True while a follow-up sent from this page has not produced its report. */
export function askPending(submissions: readonly SubmissionView[], askedAfterSeq: number): boolean {
  const newer = submissions.filter((s) => s.seq > askedAfterSeq);
  return newer.length === 0 || newer.some((s) => !s.has_report);
}

export const YES_NO = (b: boolean): string => (b ? 'Yes' : 'No');

export function capitalise(s: string): string {
  return s === '' ? s : `${s[0]?.toUpperCase()}${s.slice(1)}`;
}
