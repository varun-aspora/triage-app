// Request and response shapes of every endpoint the console uses. Types that
// already exist in src/types are imported type-only, so no runtime code from
// src/ reaches the bundle.

import type { BlockRecord, ConnectorFailure, ResolvedBlock } from '../../../src/types/block.ts';
import type { Category, PreflightWarning, TierDecision } from '../../../src/types/classification.ts';
import type { Entity, Interface, KnownIdKey, ReportStatus, Tier } from '../../../src/types/core.ts';
import type { IdChain } from '../../../src/types/id-chain.ts';
import type { Report } from '../../../src/types/report.ts';
import type { RunUsageView, UsageTotals } from '../../../src/types/usage.ts';
import type { DoctorStatus, EvidenceKey, FeedbackVerdict, FindingVerdict, GuideStatus, RunPhase, RunStatus } from '../lib/constants.ts';

export type { BlockRecord, Category, ConnectorFailure, DoctorStatus, Entity, EvidenceKey, FeedbackVerdict, FindingVerdict, GuideStatus, IdChain };
export type { Interface, KnownIdKey, PreflightWarning, Report, ReportStatus, ResolvedBlock, RunPhase, RunStatus, RunUsageView, Tier, TierDecision };
export type { UsageTotals };

// ------------------------------------------------------------------ ui

export type UiEnv = 'production' | 'non-production';

/** GET /ui/config.json (public). */
export type UiConfig = { env: UiEnv };

/** GET /ui/session. */
export type Session = {
  ok: true;
  mock_mode: boolean;
  entities: Entity[];
  allow_slack_post: boolean;
};

/** Every error body the API returns. Only error is always present; fields name inputs, never their values. */
export type ApiErrorBody = {
  error: string;
  fields?: string[];
  reason?: string;
  /** POST /triage 422 (slack thread read failed). */
  code?: string;
  /** POST /triage 422; POST .../ask and .../resume 409: what to do instead. */
  hint?: string;
  /** POST .../stop and .../resume 409: the run's phase. */
  phase?: RunPhase;
  /** POST /repos/sync 400 and 409. */
  valid_repos?: string[];
  sync_id?: string;
  /** GET /doctor 400. */
  valid_checks?: string[];
};

// ------------------------------------------------------------------ runs

export type RunSummary = {
  run_id: string;
  created_at: string;
  updated_at: string;
  phase: RunPhase;
  category?: Category;
  tier_final?: Tier;
  report_status?: ReportStatus;
  submissions: number;
  feedback_verdict?: FeedbackVerdict;
  /** Sum of the priced usage rows (D59); absent when none is priced. */
  usd_total?: number;
  /** Input, output and cache tokens over every usage row; absent when the run has none. */
  tokens_total?: number;
  /** Set when usd_total leaves out at least one unpriced row. */
  usd_partial?: true;
  /** D71: set while the run is running but nobody is working on it. Absent otherwise, and from older servers. */
  stalled?: StalledView;
};

export type ListRunsQuery = {
  status?: RunStatus;
  phase?: RunPhase;
  category?: Category;
  /** none: no feedback yet. */
  feedback?: FeedbackVerdict | 'none';
  /** ISO timestamp; runs created at or after it. */
  since?: string;
  /** next_cursor from the previous page. */
  cursor?: string;
  /** 1..200, default 50. */
  limit?: number;
};

export type ListRunsResponse = { runs: RunSummary[]; next_cursor: string | null };

export type SubmissionView = {
  seq: number;
  /** resume: the run was sent on after a block, a failure or a stop (D55). */
  /** steer: a note sent while the run was still working, joined into its live response (D72). */
  kind: 'initial' | 'ask' | 'answer' | 'resume' | 'steer';
  question?: string;
  created_at: string;
  has_report: boolean;
};

export type FindingFeedback = { id: string; verdict: FindingVerdict; note?: string; text?: string };

export type FeedbackEntry = {
  verdict: FeedbackVerdict;
  actual_root_cause?: string;
  faster_path?: string;
  notes?: string;
  given_by: string;
  given_at: string;
  interface: Interface;
  /** The run's phase when it was given. */
  phase?: RunPhase;
  submission_seq?: number;
  report_seq?: number;
  /** A Cancel: the run was stopped with it. */
  cancelled?: true;
  findings?: FindingFeedback[];
};

/** A finding a verdict can name (src/report/finding-refs.ts). */
export type FindingRef = {
  id: string;
  kind: 'evidence' | 'hypothesis' | 'code_claim' | 'root_cause';
  key: EvidenceKey | null;
  version: number | null;
  text: string;
  detail?: string;
};

export type EvidenceProgress = { key: EvidenceKey; version: number };

/** One thread message of the stored request. at only when the stored ts still parses (Slack ts digits are usually masked). */
export type RequestMessage = { author: string; text: string; is_parent: boolean; at?: string };

/** The stored request on GET /triage/:run_id (D66): the thread, the added context and the hints given with it. */
export type RunRequest = {
  source: 'slack' | 'thread_file' | 'text' | 'json';
  /** The thread only; the context message is split out into context. */
  messages: RequestMessage[];
  context?: string;
  /** Only the keys the request carried; absent when none. IDs are the masked values. */
  hints?: {
    ids?: Partial<Record<KnownIdKey, string>>;
    entities?: Entity[];
    tier?: Tier;
    time_window?: { from: string; to: string };
  };
  attachments: number;
};

/** GET /triage/:run_id. Everything but run_id and usage has been through the persisted-profile redaction. */
export type RunDetail = {
  run_id: string;
  status: RunStatus;
  phase: RunPhase;
  classification: TierDecision | null;
  id_chain: IdChain | null;
  report?: Report;
  created_at: string;
  updated_at: string;
  phase_reason?: string;
  requested_by: string;
  interface: Interface;
  /** Slack runs only. The redacted copy: render it as a link only when it has no '*'. */
  permalink?: string;
  current_ask: string | null;
  /** What was asked (D66). Absent from an older server, or for a record with no stored source. */
  request?: RunRequest;
  /** The open block while the run waits on a system that did not answer (status blocked); null otherwise. */
  block: BlockRecord | null;
  /** Closed blocks, oldest first, each with how it was resolved. */
  block_history: ResolvedBlock[];
  preflight_warnings?: PreflightWarning[];
  evidence: EvidenceProgress[];
  /** The latest findings and the root cause, with the ids feedback takes. */
  findings: FindingRef[];
  submissions: SubmissionView[];
  feedback: FeedbackEntry[];
  report_md?: string;
  /** Tokens and cost of every model call in the run (D59). Absent from a server older than D59. */
  usage?: RunUsageView;
  /** D71: set while the run is running but nobody is working on it. Absent otherwise, and from older servers. */
  stalled?: StalledView;
};

export type ThreadMessageInput = { ts: string; author: string; text: string; is_parent?: boolean };

type StartRunCommon = {
  ids?: Partial<Record<KnownIdKey, string>>;
  /** Left out for Auto: the agent picks. */
  entities?: Entity[];
  /** Left out for Auto: the classifier picks. */
  tier?: Tier;
  requested_by: string;
  time_window?: { from: string; to: string };
  /** Extra notes not in the thread. The server appends them after the thread. */
  context?: string;
};

/** POST /triage. Either a Slack thread URL or pasted messages. */
export type StartRunBody = StartRunCommon &
  ({ slack_url: string; messages?: never } | { messages: ThreadMessageInput[]; slack_url?: never });

export type StartRunResponse = { run_id: string; deduplicated?: true };

export type AskBody = { question: string; requested_by: string };
export type AskResponse = { run_id: string; submission_id: string | null };

/** POST /triage/:run_id/resume. 409 (error, phase, hint) unless the run is blocked, or failed or stopped after it started. */
export type ResumeBody = { requested_by: string; note?: string };
/**
 * mode (D72): 'steer' when the run was still working and the note joined its
 * live response; 'resume' when the run was sent on (a stalled run is stopped
 * first). Absent from a server older than D72.
 *
 * A stalled run's resume answers at once with mode 'resume' and
 * submission_id null: the stop, abort and resume carry on on the server, on
 * the same Flue instance and session, while the page polls.
 */
export type ResumeResponse = { run_id: string; submission_id: string | null; mode?: 'steer' | 'resume' };

/** D71: a running run nobody is working on. The status stays running. */
export type StalledView = { reason: 'no_owner' | 'no_progress'; since: string };

export type FeedbackBody = {
  verdict: FeedbackVerdict;
  actual_root_cause?: string;
  faster_path?: string;
  notes?: string;
  findings?: { id: string; verdict: FindingVerdict; note?: string }[];
  given_by: string;
};
export type FeedbackResponse = { run_id: string; verdict: FeedbackVerdict; count: number };

/** POST /triage/:run_id/stop. verdict false: stop without the Cancel verdict. */
export type StopBody = { given_by: string; verdict?: boolean };
export type StopResponse = { run_id: string; stopped_from: RunPhase; aborted: boolean; feedback_count: number | null; gaps: string[] };

/** One line of a run's event log. data is the redacted event, whose shape depends on type. */
export type RunEvent = { index: number; ts: string; source: 'flue' | 'pipeline'; type: string; data: unknown };
export type RunEventsResponse = { events: RunEvent[]; next: number; more: boolean };

// ------------------------------------------------------------------ catalog

/** An env key by name and whether the .env has it. Never the value. */
export type EnvKeyRef = { name: string; state: 'set' | 'blank' | 'missing' };

export type ServiceRow = {
  key: string;
  repo: string | null;
  quickwit_service: string | null;
  db_env: EnvKeyRef | null;
  api_env: EnvKeyRef | null;
  transport: 'cbs' | null;
  note: string | null;
  guide: { name: string; status: GuideStatus | null } | null;
  /** Written by this server process; agents see it after a restart. */
  pending_restart: boolean;
};

export type EntityServices = { entity: Entity; services: ServiceRow[] };

export type RepoPinRow = { repo: string; entities: Entity[]; branch?: string };

export type ServicesResponse = {
  restart_required: boolean;
  entities: EntityServices[];
  repos: RepoPinRow[];
};

export type AddServiceBody = {
  entity: Entity;
  key: string;
  repo: string;
  quickwit_service?: string;
  db_env?: string;
  api_env?: string;
  note?: string;
  /** Default true. */
  create_guide?: boolean;
  guide_description?: string;
};

export type CatalogFile = { path: string; action: 'created' | 'updated' };

export type AddServiceResponse = {
  entity: Entity;
  key: string;
  files: CatalogFile[];
  warnings: string[];
  restart_required: true;
};

export type GuideRow = {
  name: string;
  kind: string;
  entity: string;
  service: string | null;
  status: GuideStatus | null;
  description: string;
  sources: string | null;
  pending_restart: boolean;
  /** Set when the SKILL.md does not parse. */
  problem?: string;
};

export type GuidesResponse = {
  restart_required: boolean;
  counts: { total: number; ported: number; written: number; stub: number };
  guides: GuideRow[];
};

export type GuideDetail = GuideRow & { body: string; files: string[] };

export type AddGuideBody = {
  kind: 'service' | 'overview';
  entity: Entity;
  /** Required when kind is service. */
  service?: string;
  description: string;
  sources?: string;
  status: GuideStatus;
  body: string;
};

export type AddGuideResponse = { name: string; file: string; restart_required: true };

// ------------------------------------------------------------------ ops

export type SyncState = {
  last_attempt_at: string;
  last_ok_at?: string;
  trigger: 'timer' | 'run' | 'cli' | 'http';
  ok: string[];
  skipped: string[];
  failed: string[];
};

/** GET /repos row, camelCase as served. */
export type RepoStatusRow = {
  repo: string;
  expectedBranch: string | null;
  actualBranch: string | null;
  commit: string | null;
  dirty: boolean | null;
  drift: boolean | null;
  indexed: boolean;
  present: boolean;
  problem?: string;
};

export type ReposResponse = {
  sync: {
    interval_ms: number;
    interfaces: Interface[];
    timer: { on: true } | { on: false; reason: string };
    running: boolean;
    last: SyncState | null;
    due: boolean;
    next_at?: string;
  };
  repos: RepoStatusRow[];
  not_configured?: { key: string; message: string };
};

export type RepoSyncResult = {
  repo: string;
  status: 'ok' | 'skipped' | 'failed';
  action?: 'cloned' | 'updated';
  branch?: string;
  commit?: string;
  index?: 'init' | 'sync';
  reason?: string;
  warnings: string[];
  line: string;
};

export type SyncJob = {
  sync_id: string;
  repo: string | null;
  status: 'running' | 'done' | 'busy' | 'failed';
  started_at: string;
  finished_at?: string;
  results?: RepoSyncResult[];
  ok?: string[];
  skipped?: string[];
  failed?: string[];
  reason?: string;
};

export type StartSyncResponse = { sync_id: string; status: 'running' };

export type DoctorCheck = {
  id: string;
  entity?: Entity;
  status: DoctorStatus;
  key_names: string[];
  message: string;
};

export type DoctorQuery = { check?: string[]; errorsOnly?: boolean; sortBy?: 'entity' | 'check' };

export type DoctorResponse = { checks: DoctorCheck[]; counts: Record<DoctorStatus, number> };
