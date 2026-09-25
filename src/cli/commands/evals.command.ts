// triage evals [contract | classifier | triage | pseudonymise] [...]
//
//   triage evals                     contract suite, then the classifier suite
//   triage evals contract            Vitest over test/contract (fake model, strict mock)
//   triage evals classifier [--provider <spec>]... [--judge] [--repeat <k>]
//                                    suite 1 through promptfoo evaluate(); faux
//                                    providers unless --provider is given
//   triage evals triage              refused: the full-Triage suite is not in v1
//   triage evals pseudonymise <case_dir>
//                                    reads the key from stdin and rewrites
//                                    <case_dir>/case.yaml in place
//
// Config comes from TRIAGE_HOME, never a flag (D4, D42). Every suite run first
// checks that TRIAGE_HOME is an eval home (assertEvalHome) and refuses with key
// names only when it is not. Before promptfoo is imported, the promptfoo off
// switches and PROMPTFOO_CONFIG_DIR (under TRIAGE_DATA_DIR) are set in this
// process's env only; nothing is written to a .env.
//
// The classifier suite runs faux providers by default, whatever MODEL_CLASSIFIER
// says, and installs the no-io guard before promptfoo loads, so the default run
// cannot reach a network. --judge needs TRIAGE_EVAL_JUDGE_MODEL and fails
// before any suite runs when it is blank.
//
// pseudonymise does not load config or run a suite, so it needs no eval home.
// The key is read from piped stdin only: never argv, never env, never a TTY
// (a typed key would be echoed). The rewritten case must pass validateCaseIds
// before it is written.

import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Option } from 'commander';
import type { EvaluateOptions, EvaluateSummaryV3, EvaluateTestSuite } from 'promptfoo';
import * as v from 'valibot';
import { stringify as stringifyYaml } from 'yaml';
import type { Config } from '../../config/env.ts';
import { applyPromptfooEnv } from '../../config/promptfoo-env.ts';
import { loadRegistry, type Registry } from '../../config/registry.ts';
import { createExecRunner, type ExecRunner } from '../../connectors/exec.ts';
import { CASE_FILE, parseCaseYaml, type EvalCase } from '../../evals/case-schema.ts';
import { assertEvalHome, EvalHomeError } from '../../evals/home.ts';
import { PseudonymError, pseudonymiseCase, validateCaseIds } from '../../evals/pseudonym.ts';
import { parseSpec } from '../../models.ts';
import { emitJson } from '../lib/output-schemas.ts';
import { EXIT, printError, printHuman } from '../output.ts';
import type { CliCommand, CliIo } from '../types.ts';

export const EVAL_SUITES = ['contract', 'classifier', 'triage', 'pseudonymise'] as const;
export type EvalSuite = (typeof EVAL_SUITES)[number];

export const TRIAGE_SUITE_REFUSAL = 'full-Triage suite is not in v1';

/** The classifier providers when --provider is not given. Never a real model. */
export const DEFAULT_CLASSIFIER_PROVIDERS: readonly string[] = Object.freeze(['faux/classifier']);

export const JUDGE_KEY = 'TRIAGE_EVAL_JUDGE_MODEL';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CONTRACT_DIR = 'test/contract';
const CONTRACT_TIMEOUT_MS = 30 * 60 * 1000;
const CONTRACT_MAX_OUTPUT_BYTES = 20 * 1024 * 1024;

type SuiteModule = typeof import('../../../evals/promptfoo/classifier.config.ts');
type BuiltSuite = Awaited<ReturnType<SuiteModule['buildClassifierSuite']>>;
type BuildSuiteOptions = Parameters<SuiteModule['buildClassifierSuite']>[0];
type EvaluateFn = (suite: EvaluateTestSuite, options: EvaluateOptions) => Promise<{ toEvaluateSummary(): Promise<unknown> }>;

export type EvalsCommandOptions = {
  readonly loadRegistry?: (config: Config) => Registry;
  /** Runs the Vitest child for the contract suite. Defaults to the one exec runner. */
  readonly exec?: ExecRunner;
  /** Sets the promptfoo switches. Defaults to applyPromptfooEnv on the process env. */
  readonly applyPromptfooEnv?: (config: Config) => void;
  /** Installs the network and binary deny before promptfoo loads in faux mode. */
  readonly installNetworkDeny?: () => Promise<void>;
  /** Builds suite 1. Defaults to buildClassifierSuite, imported on use. */
  readonly buildSuite?: (options: BuildSuiteOptions) => Promise<BuiltSuite>;
  /** promptfoo's evaluate(), imported on use. */
  readonly loadEvaluate?: () => Promise<EvaluateFn>;
};

// ------------------------------------------------------------ json shapes

const ContractResultSchema = v.strictObject({
  suite: v.literal('contract'),
  ok: v.boolean(),
  exit_code: v.nullable(v.number()),
});

const ProviderCountsSchema = v.strictObject({
  provider: v.string(),
  passed: v.number(),
  failed: v.number(),
  errors: v.number(),
});

const ClassifierResultSchema = v.strictObject({
  suite: v.literal('classifier'),
  ok: v.boolean(),
  providers: v.array(v.string()),
  judge: v.boolean(),
  repeat: v.number(),
  passed: v.number(),
  failed: v.number(),
  errors: v.number(),
  by_provider: v.array(ProviderCountsSchema),
  cost_usd: v.number(),
  cost_cap_usd: v.nullable(v.number()),
  cost_cap_exceeded: v.boolean(),
});

/** `triage evals [contract|classifier] --json`. */
export const EvalsOutputSchema = v.strictObject({
  ok: v.boolean(),
  suites: v.array(v.variant('suite', [ContractResultSchema, ClassifierResultSchema])),
});
export type EvalsOutput = v.InferOutput<typeof EvalsOutputSchema>;
type ContractResult = v.InferOutput<typeof ContractResultSchema>;
type ClassifierResult = v.InferOutput<typeof ClassifierResultSchema>;

/** `triage evals pseudonymise <case_dir> --json`. */
export const PseudonymiseOutputSchema = v.strictObject({ case_id: v.string(), file: v.string(), rewritten: v.literal(true) });

// ------------------------------------------------------------ defaults

const lazyBuildSuite = async (options: BuildSuiteOptions): Promise<BuiltSuite> =>
  (await import('../../../evals/promptfoo/classifier.config.ts')).buildClassifierSuite(options);

const lazyEvaluate = async (): Promise<EvaluateFn> => (await import('promptfoo')).evaluate as unknown as EvaluateFn;

// The one network deny (test/support/no-io-guard.ts); the faux classifier
// provider installs the same guard on each call.
const lazyNetworkDeny = async (): Promise<void> => {
  (await import('../../../test/support/no-io-guard.ts')).installNoIoGuard();
};

// ------------------------------------------------------------ command

class UsageError extends Error {
  override readonly name = 'UsageError';
}

type ClassifierArgs = { readonly providers: readonly string[]; readonly judge: boolean; readonly repeat: number; readonly explicit: boolean };

export function createEvalsCommand(options: EvalsCommandOptions = {}): CliCommand {
  const registryOf = options.loadRegistry ?? ((config: Config) => loadRegistry(config));
  const setPromptfooEnv = options.applyPromptfooEnv ?? ((config: Config) => void applyPromptfooEnv(config));
  const denyNetwork = options.installNetworkDeny ?? lazyNetworkDeny;
  const buildSuite = options.buildSuite ?? lazyBuildSuite;
  const loadEvaluate = options.loadEvaluate ?? lazyEvaluate;

  return {
    path: ['evals'],
    summary: 'run the eval suites from the eval home: contract, classifier, or pseudonymise a case',
    configure(cmd) {
      cmd
        .argument('[suite]', `one of ${EVAL_SUITES.join(', ')}; default runs contract then classifier`)
        .argument('[case_dir]', 'pseudonymise only: the case directory to rewrite')
        .argument('[extra...]', 'not accepted; pseudonymise reads its key from stdin')
        .addOption(
          new Option('--provider <spec>', 'classifier model to compare, repeatable').argParser(collect).default([], 'faux/classifier'),
        )
        .option('--judge', `grade model-graded asserts with ${JUDGE_KEY}`)
        .option('--repeat <k>', 'trials per case, passed to promptfoo')
        .option('--json', 'print machine-readable JSON')
        // Declared only so a key passed this way is refused without being echoed.
        .addOption(new Option('--key <value>').hideHelp());
    },
    async run(ctx, { args, opts }) {
      const { io } = ctx;
      const json = opts.json;
      const suiteArg = args[0] as string | undefined;
      const caseDir = args[1] as string | undefined;
      const extra = (args[2] as string[] | undefined) ?? [];

      if (suiteArg !== undefined && !(EVAL_SUITES as readonly string[]).includes(suiteArg)) {
        printError(io, json, 'USAGE', `unknown suite; use one of ${EVAL_SUITES.join(', ')}`);
        return EXIT.USAGE;
      }
      const suite = suiteArg as EvalSuite | undefined;

      if (suite === 'pseudonymise') {
        if (opts.key !== undefined || extra.length > 0) {
          printError(io, json, 'USAGE', 'pseudonymise reads the key from stdin only; do not pass it as an argument');
          return EXIT.USAGE;
        }
        if (caseDir === undefined) {
          printError(io, json, 'USAGE', 'pseudonymise needs <case_dir>');
          return EXIT.USAGE;
        }
        return pseudonymiseCommand(io, json, caseDir);
      }

      if (opts.key !== undefined) {
        printError(io, json, 'USAGE', '--key is not an option; pseudonymise reads the key from stdin');
        return EXIT.USAGE;
      }
      if (caseDir !== undefined || extra.length > 0) {
        printError(io, json, 'USAGE', 'only pseudonymise takes a case directory');
        return EXIT.USAGE;
      }
      if (suite === 'triage') {
        printError(io, json, 'USAGE', TRIAGE_SUITE_REFUSAL);
        return EXIT.USAGE;
      }

      let classifierArgs: ClassifierArgs;
      try {
        classifierArgs = parseClassifierArgs(opts);
        if (suite === 'contract' && classifierArgs.explicit) {
          throw new UsageError('--provider, --judge and --repeat apply to the classifier suite');
        }
      } catch (err) {
        if (!(err instanceof UsageError)) throw err;
        printError(io, json, 'USAGE', err.message);
        return EXIT.USAGE;
      }

      const config = ctx.config();
      try {
        assertEvalHome(config, registryOf(config));
      } catch (err) {
        if (!(err instanceof EvalHomeError)) throw err;
        const text = err.problems.map((p) => `${p.key} ${p.reason}`).join('; ');
        printError(io, json, 'CONFIG', `TRIAGE_HOME is not an eval home: ${text}`);
        return EXIT.CONFIG;
      }

      const runClassifier = suite === undefined || suite === 'classifier';
      if (runClassifier && classifierArgs.judge && (config.evals.judgeModel?.trim() ?? '') === '') {
        printError(io, json, 'CONFIG', `${JUDGE_KEY} is blank; --judge needs a judge model and there is no fallback`);
        return EXIT.CONFIG;
      }

      // Before anything can import promptfoo.
      setPromptfooEnv(config);

      let built: BuiltSuite | undefined;
      if (runClassifier) {
        try {
          built = await buildSuite({
            providers: classifierArgs.providers,
            judgeOn: classifierArgs.judge,
            repeat: classifierArgs.repeat,
            config,
          });
        } catch (err) {
          if (!(err instanceof Error) || !['SuiteConfigError', 'JudgeConfigError'].includes(err.name)) throw err;
          printError(io, json, 'CONFIG', err.message);
          return EXIT.CONFIG;
        }
      }

      const results: (ContractResult | ClassifierResult)[] = [];
      if (suite === undefined || suite === 'contract') {
        const contract = await runContract(options.exec ?? createExecRunner(), io, json);
        results.push(contract);
        if (!contract.ok) return finish(io, json, results);
      }
      if (built !== undefined) {
        const faux = built.providers.every((p) => p.faux);
        if (faux) await denyNetwork();
        const evaluate = await loadEvaluate();
        const run = await evaluate(built.testSuite, { ...built.evaluateOptions, silent: true } as EvaluateOptions);
        const summary = (await run.toEvaluateSummary()) as EvaluateSummaryV3;
        results.push(classifierResult(built, summary, classifierArgs));
      }
      return finish(io, json, results);
    },
  };
}

export const command: CliCommand = createEvalsCommand();

// ------------------------------------------------------------ options

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parseClassifierArgs(opts: Readonly<Record<string, unknown>>): ClassifierArgs {
  const given = (opts.provider as string[] | undefined) ?? [];
  for (const spec of given) {
    if (parseSpec(spec) === undefined) throw new UsageError("--provider must be a 'provider/model' spec");
  }
  let repeat = 1;
  if (opts.repeat !== undefined) {
    const raw = String(opts.repeat);
    if (!/^\d+$/.test(raw) || Number(raw) < 1) throw new UsageError('--repeat must be an integer >= 1');
    repeat = Number(raw);
  }
  const judge = opts.judge === true;
  return {
    providers: given.length > 0 ? [...given] : [...DEFAULT_CLASSIFIER_PROVIDERS],
    judge,
    repeat,
    explicit: given.length > 0 || judge || opts.repeat !== undefined,
  };
}

// ------------------------------------------------------------ suites

/** The Vitest child the contract suite runs: this Node binary on Vitest's CLI, from the repo root. */
export function contractInvocation(): { bin: string; argv: readonly string[]; cwd: string } {
  return { bin: process.execPath, argv: [vitestBin(), 'run', CONTRACT_DIR], cwd: REPO_ROOT };
}

async function runContract(exec: ExecRunner, io: CliIo, json: boolean): Promise<ContractResult> {
  const { bin, argv, cwd } = contractInvocation();
  const result = await exec.run(bin, argv, { timeoutMs: CONTRACT_TIMEOUT_MS, cwd, maxOutputBytes: CONTRACT_MAX_OUTPUT_BYTES });
  // Under --json stdout carries one JSON document, so Vitest's report goes to stderr.
  (json ? io.stderr : io.stdout).write(result.stdout);
  io.stderr.write(result.stderr);
  if (result.spawnError !== undefined) io.stderr.write(`triage: could not start vitest (${result.spawnError})\n`);
  if (result.timedOut) io.stderr.write('triage: the contract suite timed out\n');
  if (result.truncated) io.stderr.write('triage: the contract suite output was cut at the size cap\n');
  const ok = result.exitCode === 0 && !result.timedOut && !result.truncated && !result.aborted;
  return { suite: 'contract', ok, exit_code: result.exitCode };
}

function vitestBin(): string {
  const pkgFile = fileURLToPath(import.meta.resolve('vitest/package.json'));
  const pkg = JSON.parse(readFileSync(pkgFile, 'utf8')) as { bin?: string | Record<string, string> };
  const bin = typeof pkg.bin === 'string' ? pkg.bin : (pkg.bin?.vitest ?? 'vitest.mjs');
  return join(dirname(pkgFile), bin);
}

function classifierResult(built: BuiltSuite, summary: EvaluateSummaryV3, args: ClassifierArgs): ClassifierResult {
  const counts = new Map<string, { passed: number; failed: number; errors: number }>();
  for (const p of built.providers) counts.set(p.id(), { passed: 0, failed: 0, errors: 0 });
  let passed = 0;
  let failed = 0;
  let errors = 0;
  for (const r of summary.results) {
    const id = String(r.provider?.id ?? 'unknown');
    const c = counts.get(id) ?? { passed: 0, failed: 0, errors: 0 };
    counts.set(id, c);
    if (r.success) {
      c.passed++;
      passed++;
    } else if (r.failureReason === 2) {
      c.errors++;
      errors++;
    } else {
      c.failed++;
      failed++;
    }
  }
  const budget = built.budget.summary();
  return {
    suite: 'classifier',
    ok: failed === 0 && errors === 0 && !budget.cost_cap_exceeded && summary.results.length > 0,
    providers: built.providers.map((p) => p.model),
    judge: args.judge,
    repeat: args.repeat,
    passed,
    failed,
    errors,
    by_provider: [...counts].map(([provider, c]) => ({ provider, ...c })),
    cost_usd: budget.total_usd,
    cost_cap_usd: budget.cap_usd,
    cost_cap_exceeded: budget.cost_cap_exceeded,
  };
}

function finish(io: CliIo, json: boolean, suites: (ContractResult | ClassifierResult)[]): number {
  const ok = suites.length > 0 && suites.every((s) => s.ok);
  if (json) {
    emitJson(io, EvalsOutputSchema, { ok, suites });
  } else {
    const lines: string[] = [];
    for (const s of suites) {
      if (s.suite === 'contract') {
        lines.push(`contract: ${s.ok ? 'passed' : `failed (exit ${s.exit_code ?? 'none'})`}`);
      } else {
        lines.push(
          `classifier: ${s.ok ? 'passed' : 'failed'}, ${s.passed} passed, ${s.failed} failed, ${s.errors} errors` +
            ` (repeat ${s.repeat}, judge ${s.judge ? 'on' : 'off'})`,
        );
        for (const p of s.by_provider) lines.push(`  ${p.provider}: ${p.passed} passed, ${p.failed} failed, ${p.errors} errors`);
        const cap = s.cost_cap_usd === null ? 'no cap' : `cap $${s.cost_cap_usd}`;
        lines.push(`  cost: $${s.cost_usd.toFixed(4)} (${cap}${s.cost_cap_exceeded ? ', cap exceeded' : ''})`);
      }
    }
    printHuman(io, lines);
  }
  return ok ? EXIT.OK : EXIT.ERROR;
}

// ------------------------------------------------------------ pseudonymise

async function pseudonymiseCommand(io: CliIo, json: boolean, caseDir: string): Promise<number> {
  if (io.isTTY) {
    printError(io, json, 'USAGE', 'pipe the pseudonym key on stdin; it is not read from a terminal, argv or env');
    return EXIT.USAGE;
  }
  const file = join(resolve(caseDir), CASE_FILE);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    printError(io, json, 'ERROR', `cannot read ${CASE_FILE} in the case directory`);
    return EXIT.ERROR;
  }
  const parsed = parseCaseYaml(text);
  if (!parsed.ok) {
    printError(io, json, 'ERROR', `invalid case: ${parsed.problems.join('; ')}`);
    return EXIT.ERROR;
  }

  const key = (await readAll(io.stdin)).replace(/\r?\n$/, '');
  if (key === '') {
    printError(io, json, 'USAGE', 'no key on stdin');
    return EXIT.USAGE;
  }

  let rewritten: EvalCase;
  try {
    rewritten = pseudonymiseCase(parsed.case, key);
  } catch (err) {
    if (!(err instanceof PseudonymError)) throw err;
    printError(io, json, 'ERROR', err.message);
    return EXIT.ERROR;
  }
  const check = validateCaseIds(rewritten);
  if (!check.ok) {
    const text = check.problems.map((p) => `${p.where} ${p.reason}${p.masked ? ` (${p.masked})` : ''}`).join('; ');
    printError(io, json, 'ERROR', `the rewritten case fails validateCaseIds, nothing written: ${text}`);
    return EXIT.ERROR;
  }

  // Same directory, then rename, so a crash never leaves half a case.
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, stringifyYaml(rewritten, { lineWidth: 0 }));
  renameSync(tmp, file);

  if (json) emitJson(io, PseudonymiseOutputSchema, { case_id: rewritten.id, file, rewritten: true });
  else printHuman(io, `rewrote ${file} with pseudonyms`);
  return EXIT.OK;
}

async function readAll(stream: AsyncIterable<unknown>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString('utf8');
}
