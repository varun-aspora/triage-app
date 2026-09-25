import { useEffect } from 'react';
import { useTheme } from '../theme/theme.ts';

/** Sets the tab title; production tabs say so, so they are easy to tell apart. */
export function usePageTitle(title: string): void {
  const { env } = useTheme();
  useEffect(() => {
    document.title = env === 'production' ? `${title} — PRODUCTION` : title;
  }, [title, env]);
}
