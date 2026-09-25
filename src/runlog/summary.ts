// One-line summaries of event log lines, for `triage logs`. The full line is
// always there with --json; the summary picks the fields a person scans for.

import type { RunEventLine } from './event-log.ts';

const MAX_EXCERPT = 160;

type Data = Record<string, unknown>;

export function summariseEvent(line: Pick<RunEventLine, 'source' | 'type' | 'data'>): string {
  const d = (typeof line.data === 'object' && line.data !== null ? line.data : {}) as Data;
  switch (line.type) {
    case 'phase':
      return `${str(d.phase)}${d.refused !== undefined ? ` (refused: ${str(d.refused)})` : ''}`;
    case 'tool_start':
      return `${str(d.toolName)} ${excerpt(d.args ?? '')}`;
    case 'tool':
      return `${str(d.toolName)} ${d.isError === true ? 'error' : 'ok'} in ${ms(d.durationMs)} ${excerpt(d.effectiveResult ?? d.result ?? '')}`;
    case 'turn': {
      const request = (d.request ?? {}) as Data;
      const response = (d.response ?? {}) as Data;
      const usage = (response.usage ?? {}) as Data;
      const tokens = usage.input !== undefined ? ` ${num(usage.input)} in / ${num(usage.output)} out` : '';
      return `${str(request.requestedModel)} ${str(response.finishReason ?? '')}${tokens} in ${ms(d.durationMs)}${d.isError === true ? ' error' : ''}`;
    }
    case 'turn_request': {
      const request = (d.request ?? {}) as Data;
      const input = (request.input ?? {}) as Data;
      return `${str(request.requestedModel)} ${num(input.message_count)} messages${input.systemPrompt !== undefined ? ', new system prompt' : ''} · ${sessionLabel(d)}`;
    }
    case 'message_end': {
      const message = (d.message ?? {}) as Data;
      return `${str(message.role)}: ${excerpt(textOf(message.content))}`;
    }
    case 'thinking_end':
      return excerpt(d.content);
    case 'task_start':
      return `${str(d.agent ?? 'task')} ${excerpt(d.prompt)}`;
    case 'task':
      return `${str(d.agent ?? 'task')} ${d.isError === true ? 'error' : 'ok'} in ${ms(d.durationMs)}`;
    case 'operation':
      return `${str(d.operationKind)} ${d.isError === true ? 'error' : 'ok'} in ${ms(d.durationMs)}`;
    case 'log':
      return `${str(d.level)} ${excerpt(d.message)}`;
    case 'submission_settled':
      return `${str(d.outcome)}${d.error !== undefined ? ` ${excerpt(d.error)}` : ''}`;
    case 'settled':
      return `${str(d.status)}${d.error !== undefined ? ` (${str(d.error)})` : ''}`;
    case 'failed':
      return excerpt((d.error as Data | undefined)?.message ?? d.error);
    case 'feedback':
      return `${str(d.verdict)}${d.cancelled === true ? ' (cancel)' : ''}${d.notes !== undefined ? ` ${excerpt(d.notes)}` : ''}`;
    case 'stop':
      return `by ${str(d.by)} from ${str(d.stopped_from)}`;
    default:
      return lifecycleSummary(line.type, d) ?? excerpt(d);
  }
}

/** Where an event ran: the root agent or a delegate's session. */
function sessionLabel(d: Data): string {
  const session = str(d.session);
  if (session === '' || session === 'default') return 'root';
  return session.startsWith('task:') ? 'delegate' : session;
}

// Pipeline steps and Flue lifecycle events, which say little beyond where and when.
function lifecycleSummary(type: string, d: Data): string | undefined {
  const count = (v: unknown) => (Array.isArray(v) ? v.length : 0);
  switch (type) {
    case 'run_created':
      return `${str(d.interface)} · ${num(d.messages)} messages · ${num(d.attachments)} attachments`;
    case 'preflight':
      return d.skipped !== undefined ? `skipped (${str(d.skipped)})` : `${count(d.warnings)} warnings in ${ms(d.durationMs)}`;
    case 'identity': {
      const ids = ((d.id_chain ?? {}) as Data).ids;
      return `${Object.keys((ids ?? {}) as object).length} ids, ${count(d.gaps)} gaps in ${ms(d.durationMs)}`;
    }
    case 'classifier': {
      const c = (d.classification ?? {}) as Data;
      return `${str(c.category)} · proposed ${str(c.tier_proposed)} in ${ms(d.durationMs)}`;
    }
    case 'classification': {
      const dec = (d.decision ?? {}) as Data;
      return `${str(((dec.proposed ?? {}) as Data).category)} · tier ${str(dec.tier_final)} (${str(dec.rule_fired)})`;
    }
    case 'dispatch':
      return `submission ${num(d.submission_seq)} (${str(d.kind)})`;
    case 'submission_queued':
      return str(d.kind);
    case 'submission_running':
      return `attempt ${num(d.attemptCount)} of ${num(d.maxAttempts)}`;
    case 'operation_start':
      return `${str(d.operationKind)} · ${sessionLabel(d)}`;
    case 'agent_start':
    case 'idle':
    case 'turn_start':
      return sessionLabel(d);
    case 'agent_end':
      return `${sessionLabel(d)} · ${num(d.message_count)} messages`;
    case 'message_start':
      return `${str(d.message_role)} · ${sessionLabel(d)}`;
    case 'turn_messages':
      return `${str(d.message_role)} · ${num(d.tool_result_count)} tool results · ${sessionLabel(d)}`;
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
      if (p.type === 'toolCall' || p.type === 'tool_call') return `[call ${str(p.name)}]`;
      if (typeof p.thinking === 'string') return '[thinking]';
      return '';
    })
    .filter((s) => s !== '')
    .join(' ');
}

function excerpt(value: unknown): string {
  const text = typeof value === 'string' ? value : safeJson(value);
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > MAX_EXCERPT ? `${one.slice(0, MAX_EXCERPT)}…` : one;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
}

function num(value: unknown): string {
  return typeof value === 'number' ? String(value) : '?';
}

function ms(value: unknown): string {
  return typeof value === 'number' ? `${Math.round(value)}ms` : '?';
}
