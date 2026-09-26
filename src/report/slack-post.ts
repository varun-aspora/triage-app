// Posting a finished report to its Slack thread (HLD 02 §5.1, §7; D13, D20,
// D25, D28, D39). Ingress code only: no agent tool imports this file, and the
// post needs an Approval that only requireApproval (approval.ts) can issue.
//
// prepareSlackPost(runId, deps) does everything up to the approval question:
//   1. the client is ready (in real mode SLACK_BOT_TOKEN is set);
//   2. the run has a report and a Slack thread target;
//   3. the reviewer is looked up (a Slack read, or a fixture in mock mode) and
//      picked with the fallback group;
//   4. the message is formatted and the egress check runs over the final text.
// Any failure is a SlackPostRefusal and writes an audit deny line.
//
// postReport(prepared, approval, deps) posts the prepared text as it is, then
// writes one audit line: tool slack_post, target SLACK_BOT_TOKEN (the env var
// name, never the token), transport real|mock, and approved_by in the summary.
// The message text is never written to the audit log.
import * as v from 'valibot';
import { makeAuditLine, type AuditInput } from '../gate/audit.ts';
import type { AuditSink } from '../gate/audit-sink.ts';
import { checkEgress } from '../gate/redact.ts';
import type { RunRecord, RunStore } from '../runstore/types.ts';
import type { AuditTransport } from '../types/audit.ts';
import { RunIdSchema, type Interface } from '../types/core.ts';
import { isApproval, type Approval } from './approval.ts';
import { ReportSchema } from './schema.ts';
import { SlackClientError, TOKEN_KEY, type SlackClient } from './slack-client.ts';
import { formatSlackReport, pickReviewer, renderReviewerTag, type ReviewerTag } from './slack-format.ts';

export const AUDIT_TOOL = 'slack_post';
export const AUDIT_TARGET = TOKEN_KEY;

export const NO_REPORT = 'no report yet';
export const NO_TARGET = 'no Slack thread for this run';

// Same shapes ingress checks before it reads a thread.
const CHANNEL_ID = /^[CGD][A-Z0-9]{2,20}$/;
const THREAD_TS = /^\d{9,11}\.\d{6}$/;
const SLACK_USER_ID = /^[UW][A-Z0-9]{2,20}$/;

export type SlackPostRefusalCode =
  | 'invalid_run_id'
  | 'not_ready'
  | 'not_found'
  | 'no_report'
  | 'bad_report'
  | 'no_target'
  | 'reviewer'
  | 'egress'
  | 'not_approved'
  | 'not_prepared';

/** A refusal before or instead of the post. Messages carry key and pattern names, never values. */
export class SlackPostRefusal extends Error {
  override readonly name = 'SlackPostRefusal';
  readonly code: SlackPostRefusalCode;
  constructor(code: SlackPostRefusalCode, message: string) {
    super(message);
    this.code = code;
  }
}

export type SlackTarget = { readonly channel_id: string; readonly thread_ts: string };

export type PreparedSlackPost = {
  readonly run_id: string;
  /** The exact text that will be posted. Show it before asking for approval. */
  readonly text: string;
  readonly target: SlackTarget;
  readonly reviewer: ReviewerTag;
  readonly transport: AuditTransport;
};

export type SlackPostConfig = {
  readonly slack: {
    readonly reviewerEmail?: string | undefined;
    readonly fallbackGroupHandle?: string | undefined;
  };
};

export type SlackPostDeps = {
  readonly store: Pick<RunStore, 'getRun'>;
  readonly client: SlackClient;
  readonly audit: AuditSink;
  readonly config: SlackPostConfig;
  /** Defaults to 'cli'. */
  readonly interface?: Interface;
  readonly now?: () => Date;
  readonly signal?: AbortSignal;
};

export type PostResult = {
  readonly run_id: string;
  readonly channel: string;
  readonly thread_ts: string;
  readonly ts: string;
  readonly transport: AuditTransport;
  readonly approved_by: string;
};

// Prepared posts issued by prepareSlackPost in this process. postReport sends
// only these, so a hand-built or edited text cannot be posted.
const prepared = new WeakSet<object>();

// ------------------------------------------------------------------ prepare

export async function prepareSlackPost(runId: string, deps: SlackPostDeps): Promise<PreparedSlackPost> {
  const signal = deps.signal ?? new AbortController().signal;
  const deny = denier(runId, deps);

  if (!v.is(RunIdSchema, runId)) throw new SlackPostRefusal('invalid_run_id', 'run_id is not a run id');

  const ready = deps.client.ready();
  if (!ready.ok) throw deny('not_ready', ready.reason);

  const run = await deps.store.getRun(runId);
  if (run === null) throw deny('not_found', `run not found: ${runId}`);
  if (run.report === null) throw deny('no_report', `${NO_REPORT} for run ${runId}; wait for it to finish (triage wait ${runId})`);

  // The stored report went through the persisted profile, which can mask
  // digit runs inside a ULID. The run id the operator passed is the real one.
  const parsed = v.safeParse(ReportSchema, { ...run.report, run_id: runId });
  if (!parsed.success) throw deny('bad_report', `the stored report for run ${runId} fails the report schema`);
  const report = parsed.output;

  const target = slackTargetOf(run);
  if (target === null) {
    throw deny('no_target', `${NO_TARGET}: it was not started from a Slack thread (--text, --thread-file or JSON input)`);
  }
  if (target === 'unusable') {
    throw deny('no_target', `${NO_TARGET}: the stored thread reference is not a usable channel id and ts`);
  }

  const reviewer = await chooseReviewer(run, deps, signal, deny);
  const text = formatSlackReport(report, reviewer);

  const check = egressCheck(text, runId, reviewer);
  if (!check.ok) throw deny('egress', `the Slack text still has unmasked ${check.unmasked.join(', ')}; nothing was posted`);

  const result: PreparedSlackPost = Object.freeze({
    run_id: runId,
    text,
    target: Object.freeze({ ...target }),
    reviewer: Object.freeze({ ...reviewer }),
    transport: deps.client.transport,
  });
  prepared.add(result);
  return result;
}

/**
 * The Slack thread of a run. A structural slack_target on the run record is
 * used when the store has one; otherwise the request source. null when the run
 * did not come from Slack, 'unusable' when the stored ids are not a channel id
 * and ts (for example masked by the persisted profile).
 */
export function slackTargetOf(run: RunRecord): SlackTarget | null | 'unusable' {
  const structural = (run as RunRecord & { readonly slack_target?: unknown }).slack_target;
  const candidate =
    structural !== undefined && structural !== null
      ? (structural as Partial<SlackTarget>)
      : run.request.source.kind === 'slack'
        ? run.request.source
        : null;
  if (candidate === null) return null;
  const channel_id = typeof candidate.channel_id === 'string' ? candidate.channel_id.trim() : '';
  const thread_ts = typeof candidate.thread_ts === 'string' ? candidate.thread_ts.trim() : '';
  if (!CHANNEL_ID.test(channel_id) || !THREAD_TS.test(thread_ts)) return 'unusable';
  return { channel_id, thread_ts };
}

async function chooseReviewer(
  run: RunRecord,
  deps: SlackPostDeps,
  signal: AbortSignal,
  deny: Denier,
): Promise<ReviewerTag> {
  const email = (deps.config.slack.reviewerEmail ?? '').trim();
  let reviewer: { id: string; active: boolean } | undefined;
  if (email !== '') {
    try {
      reviewer = (await deps.client.lookupUserByEmail(email, signal)) ?? undefined;
    } catch (err) {
      if (err instanceof SlackClientError) throw deny('reviewer', `reviewer lookup failed: ${err.message}`);
      throw err;
    }
  }
  const requester = run.request.requested_by.trim();
  try {
    return pickReviewer({
      ...(reviewer !== undefined ? { reviewer } : {}),
      ...(SLACK_USER_ID.test(requester) ? { requesterSlackId: requester } : {}),
      fallbackHandle: deps.config.slack.fallbackGroupHandle ?? '',
    });
  } catch (err) {
    throw deny('reviewer', err instanceof Error ? err.message : 'no reviewer could be tagged');
  }
}

// The egress check over the text as posted. Two tokens this module put there
// itself are left out: the run id code span (a ULID can hold six digits in a
// row) and the reviewer mention (a Slack user id). Both are ids, not PII.
function egressCheck(text: string, runId: string, reviewer: ReviewerTag) {
  const scanned = text
    .split(`\`${runId}\``)
    .join('`run_id`')
    .split(renderReviewerTag(reviewer))
    .join('@reviewer');
  return checkEgress(scanned);
}

// ------------------------------------------------------------------ post

/** Posts a prepared report. Needs an Approval issued by requireApproval in this process. */
export async function postReport(post: PreparedSlackPost, approval: Approval, deps: SlackPostDeps): Promise<PostResult> {
  const signal = deps.signal ?? new AbortController().signal;
  const deny = denier(post.run_id, deps);
  if (!isApproval(approval)) throw deny('not_approved', 'the approval was not issued by requireApproval; nothing was posted');
  if (!prepared.has(post)) throw deny('not_prepared', 'the post was not prepared by prepareSlackPost; nothing was posted');
  if (post.transport !== deps.client.transport) {
    throw deny('not_prepared', 'the post was prepared for another transport; nothing was posted');
  }

  const now = deps.now ?? (() => new Date());
  const started = now();
  const who = `approved_by ${approval.approved_by} (${approval.method})`;
  const line = (exit: number | string, summary: string) =>
    writeAudit(post.run_id, deps, now, {
      decision: 'allow',
      summary,
      duration_ms: Math.max(0, now().getTime() - started.getTime()),
      exit,
    });

  const { channel_id, thread_ts } = post.target;
  let reply;
  try {
    reply = await deps.client.postThreadReply(channel_id, thread_ts, post.text, signal);
  } catch (err) {
    const code = err instanceof SlackClientError ? err.code : 'error';
    line(code, `${AUDIT_TOOL} ${channel_id}: failed, ${who}`);
    if (err instanceof SlackClientError || signal.aborted) throw err;
    throw new SlackClientError('error', 'unexpected failure while posting the report');
  }
  line(0, `${AUDIT_TOOL} ${channel_id}: posted to the thread, ${who}`);
  return Object.freeze({
    run_id: post.run_id,
    channel: reply.channel,
    thread_ts,
    ts: reply.ts,
    transport: deps.client.transport,
    approved_by: approval.approved_by,
  });
}

/** Writes the audit deny line for an approval that was refused. Nothing is posted. */
export function recordApprovalRefusal(post: PreparedSlackPost, reason: string, deps: SlackPostDeps): void {
  denier(post.run_id, deps)('not_approved', `not approved: ${reason}`);
}

// ------------------------------------------------------------------ audit

type Denier = (code: SlackPostRefusalCode, message: string) => SlackPostRefusal;

// Builds the refusal and writes its deny line. A run id that fails the schema
// cannot be audited (it is a path segment in the run folder), so it is not.
function denier(runId: string, deps: SlackPostDeps): Denier {
  const now = deps.now ?? (() => new Date());
  return (code, message) => {
    if (v.is(RunIdSchema, runId)) {
      writeAudit(runId, deps, now, {
        decision: 'deny',
        reason: message,
        summary: `${AUDIT_TOOL}: refused (${code})`,
        duration_ms: 0,
        exit: code,
      });
    }
    return new SlackPostRefusal(code, message);
  };
}

// One slack_post audit line; the fields every line shares are filled here.
function writeAudit(
  runId: string,
  deps: SlackPostDeps,
  now: () => Date,
  fields: Pick<AuditInput, 'decision' | 'reason' | 'summary' | 'duration_ms' | 'exit'>,
): void {
  deps.audit.write(
    makeAuditLine({
      run_id: runId,
      ts: now().toISOString(),
      interface: deps.interface ?? 'cli',
      entity: null,
      tool: AUDIT_TOOL,
      target: AUDIT_TARGET,
      transport: deps.client.transport,
      ...fields,
    }),
  );
}
