import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { ApiError } from '../../api/client.ts';
import { getRun } from '../../api/endpoints.ts';
import type { RunDetail } from '../../api/types.ts';
import { Button, LinkButton } from '../../components/Button.tsx';
import { EmptyState } from '../../components/EmptyState.tsx';
import { Icon } from '../../components/Icon.tsx';
import { describeError, ErrorNotice, Loading } from '../../components/LoadState.tsx';
import { Notice } from '../../components/Notice.tsx';
import { PageHeader } from '../../components/PageHeader.tsx';
import { Panel } from '../../components/Panel.tsx';
import { StatusTag } from '../../components/StatusTag.tsx';
import { Tabs } from '../../components/Tabs.tsx';
import { formatDateTime, formatRelative } from '../../lib/format.ts';
import { useApi } from '../../lib/useApi.ts';
import {
  ActionsSection,
  CurrentStateSection,
  CxAnswerSection,
  RootCauseSection,
  SuggestedFixSection,
  TimelineSection,
} from './ReportSections.tsx';
import { blockHistory, openBlock, resumeFrom, shownBlock, submissionKindLabel } from './block-logic.ts';
import { BlockHistoryPanel, BlockPanel, ResumeForm, ResumePanel } from './RunBlock.tsx';
import { AskForm, SlackPostPanel } from './RunForms.tsx';
import { StepsPanel } from './RunSteps.tsx';
import { VerdictPanel } from './RunVerdict.tsx';
import { verdictLabel } from './verdict-logic.ts';
import { ClassificationPanel, CostPanel, Dash, EvidencePanel, IdChainPanel, KV, PhaseStepper, RunHeader } from './RunParts.tsx';
import { blockedSteps, deriveInvestigators, followUpPending, inferFailure, investigatorLook, permalinkHref, runningSteps } from './run-logic.ts';
import './runs.css';

const POLL_MS = 3000;
// A follow-up or a resume whose submission never shows up must not keep the page polling forever.
const ASK_POLL_LIMIT_MS = 15 * 60_000;

type PendingAsk = { afterSeq: number; until: number };

export default function RunDetailPage() {
  const { runId = '' } = useParams();
  const [pendingAsk, setPendingAsk] = useState<PendingAsk | null>(null);
  const pendingRef = useRef(pendingAsk);
  pendingRef.current = pendingAsk;

  const { data, error, loading, reload } = useApi((signal) => getRun(runId, { signal }), [runId], {
    pollMs: POLL_MS,
    pollWhile: (run) => {
      if (run.status === 'running') return true;
      const p = pendingRef.current;
      return p !== null && Date.now() < p.until && followUpPending(run, p.afterSeq);
    },
  });

  useEffect(() => setPendingAsk(null), [runId]);

  if (data === undefined) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 400)) {
      return (
        <>
          <PageHeader title="Run not found" breadcrumb={[{ label: 'Runs', to: '/runs' }, { label: runId }]} />
          <Panel padded={false}>
            <EmptyState title={error.status === 404 ? 'There is no run with this id' : 'That is not a run id'} actions={<LinkButton to="/runs">Back to runs</LinkButton>}>
              Check the id, or find the run in the list.
            </EmptyState>
          </Panel>
        </>
      );
    }
    return (
      <>
        <PageHeader title="Run" breadcrumb={[{ label: 'Runs', to: '/runs' }, { label: runId }]} />
        {error !== undefined ? <ErrorNotice error={error} onRetry={reload} title="Could not load this run" /> : loading && <Loading label="Loading run…" />}
      </>
    );
  }

  const refreshError =
    error !== undefined && !(error instanceof ApiError && error.status === 401) ? (
      <Notice variant="warn" title="Could not refresh" actions={<Button size="sm" icon="refresh" onClick={reload}>Retry</Button>}>
        {describeError(error)} What you see may be out of date.
      </Notice>
    ) : null;

  // After a follow-up or a resume: poll until its submission settles.
  const onFollowUp = () => {
    const lastSeq = data.submissions.reduce((m, s) => Math.max(m, s.seq), 0);
    setPendingAsk({ afterSeq: lastSeq, until: Date.now() + ASK_POLL_LIMIT_MS });
    reload();
  };

  // A stored report means a submission already finished, so a running,
  // blocked or failed status here is a follow-up: keep the report and forms in view.
  if (data.report === undefined) {
    if (data.status === 'running') return <RunningView run={data} refreshError={refreshError} onChanged={reload} />;
    if (data.status === 'blocked') return <BlockedView run={data} refreshError={refreshError} onChanged={reload} onFollowUp={onFollowUp} />;
    if (data.status === 'failed' || data.status === 'stopped') {
      return <FailedView run={data} refreshError={refreshError} onChanged={reload} onFollowUp={onFollowUp} />;
    }
  }
  return (
    <CompletedView
      run={data}
      refreshError={refreshError}
      askInFlight={pendingAsk !== null && Date.now() < pendingAsk.until && followUpPending(data, pendingAsk.afterSeq)}
      onFollowUp={onFollowUp}
      onFeedback={reload}
    />
  );
}

// ------------------------------------------------------------------ running

/** Re-renders every second so 'Updated Ns ago' keeps moving between polls. */
function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

function RunningView({ run, refreshError, onChanged }: { run: RunDetail; refreshError: ReactNode; onChanged: () => void }) {
  const now = useNow(1000);
  const investigators = deriveInvestigators(run);
  return (
    <>
      <RunHeader run={run} extraMeta={<span>Updated {formatRelative(run.updated_at, now)}</span>} />
      {refreshError}
      <PhaseStepper steps={runningSteps(run.phase)} />
      <div className="runs-cols">
        <div className="runs-main">
          <Panel title="Investigators" description="Per-entity agents the Triage agent sent out.">
            {investigators.length === 0 ? (
              <p className="hint" style={{ margin: 0 }}>
                Investigators start once the run is classified.
              </p>
            ) : (
              investigators.map((row) => (
                <div key={row.key} className="runs-inv">
                  <div style={{ width: 180, fontSize: 14, fontWeight: 500 }}>{row.label}</div>
                  <div style={{ width: 110 }}>
                    <StatusTag look={investigatorLook(row.state)}>{row.state}</StatusTag>
                  </div>
                  <div style={{ fontSize: 13, color: 'var(--text-2)' }}>{row.detail}</div>
                </div>
              ))
            )}
          </Panel>
          <Panel>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: 8, padding: '24px 0' }}>
              <h2 style={{ fontSize: 16, fontWeight: 600 }}>The report shows here when the run finishes</h2>
              <p className="hint" style={{ margin: 0, maxWidth: 420 }}>
                This page checks for updates every few seconds. You can leave and come back; the run keeps going.
              </p>
            </div>
          </Panel>
          <VerdictPanel run={run} onSaved={onChanged} />
          <PreflightWarnings run={run} />
          <StepsPanel runId={run.run_id} live />
        </div>
        {(run.id_chain !== null || run.classification !== null) && (
          <aside className="runs-side">
            {run.id_chain !== null && <IdChainPanel chain={run.id_chain} />}
            {run.classification !== null && <ClassificationPanel decision={run.classification} full={false} />}
          </aside>
        )}
      </div>
    </>
  );
}

// ------------------------------------------------------------------ blocked

/** Parked on a system that did not answer (D55): no report, and nothing runs until someone resumes it. */
function BlockedView({
  run,
  refreshError,
  onChanged,
  onFollowUp,
}: {
  run: RunDetail;
  refreshError: ReactNode;
  onChanged: () => void;
  onFollowUp: () => void;
}) {
  const now = useNow(30_000);
  const block = shownBlock(run);
  const hasSide = run.id_chain !== null || run.classification !== null;
  const form = <ResumeForm runId={run.run_id} from="blocked" onResumed={onFollowUp} onRefused={onChanged} />;
  return (
    <>
      <RunHeader run={run} extraMeta={block !== null ? <span>Blocked {formatRelative(block.blocked_at, now)}</span> : undefined} />
      {refreshError}
      <PhaseStepper steps={blockedSteps()} />
      <div className="runs-cols">
        <div className="runs-main">
          {block !== null ? (
            <BlockPanel block={block} now={now}>
              {form}
            </BlockPanel>
          ) : (
            <Panel title="The run is waiting on a system" description="The block record was not stored with the run, so the reason cannot be shown.">
              {form}
            </Panel>
          )}
          <BlockHistoryPanel history={blockHistory(run)} />
          <VerdictPanel run={run} onSaved={onChanged} />
          <PreflightWarnings run={run} />
          <StepsPanel runId={run.run_id} live={false} />
        </div>
        {hasSide && (
          <aside className="runs-side">
            {run.id_chain !== null && <IdChainPanel chain={run.id_chain} />}
            {run.classification !== null && <ClassificationPanel decision={run.classification} full={false} />}
          </aside>
        )}
      </div>
    </>
  );
}

// ------------------------------------------------------------------ failed

function FailedView({
  run,
  refreshError,
  onChanged,
  onFollowUp,
}: {
  run: RunDetail;
  refreshError: ReactNode;
  onChanged: () => void;
  onFollowUp: () => void;
}) {
  const now = useNow(30_000);
  const stopped = run.status === 'stopped';
  // Resume continues the run's conversation, so it needs one: at least one submission was sent.
  const from = resumeFrom(run);
  const failure = inferFailure(run);
  const guess = stopped
    ? {
        ...failure,
        title: 'The run was stopped',
        hint:
          from !== null
            ? 'Someone stopped it before it finished. Resume it to carry on from what it found so far, or ask a follow-up.'
            : 'Someone stopped it before it finished. Ask a follow-up to start it again on what it has found so far.',
      }
    : failure;
  // A run that failed right after it blocked still holds the block: show what it was waiting on.
  const block = openBlock(run);
  const hasSide = run.id_chain !== null || run.classification !== null;
  return (
    <>
      <RunHeader run={run} />
      {refreshError}
      <PhaseStepper steps={guess.steps} />
      <div className="runs-cols">
        <div className="runs-main">
          <Panel>
            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
              <span style={{ color: 'var(--tone-rust-fg)', display: 'flex', paddingTop: 2 }}>
                <Icon name="alert" size={18} />
              </span>
              <div style={{ flexGrow: 1, minWidth: 0 }}>
                <h2 style={{ fontSize: 16, fontWeight: 600 }}>{guess.title}</h2>
                <p style={{ margin: '6px 0 0', fontSize: 14, lineHeight: 1.5, color: 'var(--text-2)' }}>
                  Reason: <span className="mono">{run.phase_reason ?? 'not recorded'}</span>
                </p>
                <p className="hint">{guess.hint}</p>
                {!stopped && (
                  <p className="hint">
                    {from !== null
                      ? 'The run had started investigating, so once the cause is fixed it can be resumed. It carries on from what it found.'
                      : 'The stored thread is redacted, so this run cannot be repeated as it was. Start a new run with the original thread.'}
                  </p>
                )}
                <div style={{ display: 'flex', gap: 12, margin: '16px 0 0', flexWrap: 'wrap' }}>
                  {!stopped && (
                    <LinkButton to="/doctor" icon="doctor">
                      Open Doctor
                    </LinkButton>
                  )}
                  {from === null && (
                    <LinkButton to="/runs/new" variant="primary" icon="plus">
                      Start a new run
                    </LinkButton>
                  )}
                </div>
              </div>
            </div>
          </Panel>
          {block !== null && <BlockPanel block={block} now={now} title="It had blocked on a system" />}
          {from !== null && <ResumePanel runId={run.run_id} from={from} onResumed={onFollowUp} onRefused={onChanged} />}
          {stopped && <AskForm runId={run.run_id} reports={0} onAsked={onFollowUp} />}
          <BlockHistoryPanel history={blockHistory(run)} />
          <VerdictPanel run={run} onSaved={onChanged} />
          <PreflightWarnings run={run} />
          <StepsPanel runId={run.run_id} live={false} />
        </div>
        {hasSide && (
          <aside className="runs-side">
            {run.id_chain !== null && <IdChainPanel chain={run.id_chain} />}
            {run.classification !== null && <ClassificationPanel decision={run.classification} full={false} />}
          </aside>
        )}
      </div>
    </>
  );
}

function PreflightWarnings({ run }: { run: RunDetail }) {
  const warnings = run.preflight_warnings ?? [];
  if (warnings.length === 0) return null;
  return (
    <Panel title="Pre-flight warnings" description="Checks that did not pass when the run started. The run carried on without these.">
      <ul className="runs-list">
        {warnings.map((w, i) => (
          <li key={i}>
            {w.entity !== undefined && <span className="mono">{w.entity} · </span>}
            <span className="mono">{w.step}</span>: {w.message}
            {w.fix !== undefined && w.fix !== '' && <div className="hint" style={{ margin: '2px 0 0' }}>Fix: {w.fix}</div>}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

// ------------------------------------------------------------------ completed

type TabId = 'report' | 'asks' | 'feedback' | 'steps' | 'request';

function CompletedView({
  run,
  refreshError,
  askInFlight,
  onFollowUp,
  onFeedback,
}: {
  run: RunDetail;
  refreshError: ReactNode;
  askInFlight: boolean;
  onFollowUp: () => void;
  onFeedback: () => void;
}) {
  const [tab, setTab] = useState<TabId>('report');
  const now = useNow(30_000);
  const asks = run.submissions.filter((s) => s.kind === 'ask');
  const reports = run.submissions.filter((s) => s.has_report).length;
  const report = run.report;
  const from = resumeFrom(run);
  const block = openBlock(run);

  const askForm = <AskForm runId={run.run_id} reports={reports} onAsked={onFollowUp} />;
  const feedbackForm = <VerdictPanel run={run} onSaved={onFeedback} />;
  // A blocked follow-up shows what it waits on with the form; a failed or stopped one gets the form alone.
  let resumePanel: ReactNode = null;
  if (from === 'blocked' && block !== null) {
    resumePanel = (
      <BlockPanel block={block} now={now}>
        <ResumeForm runId={run.run_id} from="blocked" onResumed={onFollowUp} onRefused={onFeedback} />
      </BlockPanel>
    );
  } else if (from !== null) {
    resumePanel = <ResumePanel runId={run.run_id} from={from} onResumed={onFollowUp} onRefused={onFeedback} />;
  }
  let askNotice: ReactNode = null;
  if (run.status === 'blocked') {
    askNotice = (
      <Notice variant="warn" title="The follow-up is waiting on a system">
        A system did not answer and the follow-up could not go on. The report below is from before it. Resume it once the system is back.
      </Notice>
    );
  } else if (run.status === 'stopped') {
    askNotice = (
      <Notice variant="warn" title="The run was stopped">
        The report below is from before it was stopped. Resume it to carry on, or ask a follow-up to start it again.
      </Notice>
    );
  } else if (run.status === 'failed') {
    askNotice = (
      <Notice variant="warn" title="The last follow-up failed">
        Reason: <span className="mono">{run.phase_reason ?? 'not recorded'}</span>. The report below is from before it. You can resume it or ask
        again.
      </Notice>
    );
  } else if (run.status === 'running' || askInFlight) {
    askNotice = (
      <Notice variant="info" title="Follow-up running">
        {run.status === 'running' && (
          <>
            Phase: <span className="mono">{run.phase}</span>.{' '}
          </>
        )}
        The new report version shows here when it is ready. This page checks every few seconds.
      </Notice>
    );
  }

  return (
    <>
      <RunHeader run={run} />
      {refreshError}
      {askNotice}
      <Tabs
        label="Run"
        active={tab}
        onChange={setTab}
        tabs={[
          { id: 'report', label: 'Report' },
          { id: 'asks', label: `Follow-ups (${asks.length})` },
          { id: 'feedback', label: `Feedback (${run.feedback.length})` },
          { id: 'steps', label: 'Steps' },
          { id: 'request', label: 'Request' },
        ]}
      />

      {tab === 'report' &&
        (report === undefined ? (
          <>
            <Notice variant="warn" title="No report stored">
              The run finished without a stored report. The Request tab shows what was asked.
            </Notice>
          </>
        ) : (
          <div className="runs-cols">
            <div className="runs-main">
              {from === 'blocked' && resumePanel}
              <CxAnswerSection cx={report.cx_answer} />
              <RootCauseSection report={report} />
              <TimelineSection items={report.timeline} />
              <CurrentStateSection items={report.current_state} />
              <ActionsSection actions={report.actions} />
              <SuggestedFixSection fixes={report.suggested_fix} />
              {from !== 'blocked' && resumePanel}
              {askForm}
              {feedbackForm}
              <SlackPostPanel />
            </div>
            <aside className="runs-side">
              <ClassificationPanel decision={report.classification} full />
              <IdChainPanel chain={report.id_chain} />
              <EvidencePanel report={report} />
              <CostPanel cost={report.cost} />
            </aside>
          </div>
        ))}

      {tab === 'asks' && (
        <div className="runs-main" style={{ maxWidth: 880 }}>
          <Panel title="Follow-ups" description="Questions asked after the first report. Each one that finishes adds a report version.">
            {asks.length === 0 ? (
              <p className="hint" style={{ margin: 0 }}>
                No follow-ups yet.
              </p>
            ) : (
              asks.map((s) => (
                <div key={s.seq} className="runs-entry">
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                    <span className="muted" style={{ fontSize: 13 }}>
                      #{s.seq} · {formatDateTime(s.created_at)}
                    </span>
                    {s.has_report ? (
                      <StatusTag tone="neutral" icon="check">
                        report stored
                      </StatusTag>
                    ) : (
                      <StatusTag tone="muted" icon="clock">
                        no report yet
                      </StatusTag>
                    )}
                  </div>
                  <div style={{ margin: '6px 0 0', whiteSpace: 'pre-wrap' }}>{s.question ?? <Dash />}</div>
                </div>
              ))
            )}
          </Panel>
          {askForm}
        </div>
      )}

      {tab === 'feedback' && (
        <div className="runs-main" style={{ maxWidth: 880 }}>
          <Panel title="Feedback" description="Oldest first. The latest entry wins.">
            {run.feedback.length === 0 ? (
              <p className="hint" style={{ margin: 0 }}>
                No feedback yet.
              </p>
            ) : (
              run.feedback.map((f, i) => (
                <div key={i} className="runs-entry">
                  <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                    <StatusTag tone={f.verdict === 'wrong' ? 'rust' : f.verdict === 'partial' || f.verdict === 'pending' ? 'amber' : 'neutral'}>
                      {verdictLabel(f)}
                    </StatusTag>
                    <span className="muted" style={{ fontSize: 13 }}>
                      {f.given_by} · {formatDateTime(f.given_at)} · {f.interface}
                      {f.phase !== undefined && f.phase !== 'completed' && <> · while {f.phase}</>}
                      {f.report_seq !== undefined && <> · report #{f.report_seq}</>}
                    </span>
                  </div>
                  {f.notes !== undefined && <p style={{ margin: '8px 0 0', fontSize: 13, whiteSpace: 'pre-wrap' }}>{f.notes}</p>}
                  {f.findings !== undefined && f.findings.length > 0 && (
                    <ul className="runs-list" style={{ margin: '8px 0 0' }}>
                      {f.findings.map((m) => (
                        <li key={m.id} style={{ fontSize: 13 }}>
                          <StatusTag tone={m.verdict === 'wrong' ? 'rust' : m.verdict === 'partial' ? 'amber' : 'neutral'} icon={m.verdict === 'wrong' ? 'x' : 'check'}>
                            <span className="mono">{m.id}</span>
                          </StatusTag>{' '}
                          {m.text ?? <span className="muted">(an older version of the findings)</span>}
                          {m.note !== undefined && <span className="muted"> · {m.note}</span>}
                        </li>
                      ))}
                    </ul>
                  )}
                  {f.actual_root_cause !== undefined && (
                    <p style={{ margin: '8px 0 0', fontSize: 13 }}>
                      <span className="muted">Actual root cause: </span>
                      {f.actual_root_cause}
                    </p>
                  )}
                  {f.faster_path !== undefined && (
                    <p style={{ margin: '4px 0 0', fontSize: 13 }}>
                      <span className="muted">Faster path: </span>
                      {f.faster_path}
                    </p>
                  )}
                </div>
              ))
            )}
          </Panel>
          {feedbackForm}
        </div>
      )}

      {tab === 'steps' && (
        <div className="runs-main">
          <StepsPanel runId={run.run_id} live={run.status === 'running'} />
        </div>
      )}

      {tab === 'request' && <RequestTab run={run} />}
    </>
  );
}

function RequestTab({ run }: { run: RunDetail }) {
  const href = permalinkHref(run.permalink);
  return (
    <div className="runs-cols">
      <div className="runs-main">
        <Panel title="Request" description="What was asked and how. The stored thread is redacted, so it is not shown here.">
          <KV k="Current ask">{run.current_ask ?? <Dash />}</KV>
          <KV k="Requested by">{run.requested_by}</KV>
          <KV k="Sent from">{run.interface}</KV>
          <KV k="Slack thread">
            {href !== undefined ? (
              <a href={href} className="link" target="_blank" rel="noreferrer noopener">
                Open in Slack
              </a>
            ) : run.permalink !== undefined ? (
              <span className="mono" style={{ fontSize: 12 }}>
                {run.permalink}
              </span>
            ) : (
              <Dash />
            )}
          </KV>
          <KV k="Created">{formatDateTime(run.created_at)}</KV>
          <KV k="Last updated">{formatDateTime(run.updated_at)}</KV>
          <KV k="Run id">
            <span className="mono" style={{ fontSize: 12 }}>
              {run.run_id}
            </span>
          </KV>
        </Panel>
        <Panel padded={false}>
          <div style={{ padding: '20px 24px 8px' }}>
            <h2 style={{ fontSize: 16, fontWeight: 600 }}>Submissions</h2>
          </div>
          <div className="runs-table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">Kind</th>
                  <th scope="col">Question</th>
                  <th scope="col">Sent</th>
                  <th scope="col">Report</th>
                </tr>
              </thead>
              <tbody>
                {run.submissions.map((s) => (
                  <tr key={s.seq}>
                    <td className="mono">{s.seq}</td>
                    <td>{submissionKindLabel(s.kind)}</td>
                    <td style={{ fontSize: 13 }}>{s.question ?? <Dash />}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{formatDateTime(s.created_at)}</td>
                    <td>{s.has_report ? 'Yes' : 'No'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
        <BlockHistoryPanel history={blockHistory(run)} />
        <PreflightWarnings run={run} />
      </div>
      {run.id_chain !== null && (
        <aside className="runs-side">
          <IdChainPanel chain={run.id_chain} />
        </aside>
      )}
    </div>
  );
}
