// Environment colours, from TRIAGE_UI_ENV via the public /ui/config.json.
// Red means production; green means anything else. Status tags never use
// these colours (see lib/status.ts).

import { createContext, useContext } from 'react';
import type { UiEnv } from '../api/types.ts';

export type Theme = {
  readonly name: string;
  readonly accent: string;
  readonly soft: string;
  readonly sidebar: string;
  /** Shown in the banner next to the name. */
  readonly note?: string;
};

export const THEMES: Readonly<Record<UiEnv, Theme>> = {
  production: {
    name: 'PRODUCTION',
    accent: '#b42335',
    soft: '#fbeaec',
    sidebar: '#f3e4e6',
    note: 'Real customer data. Every read is audited.',
  },
  'non-production': { name: 'NON-PRODUCTION', accent: '#1e7a4c', soft: '#e6f3ec', sidebar: '#e2eee7' },
};

export function applyTheme(env: UiEnv): void {
  const theme = THEMES[env];
  const root = document.documentElement;
  root.style.setProperty('--accent', theme.accent);
  root.style.setProperty('--accent-soft', theme.soft);
  root.style.setProperty('--sidebar', theme.sidebar);
  root.dataset.env = env;
}

export type ThemeValue = { readonly env: UiEnv; readonly theme: Theme };

export const ThemeContext = createContext<ThemeValue>({ env: 'non-production', theme: THEMES['non-production'] });

export function useTheme(): ThemeValue {
  return useContext(ThemeContext);
}
