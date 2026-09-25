// The verdict panel: accept or reject a run at any point, with notes and a
// tick or cross on each finding, and Cancel, which stops a running run and
// records it as rejected with no notes.

import { type FormEvent, useState } from 'react';
import { ApiError } from '../../api/client.ts';
import { sendFeedback, stopRun } from '../../api/endpoints.ts';
import type { FindingRef, RunDetail } from '../../api/types.ts';
import { Button } from '../../components/Button.tsx';
import { Field, Input, Textarea } from '../../components/Field.tsx';
import { describeError } from '../../components/LoadState.tsx';
import { Notice } from '../../components/Notice.tsx';
import { Panel } from '../../components/Panel.tsx';
import { useRememberedName } from './remembered-name.ts';
import {
  buildVerdictBody,
  canCancel,
  EMPTY_VERDICT_FORM,
  FINDING_KIND_LABELS,
  type FindingMarks,
  groupFindings,
  MAX_NOTES,
  toggleMark,
  type VerdictChoice,
} from './verdict-logic.ts';

type Status = { kind: 'idle' } | { kind: 'ok'; text: string } | { kind: 'error'; text: string };

export function VerdictPanel({ run, onSaved }: { run: RunDetail; onSaved: () => void }) {
  const [notes, setNotes] = useState(EMPTY_VERDICT_FORM.notes);
  const [rootCause, setRootCause] = useState(EMPTY_VERDICT_FORM.rootCause);
  const [fasterPath, setFasterPath] = useState(EMPTY_VERDICT_FORM.fasterPath);
  const [marks, setMarks] = useState<FindingMarks>(EMPTY_VERDICT_FORM.marks);
  const [name, setName] = useRememberedName();
  const [busy, setBusy] = useState<VerdictChoice | 'cancel' | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const running = canCancel(run);

  const fail = (err: unknown, notFound: string) => {
    if (err instanceof ApiError && err.status === 401) return;
    setStatus({ kind: 'error', text: err instanceof ApiError && err.status === 404 ? notFound : describeError(err) });
  };

  const save = async (choice: VerdictChoice) => {
    if (busy !== null) return;
    const built = buildVerdictBody(choice, { notes, rootCause, fasterPath, name, marks }, run.findings);
    if (!built.ok) {
      setStatus({ kind: 'error', text: built.error });
      return;
    }
    setBusy(choice);
    setStatus({ kind: 'idle' });
    try {
      const res = await sendFeedback(run.run_id, built.body);
      setStatus({
        kind: 'ok',
        text: `${choice === 'accept' ? 'Accepted' : 'Rejected'}. This run has ${res.count} verdict${res.count === 1 ? '' : 's'}.${running ? ' The run keeps going.' : ''}`,
      });
      setNotes('');
      setRootCause('');
      setFasterPath('');
      setMarks({});
      onSaved();
    } catch (err) {
      fail(err, 'This run no longer exists.');
    } finally {
      setBusy(null);
    }
  };

  const cancel = async () => {
    if (busy !== null) return;
    if (name.trim() === '') {
      setStatus({ kind: 'error', text: 'Enter your name.' });
      return;
    }
    setBusy('cancel');
    setStatus({ kind: 'idle' });
    try {
      const res = await stopRun(run.run_id, { given_by: name.trim() });
      setConfirmCancel(false);
      setStatus({
        kind: 'ok',
        text: `Stopped the run (it was in ${res.stopped_from}) and recorded it as rejected.${res.gaps.length > 0 ? ` ${res.gaps.join(' ')}` : ''}`,
      });
      onSaved();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setConfirmCancel(false);
        setStatus({ kind: 'error', text: 'The run has already finished. Accept or reject it instead.' });
        onSaved();
        return;
      }
      fail(err, 'This run no longer exists.');
    } finally {
      setBusy(null);
    }
  };

  const onSubmit = (e: FormEvent) => e.preventDefault();

  return (
    <Panel
      title="Accept or reject"
      description={
        running
          ? 'You can judge the run while it is still going. Cancel stops it and records it as rejected, with no notes.'
          : 'Your verdict, notes and ticks on findings are kept with the run for evals and learning. The latest verdict wins.'
      }
    >
      <form onSubmit={onSubmit} noValidate style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <FindingsList findings={run.findings} marks={marks} onMark={(id, v) => setMarks((m) => toggleMark(m, id, v))} />
        <Field label="Notes" optional>
          <Textarea
            rows={3}
            maxLength={MAX_NOTES}
            placeholder="What it got right or wrong, and why"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </Field>
        <details>
          <summary className="hint" style={{ cursor: 'pointer' }}>
            More detail for the eval case
          </summary>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 10 }}>
            <Field label="Actual root cause" optional className="runs-grow">
              <Textarea rows={2} maxLength={MAX_NOTES} placeholder="Only if the run got it wrong" value={rootCause} onChange={(e) => setRootCause(e.target.value)} />
            </Field>
            <Field label="Faster path" optional className="runs-grow">
              <Textarea rows={2} maxLength={MAX_NOTES} placeholder="Where it should have looked first" value={fasterPath} onChange={(e) => setFasterPath(e.target.value)} />
            </Field>
          </div>
        </details>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
          <Field label="Given by" className="runs-grow">
            <Input placeholder="[your name]" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} style={{ maxWidth: 280 }} />
          </Field>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {running && !confirmCancel && (
              <Button variant="ghost" icon="x" onClick={() => setConfirmCancel(true)} disabled={busy !== null}>
                Cancel run
              </Button>
            )}
            <Button icon="x" busy={busy === 'reject'} disabled={busy !== null && busy !== 'reject'} onClick={() => void save('reject')}>
              Reject
            </Button>
            <Button variant="primary" icon="check" busy={busy === 'accept'} disabled={busy !== null && busy !== 'accept'} onClick={() => void save('accept')}>
              Accept
            </Button>
          </div>
        </div>
        {confirmCancel && (
          <Notice
            variant="warn"
            title="Stop this run?"
            actions={
              <>
                <Button size="sm" onClick={() => setConfirmCancel(false)} disabled={busy === 'cancel'}>
                  Keep running
                </Button>
                <Button size="sm" variant="primary" busy={busy === 'cancel'} onClick={() => void cancel()}>
                  Stop and reject
                </Button>
              </>
            }
          >
            The agent stops within a few seconds and the run is recorded as rejected, with no notes. A follow-up question starts it again.
          </Notice>
        )}
        {status.kind !== 'idle' && <Notice variant={status.kind === 'ok' ? 'info' : 'error'}>{status.text}</Notice>}
      </form>
    </Panel>
  );
}

function FindingsList({
  findings,
  marks,
  onMark,
}: {
  findings: readonly FindingRef[];
  marks: FindingMarks;
  onMark: (id: string, verdict: 'correct' | 'wrong') => void;
}) {
  if (findings.length === 0) {
    return (
      <p className="hint" style={{ margin: 0 }}>
        No findings yet. They show here as investigators report them, and you can tick or cross each one.
      </p>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {groupFindings(findings).map((g) => (
        <div key={g.label}>
          <div className="muted" style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', margin: '0 0 6px' }}>
            {g.label}
          </div>
          {g.items.map((f) => {
            const mark = marks[f.id];
            return (
              <div key={f.id} className="runs-entry" style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                <div style={{ flexGrow: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14 }}>
                    <span className="muted" style={{ fontSize: 12 }}>
                      {FINDING_KIND_LABELS[f.kind]} ·{' '}
                    </span>
                    {f.text}
                  </div>
                  {f.detail !== undefined && (
                    <div className="mono muted" style={{ fontSize: 12, marginTop: 2, overflowWrap: 'anywhere' }}>
                      {f.detail}
                    </div>
                  )}
                </div>
                <div role="group" aria-label={`Verdict on ${f.id}`} style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                  <Button
                    size="sm"
                    variant={mark === 'correct' ? 'primary' : 'ghost'}
                    icon="check"
                    aria-pressed={mark === 'correct'}
                    title="Right"
                    onClick={() => onMark(f.id, 'correct')}
                  >
                    <span className="visually-hidden">Right</span>
                  </Button>
                  <Button
                    size="sm"
                    variant={mark === 'wrong' ? 'primary' : 'ghost'}
                    icon="x"
                    aria-pressed={mark === 'wrong'}
                    title="Wrong"
                    onClick={() => onMark(f.id, 'wrong')}
                  >
                    <span className="visually-hidden">Wrong</span>
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
