// bootRuntime starts Flue once per process, installs tracing when the config
// turns it on, and the source rules around it: the HTTP side never imports
// it, and nothing in src/ingress reads the deploy mode or the display label.
import { afterEach, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StartOptions } from '@flue/runtime/node';
import { Triage } from '../agents/triage.agent.ts';
import type { Config } from '../config/env.ts';
import type { RunRecord, RunStore } from '../runstore/types.ts';
import type { InstallOptions, TraceRoot } from '../tracing/braintrust.ts';
import { makeTestHome, type TestHome } from '../../test/support/home.ts';
import { bootRuntime, resetRuntimeForTests, traceRootRecorder } from './runtime.ts';

const SRC = fileURLToPath(new URL('..', import.meta.url));
const REPO = join(SRC, '..');

const homes: TestHome[] = [];
const savedHome = process.env.TRIAGE_HOME;

afterEach(() => {
  resetRuntimeForTests();
  for (const h of homes.splice(0)) h.cleanup();
  if (savedHome === undefined) delete process.env.TRIAGE_HOME;
  else process.env.TRIAGE_HOME = savedHome;
});

/** A test home with tracing on (a fake key; nothing here reaches Braintrust), set as TRIAGE_HOME. */
function tracingHome(): TestHome {
  const home = makeTestHome({ overrides: { TRIAGE_BRAINTRUST_ENABLED: 'true', BRAINTRUST_API_KEY: 'fake-braintrust-key-0001' } });
  homes.push(home);
  process.env.TRIAGE_HOME = home.home;
  return home;
}

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
      eventLog: false as const,
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
    const opts = { start: fakeStart(calls), db: () => DB, eventLog: false as const };
    const [a, b] = await Promise.all([bootRuntime(opts), bootRuntime(opts)]);
    expect(a).toBe(b);
    expect(calls).toHaveLength(1);
  });

  test('a failed start is forgotten so the next call tries again', async () => {
    const calls: StartOptions[] = [];
    await expect(bootRuntime({ start: fakeStart(calls, true), db: () => DB, eventLog: false as const })).rejects.toThrow('start failed');
    await bootRuntime({ start: fakeStart(calls), db: () => DB, eventLog: false as const });
    expect(calls).toHaveLength(2);
  });

  test('the model check runs once, before start()', async () => {
    const order: string[] = [];
    const opts = {
      start: async (options: StartOptions) => {
        order.push('start');
        return fakeStart([])(options);
      },
      db: () => DB,
      eventLog: false as const,
      ensureModels: async () => {
        order.push('models');
      },
    };
    await bootRuntime(opts);
    await bootRuntime(opts);
    expect(order).toEqual(['models', 'start']);
  });
});

describe('bootRuntime tracing (D82)', () => {
  function recordingInstall(order: string[], seen: { config?: Config; options?: InstallOptions }[]) {
    return async (config: Pick<Config, 'tracing'>, options?: InstallOptions): Promise<void> => {
      order.push('tracing');
      seen.push({ config: config as Config, ...(options !== undefined ? { options } : {}) });
    };
  }

  test('installs tracing with the loaded config and a root span recorder, before start()', async () => {
    tracingHome();
    const order: string[] = [];
    const seen: { config?: Config; options?: InstallOptions }[] = [];
    await bootRuntime({
      start: async (o) => (order.push('start'), fakeStart([])(o)),
      db: () => DB,
      eventLog: false,
      usageMeter: false,
      settleListener: false,
      ensureModels: async () => {},
      installTracing: recordingInstall(order, seen),
    });
    expect(order).toEqual(['tracing', 'start']);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.config?.tracing).toMatchObject({ enabled: true, projectName: 'triage-app', content: 'metadata' });
    expect(typeof seen[0]?.options?.onRootSpan).toBe('function');
  });

  test('braintrust: false leaves tracing off', async () => {
    tracingHome();
    const order: string[] = [];
    await bootRuntime({
      start: fakeStart([]),
      db: () => DB,
      eventLog: false,
      usageMeter: false,
      settleListener: false,
      ensureModels: async () => {},
      braintrust: false,
      installTracing: recordingInstall(order, []),
    });
    expect(order).toEqual([]);
  });

  test('a config that does not load leaves tracing off and still starts', async () => {
    delete process.env.TRIAGE_HOME;
    const order: string[] = [];
    const calls: StartOptions[] = [];
    await bootRuntime({
      start: fakeStart(calls),
      db: () => DB,
      eventLog: false,
      usageMeter: false,
      settleListener: false,
      ensureModels: async () => {},
      installTracing: recordingInstall(order, []),
    });
    expect(order).toEqual([]);
    expect(calls).toHaveLength(1);
  });
});

describe('traceRootRecorder', () => {
  const RUN = '01J8ZQ7XK3PSEDRMNABCDEFGH1';
  // A ULID-style Flue submission id with a long digit run: matched as stored, never redacted.
  const ROOT: TraceRoot = { runId: RUN, flueSubmissionId: 'sub_01M3EN7034701234ABCDEFGH', spanId: '0123456789abcdef', rootSpanId: 'f'.repeat(32) };

  type Write = { runId: string; seq: number; spanId: string };

  /** getRun returns each listed submission set in turn, the last one from then on. */
  function fakeStore(views: (readonly { seq: number; flue_submission_id?: string }[] | null | Error)[]) {
    const writes: Write[] = [];
    let reads = 0;
    const store = {
      getRun: async () => {
        const view = views[Math.min(reads++, views.length - 1)];
        if (view instanceof Error) throw view;
        return view === null ? null : ({ submissions: view } as unknown as RunRecord);
      },
      setSubmissionTraceSpanId: async (runId: string, seq: number, spanId: string) => void writes.push({ runId, seq, spanId }),
    } as unknown as RunStore;
    return { store, writes, reads: () => reads };
  }

  test('writes the span id to the submission with that Flue id', async () => {
    const f = fakeStore([[{ seq: 1, flue_submission_id: 'sub_other' }, { seq: 2, flue_submission_id: ROOT.flueSubmissionId }]]);
    await traceRootRecorder(() => f.store, { retryMs: [] })(ROOT);
    expect(f.writes).toEqual([{ runId: RUN, seq: 2, spanId: ROOT.spanId }]);
  });

  test('retries while ingress has not written the Flue id yet', async () => {
    const f = fakeStore([[{ seq: 1 }], [{ seq: 1 }], [{ seq: 1, flue_submission_id: ROOT.flueSubmissionId }]]);
    await traceRootRecorder(() => f.store, { retryMs: [0, 0, 0] })(ROOT);
    expect(f.reads()).toBe(3);
    expect(f.writes).toEqual([{ runId: RUN, seq: 1, spanId: ROOT.spanId }]);
  });

  test('gives up after the retries, and on a run that is gone, without writing', async () => {
    const never = fakeStore([[{ seq: 1 }]]);
    await traceRootRecorder(() => never.store, { retryMs: [0, 0] })(ROOT);
    expect(never.reads()).toBe(3);
    expect(never.writes).toEqual([]);

    const gone = fakeStore([null]);
    await traceRootRecorder(() => gone.store, { retryMs: [0, 0] })(ROOT);
    expect(gone.reads()).toBe(1);
    expect(gone.writes).toEqual([]);
  });

  test('never rejects: a store error, a store that cannot be built, or a bad run id', async () => {
    const failing = fakeStore([new Error('connection lost')]);
    await expect(traceRootRecorder(() => failing.store, { retryMs: [] })(ROOT)).resolves.toBeUndefined();
    const unbuilt = () => {
      throw new Error('no config');
    };
    await expect(traceRootRecorder(unbuilt, { retryMs: [] })(ROOT)).resolves.toBeUndefined();
    const ok = fakeStore([[{ seq: 1, flue_submission_id: ROOT.flueSubmissionId }]]);
    await traceRootRecorder(() => ok.store, { retryMs: [] })({ ...ROOT, runId: '../etc' });
    expect(ok.reads()).toBe(0);
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
