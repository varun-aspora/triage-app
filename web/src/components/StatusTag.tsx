// A status chip: a neutral, muted, amber, rust or info tone plus an icon, so
// the state reads without colour. Never uses the environment accent.

import type { ReactNode } from 'react';
import type { StatusIcon, StatusLook, Tone } from '../lib/status.ts';
import { Icon } from './Icon.tsx';

type Props = {
  tone?: Tone;
  icon?: StatusIcon | null;
  /** Shortcut for tone + icon from lib/status.ts. */
  look?: StatusLook;
  children: ReactNode;
  title?: string;
};

export function StatusTag({ tone, icon, look, children, title }: Props) {
  const t = tone ?? look?.tone ?? 'neutral';
  const i = icon === null ? null : (icon ?? look?.icon ?? null);
  return (
    <span className={`chip tone-${t}`} title={title}>
      {i !== null && <Icon name={i} size={12} className={i === 'spinner' ? 'spin' : undefined} />}
      {children}
    </span>
  );
}

/** A plain chip with no icon, for categories, tiers and entity names. */
export function Chip({ children, tone = 'neutral', mono = false }: { children: ReactNode; tone?: Tone; mono?: boolean }) {
  return <span className={`chip tone-${tone}${mono ? ' mono' : ''}`}>{children}</span>;
}
