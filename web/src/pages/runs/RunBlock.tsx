// A run parked on a system that did not answer (D55): what it waits on, and
// the Resume form that sends it on. The same form serves a run that failed or
// was stopped after it started, which resume continues the same way, and a
// run still investigating (D72): a note to it joins the live investigation,
// and a stalled one is stopped and resumed.

import { type FormEvent, type ReactNode, useState } from 'react';
import { ApiError } from '../../api/client.ts';
import { resumeRun } from '../../api/endpoints.ts';
import type { BlockRecord, ResolvedBlock, ResumeResponse } from '../../api/types.ts';
import { Button } from '../../components/Button.tsx';
import { Field, Input, Textarea } from '../../components/Field.tsx';
import { Icon } from '../../components/Icon.tsx';
import { describeError } from '../../components/LoadState.tsx';
import { Notice } from '../../components/Notice.tsx';
import { Panel } from '../../components/Panel.tsx';
import { StatusTag } from '../../components/StatusTag.tsx';
import { formatDateTime, formatRelative } from '../../lib/format.ts';
import {
  buildResumeBody,
  failureCodeLabel,
  groupFailures,
  MAX_RESUME_NOTE,
  refusalText,
  resolutionLabel,
  resumedText,
  type ResumeFrom,
  resumeLabels,
  startsResuming,
} from './block-logic.ts';
import { useRememberedName } from './remembered-name.ts';

type Status = { kind: 'idle' } | { kind: 'ok'; text: string } | { kind: 'error'; text: string };

export type ResumeFormProps = {
  runId: string;
  from: ResumeFrom;
  /** The run was sent on, or took the note: poll for the new submission. res tells a stalled run's resume (D72) apart. */
  onResumed: (res: ResumeResponse) => void;
  /** The server refused (409): the run changed under this page, so reload it. */
  onRefused?: () => void;
  /** A stalled run's resume is in flight (D72): the form shows but sends nothing. */
  disabled?: boolean;
};

/** The Resume form on its own: a note, the name and the button. */
export function ResumeForm({ runId, from, onResumed, onRefused, disabled = false }: ResumeFormProps) {
  const labels = resumeLabels(from);
  const [note, setNote] = useState('');
  const [name, setName] = useRememberedName();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || disabled) return;
    const built = buildResumeBody({ name, note }, from);
    if (!built.ok) {
      setStatus({ kind: 'error', text: built.error });
      return;
    }
    setBusy(true);
    setStatus({ kind: 'idle' });
    try {
      const res = await resumeRun(runId, built.body);
      setNote('');
      // A stalled run's resume shows the page's Resuming notice instead.
      setStatus(startsResuming(from, res) ? { kind: 'idle' } : { kind: 'ok', text: resumedText(res.mode) });
      onResumed(res);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return;
      if (err instanceof ApiError && err.status === 409) {
        setStatus({ kind: 'error', text: refusalText(err.body) });
        onRefused?.();
        return;
      }
      setStatus({ kind: 'error', text: err instanceof ApiError && err.status === 404 ? 'This run no longer exists.' : describeError(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} noValidate style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Field label="Message" optional={from !== 'running'} hint={labels.noteHint}>
        <Textarea
          rows={3}
          maxLength={MAX_RESUME_NOTE}
          placeholder={labels.notePlaceholder}
          value={note}
          disabled={disabled}
          onChange={(e) => setNote(e.target.value)}
        />
      </Field>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
        <Field label={labels.by} className="runs-grow">
          <Input placeholder="[your name]" autoComplete="name" value={name} disabled={disabled} onChange={(e) => setName(e.target.value)} style={{ maxWidth: 280 }} />
        </Field>
        <Button type="submit" variant="primary" {...(from !== 'running' ? { icon: 'refresh' as const } : {})} busy={busy} disabled={disabled}>
          {disabled ? 'Resuming…' : labels.button}
        </Button>
      </div>
      {status.kind !== 'idle' && <Notice variant={status.kind === 'ok' ? 'info' : 'error'}>{status.text}</Notice>}
    </form>
  );
}

/** The Resume form in its own panel, for a failed, stopped, stalled or running run. */
export function ResumePanel(props: ResumeFormProps) {
  const labels = resumeLabels(props.from);
  return (
    <Panel title={labels.title} description={labels.description}>
      <ResumeForm {...props} />
    </Panel>
  );
}

/**
 * What a blocked run waits on: the reason, the systems with their recorded
 * failures, and since when. The Resume form goes in as children.
 */
export function BlockPanel({
  block,
  now,
  title = 'The run is waiting on a system',
  children,
}: {
  block: BlockRecord;
  /** Date.now() at render, for 'blocked 5m ago'. */
  now: number;
  title?: string;
  children?: ReactNode;
}) {
  const systems = groupFailures(block);
  return (
    <Panel>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        <span style={{ color: 'var(--tone-amber-fg)', display: 'flex', paddingTop: 2 }}>
          <Icon name="alert" size={18} />
        </span>
        <div style={{ flexGrow: 1, minWidth: 0 }}>
          <h2 style={{ fontSize: 16, fontWeight: 600 }}>{title}</h2>
          <p className="hint" style={{ margin: '4px 0 0' }}>
            Blocked {formatRelative(block.blocked_at, now)} ({formatDateTime(block.blocked_at)}), during submission #{block.submission_seq}. Nothing
            runs until it is resumed; what it found so far is kept.
          </p>
          <p className="runs-quote" style={{ margin: '12px 0 0' }}>
            {block.reason}
          </p>
          <div style={{ margin: '16px 0 0' }}>
            <div style={{ fontSize: 13, color: 'var(--muted)' }}>Systems that did not answer</div>
            {systems.map((row) => (
              <div key={row.system} className="runs-inv" style={{ alignItems: 'flex-start' }}>
                <span className="mono" style={{ width: 180, fontSize: 13, fontWeight: 500 }}>
                  {row.system}
                </span>
                {row.failures.length === 0 ? (
                  <span className="hint" style={{ margin: 0 }}>
                    No failure recorded.
                  </span>
                ) : (
                  <ul className="runs-list" style={{ listStyle: 'none', paddingLeft: 0 }}>
                    {row.failures.map((f, i) => (
                      <li key={i}>
                        <span className="mono">{f.tool}</span> {failureCodeLabel(f.code)} · {formatDateTime(f.at)}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
          {children !== undefined && (
            <div style={{ margin: '20px 0 0', paddingTop: 16, borderTop: '1px solid var(--line-soft)' }}>
              <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>Resume</h3>
              <p className="hint" style={{ margin: '4px 0 12px' }}>
                {resumeLabels('blocked').description}
              </p>
              {children}
            </div>
          )}
        </div>
      </div>
    </Panel>
  );
}

/** Earlier blocks and how each was closed. Nothing when the run never blocked before. */
export function BlockHistoryPanel({ history }: { history: readonly ResolvedBlock[] }) {
  if (history.length === 0) return null;
  return (
    <Panel title="Earlier blocks" description="Times the run waited on a system, oldest first, and how each ended.">
      {history.map((b) => (
        <div key={b.block_id} className="runs-entry">
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
            <span className="muted" style={{ fontSize: 13 }}>
              <span className="mono">{b.block_id}</span> · blocked {formatDateTime(b.blocked_at)} · {b.systems.join(', ')}
            </span>
            <StatusTag tone={b.status === 'resumed' ? 'neutral' : 'muted'} icon={b.status === 'resumed' ? 'check' : 'dash'}>
              {resolutionLabel(b)} · {formatDateTime(b.resolved_at)}
            </StatusTag>
          </div>
          <div style={{ margin: '6px 0 0', fontSize: 13, whiteSpace: 'pre-wrap' }}>{b.reason}</div>
          {b.note !== undefined && (
            <div className="hint" style={{ margin: '4px 0 0' }}>
              Note: {b.note}
            </div>
          )}
        </div>
      ))}
    </Panel>
  );
}
