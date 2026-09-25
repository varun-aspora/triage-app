// The white card every page section sits in.

import type { CSSProperties, ReactNode } from 'react';

type Props = {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** false for tables that run edge to edge. Default true. */
  padded?: boolean;
  children?: ReactNode;
  style?: CSSProperties;
  as?: 'section' | 'div' | 'aside';
};

export function Panel({ title, description, actions, padded = true, children, style, as: Tag = 'section' }: Props) {
  const hasHead = title !== undefined || actions !== undefined;
  return (
    <Tag
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--line)',
        borderRadius: 'var(--radius-lg)',
        padding: padded ? 24 : 0,
        minWidth: 0,
        ...style,
      }}
    >
      {hasHead && (
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            gap: 16,
            margin: padded ? '0 0 14px' : 0,
            padding: padded ? 0 : '16px 16px 12px',
          }}
        >
          <div>
            {title !== undefined && <h2 style={{ fontSize: 16, fontWeight: 600 }}>{title}</h2>}
            {description !== undefined && <p className="hint" style={{ margin: '4px 0 0' }}>{description}</p>}
          </div>
          {actions !== undefined && <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>{actions}</div>}
        </div>
      )}
      {children}
    </Tag>
  );
}
