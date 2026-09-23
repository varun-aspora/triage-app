// scripts/ci.ts smoke: steps run in order with the eval home exported, the
// first failing step stops the run with its exit code, and the children's env
// has no model keys. The step runner is stubbed, so nothing is spawned.

import { describe, expect, test } from 'bun:test';
import { CI_STEPS, SCRUBBED_KEYS, childEnv, runCi, type CiStep, type StepRunner } from './ci.ts';

function recorder(codes: Record<string, number> = {}) {
  const ran: { name: string; home: string | undefined }[] = [];
  const run: StepRunner = async (step, env) => {
    ran.push({ name: step.name, home: env.TRIAGE_HOME });
    return codes[step.name] ?? 0;
  };
  return { ran, run };
}

const quiet = () => {};
const env = { TRIAGE_HOME: '/tmp/eval-home' };

describe('scripts/ci.ts', () => {
  test('runs typecheck, unit tests, the contract suite and the faux classifier suite, in that order', async () => {
    const { ran, run } = recorder();
    const code = await runCi(CI_STEPS, run, env, quiet);
    expect(code).toBe(0);
    expect(ran.map((r) => r.name)).toEqual(CI_STEPS.map((s) => s.name));
    expect(ran.every((r) => r.home === '/tmp/eval-home')).toBe(true);
    expect(CI_STEPS.map((s) => [s.bin, ...s.argv].join(' '))).toEqual([
      'bun run typecheck',
      'bun run test',
      'node bin/triage.mjs evals contract',
      'node bin/triage.mjs evals classifier',
    ]);
  });

  test('the classifier step passes no --provider or --judge, so it runs faux with the judge off', () => {
    const classifier = CI_STEPS.find((s) => s.argv.includes('classifier')) as CiStep;
    expect(classifier.argv).not.toContain('--provider');
    expect(classifier.argv).not.toContain('--judge');
  });

  test('a failing step stops the run with a non-zero exit, and later steps do not run', async () => {
    const { ran, run } = recorder({ 'unit tests': 3 });
    const lines: string[] = [];
    const code = await runCi(CI_STEPS, run, env, (l) => lines.push(l));
    expect(code).toBe(3);
    expect(ran.map((r) => r.name)).toEqual(['typecheck', 'unit tests']);
    expect(lines).toContain('ci: unit tests failed (exit 3)');
  });

  test('a failure in the last step is still reported', async () => {
    const { ran, run } = recorder({ 'classifier suite (faux, judge off)': 1 });
    expect(await runCi(CI_STEPS, run, env, quiet)).toBe(1);
    expect(ran).toHaveLength(CI_STEPS.length);
  });

  test('the children get TRIAGE_HOME and no model or Slack keys', () => {
    const parent: Record<string, string> = { PATH: '/usr/bin', TRIAGE_HOME: '/real/home' };
    for (const k of SCRUBBED_KEYS) parent[k] = 'fake-value';
    const out = childEnv(parent, '/tmp/eval-home');
    expect(out).toEqual({ PATH: '/usr/bin', TRIAGE_HOME: '/tmp/eval-home' });
  });
});
