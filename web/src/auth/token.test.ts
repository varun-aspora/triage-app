import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { clearToken, getToken, saveToken, TOKEN_KEY } from './token.ts';

// Minimal Web Storage stand-ins; bun has no sessionStorage.
class MemoryStorage {
  private readonly map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v);
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
}

const g = globalThis as Record<string, unknown>;
let saved: { session: unknown; local: unknown };

function install(session: unknown, local: unknown): void {
  Object.defineProperty(g, 'sessionStorage', { value: session, configurable: true, writable: true });
  Object.defineProperty(g, 'localStorage', { value: local, configurable: true, writable: true });
}

beforeEach(() => {
  saved = { session: g.sessionStorage, local: g.localStorage };
  install(new MemoryStorage(), new MemoryStorage());
});

afterEach(() => install(saved.session, saved.local));

const session = () => g.sessionStorage as MemoryStorage;
const local = () => g.localStorage as MemoryStorage;

describe('token storage', () => {
  test('defaults to sessionStorage', () => {
    saveToken('t1', false);
    expect(session().getItem(TOKEN_KEY)).toBe('t1');
    expect(local().getItem(TOKEN_KEY)).toBeNull();
    expect(getToken()).toBe('t1');
  });

  test('remember uses localStorage and removes the session copy', () => {
    saveToken('t1', false);
    saveToken('t2', true);
    expect(session().getItem(TOKEN_KEY)).toBeNull();
    expect(local().getItem(TOKEN_KEY)).toBe('t2');
    expect(getToken()).toBe('t2');
  });

  test('not remembering removes a remembered copy', () => {
    saveToken('t2', true);
    saveToken('t3', false);
    expect(local().getItem(TOKEN_KEY)).toBeNull();
    expect(getToken()).toBe('t3');
  });

  test('clearToken removes both', () => {
    session().setItem(TOKEN_KEY, 'a');
    local().setItem(TOKEN_KEY, 'b');
    clearToken();
    expect(getToken()).toBeNull();
  });

  test('storage that throws or is missing reads as no token', () => {
    const broken = {
      getItem() {
        throw new Error('blocked');
      },
      setItem() {
        throw new Error('blocked');
      },
      removeItem() {
        throw new Error('blocked');
      },
    };
    install(broken, undefined);
    expect(() => saveToken('x', false)).not.toThrow();
    expect(getToken()).toBeNull();
    expect(() => clearToken()).not.toThrow();
  });
});
