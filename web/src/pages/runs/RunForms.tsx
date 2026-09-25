// The follow-up and feedback forms, and the disabled Slack post panel.

import { type FormEvent, useState } from 'react';
import { ApiError } from '../../api/client.ts';
import { askRun, sendFeedback } from '../../api/endpoints.ts';
import type { FeedbackVerdict } from '../../api/types.ts';
import { Button } from '../../components/Button.tsx';
import { Field, Input, Textarea } from '../../components/Field.tsx';
import { describeError } from '../../components/LoadState.tsx';
import { Notice } from '../../components/Notice.tsx';
import { Panel } from '../../components/Panel.tsx';
import { FEEDBACK_VERDICTS } from '../../lib/constants.ts';
import { useRememberedName } from './remembered-name.ts';

const MAX_QUESTION = 4000;

type Status = { kind: 'idle' } | { kind: 'ok'; text: string } | { kind: 'error'; text: string };

export function AskForm({ runId, reports, onAsked }: { runId: string; reports: number; onAsked: () => void }) {
  const [question, setQuestion] = useState('');
  const [name, setName] = useRememberedName();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const q = question.trim();
    if (q === '' || name.trim() === '' || busy) {
      setStatus({ kind: 'error', text: q === '' ? 'Write a question first.' : 'Enter your name.' });
      return;
    }
    setBusy(true);
    setStatus({ kind: 'idle' });
    try {
      await askRun(runId, { question: q, requested_by: name.trim() });
      setQuestion('');
      setStatus({ kind: 'ok', text: 'Sent. The new report version shows here when it is ready; this page checks every few seconds.' });
      onAsked();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return;
      setStatus({ kind: 'error', text: err instanceof ApiError && err.status === 404 ? 'This run no longer exists.' : describeError(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel
      title="Ask a follow-up"
      description={`Runs again on the same evidence and adds a new report version. This run has ${reports}.`}
    >
      <form onSubmit={submit} noValidate style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Field label={<span className="visually-hidden">Question</span>}>
          <Textarea
            rows={3}
            maxLength={MAX_QUESTION}
            placeholder="e.g. Did the reversal reach the customer's NRE account?"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
          />
        </Field>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
          <Field label="Asked as" className="runs-grow">
            <Input placeholder="[your name]" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} style={{ maxWidth: 280 }} />
          </Field>
          <Button type="submit" variant="primary" busy={busy}>
            Ask
          </Button>
        </div>
        {status.kind !== 'idle' && <Notice variant={status.kind === 'ok' ? 'info' : 'error'}>{status.text}</Notice>}
      </form>
    </Panel>
  );
}

export function FeedbackForm({ runId, onSaved }: { runId: string; onSaved: () => void }) {
  const [verdict, setVerdict] = useState<FeedbackVerdict>('correct');
  const [rootCause, setRootCause] = useState('');
  const [fasterPath, setFasterPath] = useState('');
  const [name, setName] = useRememberedName();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (name.trim() === '') {
      setStatus({ kind: 'error', text: 'Enter your name.' });
      return;
    }
    setBusy(true);
    setStatus({ kind: 'idle' });
    try {
      const res = await sendFeedback(runId, {
        verdict,
        given_by: name.trim(),
        ...(rootCause.trim() !== '' ? { actual_root_cause: rootCause.trim() } : {}),
        ...(fasterPath.trim() !== '' ? { faster_path: fasterPath.trim() } : {}),
      });
      setStatus({ kind: 'ok', text: `Saved. This run has ${res.count} feedback ${res.count === 1 ? 'entry' : 'entries'}.` });
      setRootCause('');
      setFasterPath('');
      onSaved();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return;
      const text =
        err instanceof ApiError && err.status === 409
          ? 'The run has no report yet.'
          : err instanceof ApiError && err.status === 404
            ? 'This run no longer exists.'
            : describeError(err);
      setStatus({ kind: 'error', text });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title="Was this right?" description="Feedback trains the evals. The latest entry wins.">
      <form onSubmit={submit} noValidate style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div role="radiogroup" aria-label="Verdict" className="runs-row">
          {FEEDBACK_VERDICTS.map((v) => (
            <label key={v} className="runs-pill">
              <input type="radio" name={`verdict-${runId}`} checked={verdict === v} onChange={() => setVerdict(v)} />
              {v}
            </label>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <Field label="Actual root cause" optional className="runs-grow">
            <Textarea rows={2} placeholder="Only if the report got it wrong" value={rootCause} onChange={(e) => setRootCause(e.target.value)} />
          </Field>
          <Field label="Faster path" optional className="runs-grow">
            <Textarea rows={2} placeholder="Where it should have looked first" value={fasterPath} onChange={(e) => setFasterPath(e.target.value)} />
          </Field>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
          <Field label="Given by" className="runs-grow">
            <Input placeholder="[your name]" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} style={{ maxWidth: 280 }} />
          </Field>
          <Button type="submit" variant="primary" busy={busy}>
            Save feedback
          </Button>
        </div>
        {status.kind !== 'idle' && <Notice variant={status.kind === 'ok' ? 'info' : 'error'}>{status.text}</Notice>}
      </form>
    </Panel>
  );
}

export function SlackPostPanel() {
  return (
    <Panel>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 0', minWidth: 240 }}>
          <h2 style={{ fontSize: 16, fontWeight: 600 }}>Post to the Slack thread</h2>
          <p className="hint" style={{ margin: '4px 0 0' }}>
            Needs a signed Slack approval, which the server does not take over HTTP yet. Use <span className="mono">triage post</span> for
            now.
          </p>
        </div>
        <Button size="sm" disabled>
          Post to Slack
        </Button>
      </div>
    </Panel>
  );
}
