// Counts subprocess starts while a test runs, for code that must never spawn
// anything (git included). It wraps the child_process functions and, under
// Bun, Bun.spawn and Bun.spawnSync. The wrapped functions still go through
// the no-io guard, so a counted call to a denied binary also throws.
//
// src/ files may not import child_process (test/guards/no-child-process), so
// tests under src/ use this helper instead of spying on the module directly.
import childProcess from 'node:child_process';

const CHILD_PROCESS_FUNCTIONS = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const;
const BUN_FUNCTIONS = ['spawn', 'spawnSync'] as const;

export type SpawnSpy = {
  /** Names of the functions called so far, in order, e.g. 'child_process.spawn'. */
  calls(): readonly string[];
  /** Puts the original functions back. Safe to call twice. */
  restore(): void;
};

type Target = Record<string, unknown>;

export function spyOnSpawns(): SpawnSpy {
  const calls: string[] = [];
  const restores: (() => void)[] = [];

  const wrap = (target: Target, key: string, label: string) => {
    const original = target[key];
    if (typeof original !== 'function') return;
    const wrapped = function (this: unknown, ...args: unknown[]) {
      calls.push(label);
      return (original as (...a: unknown[]) => unknown).apply(this, args);
    };
    target[key] = wrapped;
    restores.push(() => {
      if (target[key] === wrapped) target[key] = original;
    });
  };

  for (const key of CHILD_PROCESS_FUNCTIONS) wrap(childProcess as unknown as Target, key, `child_process.${key}`);
  const bun = (globalThis as { Bun?: Target }).Bun;
  if (bun !== undefined) for (const key of BUN_FUNCTIONS) wrap(bun, key, `Bun.${key}`);

  let restored = false;
  return {
    calls: () => [...calls],
    restore() {
      if (restored) return;
      restored = true;
      for (const undo of restores.reverse()) undo();
    },
  };
}
