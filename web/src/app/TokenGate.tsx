// Asks for the API bearer token before anything else talks to the API.
//
// On load: no stored token shows the prompt; a stored one is checked with
// GET /ui/session. A typed token is checked the same way and stored only when
// the server accepts it. Any 401 later (client.ts clears the token) brings the
// prompt back.

import { type FormEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, onUnauthorized } from '../api/client.ts';
import { getSession } from '../api/endpoints.ts';
import type { Session } from '../api/types.ts';
import { clearToken, getToken, saveToken } from '../auth/token.ts';
import { Button } from '../components/Button.tsx';
import { Checkbox, Field, Input } from '../components/Field.tsx';
import { Icon } from '../components/Icon.tsx';
import { Loading } from '../components/LoadState.tsx';
import { Notice } from '../components/Notice.tsx';
import { usePageTitle } from '../lib/usePageTitle.ts';
import { EnvBanner } from './EnvBanner.tsx';
import { SessionContext, type SessionValue } from './session.ts';

export const MESSAGES = {
  rejected: 'That token was not accepted.',
  expired: 'Your token stopped working. Enter it again.',
  signedOut: 'Signed out.',
  notConfigured: 'The server has no token configured.',
} as const;

type GateState =
  | { kind: 'checking' }
  | { kind: 'prompt'; message?: string; tone?: 'info' | 'error' }
  | { kind: 'ready'; session: Session };

export function TokenGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<GateState>(() => (getToken() === null ? { kind: 'prompt' } : { kind: 'checking' }));
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    if (state.kind !== 'checking') return;
    const controller = new AbortController();
    getSession(undefined, { signal: controller.signal }).then(
      (session) => setState({ kind: 'ready', session }),
      (err: unknown) => {
        if (controller.signal.aborted) return;
        setState({ kind: 'prompt', message: messageFor(err), tone: 'error' });
      },
    );
    return () => controller.abort();
  }, [state.kind]);

  useEffect(
    () =>
      onUnauthorized(() => {
        // While checking, the check's own handler shows the message.
        if (stateRef.current.kind === 'ready') setState({ kind: 'prompt', message: MESSAGES.expired, tone: 'error' });
      }),
    [],
  );

  const signOut = useCallback(() => {
    clearToken();
    setState({ kind: 'prompt', message: MESSAGES.signedOut, tone: 'info' });
  }, []);

  const value = useMemo<SessionValue | null>(
    () => (state.kind === 'ready' ? { session: state.session, signOut } : null),
    [state, signOut],
  );

  if (state.kind === 'checking') {
    return (
      <GateFrame>
        <Loading label="Checking the token…" />
      </GateFrame>
    );
  }
  if (state.kind === 'prompt' || value === null) {
    return (
      <TokenPrompt
        message={state.kind === 'prompt' ? state.message : undefined}
        tone={state.kind === 'prompt' ? state.tone : undefined}
        onAccepted={(session) => setState({ kind: 'ready', session })}
      />
    );
  }
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

function messageFor(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401) return MESSAGES.rejected;
    if (err.status === 503) return MESSAGES.notConfigured;
    return err.body.error;
  }
  return 'Could not reach the server.';
}

function GateFrame({ children }: { children: ReactNode }) {
  return (
    <div style={{ minHeight: '100%', display: 'flex', flexDirection: 'column' }}>
      <EnvBanner />
      <main style={{ flexGrow: 1, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '12vh 16px 32px' }}>
        {children}
      </main>
    </div>
  );
}

function TokenPrompt({
  message,
  tone,
  onAccepted,
}: {
  message?: string;
  tone?: 'info' | 'error';
  onAccepted: (session: Session) => void;
}) {
  usePageTitle('Enter the API token');
  const [token, setToken] = useState('');
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const entered = token.trim();
    if (entered === '') {
      setError('Enter the token.');
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const session = await getSession(entered);
      saveToken(entered, remember);
      setToken('');
      onAccepted(session);
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setBusy(false);
    }
  };

  // A fresh error from this form replaces the message the prompt opened with.
  const shown = error ?? message;
  const shownTone = error !== undefined ? 'error' : (tone ?? 'info');

  return (
    <GateFrame>
      <form
        onSubmit={submit}
        noValidate
        style={{
          width: '100%',
          maxWidth: 420,
          background: 'var(--surface)',
          border: '1px solid var(--line)',
          borderRadius: 'var(--radius-lg)',
          padding: 28,
          display: 'flex',
          flexDirection: 'column',
          gap: 18,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span style={{ fontSize: 18, fontWeight: 600, letterSpacing: '-0.01em' }}>triage</span>
          <span className="mono muted" style={{ fontSize: 12 }}>
            console
          </span>
        </div>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icon name="lock" size={18} />
            Enter the API token
          </h1>
          <p className="muted" style={{ margin: '6px 0 0', fontSize: 14 }}>
            Every request to this server needs its bearer token (<span className="mono">TRIAGE_HTTP_AUTH_TOKEN</span>).
          </p>
        </div>
        {shown !== undefined && <Notice variant={shownTone === 'error' ? 'error' : 'info'}>{shown}</Notice>}
        <Field label="Token">
          <Input
            type="password"
            name="token"
            autoComplete="off"
            spellCheck={false}
            autoFocus
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
        </Field>
        <Checkbox label="Remember on this device" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
        <p className="hint" style={{ margin: '-10px 0 0' }}>
          {remember ? 'Kept in this browser until you sign out.' : 'Kept until this tab closes.'}
        </p>
        <Button type="submit" variant="primary" busy={busy}>
          Continue
        </Button>
      </form>
    </GateFrame>
  );
}
