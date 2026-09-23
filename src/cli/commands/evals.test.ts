// triage evals, run through buildProgram and runCli with fake io. Eval homes
// are real ones written by materialiseEvalHome into temp dirs; the non-eval
// home is a test home, which keeps some CBS and tunnel keys filled. The
// contract suite's Vitest child is a scripted fake runner, so nothing is
// spawned. The classifier suite runs promptfoo evaluate() in-process with
// faux providers under the no-io guard from the test preload.

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import * as v from 'valibot';
import { parse as parseYaml } from 'yaml';
import { REPO_ROOT, makeTestHome, type TestHome } from '../../../test/support/home.ts';
import { assertNoIoGuardInstalled } from '../../../test/support/no-io-guard.ts';
import { loadConfig, type Config } from '../../config/env.ts';
import { PROMPTFOO_CONFIG_DIR_KEY, PROMPTFOO_OFF_SWITCHES, promptfooConfigDir } from '../../config/promptfoo-env.ts';
import { createFakeRunner, type FakeRunner } from '../../connectors/exec-fake.ts';
import { CaseSchema } from '../../evals/case-schema.ts';
import { materialiseEvalHome } from '../../evals/make-home.ts';
import { validateCaseIds } from '../../evals/pseudonym.ts';
import { commands as generatedCommands } from '../command-modules.gen.ts';
import { buildProgram, runCli } from '../index.ts';
import { EXIT } from '../output.ts';
import type { CliCommand, CliContext } from '../types.ts';
import {
  DEFAULT_CLASSIFIER_PROVIDERS,
  TRIAGE_SUITE_REFUSAL,
  contractInvocation,
  createEvalsCommand,
  type EvalsCommandOptions,
} from './evals.command.ts';

const PROMPTFOO_KEYS = [...Object.keys(PROMPTFOO_OFF_SWITCHES), PROMPTFOO_CONFIG_DIR_KEY];
const saved: Record<string, string | undefined> = {};
const dirs: string[] = [];
const homes: TestHome[] = [];

beforeAll(() => {
  assertNoIoGuardInstalled();
  for (const k of PROMPTFOO_KEYS) saved[k] = process.env[k];
});

afterEach(() => {
  for (const h of homes.splice(0)) h.cleanup();
});

afterAll(() => {
  for (const [k, val] of Object.entries(saved)) {
    if (val === undefined) delete process.env[k];
    else process.env[k] = val;
  }
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

type EvalHome = { home: string; config: Config };

function evalHome(overrides: Record<string, string> = {}): EvalHome {
  const home = materialiseEvalHome(tempDir('triage-evals-home-'), REPO_ROOT);
  return { home, config: loadConfig({ home, overrides }) };
}

function nonEvalHome(): TestHome {
  const h = makeTestHome();
  homes.push(h);
  return h;
}

type Run = { code: number; out: string; err: string; configCalls: number };

async function cli(
  argv: string[],
  config: () => Config,
  options: EvalsCommandOptions = {},
  io: { stdin?: string; isTTY?: boolean } = {},
): Promise<Run> {
  let out = '';
  let err = '';
  let configCalls = 0;
  const ctx: CliContext = {
    config: () => {
      configCalls++;
      return config();
    },
    io: {
      stdout: { write: (s: string) => (out += s) },
      stderr: { write: (s: string) => (err += s) },
      stdin: Readable.from(io.stdin === undefined ? [] : [io.stdin]),
      isTTY: io.isTTY ?? false,
    },
    deps: {},
  };
  const code = await runCli(buildProgram([createEvalsCommand(options)], ctx), ['evals', ...argv]);
  return { code, out, err, configCalls };
}

const noConfig = (): Config => {
  throw new Error('config must not be loaded');
};

/** Seams that record what ran and fail the test if a suite starts unexpectedly. */
function spies(runner: FakeRunner = createFakeRunner([])) {
  const events: string[] = [];
  const options: EvalsCommandOptions = {
    exec: {
      run: async (bin, argv, opts) => {
        events.push('contract');
        return runner.run(bin, argv, opts);
      },
    },
    applyPromptfooEnv: () => void events.push('promptfoo-env'),
    installNetworkDeny: async () => void events.push('network-deny'),
    buildSuite: async () => {
      events.push('build-suite');
      throw new Error('buildSuite must not run in this test');
    },
    loadEvaluate: async () => {
      events.push('load-evaluate');
      throw new Error('evaluate must not run in this test');
    },
  };
  return { events, options };
}

function contractRunner(exitCode: number): FakeRunner {
  const { bin, argv } = contractInvocation();
  return createFakeRunner([{ bin, argv, result: { exitCode, stdout: 'vitest report\n' } }]);
}

/** A promptfoo summary with one passing result per provider. */
function fakeSummary(providers: readonly string[]) {
  return {
    version: 3,
    results: providers.map((p) => ({ provider: { id: `triage-classifier:${p}` }, success: true, failureReason: 0 })),
    stats: { successes: providers.length, failures: 0, errors: 0 },
  };
}

describe('triage evals: registration and refusals', () => {
  test('is in the generated command list', () => {
    const paths = (generatedCommands as readonly CliCommand[]).map((c) => c.path.join(' '));
    expect(paths).toContain('evals');
  });

  test('a TRIAGE_HOME that is not an eval home is refused with key names only, before any suite', async () => {
    const h = nonEvalHome();
    for (const argv of [[], ['classifier'], ['contract'], ['--json']]) {
      const { events, options } = spies();
      const r = await cli(argv, () => h.config, options);
      expect(r.code).toBe(EXIT.CONFIG);
      expect(events).toEqual([]);
      const text = r.out + r.err;
      expect(text).toContain('not an eval home');
      expect(text).toContain('SSFB_CBS_K8S_NAMESPACE');
      // Key names, never the values the test home holds.
      for (const [key, value] of Object.entries(h.env)) {
        if (value.length >= 4 && /CBS|TUNNEL|QW_CONTEXT/.test(key)) expect(text).not.toContain(value);
      }
    }
  });

  test("the 'triage' suite is refused with the v1 message, without loading config", async () => {
    const { events, options } = spies();
    const r = await cli(['triage'], noConfig, options);
    expect(r.code).not.toBe(EXIT.OK);
    expect(r.err).toContain(TRIAGE_SUITE_REFUSAL);
    expect(r.configCalls).toBe(0);
    expect(events).toEqual([]);

    const j = await cli(['triage', '--json'], noConfig, options);
    expect(j.code).not.toBe(EXIT.OK);
    expect(JSON.parse(j.out)).toEqual({ error: { code: 'USAGE', message: TRIAGE_SUITE_REFUSAL } });
  });

  test('an unknown suite is a usage error', async () => {
    const r = await cli(['suite2'], noConfig, spies().options);
    expect(r.code).toBe(EXIT.USAGE);
  });

  test('--judge without TRIAGE_EVAL_JUDGE_MODEL fails before any suite runs', async () => {
    const e = evalHome();
    for (const argv of [['--judge'], ['classifier', '--judge']]) {
      const { events, options } = spies(contractRunner(0));
      const r = await cli(argv, () => e.config, options);
      expect(r.code).toBe(EXIT.CONFIG);
      expect(r.err).toContain('TRIAGE_EVAL_JUDGE_MODEL');
      expect(events).toEqual([]);
    }
  });

  test('--repeat must be a positive integer, and classifier flags do not apply to contract', async () => {
    const e = evalHome();
    for (const argv of [['classifier', '--repeat', '0'], ['classifier', '--repeat', 'x'], ['contract', '--provider', 'faux/cheap']]) {
      const { events, options } = spies();
      const r = await cli(argv, () => e.config, options);
      expect(r.code).toBe(EXIT.USAGE);
      expect(events).toEqual([]);
    }
  });

  test('--provider must be a provider/model spec', async () => {
    const e = evalHome();
    const r = await cli(['classifier', '--provider', 'nospec'], () => e.config, spies().options);
    expect(r.code).toBe(EXIT.USAGE);
  });
});

describe('triage evals: suites', () => {
  test('the classifier provider list defaults to faux, even when MODEL_CLASSIFIER is a real model', async () => {
    const e = evalHome({ MODEL_CLASSIFIER: 'openai/gpt-5-mini' });
    let seen: readonly string[] | undefined;
    const r = await cli(['classifier', '--json'], () => e.config, {
      applyPromptfooEnv: () => {},
      installNetworkDeny: async () => {},
      buildSuite: async (o) => {
        seen = o.providers;
        throw Object.assign(new Error('stop here'), { name: 'SuiteConfigError' });
      },
    });
    expect(seen).toEqual(DEFAULT_CLASSIFIER_PROVIDERS);
    expect(seen?.every((p) => p.startsWith('faux/'))).toBe(true);
    expect(r.code).toBe(EXIT.CONFIG);
  });

  test('--repeat k and each --provider are passed through to promptfoo', async () => {
    const e = evalHome();
    let evaluateOptions: Record<string, unknown> | undefined;
    const providers = ['faux/classifier', 'faux/cheap'];
    const r = await cli(['classifier', '--repeat', '3', '--provider', providers[0]!, '--provider', providers[1]!, '--json'], () => e.config, {
      applyPromptfooEnv: () => {},
      installNetworkDeny: async () => {},
      loadEvaluate: async () => async (_suite, opts) => {
        evaluateOptions = opts as Record<string, unknown>;
        return { toEvaluateSummary: async () => fakeSummary(providers) };
      },
    });
    expect(evaluateOptions).toMatchObject({ repeat: 3, cache: false });
    expect(r.code).toBe(EXIT.OK);
    const out = JSON.parse(r.out);
    expect(out.suites[0]).toMatchObject({ suite: 'classifier', repeat: 3, providers, ok: true });
  });

  test('the default run is contract then classifier, and promptfoo env is set before the classifier suite loads', async () => {
    const e = evalHome();
    const events: string[] = [];
    const runner = contractRunner(0);
    const r = await cli(['--json'], () => e.config, {
      exec: {
        run: async (bin, argv, opts) => {
          events.push('contract');
          return runner.run(bin, argv, opts);
        },
      },
      applyPromptfooEnv: () => void events.push('promptfoo-env'),
      installNetworkDeny: async () => void events.push('network-deny'),
      loadEvaluate: async () => {
        events.push('load-evaluate');
        return async () => ({ toEvaluateSummary: async () => fakeSummary(DEFAULT_CLASSIFIER_PROVIDERS) });
      },
    });
    expect(r.code).toBe(EXIT.OK);
    expect(events).toEqual(['promptfoo-env', 'contract', 'network-deny', 'load-evaluate']);
    expect(runner.calls[0]?.cwd).toBe(contractInvocation().cwd);
    expect(runner.calls[0]?.argv.slice(-2)).toEqual(['run', 'test/contract']);
    const out = JSON.parse(r.out);
    expect(out.ok).toBe(true);
    expect(out.suites.map((s: { suite: string }) => s.suite)).toEqual(['contract', 'classifier']);
    // Vitest's own report stays off stdout under --json.
    expect(r.err).toContain('vitest report');
  });

  test('a failing contract suite stops the default run before the classifier suite', async () => {
    const e = evalHome();
    const events: string[] = [];
    const runner = contractRunner(1);
    const r = await cli([], () => e.config, {
      exec: { run: (bin, argv, opts) => (events.push('contract'), runner.run(bin, argv, opts)) },
      applyPromptfooEnv: () => {},
      installNetworkDeny: async () => void events.push('network-deny'),
      loadEvaluate: async () => {
        events.push('load-evaluate');
        throw new Error('must not run');
      },
    });
    expect(r.code).toBe(EXIT.ERROR);
    expect(events).toEqual(['contract']);
    expect(r.out).toContain('contract: failed (exit 1)');
  });

  test('triage evals contract runs only the Vitest child', async () => {
    const e = evalHome();
    const runner = contractRunner(0);
    const { events, options } = spies(runner);
    const r = await cli(['contract'], () => e.config, options);
    expect(r.code).toBe(EXIT.OK);
    expect(events).toEqual(['promptfoo-env', 'contract']);
    expect(r.out).toContain('vitest report');
    expect(r.out).toContain('contract: passed');
  });

  test('the default classifier run goes through promptfoo with faux providers only, and writes no .env', async () => {
    const e = evalHome();
    const envBefore = readFileSync(join(e.home, '.env'), 'utf8');
    let atImport: Record<string, string | undefined> | undefined;
    const r = await cli(['classifier', '--json'], () => e.config, {
      loadEvaluate: async () => {
        atImport = Object.fromEntries(PROMPTFOO_KEYS.map((k) => [k, process.env[k]]));
        return (await import('promptfoo')).evaluate as never;
      },
    });
    expect(r.err).toBe('');
    expect(r.code).toBe(EXIT.OK);
    const out = JSON.parse(r.out);
    expect(out.ok).toBe(true);
    const suite = out.suites[0];
    expect(suite).toMatchObject({ suite: 'classifier', providers: ['faux/classifier'], judge: false, repeat: 1 });
    expect(suite.passed).toBeGreaterThanOrEqual(6);
    expect(suite.failed + suite.errors).toBe(0);
    expect(suite.cost_usd).toBe(0);

    // The switches were in the process env before promptfoo was imported.
    expect(atImport).toEqual({ ...PROMPTFOO_OFF_SWITCHES, [PROMPTFOO_CONFIG_DIR_KEY]: promptfooConfigDir(e.config) });
    expect(promptfooConfigDir(e.config).startsWith(e.config.paths.dataDir)).toBe(true);
    // Process env only: the eval home's .env is untouched.
    const envAfter = readFileSync(join(e.home, '.env'), 'utf8');
    expect(envAfter).toBe(envBefore);
    expect(envAfter).not.toContain('PROMPTFOO_');
  });
});

describe('triage evals pseudonymise', () => {
  const KEY = 'test-only-pseudonym-key-0123456789';

  function caseCopy(id = 'syn-money-moved'): { dir: string; file: string; before: string } {
    const dir = join(tempDir('triage-pseudo-'), id);
    cpSync(join(REPO_ROOT, 'evals', 'cases', id), dir, { recursive: true });
    const file = join(dir, 'case.yaml');
    return { dir, file, before: readFileSync(file, 'utf8') };
  }

  test('reads the key from stdin and rewrites the case in place; the result passes validateCaseIds', async () => {
    const c = caseCopy();
    const r = await cli(['pseudonymise', c.dir, '--json'], noConfig, {}, { stdin: `${KEY}\n` });
    expect(r.err).toBe('');
    expect(r.code).toBe(EXIT.OK);
    expect(JSON.parse(r.out)).toEqual({ case_id: 'syn-money-moved', file: c.file, rewritten: true });
    expect(r.configCalls).toBe(0);

    const before = v.parse(CaseSchema, parseYaml(c.before));
    const rewritten = v.parse(CaseSchema, parseYaml(readFileSync(c.file, 'utf8')));
    expect(validateCaseIds(rewritten)).toEqual({ ok: true });
    expect(rewritten.ids.account_number).not.toBe(before.ids.account_number);
    expect(rewritten.ids.horus_customer_id).not.toBe(before.ids.horus_customer_id);
    expect(readFileSync(c.file, 'utf8')).not.toContain(String(before.ids.account_number));
    expect(r.out).not.toContain(KEY);
  });

  test('a key passed as an argument is refused, not echoed, and nothing is written', async () => {
    const c = caseCopy();
    for (const argv of [
      ['pseudonymise', c.dir, KEY],
      ['pseudonymise', c.dir, '--key', KEY],
      ['pseudonymise', c.dir, `--key=${KEY}`],
    ]) {
      const r = await cli(argv, noConfig, {}, { stdin: `${KEY}\n` });
      expect(r.code).toBe(EXIT.USAGE);
      expect(r.err).toContain('stdin');
      expect(r.out + r.err).not.toContain(KEY);
      expect(readFileSync(c.file, 'utf8')).toBe(c.before);
    }
  });

  test('a terminal stdin, an empty stdin and a short key are refused; nothing is written', async () => {
    const c = caseCopy();
    const tty = await cli(['pseudonymise', c.dir], noConfig, {}, { isTTY: true });
    expect(tty.code).toBe(EXIT.USAGE);
    const empty = await cli(['pseudonymise', c.dir], noConfig, {}, { stdin: '' });
    expect(empty.code).toBe(EXIT.USAGE);
    const short = await cli(['pseudonymise', c.dir], noConfig, {}, { stdin: 'short-key\n' });
    expect(short.code).toBe(EXIT.ERROR);
    expect(short.err).toContain('at least');
    expect(short.err).not.toContain('short-key');
    expect(readFileSync(c.file, 'utf8')).toBe(c.before);
  });

  test('a missing case_dir and a directory without case.yaml are refused', async () => {
    const missing = await cli(['pseudonymise'], noConfig, {}, { stdin: KEY });
    expect(missing.code).toBe(EXIT.USAGE);
    const none = await cli(['pseudonymise', tempDir('triage-pseudo-empty-')], noConfig, {}, { stdin: KEY });
    expect(none.code).toBe(EXIT.ERROR);
  });

  test('a case directory is refused for every other suite', async () => {
    const r = await cli(['classifier', '/tmp/some-case'], noConfig, spies().options);
    expect(r.code).toBe(EXIT.USAGE);
  });
});
