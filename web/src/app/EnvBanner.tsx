// Full-width strip in the environment colour, on every screen including the
// token prompt.

import type { Session } from '../api/types.ts';
import { bannerNote, useTheme } from '../theme/theme.ts';

/** Without a session (the token prompt) only the environment is shown. */
export function EnvBanner({ session }: { session?: Session }) {
  const { theme } = useTheme();
  const note = bannerNote(theme, session);
  return (
    <div
      role="status"
      aria-label={`Environment: ${theme.name}`}
      style={{
        minHeight: 36,
        flexShrink: 0,
        padding: '0 20px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 16,
        background: 'var(--accent)',
        color: '#ffffff',
        fontSize: 13,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ width: 8, height: 8, borderRadius: 4, background: '#ffffff' }} />
        <span style={{ fontWeight: 600, letterSpacing: '0.08em' }}>{theme.name}</span>
      </div>
      {note !== undefined && <span>{note}</span>}
    </div>
  );
}
