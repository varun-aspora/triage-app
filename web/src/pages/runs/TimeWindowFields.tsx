// The time window on the new run form: quick ranges, then a from and a to
// field that take a local time or a relative expression (time-expr.ts). The
// fields keep the text as typed; buildStartBody resolves it at submit.

import { useEffect, useId, useRef, useState } from 'react';
import { FieldError, Hint, Input, Label } from '../../components/Field.tsx';
import { Icon } from '../../components/Icon.tsx';
import { formatDateTime } from '../../lib/format.ts';
import { RANGE_PRESETS, resolveTimeExpr, toDatetimeLocal } from './time-expr.ts';

type Props = {
  from: string;
  to: string;
  onFrom: (value: string) => void;
  onTo: (value: string) => void;
  error?: string;
};

/** How often the resolved-time previews move on while the form is open. */
const PREVIEW_TICK_MS = 30_000;

export function TimeWindowFields({ from, to, onFrom, onTo, error }: Props) {
  const now = useNow(PREVIEW_TICK_MS);
  const set = (f: string, t: string) => {
    onFrom(f);
    onTo(t);
  };
  return (
    <div>
      <Label optional>Time window</Label>
      <div className="runs-presets" role="group" aria-label="Quick time ranges">
        {RANGE_PRESETS.map((p) => (
          <button
            key={p.label}
            type="button"
            className="runs-preset"
            aria-pressed={from === p.from && to === p.to}
            onClick={() => set(p.from, p.to)}
          >
            {p.label}
          </button>
        ))}
        {(from !== '' || to !== '') && (
          <button type="button" className="runs-preset" onClick={() => set('', '')}>
            Clear
          </button>
        )}
      </div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <TimeField label="From" end="start" placeholder="now-1h" value={from} onChange={onFrom} now={now} shortcut={{ label: 'Start of day', value: 'now/d' }} />
        <TimeField label="To" end="end" placeholder="now" value={to} onChange={onTo} now={now} shortcut={{ label: 'Now', value: 'now' }} />
      </div>
      <p className="hint">Your local time, or relative to when the run starts: now, now-1h, now-1d, now/d (start of today). Set both ends or leave both empty.</p>
      {error !== undefined && <FieldError>{error}</FieldError>}
    </div>
  );
}

type FieldProps = {
  label: string;
  /** Names the window end in the calendar button's label. */
  end: 'start' | 'end';
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  now: number;
  shortcut: { label: string; value: string };
};

function TimeField({ label, end, placeholder, value, onChange, now, shortcut }: FieldProps) {
  const id = `t${useId()}`;
  const native = useRef<HTMLInputElement>(null);
  const resolved = resolveTimeExpr(value, now);
  const preview =
    value.trim() === ''
      ? ''
      : resolved === undefined
        ? 'Not a time this field reads'
        : `${formatDateTime(new Date(resolved).toISOString(), new Date(now))}${value.trim().startsWith('now') ? ', counted from when the run starts' : ''}`;

  const openCalendar = () => {
    const el = native.current;
    if (el === null) return;
    el.value = toDatetimeLocal(resolved ?? now);
    try {
      el.showPicker();
    } catch {
      el.focus();
    }
  };

  return (
    <div className="runs-grow">
      <label className="lbl" htmlFor={id} style={{ fontWeight: 400, color: 'var(--muted)' }}>
        {label}
      </label>
      <div className="runs-time-row">
        <Input
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          spellCheck={false}
          autoComplete="off"
          aria-describedby={`${id}-hint`}
          aria-invalid={value.trim() !== '' && resolved === undefined ? true : undefined}
        />
        <button type="button" className="runs-text-btn" onClick={openCalendar} aria-label={`Pick the ${end} from a calendar`} title="Pick from a calendar">
          <Icon name="calendar" size={16} />
        </button>
        <button type="button" className="runs-text-btn" onClick={() => onChange(shortcut.value)}>
          {shortcut.label}
        </button>
        <input
          ref={native}
          type="datetime-local"
          className="runs-time-native"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(e) => {
            if (e.target.value !== '') onChange(e.target.value.replace('T', ' '));
          }}
        />
      </div>
      {/* A non-breaking space keeps the row height while the field is empty. */}
      <Hint id={`${id}-hint`}>{preview === '' ? '\u00a0' : preview}</Hint>
    </div>
  );
}

function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}
