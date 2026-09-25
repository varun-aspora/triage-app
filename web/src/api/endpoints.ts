// One typed function per endpoint. All throw ApiError on a non-2xx answer.
// Reads take an optional AbortSignal so useApi can cancel them on unmount.

import { request } from './client.ts';
import type {
  AddGuideBody,
  AddGuideResponse,
  AddServiceBody,
  AddServiceResponse,
  AskBody,
  AskResponse,
  DoctorQuery,
  DoctorResponse,
  FeedbackBody,
  FeedbackResponse,
  GuideDetail,
  GuidesResponse,
  ListRunsQuery,
  ListRunsResponse,
  ReposResponse,
  ResumeBody,
  ResumeResponse,
  RunDetail,
  RunEventsResponse,
  ServicesResponse,
  Session,
  StartRunBody,
  StartRunResponse,
  StartSyncResponse,
  StopBody,
  StopResponse,
  SyncJob,
  UiConfig,
} from './types.ts';

type Read = { signal?: AbortSignal };

const seg = (s: string): string => encodeURIComponent(s);

// ------------------------------------------------------------------ ui

/** Public: the theme, needed before the token prompt. */
export function getUiConfig(opts: Read = {}): Promise<UiConfig> {
  return request('GET', '/ui/config.json', { auth: false, signal: opts.signal });
}

/** Verifies the stored token, or tokenOverride when the operator has just typed one. */
export function getSession(tokenOverride?: string, opts: Read = {}): Promise<Session> {
  return request('GET', '/ui/session', { signal: opts.signal, ...(tokenOverride !== undefined ? { token: tokenOverride } : {}) });
}

// ------------------------------------------------------------------ runs

export function listRuns(q: ListRunsQuery = {}, opts: Read = {}): Promise<ListRunsResponse> {
  return request('GET', '/triage', { query: { ...q }, signal: opts.signal });
}

export function getRun(runId: string, opts: Read = {}): Promise<RunDetail> {
  return request('GET', `/triage/${seg(runId)}`, { signal: opts.signal });
}

/** Send a fresh idempotencyKey per form submission; a retry of the same submission reuses it. */
export function startRun(body: StartRunBody, idempotencyKey: string): Promise<StartRunResponse> {
  return request('POST', '/triage', { body, headers: { 'Idempotency-Key': idempotencyKey } });
}

/** 409 while the run is blocked: resume it instead. */
export function askRun(runId: string, body: AskBody): Promise<AskResponse> {
  return request('POST', `/triage/${seg(runId)}/ask`, { body });
}

/** Sends a blocked, failed or stopped run on (D55). 409 with a hint when the run cannot be resumed. */
export function resumeRun(runId: string, body: ResumeBody): Promise<ResumeResponse> {
  return request('POST', `/triage/${seg(runId)}/resume`, { body });
}

export function sendFeedback(runId: string, body: FeedbackBody): Promise<FeedbackResponse> {
  return request('POST', `/triage/${seg(runId)}/feedback`, { body });
}

/** 409 when the run has already finished. */
export function stopRun(runId: string, body: StopBody): Promise<StopResponse> {
  return request('POST', `/triage/${seg(runId)}/stop`, { body });
}

/** The run's event log from line `after` on. */
export function getRunEvents(runId: string, q: { after?: number; limit?: number } = {}, opts: Read = {}): Promise<RunEventsResponse> {
  return request('GET', `/triage/${seg(runId)}/events`, { query: { ...q }, signal: opts.signal });
}

// ------------------------------------------------------------------ catalog

export function listServices(opts: Read = {}): Promise<ServicesResponse> {
  return request('GET', '/services', { signal: opts.signal });
}

export function addService(body: AddServiceBody): Promise<AddServiceResponse> {
  return request('POST', '/services', { body });
}

export function listGuides(opts: Read = {}): Promise<GuidesResponse> {
  return request('GET', '/guides', { signal: opts.signal });
}

export function getGuide(name: string, opts: Read = {}): Promise<GuideDetail> {
  return request('GET', `/guides/${seg(name)}`, { signal: opts.signal });
}

export function addGuide(body: AddGuideBody): Promise<AddGuideResponse> {
  return request('POST', '/guides', { body });
}

// ------------------------------------------------------------------ ops

export function getRepos(opts: Read = {}): Promise<ReposResponse> {
  return request('GET', '/repos', { signal: opts.signal });
}

/** No repo syncs every repo in resources/repos.json. */
export function startRepoSync(repo?: string): Promise<StartSyncResponse> {
  return request('POST', '/repos/sync', { body: repo !== undefined ? { repo } : {} });
}

export function getRepoSync(syncId: string, opts: Read = {}): Promise<SyncJob> {
  return request('GET', `/repos/sync/${seg(syncId)}`, { signal: opts.signal });
}

/** Slow: runs the probes. */
export function getDoctor(q: DoctorQuery = {}, opts: Read = {}): Promise<DoctorResponse> {
  return request('GET', '/doctor', {
    query: {
      check: q.check !== undefined && q.check.length > 0 ? q.check : undefined,
      errors_only: q.errorsOnly,
      sort_by: q.sortBy,
    },
    signal: opts.signal,
  });
}
