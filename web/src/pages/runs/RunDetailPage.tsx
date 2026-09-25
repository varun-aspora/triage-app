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
import { AskForm, FeedbackForm, SlackPostPanel } from './RunForms.tsx';
import { ClassificationPanel, CostPanel, Dash, EvidencePanel, IdChainPanel, KV, PhaseStepper, RunHeader } from './RunParts.tsx';
import { askPending, deriveInvestigators, inferFailure, investigatorLook, permalinkHref, runningSteps } from './run-logic.ts';
import './runs.css';

const POLL_MS = 3000;
// A follow-up that never produces a report (it failed) must not keep the page polling forever.
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
      return p !== null && Date.now() < p.until && askPending(run.submissions, p.afterSeq);
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

  const onAsked = () => {
    const lastSeq = data.submissions.reduce((m, s) => Math.max(m, s.seq), 0);
    setPendingAsk({ afterSeq: lastSeq, until: Date.now() + ASK_POLL_LIMIT_MS });
    reload();
  };

  if (data.status === 'running') return <RunningView run={data} refreshError={refreshError} />;
  if (data.status === 'failed') return <FailedView run={data} refreshError={refreshError} />;
  return (
    <CompletedView
      run={data}
      refreshError={refreshError}
      askInFlight={pendingAsk !== null && Date.now() < pendingAsk.until && askPending(data.submissions, pendingAsk.afterSeq)}
      onAsked={onAsked}
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

function RunningView({ run, refreshError }: { run: RunDetail; refreshError: ReactNode }) {
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
          <PreflightWarnings run={run} />
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

// ------------------------------------------------------------------ failed

function FailedView({ run, refreshError }: { run: RunDetail; refreshError: ReactNode }) {
  const guess = inferFailure(run);
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
                <p className="hint">
                  The stored thread is redacted, so this run cannot be repeated as it was. Start a new run with the original thread.
                </p>
                <div style={{ display: 'flex', gap: 12, margin: '16px 0 0', flexWrap: 'wrap' }}>
                  <LinkButton to="/doctor" icon="doctor">
                    Open Doctor
                  </LinkButton>
                  <LinkButton to="/runs/new" variant="primary" icon="plus">
                    Start a new run
                  </LinkButton>
                </div>
              </div>
            </div>
          </Panel>
          <PreflightWarnings run={run} />
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

type TabId = 'report' | 'asks' | 'feedback' | 'request';

function CompletedView({
  run,
  refreshError,
  askInFlight,
  onAsked,
  onFeedback,
}: {
  run: RunDetail;
  refreshError: ReactNode;
  askInFlight: boolean;
  onAsked: () => void;
  onFeedback: () => void;
}) {
  const [tab, setTab] = useState<TabId>('report');
  const asks = run.submissions.filter((s) => s.kind === 'ask');
  const reports = run.submissions.filter((s) => s.has_report).length;
  const report = run.report;

  const askForm = <AskForm runId={run.run_id} reports={reports} onAsked={onAsked} />;
  const feedbackForm = <FeedbackForm runId={run.run_id} onSaved={onFeedback} />;
  const askNotice = askInFlight ? (
    <Notice variant="info" title="Follow-up in progress">
      The new report version shows here when it is ready. This page checks every few seconds.
    </Notice>
  ) : null;

  return (
    <>
      <RunHeader run={run} />
      {refreshError}
      <Tabs
        label="Run"
        active={tab}
        onChange={setTab}
        tabs={[
          { id: 'report', label: 'Report' },
          { id: 'asks', label: `Follow-ups (${asks.length})` },
          { id: 'feedback', label: `Feedback (${run.feedback.length})` },
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
              {askNotice}
              <CxAnswerSection cx={report.cx_answer} />
              <RootCauseSection report={report} />
              <TimelineSection items={report.timeline} />
              <CurrentStateSection items={report.current_state} />
              <ActionsSection actions={report.actions} />
              <SuggestedFixSection fixes={report.suggested_fix} />
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
          {askNotice}
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
                      {f.verdict}
                    </StatusTag>
                    <span className="muted" style={{ fontSize: 13 }}>
                      {f.given_by} · {formatDateTime(f.given_at)} · {f.interface}
                    </span>
                  </div>
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
                    <td>{s.kind === 'initial' ? 'first run' : 'follow-up'}</td>
                    <td style={{ fontSize: 13 }}>{s.question ?? <Dash />}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{formatDateTime(s.created_at)}</td>
                    <td>{s.has_report ? 'Yes' : 'No'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
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
