import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test, type Mock } from 'bun:test';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as v from 'valibot';
import { TriageRequestSchema, type TriageRequest } from '../types/request.ts';
import {
  WORKER_BIN,
  WORKER_COMMAND,
  WorkerSpawnError,
  spawnWorker,
  type SpawnFn,
  type WorkerSpawnOptions,
} from './detach.ts';
import {
  WorkerPayloadError,
  decodePayload,
  encodePayload,
  parsePayload,
  type AskPayload,
  type SubmitPayload,
  type WorkerPayload,
} from './worker-payload.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const RUN_ID = '01K5TESTRUN0000000000000AB';

// Synthetic thread text only.
function request(over: Partial<TriageRequest> = {}): TriageRequest {
  return v.parse(TriageRequestSchema, {
    request_id: RUN_ID,
    interface: 'cli',
    requested_by: 'tester@example.com',
    source: { kind: 'text' },
    messages: [{ ts: '1758362400.000100', author: 'U1', text: 'user stuck on account opening', is_parent: true }],
    attachments: [],
    hints: { entities: ['ssfb'], ids: { form_id: 'F-TEST-1' } },
    window: { from: '2026-09-13T10:00:00.000Z', to: '2026-09-23T12:00:00.000Z' },
    received_at: '2026-09-23T12:00:00.000Z',
    ...over,
  });
}

function submit(over: Partial<SubmitPayload> = {}): SubmitPayload {
  return { kind: 'submit', run_id: RUN_ID, request: request(), redaction_names: ['Test Person'], ...over };
}

function ask(over: Partial<AskPayload> = {}): AskPayload {
  return { kind: 'ask', run_id: RUN_ID, question: 'did the retry go through?', by: 'U2', ...over };
}

function chunked(text: string, size: number): Readable {
  const buf = Buffer.from(text, 'utf8');
  const parts: Buffer[] = [];
  for (let i = 0; i < buf.length; i += size) parts.push(buf.subarray(i, i + size));
  return Readable.from(parts);
}

async function decodeError(p: Promise<unknown>): Promise<WorkerPayloadError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(WorkerPayloadError);
    return err as WorkerPayloadError;
  }
  throw new Error('expected a WorkerPayloadError');
}

// ------------------------------------------------------------ fake spawn

type FakeCall = { command: string; args: readonly string[]; options: WorkerSpawnOptions };

class FakeChild extends EventEmitter {
  pid: number | undefined = 4242;
  unrefCalls = 0;
  stdinChunks: Buffer[] = [];
  stdinEnded = false;
  stdin: Writable | null;

  constructor(opts: { stdinFails?: boolean } = {}) {
    super();
    this.stdin = new Writable({
      write: (chunk: Buffer, _enc, cb) => {
        if (opts.stdinFails) {
          cb(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
          return;
        }
        this.stdinChunks.push(Buffer.from(chunk));
        cb();
      },
      final: (cb) => {
        this.stdinEnded = true;
        cb();
      },
    });
  }

  unref(): void {
    this.unrefCalls += 1;
  }

  stdinText(): string {
    return Buffer.concat(this.stdinChunks).toString('utf8');
  }
}

function fakeSpawn(behaviour: 'start' | 'enoent' | 'epipe' = 'start') {
  const calls: FakeCall[] = [];
  const children: FakeChild[] = [];
  const spawn: SpawnFn = (command, args, options) => {
    calls.push({ command, args: [...args], options });
    const child = new FakeChild({ stdinFails: behaviour === 'epipe' });
    children.push(child);
    process.nextTick(() => {
      if (behaviour === 'enoent') child.emit('error', Object.assign(new Error('spawn node ENOENT'), { code: 'ENOENT' }));
      else child.emit('spawn');
    });
    return child;
  };
  return { spawn, calls, children };
}

// --------------------------------------------------------- payload tests

describe('worker payload', () => {
  test('submit round trip through a chunked stdin stream', async () => {
    const payload = submit();
    const text = encodePayload(payload);
    const decoded = await decodePayload(chunked(text, 7));
    expect(decoded).toEqual(payload);
  });

  test('ask round trip', async () => {
    const payload = ask();
    const decoded = await decodePayload(Readable.from([encodePayload(payload)]));
    expect(decoded).toEqual(payload);
  });

  test('submit without redaction_names is accepted', async () => {
    const { redaction_names: _drop, ...rest } = submit();
    const decoded = await decodePayload(Readable.from([JSON.stringify(rest)]));
    expect(decoded.kind).toBe('submit');
  });

  test('a missing field is rejected and named', async () => {
    const { question: _drop, ...rest } = ask();
    const err = await decodeError(decodePayload(Readable.from([JSON.stringify(rest)])));
    expect(err.field).toBe('question');
    expect(err.message).toContain('question');
  });

  test('a nested bad field is named by its path', async () => {
    const bad = { ...submit(), request: { ...request(), interface: 'fax' } };
    const err = await decodeError(decodePayload(Readable.from([JSON.stringify(bad)])));
    expect(err.field).toBe('request.interface');
  });

  test('an unknown kind is rejected on kind', async () => {
    const err = await decodeError(decodePayload(Readable.from([JSON.stringify({ ...ask(), kind: 'delete' })])));
    expect(err.field).toBe('kind');
  });

  test('an unknown top-level key is rejected', async () => {
    const err = await decodeError(decodePayload(Readable.from([JSON.stringify({ ...ask(), shell: 'ls' })])));
    expect(err.field).toBe('shell');
    expect(err.reason).toBe('is not allowed');
  });

  test('a run_id that differs from request.request_id is rejected', async () => {
    const err = await decodeError(
      decodePayload(Readable.from([JSON.stringify(submit({ run_id: '01K5OTHERRUN000000000000AB' }))])),
    );
    expect(err.field).toBe('run_id');
    expect(err.reason).toBe('must equal request.request_id');
  });

  test('a run_id with path characters is rejected', async () => {
    const err = await decodeError(decodePayload(Readable.from([JSON.stringify(ask({ run_id: '../etc' }))])));
    expect(err.field).toBe('run_id');
  });

  test('the error never quotes the received value', async () => {
    const secretish = 'Customer Name 9876543210';
    const bad = { ...ask(), by: 42, question: secretish };
    const err = await decodeError(decodePayload(Readable.from([JSON.stringify(bad)])));
    expect(err.field).toBe('by');
    expect(err.message).not.toContain('42');
    const bad2 = { ...submit(), request: { ...request(), interface: secretish } };
    const err2 = await decodeError(decodePayload(Readable.from([JSON.stringify(bad2)])));
    expect(err2.message).not.toContain(secretish);
  });

  test('empty stdin, bad JSON and an oversize payload are rejected', async () => {
    expect((await decodeError(decodePayload(Readable.from([])))).reason).toBe('is empty');
    expect((await decodeError(decodePayload(Readable.from(['{not json'])))).reason).toBe('is not valid JSON');
    const big = encodePayload(ask());
    const err = await decodeError(decodePayload(Readable.from([big]), { maxBytes: 10 }));
    expect(err.reason).toContain('larger than 10 bytes');
  });

  test('encodePayload refuses an invalid payload', () => {
    expect(() => encodePayload({ ...ask(), question: '  ' } as WorkerPayload)).toThrow(WorkerPayloadError);
    expect(() => parsePayload(JSON.stringify({ kind: 'ask' }))).toThrow(WorkerPayloadError);
  });
});

// ----------------------------------------------------------- spawn tests

describe('spawnWorker', () => {
  test('argv holds only __worker and the run id; the payload goes on stdin', async () => {
    const fake = fakeSpawn();
    const payload = submit();
    const result = await spawnWorker(payload, { spawn: fake.spawn });

    expect(result).toEqual({ pid: 4242 });
    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0]!;
    expect(call.command).toBe(process.execPath);
    expect(call.args).toEqual([WORKER_BIN, WORKER_COMMAND, RUN_ID]);
    expect(WORKER_COMMAND).toBe('__worker');

    // Nothing from the payload leaks into argv.
    const argvText = [call.command, ...call.args].join(' ');
    expect(argvText).not.toContain('account opening');
    expect(argvText).not.toContain('Test Person');
    expect(argvText).not.toContain('F-TEST-1');

    const child = fake.children[0]!;
    expect(child.stdinEnded).toBe(true);
    expect(parsePayload(child.stdinText())).toEqual(payload);
  });

  test('the child is detached, its output ignored and unref called', async () => {
    const fake = fakeSpawn();
    await spawnWorker(ask(), { spawn: fake.spawn });
    const { options } = fake.calls[0]!;
    expect(options.detached).toBe(true);
    expect(options.stdio).toEqual(['pipe', 'ignore', 'ignore']);
    expect(fake.children[0]!.unrefCalls).toBe(1);
  });

  test('nodePath and binPath overrides reach the spawn call', async () => {
    const fake = fakeSpawn();
    await spawnWorker(ask(), { spawn: fake.spawn, nodePath: '/opt/node', binPath: '/opt/triage.mjs' });
    expect(fake.calls[0]!.command).toBe('/opt/node');
    expect(fake.calls[0]!.args).toEqual(['/opt/triage.mjs', '__worker', RUN_ID]);
  });

  test('WORKER_BIN is the repo bin/triage.mjs', () => {
    expect(WORKER_BIN).toBe(join(ROOT, 'bin', 'triage.mjs'));
    expect(fs.existsSync(WORKER_BIN)).toBe(true);
  });

  test('an invalid payload never starts a process', async () => {
    const fake = fakeSpawn();
    const bad = { ...ask(), by: '' } as WorkerPayload;
    await expect(spawnWorker(bad, { spawn: fake.spawn })).rejects.toBeInstanceOf(WorkerPayloadError);
    expect(fake.calls).toHaveLength(0);
  });

  test('a spawn error rejects with WorkerSpawnError and still unrefs', async () => {
    const fake = fakeSpawn('enoent');
    const p = spawnWorker(ask(), { spawn: fake.spawn });
    await expect(p).rejects.toBeInstanceOf(WorkerSpawnError);
    await expect(p).rejects.toThrow('ENOENT');
    expect(fake.children[0]!.unrefCalls).toBe(1);
  });

  test('a stdin write error rejects with WorkerSpawnError', async () => {
    const fake = fakeSpawn('epipe');
    await expect(spawnWorker(ask(), { spawn: fake.spawn })).rejects.toThrow('stdin EPIPE');
    expect(fake.children[0]!.unrefCalls).toBe(1);
  });

  test('a child without a stdin pipe or a pid is refused', async () => {
    const noStdin: SpawnFn = () => {
      const c = new FakeChild();
      c.stdin = null;
      return c;
    };
    await expect(spawnWorker(ask(), { spawn: noStdin })).rejects.toThrow('no stdin pipe');

    const noPid: SpawnFn = () => {
      const c = new FakeChild();
      c.pid = undefined;
      process.nextTick(() => c.emit('spawn'));
      return c;
    };
    await expect(spawnWorker(ask(), { spawn: noPid })).rejects.toThrow('no pid');
  });
});

// ---------------------------------------------------------- no temp file

describe('spawnWorker writes nothing to disk', () => {
  const syncNames = [
    'writeFileSync', 'appendFileSync', 'openSync', 'writeSync', 'mkdtempSync', 'copyFileSync', 'createWriteStream',
  ] as const;
  const cbNames = ['writeFile', 'appendFile', 'open', 'write', 'mkdtemp', 'copyFile'] as const;
  const promiseNames = ['writeFile', 'appendFile', 'open', 'mkdtemp', 'copyFile'] as const;
  let spies: Mock<(...args: unknown[]) => unknown>[] = [];
  let dir = '';

  beforeAll(() => {
    dir = fs.mkdtempSync(join(tmpdir(), 'detach-test-'));
  });
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function installSpies(): void {
    spies = [
      ...syncNames.map((n) => spyOn(fs, n) as unknown as Mock<(...args: unknown[]) => unknown>),
      ...cbNames.map((n) => spyOn(fs, n) as unknown as Mock<(...args: unknown[]) => unknown>),
      ...promiseNames.map((n) => spyOn(fsp, n) as unknown as Mock<(...args: unknown[]) => unknown>),
    ];
    syncBuiltinESMExports();
  }

  function writeCalls(): number {
    return spies.reduce((n, s) => n + s.mock.calls.length, 0);
  }

  afterEach(() => {
    for (const s of spies) s.mockRestore();
    spies = [];
    syncBuiltinESMExports();
  });

  test('the spy sees a write when one happens (control)', () => {
    installSpies();
    fs.writeFileSync(join(dir, 'control.txt'), 'x');
    expect(writeCalls()).toBe(1);
  });

  test('fs write spy records zero calls during spawnWorker', async () => {
    const fake = fakeSpawn();
    installSpies();
    await spawnWorker(submit(), { spawn: fake.spawn });
    expect(writeCalls()).toBe(0);
  });

  test('neither module imports node:fs', () => {
    for (const f of ['detach.ts', 'worker-payload.ts']) {
      const src = fs.readFileSync(join(ROOT, 'src', 'ingress', f), 'utf8');
      expect(src).not.toMatch(/from\s+['"](?:node:)?fs(?:\/promises)?['"]/);
    }
  });
});

// ------------------------------------------------ a real detached child

describe('spawnWorker with a real node child', () => {
  let dir = '';
  beforeAll(() => {
    dir = fs.mkdtempSync(join(tmpdir(), 'detach-real-'));
  });
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('the child receives the payload on stdin and only the run id on argv', async () => {
    const out = join(dir, 'received.json');
    const script = join(dir, 'worker.mjs');
    const payloadModule = pathToFileURL(join(ROOT, 'src', 'ingress', 'worker-payload.ts')).href;
    // A stand-in for bin/triage.mjs: decode stdin and record what arrived.
    fs.writeFileSync(
      script,
      [
        "import { renameSync, writeFileSync } from 'node:fs';",
        `const { decodePayload } = await import(${JSON.stringify(payloadModule)});`,
        'const payload = await decodePayload(process.stdin);',
        `writeFileSync(${JSON.stringify(out + '.tmp')}, JSON.stringify({ argv: process.argv.slice(2), payload }));`,
        `renameSync(${JSON.stringify(out + '.tmp')}, ${JSON.stringify(out)});`,
      ].join('\n'),
    );

    const payload = submit();
    const { pid } = await spawnWorker(payload, { nodePath: 'node', binPath: script });
    expect(pid).toBeGreaterThan(0);

    const deadline = Date.now() + 15_000;
    while (!fs.existsSync(out) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    expect(fs.existsSync(out)).toBe(true);
    const got = JSON.parse(fs.readFileSync(out, 'utf8')) as { argv: string[]; payload: unknown };
    expect(got.argv).toEqual(['__worker', RUN_ID]);
    expect(got.payload).toEqual(payload);
  }, 20_000);
});
