// A callout. restart is for catalog changes that agents only see after the
// server restarts.

import type { CSSProperties, ReactNode } from 'react';
import { Icon, type IconName } from './Icon.tsx';

export type NoticeVariant = 'info' | 'warn' | 'error' | 'restart';

const LOOK: Record<NoticeVariant, { bg: string; fg: string; icon: IconName }> = {
  info: { bg: 'var(--tone-info-bg)', fg: 'var(--tone-info-fg)', icon: 'info' },
  warn: { bg: 'var(--tone-amber-bg)', fg: 'var(--tone-amber-fg)', icon: 'alert' },
  error: { bg: 'var(--tone-rust-bg)', fg: 'var(--tone-rust-fg)', icon: 'alert' },
  restart: { bg: 'var(--tone-amber-bg)', fg: 'var(--tone-amber-fg)', icon: 'refresh' },
};

type Props = {
  variant?: NoticeVariant;
  title?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  style?: CSSProperties;
};

export function Notice({ variant = 'info', title, children, actions, style }: Props) {
  const look = LOOK[variant];
  return (
    <div
      role={variant === 'error' ? 'alert' : 'status'}
      style={{
        display: 'flex',
        gap: 10,
        alignItems: 'flex-start',
        padding: '12px 14px',
        borderRadius: 'var(--radius)',
        background: look.bg,
        color: 'var(--text)',
        fontSize: 13,
        lineHeight: 1.5,
        ...style,
      }}
    >
      <span style={{ color: look.fg, display: 'flex', paddingTop: 2 }}>
        <Icon name={look.icon} size={16} />
      </span>
      <div style={{ flexGrow: 1, minWidth: 0 }}>
        {title !== undefined && <div style={{ fontWeight: 600, color: look.fg }}>{title}</div>}
        {children !== undefined && <div>{children}</div>}
      </div>
      {actions !== undefined && <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>{actions}</div>}
    </div>
  );
}

/** The standard restart callout for catalog pages. */
export function RestartNotice({ children }: { children?: ReactNode }) {
  return (
    <Notice variant="restart" title="Restart needed">
      {children ?? 'Saved to disk. Agents pick up the change after the server restarts.'}
    </Notice>
  );
}
