// Pure helpers for the verdict panel and the Steps tab, kept apart from the
// components so bun can test them without a DOM.

import type { FeedbackBody, FeedbackEntry, FindingRef, FindingVerdict, RunDetail, RunEvent } from '../../api/types.ts';

// ------------------------------------------------------------------ verdict

/** The console's two buttons. Accept is stored as correct, reject as wrong. */
export type VerdictChoice = 'accept' | 'reject';

/** Finding id to the verdict the reviewer ticked on it. */
export type FindingMarks = Readonly<Record<string, FindingVerdict>>;

export type VerdictForm = {
  notes: string;
  rootCause: string;
  fasterPath: string;
  name: string;
  marks: FindingMarks;
};

export const EMPTY_VERDICT_FORM: Omit<VerdictForm, 'name'> = { notes: '', rootCause: '', fasterPath: '', marks: {} };

/** The server's limit on free text (MAX_FEEDBACK_TEXT). */
export const MAX_NOTES = 4000;

/** Ticking the same verdict again clears it. */
export function toggleMark(marks: FindingMarks, id: string, verdict: FindingVerdict): FindingMarks {
  const next = { ...marks };
  if (next[id] === verdict) delete next[id];
  else next[id] = verdict;
  return next;
}

export type VerdictBodyResult = { ok: true; body: FeedbackBody } | { ok: false; error: string };

/**
 * The POST /triage/:run_id/feedback body. Blank text is left out, and only
 * marks on findings the run still lists are sent.
 */
export function buildVerdictBody(choice: VerdictChoice, form: VerdictForm, findings: readonly FindingRef[]): VerdictBodyResult {
  const name = form.name.trim();
  if (name === '') return { ok: false, error: 'Enter your name.' };
  for (const [label, text] of [
    ['Notes', form.notes],
    ['Actual root cause', form.rootCause],
    ['Faster path', form.fasterPath],
  ] as const) {
    if (text.trim().length > MAX_NOTES) return { ok: false, error: `${label}: keep it under ${MAX_NOTES.toLocaleString('en')} characters.` };
  }
  const known = new Set(findings.map((f) => f.id));
  const marked = Object.entries(form.marks)
    .filter(([id]) => known.has(id))
    .map(([id, verdict]) => ({ id, verdict }));
  const notes = form.notes.trim();
  const rootCause = form.rootCause.trim();
  const fasterPath = form.fasterPath.trim();
  return {
    ok: true,
    body: {
      verdict: choice === 'accept' ? 'correct' : 'wrong',
      given_by: name,
      ...(notes !== '' ? { notes } : {}),
      ...(rootCause !== '' ? { actual_root_cause: rootCause } : {}),
      ...(fasterPath !== '' ? { faster_path: fasterPath } : {}),
      ...(marked.length > 0 ? { findings: marked } : {}),
    },
  };
}

/** Cancel stops the run while it is going or parked on a system (blocked); there is nothing to cancel once it has finished. */
export function canCancel(run: Pick<RunDetail, 'status'>): boolean {
  return run.status === 'running' || run.status === 'blocked';
}

/** How a feedback entry reads in the list: accepted, rejected, cancelled, or the stored verdict. */
export function verdictLabel(entry: Pick<FeedbackEntry, 'verdict' | 'cancelled'>): string {
  if (entry.cancelled === true) return 'cancelled';
  if (entry.verdict === 'correct') return 'accepted';
  if (entry.verdict === 'wrong') return 'rejected';
  return entry.verdict;
}

export const FINDING_KIND_LABELS: Readonly<Record<FindingRef['kind'], string>> = {
  evidence: 'Evidence',
  hypothesis: 'Hypothesis',
  code_claim: 'Code',
  root_cause: 'Root cause',
};

/** Findings grouped for display: the root cause first, then per evidence key in the order given. */
export function groupFindings(findings: readonly FindingRef[]): { label: string; items: FindingRef[] }[] {
  const groups: { label: string; items: FindingRef[] }[] = [];
  const root = findings.filter((f) => f.kind === 'root_cause');
  if (root.length > 0) groups.push({ label: 'Report', items: root });
  for (const f of findings) {
    if (f.kind === 'root_cause') continue;
    const label = f.key === 'code' ? 'Code' : `${(f.key ?? '').toUpperCase()} findings`;
    let g = groups.find((x) => x.label === label);
    if (g === undefined) {
      g = { label, items: [] };
      groups.push(g);
    }
    g.items.push(f);
  }
  return groups;
}

// ------------------------------------------------------------------ steps

export const STEP_FILTERS = ['all', 'pipeline', 'model', 'tools', 'errors'] as const;
export type StepFilter = (typeof STEP_FILTERS)[number];

const MODEL_TYPES = new Set(['turn', 'turn_request', 'message_end', 'thinking_end', 'compaction', 'compaction_start']);
const TOOL_TYPES = new Set(['tool_start', 'tool', 'task_start', 'task']);

type Data = Record<string, unknown>;
const dataOf = (e: Pick<RunEvent, 'data'>): Data => (typeof e.data === 'object' && e.data !== null ? (e.data as Data) : {});

export function isErrorEvent(e: Pick<RunEvent, 'type' | 'data'>): boolean {
  const d = dataOf(e);
  if (d.isError === true) return true;
  if (e.type === 'failed' || e.type === 'submission_recovery') return true;
  if (e.type === 'submission_settled' && d.outcome !== 'completed') return true;
  if (e.type === 'settled' && d.status === 'failed') return true;
  if (e.type === 'log' && (d.level === 'error' || d.level === 'warn')) return true;
  return false;
}

export function matchesStepFilter(e: Pick<RunEvent, 'source' | 'type' | 'data'>, filter: StepFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'pipeline':
      return e.source === 'pipeline';
    case 'model':
      return MODEL_TYPES.has(e.type);
    case 'tools':
      return TOOL_TYPES.has(e.type);
    case 'errors':
      return isErrorEvent(e);
  }
}

/** Adds a page of lines, ignoring any the list already has. */
export function appendEvents(have: readonly RunEvent[], page: readonly RunEvent[]): RunEvent[] {
  const last = have.at(-1)?.index ?? -1;
  return [...have, ...page.filter((e) => e.index > last)];
}

const MAX_EXCERPT = 180;

/** One line a person scans for; the full event is one click away. Mirrors src/runlog/summary.ts. */
export function summariseStep(e: Pick<RunEvent, 'type' | 'data'>): string {
  const d = dataOf(e);
  const s = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
  const ms = (v: unknown) => (typeof v === 'number' ? `${Math.round(v)} ms` : '');
  switch (e.type) {
    case 'phase':
      return `${s(d.phase)}${d.refused !== undefined ? ` (refused: ${s(d.refused)})` : ''}`;
    case 'tool_start':
      return `${s(d.toolName)} ${excerpt(d.args ?? '')}`;
    case 'tool':
      return `${s(d.toolName)} ${d.isError === true ? 'failed' : 'ok'} · ${ms(d.durationMs)} · ${excerpt(d.effectiveResult ?? d.result ?? '')}`;
    case 'turn': {
      const req = (d.request ?? {}) as Data;
      const res = (d.response ?? {}) as Data;
      const usage = (res.usage ?? {}) as Data;
      const tokens = typeof usage.input === 'number' ? ` · ${usage.input} in / ${s(usage.output)} out` : '';
      return `${s(req.requestedModel)} · ${s(res.finishReason)}${tokens} · ${ms(d.durationMs)}${d.isError === true ? ' · error' : ''}`;
    }
    case 'message_end': {
      const m = (d.message ?? {}) as Data;
      return `${s(m.role)}: ${excerpt(textOf(m.content))}`;
    }
    case 'thinking_end':
      return excerpt(d.content);
    case 'task_start':
      return `${s(d.agent ?? 'task')} · ${excerpt(d.prompt)}`;
    case 'task':
      return `${s(d.agent ?? 'task')} ${d.isError === true ? 'failed' : 'ok'} · ${ms(d.durationMs)}`;
    case 'log':
      return `${s(d.level)} · ${excerpt(d.message)}`;
    case 'settled':
      return `${s(d.status)}${d.error !== undefined ? ` (${s(d.error)})` : ''}`;
    case 'failed':
      return excerpt(((d.error ?? {}) as Data).message ?? d.error);
    case 'feedback':
      return `${s(d.verdict)}${d.cancelled === true ? ' (cancel)' : ''}${d.notes !== undefined ? ` · ${excerpt(d.notes)}` : ''}`;
    case 'stop':
      return `by ${s(d.by)} from ${s(d.stopped_from)}`;
    case 'blocked':
      return `${s(d.block_id)} · ${Array.isArray(d.systems) ? d.systems.map(s).join(', ') : ''}`;
    case 'resume':
      return `by ${s(d.by)} from ${s(d.from)}${d.block_id !== undefined ? ` (${s(d.block_id)})` : ''}${d.note !== undefined ? ` · ${excerpt(d.note)}` : ''}`;
    case 'turn_request': {
      const req = (d.request ?? {}) as Data;
      const input = (req.input ?? {}) as Data;
      return `${s(req.requestedModel)} · ${s(input.message_count)} messages${input.systemPrompt !== undefined ? ' · new system prompt' : ''} · ${sessionLabel(d)}`;
    }
    default:
      return lifecycleSummary(e.type, d) ?? excerpt(d);
  }
}

/** Where an event ran: the root agent or a delegate's session. */
function sessionLabel(d: Data): string {
  const session = typeof d.session === 'string' ? d.session : '';
  if (session === '' || session === 'default') return 'root';
  return session.startsWith('task:') ? 'delegate' : session;
}

// Pipeline steps and Flue lifecycle events, which say little beyond where and when.
function lifecycleSummary(type: string, d: Data): string | undefined {
  const s = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
  const count = (v: unknown) => (Array.isArray(v) ? v.length : 0);
  const ms = (v: unknown) => (typeof v === 'number' ? `${Math.round(v)} ms` : '');
  switch (type) {
    case 'run_created':
      return `${s(d.interface)} · ${s(d.messages)} messages · ${s(d.attachments)} attachments`;
    case 'preflight':
      return d.skipped !== undefined ? `skipped (${s(d.skipped)})` : `${count(d.warnings)} warnings · ${ms(d.durationMs)}`;
    case 'identity': {
      const ids = ((d.id_chain ?? {}) as Data).ids;
      return `${Object.keys((ids ?? {}) as object).length} ids · ${count(d.gaps)} gaps · ${ms(d.durationMs)}`;
    }
    case 'classifier': {
      const c = (d.classification ?? {}) as Data;
      return `${s(c.category)} · proposed ${s(c.tier_proposed)} · ${ms(d.durationMs)}`;
    }
    case 'classification': {
      const dec = (d.decision ?? {}) as Data;
      return `${s(((dec.proposed ?? {}) as Data).category)} · tier ${s(dec.tier_final)} (${s(dec.rule_fired)})`;
    }
    case 'dispatch':
      return `submission ${s(d.submission_seq)} (${s(d.kind)})`;
    case 'submission_queued':
      return s(d.kind);
    case 'submission_running':
      return `attempt ${s(d.attemptCount)} of ${s(d.maxAttempts)}`;
    case 'operation_start':
      return `${s(d.operationKind)} · ${sessionLabel(d)}`;
    case 'operation':
      return `${s(d.operationKind)} ${d.isError === true ? 'failed' : 'ok'} · ${ms(d.durationMs)} · ${sessionLabel(d)}`;
    case 'agent_start':
    case 'idle':
    case 'turn_start':
      return sessionLabel(d);
    case 'agent_end':
      return `${sessionLabel(d)} · ${s(d.message_count)} messages`;
    case 'message_start':
      return `${s(d.message_role)} · ${sessionLabel(d)}`;
    case 'turn_messages':
      return `${s(d.message_role)} · ${s(d.tool_result_count)} tool results · ${sessionLabel(d)}`;
    case 'submission_settled':
      return `${s(d.outcome)}${d.error !== undefined ? ` · ${s(((d.error ?? {}) as Data).message)}` : ''}`;
    default:
      return undefined;
  }
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      const p = (part ?? {}) as Data;
      if (typeof p.text === 'string') return p.text;
      if (p.type === 'toolCall') return `[call ${typeof p.name === 'string' ? p.name : ''}]`;
      if (typeof p.thinking === 'string') return '[thinking]';
      return '';
    })
    .filter((x) => x !== '')
    .join(' ');
}

function excerpt(value: unknown): string {
  let text: string;
  if (typeof value === 'string') text = value;
  else {
    try {
      text = JSON.stringify(value) ?? '';
    } catch {
      text = '';
    }
  }
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > MAX_EXCERPT ? `${one.slice(0, MAX_EXCERPT)}…` : one;
}
