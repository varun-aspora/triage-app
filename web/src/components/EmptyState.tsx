import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon.tsx';

type Props = {
  icon?: IconName;
  title: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
};

export function EmptyState({ icon = 'search', title, children, actions }: Props) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', padding: '56px 24px 48px', gap: 12 }}>
      <span
        style={{
          width: 48,
          height: 48,
          borderRadius: 24,
          background: 'var(--tone-muted-bg)',
          color: 'var(--muted)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Icon name={icon} size={22} />
      </span>
      <h2 style={{ margin: '4px 0 0', fontSize: 18, fontWeight: 600 }}>{title}</h2>
      {children !== undefined && <div style={{ margin: 0, fontSize: 14, color: 'var(--muted)', maxWidth: 460, lineHeight: 1.5 }}>{children}</div>}
      {actions !== undefined && <div style={{ display: 'flex', gap: 12, marginTop: 12 }}>{actions}</div>}
    </div>
  );
}
