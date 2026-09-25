// Web Storage can throw (private mode, blocked site data) or be missing
// entirely, so every access goes through these and fails soft.

export type StorageKind = 'session' | 'local';

function store(kind: StorageKind): Storage | undefined {
  try {
    return kind === 'session' ? globalThis.sessionStorage : globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function safeGet(kind: StorageKind, key: string): string | null {
  try {
    return store(kind)?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function safeSet(kind: StorageKind, key: string, value: string): boolean {
  try {
    const s = store(kind);
    if (s === undefined) return false;
    s.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function safeRemove(kind: StorageKind, key: string): void {
  try {
    store(kind)?.removeItem(key);
  } catch {
    // Nothing to clean up if storage is unavailable.
  }
}
