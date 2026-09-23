// The CI gate: `bun run ci` (bun scripts/ci.ts).
//
// Writes a fresh eval home into a temp dir (materialiseEvalHome), exports it
// as TRIAGE_HOME for every step, and runs in order:
//   1. typecheck        bun run typecheck (gen, then tsc --noEmit)
//   2. unit tests       bun run test
//   3. contract suite   node bin/triage.mjs evals contract
//   4. classifier suite node bin/triage.mjs evals classifier (faux providers, judge off)
// It stops at the first step that fails and exits with that step's code.
//
// It needs no VPN, no credentials and no model keys: the eval home has every
// credential blank, the classifier suite runs faux providers by default, and
// the model provider keys are removed from the children's env so nothing can
// fall back to a real model. The temp home is removed at the end.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { materialiseEvalHome } from '../src/evals/make-home.ts';

export const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

export type CiStep = { readonly name: string; readonly bin: string; readonly argv: readonly string[] };

export const CI_STEPS: readonly CiStep[] = Object.freeze([
  { name: 'typecheck', bin: 'bun', argv: ['run', 'typecheck'] },
  { name: 'unit tests', bin: 'bun', argv: ['run', 'test'] },
  { name: 'contract suite', bin: 'node', argv: ['bin/triage.mjs', 'evals', 'contract'] },
  { name: 'classifier suite (faux, judge off)', bin: 'node', argv: ['bin/triage.mjs', 'evals', 'classifier'] },
]);

/** Keys removed from every child's env so no step can reach a real model or Slack. */
export const SCRUBBED_KEYS: readonly string[] = Object.freeze([
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'SLACK_BOT_TOKEN',
]);

/** Runs one step and resolves with its exit code. */
export type StepRunner = (step: CiStep, env: Readonly<Record<string, string>>) => Promise<number>;

export type CiLog = (line: string) => void;

/** The env every step gets: the parent's, minus SCRUBBED_KEYS, plus TRIAGE_HOME. */
export function childEnv(parent: Readonly<Record<string, string | undefined>>, home: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, val] of Object.entries(parent)) {
    if (val !== undefined && !SCRUBBED_KEYS.includes(k)) env[k] = val;
  }
  env.TRIAGE_HOME = home;
  return env;
}

/** Runs the steps in order and returns 0, or the exit code of the first step that failed. */
export async function runCi(
  steps: readonly CiStep[],
  run: StepRunner,
  env: Readonly<Record<string, string>>,
  log: CiLog = (line) => process.stderr.write(`${line}\n`),
): Promise<number> {
  for (const step of steps) {
    log(`ci: ${step.name}`);
    const code = await run(step, env);
    if (code !== 0) {
      log(`ci: ${step.name} failed (exit ${code})`);
      return code;
    }
  }
  log('ci: all steps passed');
  return 0;
}

/** Spawns the step from the repo root with inherited stdio. A spawn error counts as exit 1. */
export const spawnStep: StepRunner = (step, env) =>
  new Promise((done) => {
    const child = spawn(step.bin, [...step.argv], { cwd: REPO_ROOT, env, stdio: 'inherit' });
    child.once('error', () => done(1));
    child.once('close', (code, signal) => done(code ?? (signal === null ? 1 : 128)));
  });

export async function main(): Promise<number> {
  const dir = mkdtempSync(join(tmpdir(), 'triage-ci-home-'));
  try {
    const home = materialiseEvalHome(dir, REPO_ROOT);
    return await runCi(CI_STEPS, spawnStep, childEnv(process.env, home));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) process.exit(await main());
