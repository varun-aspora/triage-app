// A scripted ExecRunner for tests. It never spawns anything: each call is
// matched on bin plus the exact argv against the script, answered with the
// scripted result and recorded. A call nobody scripted throws, so a test
// cannot quietly fall through to a real process.

import { checkCommand, type ExecOptions, type ExecResult, type ExecRunner } from './exec.ts';

export type FakeCall = {
  readonly bin: string;
  readonly argv: readonly string[];
  readonly stdin?: string;
  readonly cwd?: string;
  readonly timeoutMs: number;
};

export type FakeStep = {
  readonly bin: string;
  readonly argv: readonly string[];
  /** Fields left out default to a clean exit: code 0, empty output. */
  readonly result?: Partial<ExecResult> | ((call: FakeCall) => Partial<ExecResult>);
  /** How many calls this step answers. Unlimited when left out. */
  readonly times?: number;
};

export type FakeRunner = ExecRunner & {
  /** Every call that matched a step, in call order. */
  readonly calls: readonly FakeCall[];
  /** Every call that matched nothing. Each of these also threw. */
  readonly unscripted: readonly FakeCall[];
  /** Steps with a times limit that were not used up. */
  pending(): FakeStep[];
};

export class UnscriptedExecError extends Error {
  override readonly name = 'UnscriptedExecError';
  readonly call: FakeCall;
  constructor(call: FakeCall) {
    super(`fake exec runner: no scripted result for ${call.bin} ${JSON.stringify(call.argv)}`);
    this.call = call;
  }
}

const sameArgv = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

function stdinText(stdin: ExecOptions['stdin']): string | undefined {
  if (stdin === undefined) return undefined;
  return typeof stdin === 'string' ? stdin : Buffer.from(stdin).toString('utf8');
}

export function createFakeRunner(script: readonly FakeStep[]): FakeRunner {
  const steps = script.map((step) => ({ step, used: 0 }));
  const calls: FakeCall[] = [];
  const unscripted: FakeCall[] = [];

  return {
    calls,
    unscripted,
    pending() {
      return steps.filter((s) => s.step.times !== undefined && s.used < s.step.times).map((s) => s.step);
    },
    async run(bin: string, argv: readonly string[], opts: ExecOptions): Promise<ExecResult> {
      checkCommand(bin, argv);
      const stdin = stdinText(opts.stdin);
      const call: FakeCall = {
        bin,
        argv: Object.freeze([...argv]),
        timeoutMs: opts.timeoutMs,
        ...(stdin !== undefined ? { stdin } : {}),
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      };
      const match = steps.find(
        (s) => s.step.bin === bin && sameArgv(s.step.argv, argv) && (s.step.times === undefined || s.used < s.step.times),
      );
      if (match === undefined) {
        unscripted.push(call);
        throw new UnscriptedExecError(call);
      }
      match.used++;
      calls.push(call);
      if (opts.signal?.aborted) {
        return { exitCode: null, stdout: '', stderr: '', timedOut: false, truncated: false, aborted: true };
      }
      const scripted = typeof match.step.result === 'function' ? match.step.result(call) : (match.step.result ?? {});
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false, truncated: false, aborted: false, ...scripted };
    },
  };
}
