// bootRuntime starts Flue once per process, and the source rules around it:
// the HTTP side never imports it, and nothing in src/ingress reads the deploy
// mode or the display label.
import { afterEach, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StartOptions } from '@flue/runtime/node';
import { Triage } from '../agents/triage.agent.ts';
import { bootRuntime, resetRuntimeForTests } from './runtime.ts';

const SRC = fileURLToPath(new URL('..', import.meta.url));
const REPO = join(SRC, '..');

afterEach(() => resetRuntimeForTests());

type FakeFlue = { stop(): Promise<void>; [Symbol.asyncDispose](): Promise<void> };

function fakeStart(calls: StartOptions[], fail = false) {
  return async (options: StartOptions): Promise<FakeFlue> => {
    calls.push(options);
    if (fail) throw new Error('start failed');
    return { stop: async () => {}, [Symbol.asyncDispose]: async () => {} };
  };
}

const DB = { kind: 'fake-adapter' } as unknown as NonNullable<StartOptions['db']>;

describe('bootRuntime', () => {
  test('start() is called once per process with Triage and the db adapter', async () => {
    const calls: StartOptions[] = [];
    let dbBuilt = 0;
    const opts = {
      start: fakeStart(calls),
      db: () => {
        dbBuilt += 1;
        return DB;
      },
    };
    const a = await bootRuntime(opts);
    const b = await bootRuntime(opts);
    const c = await bootRuntime();
    expect(a).toBe(b);
    expect(a).toBe(c);
    expect(calls).toHaveLength(1);
    expect(dbBuilt).toBe(1);
    expect(calls[0]?.agents).toEqual([Triage]);
    expect(calls[0]?.db).toBe(DB);
  });

  test('concurrent first calls share one start', async () => {
    const calls: StartOptions[] = [];
    const opts = { start: fakeStart(calls), db: () => DB };
    const [a, b] = await Promise.all([bootRuntime(opts), bootRuntime(opts)]);
    expect(a).toBe(b);
    expect(calls).toHaveLength(1);
  });

  test('a failed start is forgotten so the next call tries again', async () => {
    const calls: StartOptions[] = [];
    await expect(bootRuntime({ start: fakeStart(calls, true), db: () => DB })).rejects.toThrow('start failed');
    await bootRuntime({ start: fakeStart(calls), db: () => DB });
    expect(calls).toHaveLength(2);
  });
});

// ------------------------------------------------------------------ source rules

function tsFiles(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of entries) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...tsFiles(path));
    else if (name.endsWith('.ts')) out.push(path);
  }
  return out;
}

const isTest = (path: string) => path.endsWith('.test.ts');

describe('source rules', () => {
  test('bootRuntime is never imported by src/ingress/http or src/http', () => {
    const offenders: string[] = [];
    for (const file of [...tsFiles(join(SRC, 'ingress', 'http')), ...tsFiles(join(SRC, 'http'))]) {
      if (isTest(file)) continue;
      const text = readFileSync(file, 'utf8');
      if (/\bbootRuntime\b/.test(text) || /from\s+['"][^'"]*ingress\/runtime(\.ts)?['"]/.test(text) || /from\s+['"]\.\.?\/runtime(\.ts)?['"]/.test(text)) {
        offenders.push(relative(REPO, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  test('the grep sees an import when there is one', () => {
    const sample = "import { bootRuntime } from '../runtime.ts';";
    expect(/\bbootRuntime\b/.test(sample)).toBe(true);
    expect(/from\s+['"]\.\.?\/runtime(\.ts)?['"]/.test("import x from './runtime.ts';")).toBe(true);
  });

  test('no code in src/ingress reads the deploy mode or the display label', () => {
    const offenders: string[] = [];
    for (const file of tsFiles(join(SRC, 'ingress'))) {
      if (isTest(file)) continue;
      const text = readFileSync(file, 'utf8');
      if (/TRIAGE_DEPLOY_MODE|TRIAGE_ENV_LABEL|deployModeForPreflight|envLabel|DEPLOY_MODE_ENV/.test(text)) {
        offenders.push(relative(REPO, file));
      }
    }
    expect(offenders).toEqual([]);
    expect(tsFiles(join(SRC, 'ingress')).some((f) => f.endsWith('submit.ts'))).toBe(true);
  });
});
