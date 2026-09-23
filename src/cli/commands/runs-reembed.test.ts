// triage runs reembed, run through buildProgram and runCli with a test home
// (mock mode forced on), fake io and a fetch spy. No real .env is read and
// nothing reaches the network.

import { afterEach, describe, expect, test } from 'bun:test';
import { Readable } from 'node:stream';
import { makeTestHome, type TestHome } from '../../../test/support/home.ts';
import { redactPersisted } from '../../gate/redact.ts';
import { RUN_A, RUN_B, RUN_C, SYNTHETIC_PHONE, sampleClassification, sampleReport, sampleRequest } from '../../runstore/contract.ts';
import { embedRun } from '../../runstore/embed-run.ts';
import { createEmbedder, HASH_MODEL } from '../../embed/index.ts';
import { createRunStore } from '../../runstore/index.ts';
import type { RunStore } from '../../runstore/types.ts';
import { commands as generatedCommands } from '../command-modules.gen.ts';
import { buildProgram, runCli } from '../index.ts';
import { EXIT } from '../output.ts';
import type { CliCommand, CliContext } from '../types.ts';
import { command, createRunsReembedCommand, type RunsReembedOptions } from './runs-reembed.command.ts';

const homes: TestHome[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) h.cleanup();
});

const EMBEDDING = 'ollama/nomic-embed-text';

function home(embedding = EMBEDDING): TestHome {
  const h = makeTestHome({ overrides: { MODEL_EMBEDDING: embedding } });
  homes.push(h);
  return h;
}

type FetchSpy = { count: number; fetch: (url: string, init: RequestInit) => Promise<Response> };

function fetchSpy(): FetchSpy {
  const spy: FetchSpy = {
    count: 0,
    fetch: async () => {
      spy.count++;
      throw new Error('fetch must not be called in mock mode');
    },
  };
  return spy;
}

async function seed(h: TestHome, ids: readonly string[]): Promise<RunStore> {
  const store = await createRunStore(h.config);
  for (const id of ids) {
    await store.createRun(id, redactPersisted(sampleRequest(id)));
    await store.putClassification(id, redactPersisted(sampleClassification()));
    const seq = await store.addSubmission(id, redactPersisted({ kind: 'initial' as const }));
    await store.putReport(id, seq, redactPersisted(sampleReport(id, 'the payout is waiting on the bank')), redactPersisted('# r'));
  }
  return store;
}

type Run = { code: number; out: string; err: string };

async function reembedCli(h: TestHome, argv: string[], cmd: CliCommand): Promise<Run> {
  let out = '';
  let err = '';
  const ctx: CliContext = {
    config: () => h.config,
    io: {
      stdout: { write: (s: string) => (out += s) },
      stderr: { write: (s: string) => (err += s) },
      stdin: Readable.from([]),
      isTTY: false,
    },
    deps: {},
  };
  const code = await runCli(buildProgram([cmd], ctx), ['runs', 'reembed', ...argv]);
  return { code, out, err };
}

function cmdWith(spy: FetchSpy, extra: Omit<RunsReembedOptions, 'fetch'> = {}): CliCommand {
  return createRunsReembedCommand({ fetch: spy.fetch, ...extra });
}

describe('registration', () => {
  test('exports command at runs reembed and the generated list picks it up', () => {
    expect(command.path).toEqual(['runs', 'reembed']);
    const paths = (generatedCommands as readonly CliCommand[]).map((c) => c.path.join(' '));
    expect(paths).toContain('runs reembed');
  });
});

describe('runs reembed', () => {
  test('with --json prints counts only', async () => {
    const h = home();
    await seed(h, [RUN_A, RUN_B]);
    const spy = fetchSpy();
    const r = await reembedCli(h, ['--json'], cmdWith(spy));
    expect(r.code).toBe(EXIT.OK);
    expect(r.err).toBe('');
    const lines = r.out.trim().split('\n');
    expect(lines).toHaveLength(1);
    const body = JSON.parse(lines[0] as string);
    expect(Object.keys(body).sort()).toEqual(['embedded', 'failed', 'runs', 'skipped', 'unchanged']);
    expect(Object.values(body).every((n) => typeof n === 'number')).toBe(true);
    expect(body).toEqual({ runs: 2, embedded: 2, unchanged: 0, skipped: 0, failed: 0 });
    for (const leak of [RUN_A, RUN_B, 'transfer', HASH_MODEL, EMBEDDING, h.home]) expect(r.out).not.toContain(leak);
    expect(spy.count).toBe(0);
  });

  test('--missing only embeds runs without a row for the current model', async () => {
    const h = home();
    const store = await seed(h, [RUN_A, RUN_B, RUN_C]);
    const embedder = createEmbedder(h.config, { fetch: fetchSpy().fetch });
    await embedRun(store, embedder, RUN_B);

    const spy = fetchSpy();
    const r = await reembedCli(h, ['--missing', '--json'], cmdWith(spy));
    expect(r.code).toBe(EXIT.OK);
    expect(JSON.parse(r.out)).toEqual({ runs: 3, embedded: 2, unchanged: 0, skipped: 1, failed: 0 });
    for (const id of [RUN_A, RUN_B, RUN_C]) {
      const rows = (await store.getRun(id))?.embeddings ?? [];
      expect(rows.map((e) => e.kind).sort()).toEqual(['case', 'request']);
      expect(rows.every((e) => e.model === HASH_MODEL)).toBe(true);
    }
    expect(spy.count).toBe(0);
  });

  test('human output is one counts line', async () => {
    const h = home();
    await seed(h, [RUN_A]);
    const r = await reembedCli(h, [], cmdWith(fetchSpy()));
    expect(r.code).toBe(EXIT.OK);
    expect(r.out).toBe('runs 1, embedded 1, unchanged 0, skipped 0, failed 0\n');
  });

  test('the default command makes no fetch call in mock mode', async () => {
    const h = home();
    await seed(h, [RUN_A, RUN_B]);
    const spy = fetchSpy();
    const original = globalThis.fetch;
    globalThis.fetch = spy.fetch as typeof globalThis.fetch;
    try {
      const r = await reembedCli(h, ['--json'], command);
      expect(r.code).toBe(EXIT.OK);
      expect(JSON.parse(r.out).embedded).toBe(2);
    } finally {
      globalThis.fetch = original;
    }
    expect(spy.count).toBe(0);
  });

  test('blank MODEL_EMBEDDING is a no-op', async () => {
    const h = home('');
    const store = await seed(h, [RUN_A]);
    const spy = fetchSpy();
    const json = await reembedCli(h, ['--json'], cmdWith(spy));
    expect(json.code).toBe(EXIT.OK);
    expect(JSON.parse(json.out)).toEqual({ disabled: true, runs: 0, embedded: 0, unchanged: 0, skipped: 0, failed: 0 });
    const human = await reembedCli(h, [], cmdWith(spy));
    expect(human.out).toContain('embeddings disabled');
    expect((await store.getRun(RUN_A))?.embeddings).toEqual([]);
    expect(spy.count).toBe(0);
  });

  test('a run that fails to store exits 1 and names the run and the error class only', async () => {
    const h = home();
    const real = await seed(h, [RUN_A]);
    const failing = new Proxy(real, {
      get(target, prop) {
        if (prop === 'putEmbedding') return () => Promise.reject(new RangeError(`disk full ${SYNTHETIC_PHONE}`));
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const human = await reembedCli(h, [], cmdWith(fetchSpy(), { store: async () => failing }));
    expect(human.code).toBe(EXIT.ERROR);
    expect(human.out).toContain('failed 1');
    expect(human.out).toContain(`${RUN_A}: case embedding not stored (RangeError)`);
    expect(human.out).not.toContain(SYNTHETIC_PHONE);

    const json = await reembedCli(h, ['--json'], cmdWith(fetchSpy(), { store: async () => failing }));
    expect(json.code).toBe(EXIT.ERROR);
    expect(JSON.parse(json.out)).toEqual({ runs: 1, embedded: 0, unchanged: 0, skipped: 0, failed: 1 });
  });

  test('a store that cannot list runs is a JSON error with the error class only', async () => {
    const h = home();
    const real = await seed(h, []);
    const broken = new Proxy(real, {
      get(target, prop) {
        if (prop === 'listRuns') return () => Promise.reject(new Error(`cannot reach ${SYNTHETIC_PHONE}`));
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const r = await reembedCli(h, ['--json'], cmdWith(fetchSpy(), { store: async () => broken }));
    expect(r.code).toBe(EXIT.ERROR);
    expect(JSON.parse(r.out)).toEqual({ error: { code: 'ERROR', message: 'reembed failed: Error' } });
    expect(r.out).not.toContain(SYNTHETIC_PHONE);
  });

  test('a refused MODEL_EMBEDDING exits 3 naming the key, not the value', async () => {
    const h = home('openrouter/some-embedder');
    const spy = fetchSpy();
    const r = await reembedCli(h, ['--json'], cmdWith(spy));
    expect(r.code).toBe(EXIT.CONFIG);
    expect(r.out).toContain('MODEL_EMBEDDING');
    expect(r.out).not.toContain('some-embedder');
    expect(spy.count).toBe(0);
  });
});
