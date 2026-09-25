// A two-or-more option switch, such as Auto / Choose on the new run form.

import type { CSSProperties } from 'react';

export type SegmentedOption<T extends string> = { value: T; label: string };

type Props<T extends string> = {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Names the group for screen readers. */
  label: string;
  disabled?: boolean;
};

const group: CSSProperties = {
  display: 'inline-flex',
  padding: 2,
  gap: 2,
  borderRadius: 8,
  background: 'var(--tone-muted-bg)',
  border: '1px solid var(--line)',
};

export function Segmented<T extends string>({ options, value, onChange, label, disabled = false }: Props<T>) {
  return (
    <div role="radiogroup" aria-label={label} style={group}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={disabled}
            onClick={() => onChange(o.value)}
            style={{
              height: 30,
              padding: '0 14px',
              border: 0,
              borderRadius: 6,
              font: 'inherit',
              fontSize: 13,
              fontWeight: on ? 600 : 500,
              cursor: disabled ? 'not-allowed' : 'pointer',
              background: on ? 'var(--surface)' : 'transparent',
              color: on ? 'var(--text)' : 'var(--muted)',
              boxShadow: on ? '0 0 0 1px var(--line)' : 'none',
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
