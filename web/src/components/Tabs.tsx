// Underlined tabs as in the wireframes. The caller renders the active panel.

import type { KeyboardEvent, ReactNode } from 'react';

export type TabItem<T extends string> = { id: T; label: ReactNode; count?: number };

type Props<T extends string> = {
  tabs: readonly TabItem<T>[];
  active: T;
  onChange: (id: T) => void;
  label: string;
};

export function Tabs<T extends string>({ tabs, active, onChange, label }: Props<T>) {
  const move = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const next = tabs[(index + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    if (next !== undefined) onChange(next.id);
  };
  return (
    <div role="tablist" aria-label={label} style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--line)', flexWrap: 'wrap' }}>
      {tabs.map((t, i) => {
        const on = t.id === active;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={on}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(t.id)}
            onKeyDown={(e) => move(e, i)}
            style={{
              height: 40,
              padding: '0 14px',
              marginBottom: -1,
              border: 0,
              background: 'none',
              font: 'inherit',
              fontSize: 14,
              cursor: 'pointer',
              borderBottom: `2px solid ${on ? 'var(--accent)' : 'transparent'}`,
              color: on ? 'var(--text)' : 'var(--muted)',
              fontWeight: on ? 600 : 400,
            }}
          >
            {t.label}
            {t.count !== undefined && (
              <span className="mono" style={{ fontSize: 12, color: 'var(--muted)', marginLeft: 6 }}>
                {t.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
