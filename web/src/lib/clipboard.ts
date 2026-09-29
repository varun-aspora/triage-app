import { useEffect, useState } from 'react';

/**
 * Copies text. navigator.clipboard needs a secure context, and the console
 * may be served over plain http inside the network, so fall back to the
 * older execCommand path.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard !== undefined && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the textarea path.
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.append(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

export type CopyState = 'idle' | 'ok' | 'fail';

/** Copies text on demand; the state says how the last copy went and goes back to idle after 2s. */
export function useCopy(text: string): [CopyState, () => void] {
  const [state, setState] = useState<CopyState>('idle');
  useEffect(() => {
    if (state === 'idle') return;
    const t = setTimeout(() => setState('idle'), 2000);
    return () => clearTimeout(t);
  }, [state]);
  return [state, () => void copyText(text).then((ok) => setState(ok ? 'ok' : 'fail'))];
}
