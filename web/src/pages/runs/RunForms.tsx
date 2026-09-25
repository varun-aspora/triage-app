// The follow-up form and the disabled Slack post panel. The verdict panel is in RunVerdict.tsx.

import { type FormEvent, useState } from 'react';
import { ApiError } from '../../api/client.ts';
import { askRun } from '../../api/endpoints.ts';
import { Button } from '../../components/Button.tsx';
import { Field, Input, Textarea } from '../../components/Field.tsx';
import { describeError } from '../../components/LoadState.tsx';
import { Notice } from '../../components/Notice.tsx';
import { Panel } from '../../components/Panel.tsx';
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
