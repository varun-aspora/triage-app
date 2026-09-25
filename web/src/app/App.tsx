// Loads the public theme first, so even the token prompt shows the right
// environment colour, then gates everything else behind the token.

import { useEffect, useMemo, useState } from 'react';
import { RouterProvider } from 'react-router';
import { getUiConfig } from '../api/endpoints.ts';
import type { UiEnv } from '../api/types.ts';
import { Button } from '../components/Button.tsx';
import { describeError, Loading } from '../components/LoadState.tsx';
import { Notice } from '../components/Notice.tsx';
import { applyTheme, THEMES, ThemeContext } from '../theme/theme.ts';
import { router } from './router.tsx';
import { TokenGate } from './TokenGate.tsx';

type Boot = { kind: 'loading' } | { kind: 'error'; error: unknown } | { kind: 'ready'; env: UiEnv };

export function App() {
  const [boot, setBoot] = useState<Boot>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    getUiConfig({ signal: controller.signal }).then(
      (config) => {
        // Anything unexpected is treated as production: the stricter look is the safer mistake.
        const env: UiEnv = config.env === 'non-production' ? 'non-production' : 'production';
        applyTheme(env);
        setBoot({ kind: 'ready', env });
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setBoot({ kind: 'error', error });
      },
    );
    return () => controller.abort();
  }, [attempt]);

  const theme = useMemo(() => (boot.kind === 'ready' ? { env: boot.env, theme: THEMES[boot.env] } : null), [boot]);

  if (boot.kind === 'loading') return <Loading label="Loading the console…" />;
  if (boot.kind === 'error' || theme === null) {
    // No theme yet, so no environment colour: never guess it.
    return (
      <div style={{ maxWidth: 520, margin: '12vh auto', padding: '0 16px' }}>
        <Notice
          variant="error"
          title="Could not reach the server"
          actions={
            <Button
              size="sm"
              icon="refresh"
              onClick={() => {
                setBoot({ kind: 'loading' });
                setAttempt((n) => n + 1);
              }}
            >
              Retry
            </Button>
          }
        >
          {boot.kind === 'error' ? describeError(boot.error) : null}
        </Notice>
      </div>
    );
  }
  return (
    <ThemeContext.Provider value={theme}>
      <TokenGate>
        <RouterProvider router={router} />
      </TokenGate>
    </ThemeContext.Provider>
  );
}
