import { useState } from 'react';
import { safeGet, safeSet } from '../../lib/storage.ts';

/** Shared by the new run, follow-up and feedback forms so the name is typed once per device. */
export const REQUESTED_BY_KEY = 'triage.requested_by';

/** The operator's name, remembered in localStorage as they type. */
export function useRememberedName(): [string, (name: string) => void] {
  const [name, setName] = useState(() => safeGet('local', REQUESTED_BY_KEY) ?? '');
  const update = (next: string) => {
    setName(next);
    safeSet('local', REQUESTED_BY_KEY, next.trim());
  };
  return [name, update];
}
