// The API bearer token, kept in the browser only. sessionStorage by default
// so it goes when the tab closes; localStorage when the operator ticks
// "Remember on this device". It is only ever sent in the Authorization header.

import { safeGet, safeRemove, safeSet } from '../lib/storage.ts';

export const TOKEN_KEY = 'triage.token';

export function getToken(): string | null {
  const token = safeGet('session', TOKEN_KEY) ?? safeGet('local', TOKEN_KEY);
  return token === null || token === '' ? null : token;
}

export function saveToken(token: string, remember: boolean): void {
  if (remember) {
    safeSet('local', TOKEN_KEY, token);
    safeRemove('session', TOKEN_KEY);
  } else {
    safeSet('session', TOKEN_KEY, token);
    safeRemove('local', TOKEN_KEY);
  }
}

export function clearToken(): void {
  safeRemove('session', TOKEN_KEY);
  safeRemove('local', TOKEN_KEY);
}
