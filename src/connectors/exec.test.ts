import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createFakeRunner, UnscriptedExecError } from './exec-fake.ts';
import { assertSafeArg, checkCommand, createExecRunner, safeArg, UnsafeArgError } from './exec.ts';

const KEY = 'SSFB_BASTION';

// Every alphanumeric run of three or more characters in the value, plus every
// non-alphanumeric character. None of them may show up in the error message.
function partsOf(value: string): string[] {
  const words = value.match(/[A-Za-z0-9]{3,}/g) ?? [];
  const symbols = value.replace(/[A-Za-z0-9\s]/g, '').split('');
  return [...words, ...symbols].filter((p) => p.length > 0);
}

function refusal(value: unknown): UnsafeArgError {
  try {
    assertSafeArg(value, KEY);
  } catch (e) {
    if (e instanceof UnsafeArgError) return e;
    throw e;
  }
  throw new Error('assertSafeArg accepted a value it should refuse');
}

describe('assertSafeArg deny path', () => {
  const DENY: [string, string][] = [
    ['semicolon', 'a;reboot'],
    ['pipe', 'a|b'],
    ['ampersand', 'a&b'],
    ['command substitution', 'a$(id)'],
    ['backtick', 'a`id`'],
    ['redirect out', 'a>b'],
    ['redirect in', 'a<b'],
    ['newline', 'a\nb'],
    ['carriage return', 'a\rb'],
    ['NUL', 'a\u0000b'],
    ['leading dash', '-oProxyCommand'],
    ['long flag', '--opt=x'],
    ['user placeholder', '<user>@host'],
    ['password placeholder', '<password>'],
    ['empty string', ''],
    ['space', 'a b'],
    ['tab', 'a\tb'],
    ['single quote', "a'b"],
    ['double quote', 'a"b'],
    ['backslash', 'a\\b'],
    ['glob', 'a*'],
    ['variable', '$HOME'],
  ];

  for (const [name, value] of DENY) {
    test(`refuses ${name}`, () => {
      const err = refusal(value);
      expect(err.keyName).toBe(KEY);
      expect(err.message).toContain(KEY);
      if (value.length > 0) expect(err.message).not.toContain(value);
      for (const part of partsOf(value)) expect(err.message).not.toContain(part);
    });
  }

  test('refuses a non-string without echoing it', () => {
    for (const value of [undefined, null, 42, ['a'], { v: 'secret' }]) {
      const err = refusal(value);
      expect(err.message).toContain(KEY);
      expect(err.message).not.toContain('secret');
    }
  });

  test('safeArg refuses the same way', () => {
    expect(() => safeArg('a;b', KEY)).toThrow(UnsafeArgError);
  });
});

describe('assertSafeArg allow path', () => {
  const ALLOW = [
    'user@10.0.0.1',
    'ssfb-prod',
    '/home/u/.ssh/id_ed25519',
    'main',
    'feature/x-1',
    'arn:aws:eks:ap-south-1:123456789012:cluster/core',
    'deploy_user',
  ];
  for (const value of ALLOW) {
    test(`allows ${value}`, () => {
      expect(() => assertSafeArg(value, KEY)).not.toThrow();
      expect(safeArg(value, KEY)).toBe(value);
    });
  }
});

describe('checkCommand', () => {
  test('rejects a non-string argv entry and names only the index', () => {
    expect(() => checkCommand('node', ['ok', 7 as unknown as string])).toThrow('argv[1] is not a string');
    expect(() => checkCommand('node', 'a b' as unknown as string[])).toThrow(TypeError);
    expect(() => checkCommand('', [])).toThrow(TypeError);
    expect(() => checkCommand('node', ['a\u0000b'])).toThrow('argv[0] contains a NUL byte');
  });
});

// These spawn only the local runtime (process.execPath: bun under bun test,
// node under Node). Nothing reaches the network, and the no-io guard is live.
describe('createExecRunner', () => {
  const runner = createExecRunner();
  const node = process.execPath;

  test('returns stdout from a fixed argv', async () => {
    const r = await runner.run(node, ['-e', "process.stdout.write('ok')"], { timeoutMs: 20_000 });
    expect(r).toEqual({ exitCode: 0, stdout: 'ok', stderr: '', timedOut: false, truncated: false, aborted: false });
  });

  test('writes stdin and closes it', async () => {
    const script = "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>process.stdout.write('got:'+s))";
    const r = await runner.run(node, ['-e', script], { timeoutMs: 20_000, stdin: 'line one\nline two' });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('got:line one\nline two');
  });

  test('closes stdin when none is given, so a reader does not hang', async () => {
    const script = "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('eof'))";
    const r = await runner.run(node, ['-e', script], { timeoutMs: 20_000 });
    expect(r.stdout).toBe('eof');
    expect(r.timedOut).toBe(false);
  });

  test('passes argv through without a shell', async () => {
    const r = await runner.run(node, ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(-2)))', '$(id)', 'a;b'], {
      timeoutMs: 20_000,
    });
    expect(JSON.parse(r.stdout)).toEqual(['$(id)', 'a;b']);
  });

  test('a non-zero exit is a result, not a rejection', async () => {
    const r = await runner.run(node, ['-e', "process.stderr.write('bad');process.exit(3)"], { timeoutMs: 20_000 });
    expect(r.exitCode).toBe(3);
    expect(r.stderr).toBe('bad');
    expect(r.timedOut).toBe(false);
  });

  test('truncates output past maxOutputBytes', async () => {
    const r = await runner.run(node, ['-e', "process.stdout.write('x'.repeat(200000))"], {
      timeoutMs: 20_000,
      maxOutputBytes: 1000,
    });
    expect(r.truncated).toBe(true);
    expect(r.stdout.length).toBeLessThanOrEqual(1000);
    expect(r.stdout.length).toBeGreaterThan(0);
  });

  test('output under the cap is not truncated', async () => {
    const r = await runner.run(node, ['-e', "process.stdout.write('x'.repeat(500))"], { timeoutMs: 20_000, maxOutputBytes: 1000 });
    expect(r.truncated).toBe(false);
    expect(r.stdout).toBe('x'.repeat(500));
  });

  test('a timeout kills the child and comes back as timedOut', async () => {
    const started = Date.now();
    const r = await runner.run(node, ['-e', 'setTimeout(() => {}, 30000)'], { timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBeNull();
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  test('aborting the signal kills the child', async () => {
    const ac = new AbortController();
    const started = Date.now();
    const pending = runner.run(node, ['-e', 'setTimeout(() => {}, 30000)'], { timeoutMs: 20_000, signal: ac.signal });
    setTimeout(() => ac.abort(), 200);
    const r = await pending;
    expect(r.aborted).toBe(true);
    expect(r.timedOut).toBe(false);
    expect(r.exitCode).toBeNull();
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  test('an already aborted signal spawns nothing', async () => {
    const ac = new AbortController();
    ac.abort();
    const r = await runner.run(node, ['-e', "process.stdout.write('ran')"], { timeoutMs: 20_000, signal: ac.signal });
    expect(r.aborted).toBe(true);
    expect(r.stdout).toBe('');
  });

  test('a binary that does not exist is a result with spawnError', async () => {
    const r = await runner.run('/nonexistent/triage-no-such-binary', [], { timeoutMs: 5_000 });
    expect(r.exitCode).toBeNull();
    expect(r.spawnError).toBe('ENOENT');
  });

  test('bad argv and bad options reject before anything is spawned', async () => {
    await expect(runner.run(node, [1 as unknown as string], { timeoutMs: 1000 })).rejects.toThrow('argv[0] is not a string');
    await expect(runner.run(node, [], { timeoutMs: 0 })).rejects.toThrow('timeoutMs');
    await expect(runner.run(node, [], { timeoutMs: 1000, maxOutputBytes: -1 })).rejects.toThrow('maxOutputBytes');
  });

  test('the no-io guard still blocks a denied binary through the runner', async () => {
    await expect(runner.run('ssh', ['-V'], { timeoutMs: 1000 })).rejects.toThrow('no-io guard');
  });
});

describe('source shape', () => {
  const src = readFileSync(join(import.meta.dir, 'exec.ts'), 'utf8');

  test('execFile is called with shell: false and no other child_process API is used', () => {
    expect(src).toContain('childProcess.execFile(');
    expect(src).toContain('shell: false');
    expect(src).not.toMatch(/childProcess\.(?:exec|spawn|execSync|spawnSync|execFileSync|fork)\s*\(/);
    expect(src).not.toMatch(/shell:\s*true/);
  });
});

describe('createFakeRunner', () => {
  test('answers scripted calls and records them in order', async () => {
    const fake = createFakeRunner([
      { bin: 'qw', argv: ['whoami', '--context', 'ssfb'], result: { stdout: 'me' } },
      { bin: 'kubectl', argv: ['version', '--client'], result: { exitCode: 1, stderr: 'no' } },
    ]);
    const a = await fake.run('kubectl', ['version', '--client'], { timeoutMs: 1000 });
    const b = await fake.run('qw', ['whoami', '--context', 'ssfb'], { timeoutMs: 2000, stdin: 'data' });
    expect(a).toMatchObject({ exitCode: 1, stderr: 'no', timedOut: false, truncated: false });
    expect(b).toMatchObject({ exitCode: 0, stdout: 'me' });
    expect(fake.calls.map((c) => c.bin)).toEqual(['kubectl', 'qw']);
    expect(fake.calls[1]).toEqual({ bin: 'qw', argv: ['whoami', '--context', 'ssfb'], timeoutMs: 2000, stdin: 'data' });
  });

  test('throws on an unscripted bin or argv', async () => {
    const fake = createFakeRunner([{ bin: 'qw', argv: ['whoami'] }]);
    await expect(fake.run('qw', ['whoami', '--extra'], { timeoutMs: 1000 })).rejects.toThrow(UnscriptedExecError);
    await expect(fake.run('ssh', ['whoami'], { timeoutMs: 1000 })).rejects.toThrow(UnscriptedExecError);
    await expect(fake.run('qw', [], { timeoutMs: 1000 })).rejects.toThrow(UnscriptedExecError);
    expect(fake.calls).toHaveLength(0);
    expect(fake.unscripted.map((c) => c.bin)).toEqual(['qw', 'ssh', 'qw']);
  });

  test('an empty script refuses every call', async () => {
    const fake = createFakeRunner([]);
    await expect(fake.run('node', ['-e', '1'], { timeoutMs: 1000 })).rejects.toThrow(UnscriptedExecError);
  });

  test('times limits a step, then the call is unscripted', async () => {
    const fake = createFakeRunner([
      { bin: 'git', argv: ['rev-parse', 'HEAD'], times: 1, result: { stdout: 'abc' } },
      { bin: 'git', argv: ['status'], times: 2 },
    ]);
    expect((await fake.run('git', ['rev-parse', 'HEAD'], { timeoutMs: 1000 })).stdout).toBe('abc');
    await expect(fake.run('git', ['rev-parse', 'HEAD'], { timeoutMs: 1000 })).rejects.toThrow(UnscriptedExecError);
    expect(fake.pending()).toEqual([{ bin: 'git', argv: ['status'], times: 2 }]);
  });

  test('a result function sees the call', async () => {
    const fake = createFakeRunner([{ bin: 'cat', argv: [], result: (call) => ({ stdout: call.stdin ?? '' }) }]);
    expect((await fake.run('cat', [], { timeoutMs: 1000, stdin: new TextEncoder().encode('hi') })).stdout).toBe('hi');
  });

  test('rejects a non-string argv entry like the real runner', async () => {
    const fake = createFakeRunner([{ bin: 'qw', argv: ['1'] }]);
    await expect(fake.run('qw', [1 as unknown as string], { timeoutMs: 1000 })).rejects.toThrow(TypeError);
    expect(fake.unscripted).toHaveLength(0);
  });

  test('an aborted signal gives an aborted result', async () => {
    const ac = new AbortController();
    ac.abort();
    const fake = createFakeRunner([{ bin: 'qw', argv: [], result: { stdout: 'x' } }]);
    const r = await fake.run('qw', [], { timeoutMs: 1000, signal: ac.signal });
    expect(r.aborted).toBe(true);
    expect(r.stdout).toBe('');
  });
});
