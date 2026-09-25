import { createContext, useContext } from 'react';
import type { Session } from '../api/types.ts';

export type SessionValue = {
  readonly session: Session;
  /** Forgets the stored token and shows the prompt. */
  signOut(): void;
};

export const SessionContext = createContext<SessionValue | null>(null);

/** The verified session. Only usable inside TokenGate, which renders children only once the token is accepted. */
export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (value === null) throw new Error('useSession used outside TokenGate');
  return value;
}
