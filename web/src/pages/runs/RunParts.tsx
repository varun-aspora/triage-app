// Pieces of the run detail page shared by the completed, running and failed views.

import { type ReactNode, useState } from 'react';
import type { IdChain, Report, RunDetail, RunUsageView, TierDecision } from '../../api/types.ts';
import { Button } from '../../components/Button.tsx';
import { Icon } from '../../components/Icon.tsx';
import { PageHeader } from '../../components/PageHeader.tsx';
import { Panel } from '../../components/Panel.tsx';
import { Segmented } from '../../components/Segmented.tsx';
import { StatusTag } from '../../components/StatusTag.tsx';
import { EVIDENCE_LADDER_STEPS } from '../../lib/constants.ts';
import { runStatusTone } from '../../lib/status.ts';
import { formatDateTime, formatDuration, formatTokens, shortRunId } from '../../lib/format.ts';
import { downloadText } from './browser.ts';
import {
  capitalise,
  formatCalls,
  formatCost,
  formatTokenSplit,
  permalinkHref,
  reportStatusLook,
  reportVersionLabel,
  STEPPER_PHASES,
  type StepperPhase,
  type StepState,
  totalTokens,
  type UsageBreakdown,
  usageLines,
  usageNotes,
  YES_NO,
} from './run-logic.ts';

export const Dash = () => <span className="faint">—</span>;

export function KV({ k, children }: { k: ReactNode; children: ReactNode }) {
  return (
    <div className="runs-kv">
      <span>{k}</span>
      <span>{children}</span>
    </div>
  );
}

export function Tag({ children, soft = false }: { children: ReactNode; soft?: boolean }) {
  return <span className={soft ? 'runs-tag soft' : 'runs-tag'}>{children}</span>;
}

export function Tags({ items }: { items: readonly string[] }) {
  if (items.length === 0) return <Dash />;
  return (
    <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
      {items.map((x) => (
        <Tag key={x}>{x}</Tag>
      ))}
    </span>
  );
}

// ------------------------------------------------------------------ header

export function RunHeader({ run, extraMeta }: { run: RunDetail; extraMeta?: ReactNode }) {
  const report = run.report;
  const href = permalinkHref(run.permalink);
  const version = reportVersionLabel(run.submissions);
  const tier = report?.classification.tier_final ?? run.classification?.tier_final;
  const category = report?.classification.proposed.category ?? run.classification?.proposed.category;

  const actions =
    report !== undefined ? (
      <>
        <Button
          size="sm"
          onClick={() => downloadText(`${run.run_id}.json`, `${JSON.stringify(report, null, 2)}\n`, 'application/json')}
        >
          Download JSON
        </Button>
        <Button
          size="sm"
          disabled={run.report_md === undefined}
          title={run.report_md === undefined ? 'No Markdown stored for this report' : undefined}
          onClick={() => run.report_md !== undefined && downloadText(`${run.run_id}.md`, run.report_md, 'text/markdown')}
        >
          Download Markdown
        </Button>
      </>
    ) : undefined;

  return (
    <PageHeader
      title={run.current_ask !== null && run.current_ask.trim() !== '' ? run.current_ask : 'Run'}
      documentTitle={`Run ${shortRunId(run.run_id)}`}
      breadcrumb={[{ label: 'Runs', to: '/runs' }, { label: run.run_id }]}
      actions={actions}
    >
      <div className="runs-tags">
        <StatusTag look={runStatusTone(run.status)}>{run.status === 'running' ? run.phase : run.status}</StatusTag>
        {category !== undefined && <StatusTag tone="neutral">{category}</StatusTag>}
        {tier !== undefined && <StatusTag tone="neutral">{tier}</StatusTag>}
        {report !== undefined && <StatusTag look={reportStatusLook(report.status)}>{report.status}</StatusTag>}
        {report !== undefined && (
          <StatusTag tone="neutral" icon={report.confidence === 'high' ? 'check' : 'alert'}>
            confidence {report.confidence}
          </StatusTag>
        )}
      </div>
      <div className="runs-meta">
        <span>Requested by {run.requested_by}</span>
        <span>Created {formatDateTime(run.created_at)}</span>
        {href !== undefined ? (
          <a href={href} className="link" target="_blank" rel="noreferrer noopener">
            Slack thread
          </a>
        ) : run.permalink !== undefined ? (
          <span title="The stored link has masked digits, so it cannot be opened from here">Slack thread (link masked)</span>
        ) : null}
        {version !== undefined && <span>{version}</span>}
        {extraMeta}
      </div>
    </PageHeader>
  );
}

// ------------------------------------------------------------------ stepper

export function PhaseStepper({ steps }: { steps: Record<StepperPhase, StepState> }) {
  return (
    <Panel>
      <ol className="runs-steps" aria-label="Run phases">
        <li className="rail" aria-hidden="true" />
        {STEPPER_PHASES.map((p) => {
          const state = steps[p];
          return (
            <li key={p} className={`step ${state}`} aria-current={state === 'current' || state === 'waiting' ? 'step' : undefined}>
              <span className="dot">
                {state === 'done' && <Icon name="check" size={12} />}
                {state === 'failed' && <Icon name="x" size={12} />}
                {state === 'waiting' && <Icon name="clock" size={12} />}
              </span>
              <span>{p}</span>
              <span className="visually-hidden">
                {state === 'done'
                  ? ' (done)'
                  : state === 'current'
                    ? ' (in progress)'
                    : state === 'waiting'
                      ? ' (waiting on a system)'
                      : state === 'failed'
                        ? ' (failed here)'
                        : ''}
              </span>
            </li>
          );
        })}
      </ol>
    </Panel>
  );
}

// ------------------------------------------------------------------ side panels

export function ClassificationPanel({ decision, full }: { decision: TierDecision; full: boolean }) {
  const p = decision.proposed;
  return (
    <Panel title="Classification" as="div" style={{ padding: 20 }}>
      <KV k="Category">
        <span className="mono">{p.category}</span>
      </KV>
      {full && (
        <KV k="Subcategory">{p.subcategory !== '' ? <span className="mono">{p.subcategory}</span> : <Dash />}</KV>
      )}
      <KV k="Entities likely">
        <Tags items={p.entities_likely} />
      </KV>
      {full && <KV k="Money moved">{YES_NO(p.money_moved)}</KV>}
      <KV k="Tier">
        <span className="mono">{decision.tier_final}</span>
        {full && <span className="muted"> (proposed {p.tier_proposed})</span>}
      </KV>
      <KV k="Rule">
        <span className="mono">{decision.rule_fired}</span>
      </KV>
      {full && <KV k="Classifier confidence">{p.confidence.toFixed(2)}</KV>}
      {full && <KV k="Known pattern">{p.matched_pattern_id !== undefined ? <span className="mono">{p.matched_pattern_id}</span> : <Dash />}</KV>}
      {decision.tier_override_by !== undefined && <KV k="Tier set by">{decision.tier_override_by}</KV>}
    </Panel>
  );
}

export function IdChainPanel({ chain }: { chain: IdChain }) {
  const ids = Object.entries(chain.ids).filter((e): e is [string, string] => typeof e[1] === 'string');
  const hops = chain.hops.length;
  return (
    <Panel title="ID chain" description="Resolved from the thread before classifying." as="div" style={{ padding: 20 }}>
      {ids.length === 0 ? (
        <p className="hint" style={{ margin: 0 }}>
          No IDs were resolved.
        </p>
      ) : (
        ids.map(([k, val]) => (
          <KV key={k} k={<span className="mono">{k}</span>}>
            <span className="mono">{val}</span>
          </KV>
        ))
      )}
      <p className="hint" style={{ margin: '10px 0 0' }}>
        {hops} {hops === 1 ? 'hop' : 'hops'}. IDs are masked in the stored profile.
      </p>
    </Panel>
  );
}

export function EvidencePanel({ report }: { report: Report }) {
  const used = new Set(report.evidence_ladder);
  return (
    <Panel title="Evidence" as="div" style={{ padding: 20 }}>
      <div className="runs-tags" style={{ margin: '0 0 10px', gap: 6 }} aria-label="Evidence ladder">
        {EVIDENCE_LADDER_STEPS.map((s) =>
          used.has(s) ? (
            <StatusTag key={s} tone="neutral" icon="check">
              <span className="mono">{s}</span>
            </StatusTag>
          ) : (
            <StatusTag key={s} tone="muted" icon={null} title="Not used">
              <span className="mono" style={{ opacity: 0.7 }}>
                {s}
              </span>
            </StatusTag>
          ),
        )}
      </div>
      <KV k="Entities consulted">
        <Tags items={report.entities_consulted} />
      </KV>
      <KV k="Confidence">
        <span title={report.confidence_reason}>{capitalise(report.confidence)}</span>
      </KV>
      <KV k="Escalated">{YES_NO(report.escalated)}</KV>
      <KV k="Images read">{YES_NO(report.images_seen)}</KV>
      {report.confidence_reason !== '' && (
        <p className="hint" style={{ margin: '10px 0 0' }}>
          {report.confidence_reason}
        </p>
      )}
      {report.escalated && report.escalation_reasons.length > 0 && (
        <SideList title="Why it escalated" items={report.escalation_reasons} />
      )}
      <SideList title="Gaps" items={report.gaps} empty="None recorded." />
      <div style={{ margin: '14px 0 0' }}>
        <div style={{ fontSize: 13, color: 'var(--muted)', margin: '0 0 4px' }}>Code read at</div>
        {report.repo_commits.length === 0 ? (
          <div className="hint" style={{ margin: 0 }}>
            No code was read.
          </div>
        ) : (
          <div className="mono" style={{ fontSize: 12, lineHeight: 1.7 }}>
            {report.repo_commits.map((c) => (
              <div key={c.repo}>
                {c.repo} @ {c.commit.slice(0, 7)}
                {c.branch !== undefined && <span className="muted"> ({c.branch})</span>}
              </div>
            ))}
          </div>
        )}
      </div>
    </Panel>
  );
}

function SideList({ title, items, empty }: { title: string; items: readonly string[]; empty?: string }) {
  return (
    <div style={{ margin: '14px 0 0' }}>
      <div style={{ fontSize: 13, color: 'var(--muted)', margin: '0 0 4px' }}>{title}</div>
      {items.length === 0 ? (
        <div className="hint" style={{ margin: 0 }}>
          {empty}
        </div>
      ) : (
        <ul className="runs-list">
          {items.map((g, i) => (
            <li key={i}>{g}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Tokens and cost of every model call in the run (D59), read from the store,
 * so it covers follow-ups and embeddings that report.cost leaves out. While the
 * run is running the page polls, so the numbers move with it. wallMs is the
 * report's wall time, when there is a report.
 */
export function UsagePanel({ usage, running, now, wallMs }: { usage: RunUsageView | undefined; running: boolean; now: number; wallMs?: number }) {
  const [by, setBy] = useState<UsageBreakdown>('model');
  const notes = usageNotes(usage, running, now);
  const counted = usage !== undefined && usage.recorded ? usage : undefined;
  return (
    <Panel title="Run cost" as="div" style={{ padding: 20 }}>
      {notes.length > 0 && (
        <div className="runs-tags" style={{ margin: '0 0 10px', gap: 6 }}>
          {notes.map((n) => (
            <StatusTag key={n.text} look={n.look}>
              {n.text}
            </StatusTag>
          ))}
        </div>
      )}
      {counted === undefined ? (
        <p className="hint" style={{ margin: 0 }}>
          {running ? 'The first model calls show here once they are counted.' : 'No model calls were counted for this run.'}
        </p>
      ) : (
        <>
          <KV k="Cost">{formatCost(counted.total, counted.pricing)}</KV>
          <KV k="Model calls">{formatCalls(counted.total)}</KV>
          <KV k="Tokens in">{formatTokens(counted.total.input_tokens)}</KV>
          <KV k="Cache read">{formatTokens(counted.total.cache_read_tokens)}</KV>
          <KV k="Cache write">{formatTokens(counted.total.cache_write_tokens)}</KV>
          <KV k="Tokens out">{formatTokens(counted.total.output_tokens)}</KV>
        </>
      )}
      {wallMs !== undefined && <KV k="Wall time">{formatDuration(wallMs)}</KV>}
      {counted !== undefined && (
        <div style={{ margin: '14px 0 0' }}>
          <Segmented
            label="Break the cost down"
            value={by}
            onChange={setBy}
            options={[
              { value: 'model', label: 'By model' },
              { value: 'agent', label: 'By agent' },
            ]}
          />
          <div className="runs-table-wrap" style={{ margin: '10px 0 0' }}>
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">{by === 'model' ? 'Model' : 'Agent'}</th>
                  <th scope="col" className="num">
                    Calls
                  </th>
                  <th scope="col" className="num">
                    Tokens
                  </th>
                  <th scope="col" className="num">
                    Cost
                  </th>
                </tr>
              </thead>
              <tbody>
                {usageLines(counted, by).map((line) => (
                  <tr key={line.key}>
                    <td className="mono" style={{ fontSize: 12, overflowWrap: 'anywhere' }}>
                      {line.key}
                    </td>
                    <td className="num">{formatCalls(line.totals)}</td>
                    <td className="num" title={formatTokenSplit(line.totals)}>
                      {formatTokens(totalTokens(line.totals))}
                    </td>
                    <td className="num" style={{ whiteSpace: 'nowrap' }}>
                      {formatCost(line.totals)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Panel>
  );
}
