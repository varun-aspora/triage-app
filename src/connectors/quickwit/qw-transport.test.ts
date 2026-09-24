import { describe, expect, test } from 'bun:test';
import { qwSafeProblem } from '../../gate/quickwit.ts';
import type { ExecOptions, ExecResult, ExecRunner } from '../exec.ts';
import { createFakeRunner, type FakeStep } from '../exec-fake.ts';
import { ConnectorError, MAX_EXEC_OUTPUT_BYTES } from '../types.ts';
import { groupHits, QW_FLAGS, qwArgv, qwSearch, type QwSearchRequest } from './qw-transport.ts';

const FIELDS = ['service', 'level', 'message', 'timestamp'];

function req(over: Partial<QwSearchRequest> = {}): QwSearchRequest {
  return {
    bin: 'qw',
    context: 'ssfb-prod',
    index: 'logs-v1',
    query: 'service:harbor AND message:"doc fetch failed"',
    mode: 'search',
    fields: FIELDS,
    maxHits: 50,
    since: '2d',
    timeoutMs: 1000,
    signal: new AbortController().signal,
    ...over,
  };
}

/** Wraps a runner so a test can see the exact options the transport passed. */
function spyOptions(inner: ExecRunner): ExecRunner & { opts: ExecOptions[] } {
  const opts: ExecOptions[] = [];
  return {
    opts,
    run(bin, argv, o) {
      opts.push(o);
      return inner.run(bin, argv, o);
    },
  };
}

function step(r: QwSearchRequest, result: FakeStep['result']): FakeStep {
  return { bin: r.bin, argv: qwArgv(r), result };
}

async function errorOf(p: Promise<unknown>): Promise<ConnectorError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ConnectorError);
    return err as ConnectorError;
  }
  throw new Error('expected a ConnectorError');
}

function expectSafeArgv(argv: readonly string[]): void {
  argv.forEach((el, i) => {
    if (QW_FLAGS.has(el)) {
      // A flag is always followed by its value.
      expect(i + 1).toBeLessThan(argv.length);
      expect(QW_FLAGS.has(argv[i + 1] as string)).toBe(false);
      return;
    }
    expect(qwSafeProblem(el)).toBeUndefined();
  });
}

describe('qwArgv', () => {
  test('every mode passes --context with the entity context, exactly once', () => {
    for (const r of [req(), req({ mode: 'count' }), req({ mode: 'histogram', groupBy: 'service' }), req({ context: 'core-prod-london' })]) {
      const argv = qwArgv(r);
      expect(argv.filter((a) => a === '--context')).toHaveLength(1);
      expect(argv[argv.indexOf('--context') + 1]).toBe(r.context);
    }
  });

  test('search: subcommand, index, query, since, max hits, json, fields, context', () => {
    const argv = qwArgv(req());
    expect(argv).toEqual([
      'search',
      'logs-v1',
      'service:harbor AND message:"doc fetch failed"',
      '--since',
      '2d',
      '--max-hits',
      '50',
      '-o',
      'json',
      '--fields',
      'service,level,message,timestamp',
      '--context',
      'ssfb-prod',
    ]);
    expectSafeArgv(argv);
  });

  test('count: no projection and no max hits', () => {
    const argv = qwArgv(req({ mode: 'count' }));
    expect(argv).toEqual(['count', 'logs-v1', 'service:harbor AND message:"doc fetch failed"', '--since', '2d', '-o', 'json', '--context', 'ssfb-prod']);
    expectSafeArgv(argv);
  });

  test('group_by: search projected to the group field (qw histogram is a date histogram)', () => {
    const argv = qwArgv(req({ mode: 'histogram', groupBy: 'error' }));
    expect(argv[0]).toBe('search');
    expect(argv[argv.indexOf('--fields') + 1]).toBe('error');
    expect(argv[argv.indexOf('--max-hits') + 1]).toBe('50');
    expectSafeArgv(argv);
  });

  test('group_by mode without a field is refused', () => {
    expect(() => qwArgv(req({ mode: 'histogram' }))).toThrow(/group_by/);
  });
});

describe('qwSearch argv and charset', () => {
  test('the runner gets QW_BIN and an argv array with --context, -o json and --since, never a shell option', async () => {
    const r = req({ bin: '/usr/local/bin/qw' });
    const fake = createFakeRunner([step(r, { stdout: '{"num_hits":0,"hits":[]}' })]);
    const runner = spyOptions(fake);
    await qwSearch(runner, r);
    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0];
    expect(call?.bin).toBe('/usr/local/bin/qw');
    const argv = call?.argv as readonly string[];
    expect(Array.isArray(argv)).toBe(true);
    expect(argv[argv.indexOf('--context') + 1]).toBe('ssfb-prod');
    expect(argv[argv.indexOf('-o') + 1]).toBe('json');
    expect(argv).toContain('--since');
    expectSafeArgv(argv);
    const opts = runner.opts[0] as ExecOptions & { shell?: unknown };
    expect('shell' in opts).toBe(false);
    expect(opts.maxOutputBytes).toBe(MAX_EXEC_OUTPUT_BYTES);
    expect(opts.timeoutMs).toBe(1000);
  });

  const badQueries: [string, string][] = [
    ['command substitution', 'service:harbor AND $(id)'],
    ['variable expansion', 'service:harbor AND ${HOME}'],
    ['backtick', 'service:harbor AND `id`'],
    ['semicolon', 'service:harbor; rm'],
    ['pipe', 'service:harbor | cat'],
    ['ampersand', 'service:harbor && x'],
    ['newline', 'service:harbor\nAND x'],
    ['NUL', 'service:harbor\u0000'],
    ['leading dash', '--config=/tmp/x'],
    ['empty', ''],
  ];
  for (const [label, query] of badQueries) {
    test(`a query with ${label} is refused before exec`, async () => {
      const fake = createFakeRunner([]);
      const err = await errorOf(qwSearch(fake, req({ query })));
      expect(err.code).toBe('refused');
      expect(fake.calls).toHaveLength(0);
      expect(fake.unscripted).toHaveLength(0);
    });
  }

  test('an unsafe context, index, since or bin is refused before exec', async () => {
    for (const over of [{ context: 'ssfb-prod;id' }, { context: '-x' }, { index: 'logs|x' }, { since: '-1d' }, { bin: '-qw' }]) {
      const fake = createFakeRunner([]);
      const err = await errorOf(qwSearch(fake, req(over)));
      expect(err.code).toBe('refused');
      expect(fake.calls).toHaveLength(0);
    }
  });

  test('the refusal message names the problem, not the value', async () => {
    const err = await errorOf(qwSearch(createFakeRunner([]), req({ context: 'secret-ctx;x' })));
    expect(err.message).not.toContain('secret-ctx');
  });
});

describe('qwSearch output parsing', () => {
  const hit = { service: 'harbor', level: 'error', message: 'doc fetch failed', timestamp: '2026-09-22T10:00:00Z' };

  test('Quickwit-shaped JSON gives hits and num_hits', async () => {
    const r = req();
    const out = await qwSearch(createFakeRunner([step(r, { stdout: JSON.stringify({ num_hits: 7, hits: [hit] }) })]), r);
    expect(out).toEqual({ kind: 'hits', hits: [hit], num_hits: 7 });
  });

  test('a bare JSON array gives hits, num_hits is its length', async () => {
    const r = req();
    const out = await qwSearch(createFakeRunner([step(r, { stdout: JSON.stringify([hit, hit]) })]), r);
    expect(out).toEqual({ kind: 'hits', hits: [hit, hit], num_hits: 2 });
  });

  test('one JSON object per line is read as hits', async () => {
    const r = req();
    const stdout = `${JSON.stringify(hit)}\n${JSON.stringify(hit)}\n`;
    const out = await qwSearch(createFakeRunner([step(r, { stdout })]), r);
    expect(out).toEqual({ kind: 'hits', hits: [hit, hit], num_hits: 2 });
  });

  test('count accepts {count}, {num_hits} and a bare number', async () => {
    const r = req({ mode: 'count' });
    for (const stdout of ['{"count":42}', '{"num_hits":42}', '42\n']) {
      const out = await qwSearch(createFakeRunner([step(r, { stdout })]), r);
      expect(out).toEqual({ kind: 'count', num_hits: 42 });
    }
  });

  test('group_by counts the returned hits per value and flags partial groups', async () => {
    const r = req({ mode: 'histogram', groupBy: 'error' });
    const hits = [{ error: 'b' }, { error: 'a' }, { error: 'b' }, {}];
    const full = await qwSearch(createFakeRunner([step(r, { stdout: JSON.stringify({ num_hits: 4, hits }) })]), r);
    expect(full).toEqual({ kind: 'groups', groups: [{ key: 'b', count: 2 }, { key: 'a', count: 1 }], num_hits: 4, truncated: false });
    const partial = await qwSearch(createFakeRunner([step(r, { stdout: JSON.stringify({ num_hits: 900, hits }) })]), r);
    expect(partial.kind === 'groups' && partial.truncated).toBe(true);
  });

  test('output that is not the expected JSON is unreachable', async () => {
    for (const stdout of ['', 'not json', '{"hits":"x"}', '[1,2]', '{"count":-1}']) {
      const r = req({ mode: stdout.includes('count') ? 'count' : 'search' });
      const err = await errorOf(qwSearch(createFakeRunner([step(r, { stdout })]), r));
      expect(err.code).toBe('unreachable');
    }
  });

  test('output past the cap is cap_exceeded, not a cut JSON parse', async () => {
    const r = req();
    const err = await errorOf(qwSearch(createFakeRunner([step(r, { stdout: '{"num_hits":1,"hi', truncated: true })]), r));
    expect(err.code).toBe('cap_exceeded');
  });
});

describe('qwSearch failures', () => {
  test('stderr saying not logged in gives unreachable with the qw login hint and nothing else from stderr', async () => {
    const r = req();
    const stderr = 'Error: not logged in to context ssfb-prod (endpoint https://qw-endpoint.internal, token abc123SECRET expired)\n';
    const err = await errorOf(qwSearch(createFakeRunner([step(r, { exitCode: 1, stderr })]), r));
    expect(err.code).toBe('unreachable');
    expect(err.message).toContain('qw login --context ssfb-prod');
    expect(err.message).not.toContain('abc123SECRET');
    expect(err.message).not.toContain('qw-endpoint');
    expect(err.message).not.toContain('https://');
  });

  test('other login wordings are recognised too', async () => {
    for (const stderr of ['token has expired, please run `qw login`', 'no cached token for context', '401 Unauthorized']) {
      const r = req();
      const err = await errorOf(qwSearch(createFakeRunner([step(r, { exitCode: 1, stderr })]), r));
      expect(err.message).toContain('qw login');
    }
  });

  test('a login message with empty stdout is unreachable even on exit 0', async () => {
    const r = req();
    const err = await errorOf(qwSearch(createFakeRunner([step(r, { exitCode: 0, stderr: 'not logged in' })]), r));
    expect(err.message).toContain('qw login');
  });

  test('any other non-zero exit is unreachable and leaves stderr out', async () => {
    const r = req();
    const err = await errorOf(qwSearch(createFakeRunner([step(r, { exitCode: 2, stderr: 'dial tcp 10.1.2.3:443: refused' })]), r));
    expect(err.code).toBe('unreachable');
    expect(err.message).toContain('exit code 2');
    expect(err.message).not.toContain('10.1.2.3');
  });

  test('a timeout is timeout', async () => {
    const r = req();
    const err = await errorOf(qwSearch(createFakeRunner([step(r, { exitCode: null, timedOut: true })]), r));
    expect(err.code).toBe('timeout');
  });

  test('a missing binary is unreachable naming QW_BIN', async () => {
    const r = req();
    const err = await errorOf(qwSearch(createFakeRunner([step(r, { exitCode: null, spawnError: 'ENOENT' })]), r));
    expect(err.code).toBe('unreachable');
    expect(err.message).toContain('QW_BIN');
  });

  test('an aborted signal rejects with the abort reason and runs nothing', async () => {
    const ac = new AbortController();
    ac.abort(new Error('stop'));
    const fake = createFakeRunner([]);
    await expect(qwSearch(fake, req({ signal: ac.signal }))).rejects.toThrow('stop');
    expect(fake.calls).toHaveLength(0);
  });

  test('an abort during the run rethrows the abort reason', async () => {
    const ac = new AbortController();
    const runner: ExecRunner = {
      async run(): Promise<ExecResult> {
        ac.abort(new Error('stopped mid-run'));
        return { exitCode: null, stdout: '', stderr: '', timedOut: false, truncated: false, aborted: true };
      },
    };
    await expect(qwSearch(runner, req({ signal: ac.signal }))).rejects.toThrow('stopped mid-run');
  });
});

describe('groupHits', () => {
  test('non-string values are keyed by their JSON text; ties sort by key', () => {
    expect(groupHits([{ s: 500 }, { s: 200 }, { s: 500 }, { s: null }, { s: 404 }], 's')).toEqual([
      { key: '500', count: 2 },
      { key: '200', count: 1 },
      { key: '404', count: 1 },
    ]);
  });
});
