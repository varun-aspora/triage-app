// Small pieces shared by the catalog pages only.

import type { ReactNode } from 'react';
import { Icon } from '../../components/Icon.tsx';
import { Input } from '../../components/Field.tsx';

export type CheckState = 'ok' | 'warn' | 'fail';
export type CheckLine = { state: CheckState; text: ReactNode };

const CHECK_LOOK: Record<CheckState, { color: string; icon: 'check' | 'alert' | 'x' }> = {
  ok: { color: 'var(--accent)', icon: 'check' },
  warn: { color: 'var(--tone-amber-fg)', icon: 'alert' },
  fail: { color: 'var(--tone-rust-fg)', icon: 'x' },
};

export function CheckList({ items }: { items: readonly CheckLine[] }) {
  if (items.length === 0) return null;
  return (
    <ul style={{ listStyle: 'none', margin: '0 0 12px', padding: 0 }}>
      {items.map((item, i) => {
        const look = CHECK_LOOK[item.state];
        return (
          <li key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13, lineHeight: 1.45, padding: '0 0 8px' }}>
            <span style={{ color: look.color, display: 'flex', paddingTop: 1 }}>
              <Icon name={look.icon} size={16} />
              <span className="visually-hidden">{item.state === 'ok' ? 'OK: ' : item.state === 'warn' ? 'Warning: ' : 'Problem: '}</span>
            </span>
            <span>{item.text}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** The dark file preview block from the wireframes. */
export function CodePreview({ children, label }: { children: string; label?: string }) {
  return (
    <pre
      aria-label={label}
      style={{
        padding: '14px 16px',
        background: '#1c1e22',
        color: '#e8e6e1',
        borderRadius: 'var(--radius)',
        fontSize: 12,
        lineHeight: 1.6,
        overflowX: 'auto',
      }}
    >
      {children}
    </pre>
  );
}

export function SearchInput({
  id,
  value,
  onChange,
  placeholder,
  width = 360,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  width?: number;
}) {
  return (
    <div style={{ width, maxWidth: '100%', flexShrink: 0 }}>
      <label className="lbl" htmlFor={id}>
        Search
      </label>
      <div style={{ position: 'relative' }}>
        <span style={{ position: 'absolute', left: 12, top: 12, color: 'var(--muted)', display: 'flex' }}>
          <Icon name="search" />
        </span>
        <Input id={id} type="search" placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} style={{ paddingLeft: 36 }} />
      </div>
    </div>
  );
}

/** Two columns: the form, and a side panel that drops below it on narrow screens. */
export function FormLayout({ main, side, sideWidth = 400 }: { main: ReactNode; side: ReactNode; sideWidth?: number }) {
  return (
    <div style={{ display: 'flex', gap: 24, alignItems: 'flex-start', flexWrap: 'wrap' }}>
      <div style={{ flex: '1 1 480px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 16 }}>{main}</div>
      <div style={{ flex: `0 1 ${sideWidth}px`, minWidth: 280, position: 'sticky', top: 24 }}>{side}</div>
    </div>
  );
}

export function Dash() {
  return <span className="faint">—</span>;
}
