// The report tab of a completed run, section by section as in the wireframe.

import { useState } from 'react';
import type { Report } from '../../api/types.ts';
import { Button } from '../../components/Button.tsx';
import { Panel } from '../../components/Panel.tsx';
import { Chip } from '../../components/StatusTag.tsx';
import { formatDateTime } from '../../lib/format.ts';
import { copyText } from './browser.ts';
import { Tag } from './RunParts.tsx';
import { capitalise } from './run-logic.ts';

const OWNER: Record<Report['cx_answer']['action_owner'], string> = {
  user: 'Customer',
  backend: 'Backend team',
  bank: 'Bank',
  unknown: 'Not clear yet',
};

function sourceLabel(src: Report['timeline'][number]['source']): string {
  return [src.source, src.service].filter(Boolean).join(' · ');
}

export function CxAnswerSection({ cx }: { cx: Report['cx_answer'] }) {
  const [copied, setCopied] = useState<'idle' | 'ok' | 'fail'>('idle');
  const copy = async () => {
    setCopied((await copyText(cx.reply_text)) ? 'ok' : 'fail');
    setTimeout(() => setCopied('idle'), 2000);
  };
  return (
    <Panel
      title="Answer for CX"
      actions={
        cx.reply_text !== '' ? (
          <Button size="sm" icon={copied === 'ok' ? 'check' : 'copy'} onClick={() => void copy()}>
            {copied === 'ok' ? 'Copied' : copied === 'fail' ? 'Copy failed' : 'Copy reply'}
          </Button>
        ) : undefined
      }
    >
      <div className="runs-tiles">
        <Tile k="Who acts next" v={OWNER[cx.action_owner]} f="action_owner" />
        <Tile k="Is the money safe" v={capitalise(cx.money_safe === 'unknown' ? 'not known' : cx.money_safe)} f="money_safe" />
        <Tile k="Should they retry" v={capitalise(cx.should_retry)} f="should_retry" />
      </div>
      {cx.reply_text !== '' ? <div className="runs-quote">{cx.reply_text}</div> : <p className="hint">No reply text in this report.</p>}
      {cx.escalate_to !== undefined && <p className="hint">Escalate to: {cx.escalate_to}</p>}
    </Panel>
  );
}

function Tile({ k, v, f }: { k: string; v: string; f: string }) {
  return (
    <div className="runs-tile">
      <div className="k">{k}</div>
      <div className="v">{v}</div>
      <div className="f">{f}</div>
    </div>
  );
}

export function RootCauseSection({ report }: { report: Report }) {
  const rc = report.root_cause;
  const scope = report.scope;
  return (
    <Panel title="Root cause">
      {rc === null ? (
        <p style={{ margin: 0, fontSize: 14 }} className="muted">
          The run did not settle on a root cause. See the gaps for what it could not check.
        </p>
      ) : (
        <>
          <p style={{ margin: '0 0 12px', fontSize: 15, lineHeight: 1.6 }}>{rc.statement}</p>
          {(rc.code_refs.length > 0 || rc.matched_pattern_id !== undefined) && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', fontSize: 13 }}>
              {rc.code_refs.length > 0 && <span className="muted">Code</span>}
              {rc.code_refs.map((r) => (
                <span key={`${r.repo}/${r.file}:${r.lines}`} className="mono" style={{ fontSize: 12 }}>
                  {r.repo}/{r.file}:{r.lines}
                </span>
              ))}
              {rc.matched_pattern_id !== undefined && (
                <>
                  <span className="muted">{rc.code_refs.length > 0 ? '· ' : ''}Matches pattern</span>
                  <span className="mono" style={{ fontSize: 12 }}>
                    {rc.matched_pattern_id}
                  </span>
                </>
              )}
            </div>
          )}
        </>
      )}
      <p className="hint">
        Scope: {scope.kind === 'single' ? 'one customer' : scope.kind}
        {scope.affected_count !== undefined && `, ${scope.affected_count} affected`}
        {scope.how_measured !== undefined && scope.how_measured !== '' && ` (${scope.how_measured})`}
      </p>
    </Panel>
  );
}

export function TimelineSection({ items }: { items: Report['timeline'] }) {
  return (
    <Panel padded={false}>
      <div style={{ padding: '20px 24px 8px' }}>
        <h2 style={{ fontSize: 16, fontWeight: 600 }}>Timeline</h2>
      </div>
      {items.length === 0 ? (
        <p className="hint" style={{ padding: '0 24px 20px' }}>
          No timeline in this report.
        </p>
      ) : (
        <div className="runs-table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Entity</th>
                <th scope="col">What happened</th>
                <th scope="col">Source</th>
              </tr>
            </thead>
            <tbody>
              {items.map((t, i) => (
                <tr key={i}>
                  <td className="mono" style={{ fontSize: 12, whiteSpace: 'nowrap', color: 'var(--text-2)' }} title={t.at}>
                    {formatDateTime(t.at)}
                  </td>
                  <td>
                    <Tag>{t.entity}</Tag>
                  </td>
                  <td style={{ fontSize: 13 }}>{t.what}</td>
                  <td>
                    <Tag soft>{sourceLabel(t.source)}</Tag>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

export function CurrentStateSection({ items }: { items: Report['current_state'] }) {
  if (items.length === 0) return null;
  return (
    <Panel padded={false}>
      <div style={{ padding: '20px 24px 8px' }}>
        <h2 style={{ fontSize: 16, fontWeight: 600 }}>Current state</h2>
      </div>
      <div className="runs-table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Item</th>
              <th scope="col">Value</th>
              <th scope="col">Read at</th>
              <th scope="col">Source</th>
            </tr>
          </thead>
          <tbody>
            {items.map((s, i) => (
              <tr key={i}>
                <td style={{ fontSize: 13 }}>{s.item}</td>
                <td className="mono" style={{ fontSize: 12, overflowWrap: 'anywhere' }}>
                  {s.value === '' ? <span className="faint">—</span> : s.value}
                </td>
                <td className="mono" style={{ fontSize: 12, whiteSpace: 'nowrap', color: 'var(--text-2)' }} title={s.taken_at}>
                  {formatDateTime(s.taken_at)}
                </td>
                <td>
                  <Tag soft>{sourceLabel(s.source)}</Tag>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

export function ActionsSection({ actions }: { actions: Report['actions'] }) {
  const groups: [string, string[]][] = [
    ['CX', actions.cx],
    ['Engineering', actions.eng],
    ['Ops / bank', actions.ops_bank],
  ];
  return (
    <Panel title="Recommended actions" description="Recommendations only. Nothing here is run by the agent.">
      <div className="runs-grid3">
        {groups.map(([title, list]) => (
          <div key={title}>
            <div style={{ fontWeight: 600, fontSize: 13, margin: '0 0 6px' }}>{title}</div>
            {list.length === 0 ? (
              <div className="hint" style={{ margin: 0 }}>
                Nothing for this team.
              </div>
            ) : (
              <ul className="runs-list">
                {list.map((a, i) => (
                  <li key={i}>{a}</li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </Panel>
  );
}

export function SuggestedFixSection({ fixes }: { fixes: Report['suggested_fix'] }) {
  if (fixes.length === 0) return null;
  return (
    <>
      {fixes.map((fix, i) => (
        <Panel
          key={i}
          title={fixes.length > 1 ? `Suggested fix ${i + 1} of ${fixes.length}` : 'Suggested fix'}
          actions={<Chip tone="muted">{fix.kind}</Chip>}
        >
          <div style={{ fontSize: 14, fontWeight: 500, margin: '0 0 8px' }}>{fix.title}</div>
          {fix.command !== '' && <pre className="runs-code">{fix.command}</pre>}
          <div style={{ display: 'flex', gap: 24, margin: '12px 0 0', fontSize: 13, lineHeight: 1.5, flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 200px' }}>
              <div style={{ fontWeight: 600 }}>Before you run it</div>
              {fix.preconditions.length === 0 ? (
                <div className="hint" style={{ margin: '4px 0 0' }}>
                  None listed.
                </div>
              ) : (
                <ul className="runs-list" style={{ margin: '4px 0 0' }}>
                  {fix.preconditions.map((p, j) => (
                    <li key={j}>{p}</li>
                  ))}
                </ul>
              )}
            </div>
            <div style={{ flex: '1 1 200px' }}>
              <div style={{ fontWeight: 600 }}>Check it worked</div>
              <div style={{ color: 'var(--text-2)', margin: '4px 0 0', whiteSpace: 'pre-wrap' }}>{fix.verify_with || '—'}</div>
            </div>
          </div>
        </Panel>
      ))}
    </>
  );
}
