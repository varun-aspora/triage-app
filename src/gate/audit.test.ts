// All values below are synthetic: made-up phone and account numbers,
// placeholder hosts and credentials.
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as v from 'valibot';
import { AuditLineSchema, type AuditLine } from '../types/audit.ts';
import { type AuditInput, AuditLineError, makeAuditLine, serializeAuditLine } from './audit.ts';
import { createJsonlAuditSink, createMemoryAuditSink } from './audit-sink.ts';

const RUN_ID = '01J8ZQ7XK3TESTRUN0000000000';

function base(over: Partial<AuditInput> = {}): AuditInput {
  return {
    run_id: RUN_ID,
    ts: '2026-09-23T10:00:00.000Z',
    interface: 'cli',
    entity: 'ssfb',
    tool: 'sql_select',
    decision: 'allow',
    service: 'harbor',
    target: 'SSFB_HARBOR_DB_URL',
    transport: 'mock',
    summary: 'select from account_forms, 1 row',
    duration_ms: 12,
    exit: 0,
    ...over,
  };
}

function rejectedFields(fn: () => unknown): readonly string[] {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(AuditLineError);
    return (e as AuditLineError).fields;
  }
  throw new Error('expected makeAuditLine to throw');
}

describe('makeAuditLine: target', () => {
  test('deny: a DSN as target throws, and the error does not repeat it', () => {
    const dsn = 'postgres://u:p@h/db';
    let message = '';
    try {
      makeAuditLine(base({ target: dsn }));
    } catch (e) {
      expect(e).toBeInstanceOf(AuditLineError);
      expect((e as AuditLineError).fields).toEqual(['target']);
      message = (e as Error).message;
    }
    expect(message).not.toBe('');
    expect(message).not.toContain(dsn);
    expect(message).not.toContain('u:p');
  });

  test('deny: a URL as target throws', () => {
    expect(rejectedFields(() => makeAuditLine(base({ target: 'https://h/x' })))).toEqual(['target']);
  });

  test('deny: a token, a lowercase name and an empty string are refused', () => {
    for (const target of ['ghp_abcdefABCDEF0123456789', 'ssfb_harbor_db_url', '', '1SSFB', 'SSFB HARBOR']) {
      expect(rejectedFields(() => makeAuditLine(base({ target })))).toEqual(['target']);
    }
  });

  test('an env var name is accepted and kept as is', () => {
    const line = makeAuditLine(base({ target: 'SSFB_HARBOR_DB_URL' }));
    expect(line.target).toBe('SSFB_HARBOR_DB_URL');
    expect(v.is(AuditLineSchema, line)).toBe(true);
  });
});

describe('makeAuditLine: transport', () => {
  test('deny: a missing transport throws at runtime', () => {
    const { transport: _drop, ...rest } = base();
    expect(rejectedFields(() => makeAuditLine(rest as AuditInput))).toEqual(['transport']);
  });

  test('deny: an unknown transport throws', () => {
    expect(rejectedFields(() => makeAuditLine(base({ transport: 'live' as 'real' })))).toEqual(['transport']);
  });

  test('a missing transport is a type error', () => {
    const { transport: _drop, ...rest } = base();
    // @ts-expect-error transport is required by AuditInput
    const call = () => makeAuditLine(rest);
    expect(call).toThrow(AuditLineError);
  });

  test('real and mock both pass through', () => {
    expect(makeAuditLine(base({ transport: 'real' })).transport).toBe('real');
    expect(makeAuditLine(base({ transport: 'mock' })).transport).toBe('mock');
  });
});

describe('makeAuditLine: deny lines and redaction', () => {
  test('deny: a deny line without a reason throws', () => {
    expect(rejectedFields(() => makeAuditLine(base({ decision: 'deny' })))).toEqual(['reason']);
    expect(rejectedFields(() => makeAuditLine(base({ decision: 'deny', reason: '   ' })))).toEqual(['reason']);
  });

  test('a deny line keeps its reason, with a phone masked', () => {
    const line = makeAuditLine(
      base({ decision: 'deny', reason: 'scope: phone +91 98765 43210 is not in the ID chain', exit: 'refused' }),
    );
    expect(line.decision).toBe('deny');
    expect(line.reason).toBe('scope: phone ****3210 is not in the ID chain');
    expect(serializeAuditLine(line)).not.toContain('98765');
  });

  test('a summary with an account number is ****last4 in the line', () => {
    const line = makeAuditLine(base({ summary: 'account 912010012345678 fetched, 1 row' }));
    expect(line.summary_redacted).toBe('account ****5678 fetched, 1 row');
    expect(serializeAuditLine(line)).not.toContain('912010012345678');
  });

  test('a DSN password in the summary is masked', () => {
    const line = makeAuditLine(base({ summary: 'connect postgres://svc:hunter2pass@db.example.test/harbor failed' }));
    expect(line.summary_redacted).not.toContain('hunter2pass');
  });

  test('names passed in the options are masked', () => {
    const line = makeAuditLine(base({ summary: 'form for Asha Verma' }), { names: ['Asha Verma'] });
    expect(line.summary_redacted).not.toContain('Asha Verma');
  });

  test('properties not in the line shape are dropped', () => {
    const input = { ...base(), plaintext: 'secret value' } as AuditInput;
    const line = makeAuditLine(input);
    expect(Object.keys(line)).not.toContain('plaintext');
    expect(serializeAuditLine(line)).not.toContain('secret value');
  });

  test('schema failures name the field only', () => {
    let err: unknown;
    try {
      makeAuditLine(base({ ts: 'yesterday at 10' }));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AuditLineError);
    expect((err as AuditLineError).fields).toEqual(['ts']);
    expect((err as Error).message).not.toContain('yesterday');
  });
});

describe('makeAuditLine: count-only tools', () => {
  test('a decrypt_fields line has count and no plaintext field', () => {
    const line = makeAuditLine(
      base({ tool: 'decrypt_fields', count: 3, summary: 'decrypted 9876543210, jane@example.com, CIF 12345678' }),
    );
    expect(line.count).toBe(3);
    expect(line.summary_redacted).toBe('decrypt_fields: 3 value(s)');
    const text = serializeAuditLine(line);
    for (const leak of ['9876543210', '3210', 'jane', 'example.com', '12345678', 'CIF']) expect(text).not.toContain(leak);
    expect(Object.keys(line).sort()).toEqual(
      [
        'count',
        'decision',
        'duration_ms',
        'entity',
        'exit',
        'interface',
        'run_id',
        'service',
        'summary_redacted',
        'target',
        'tool',
        'transport',
        'ts',
      ].sort(),
    );
  });

  test('encrypt_lookup_value is count-only too', () => {
    const line = makeAuditLine(base({ tool: 'encrypt_lookup_value', count: 1, summary: 'phone 9876543210' }));
    expect(line.summary_redacted).toBe('encrypt_lookup_value: 1 value(s)');
  });

  test('deny: a decrypt_fields line without count throws', () => {
    expect(rejectedFields(() => makeAuditLine(base({ tool: 'decrypt_fields' })))).toEqual(['count']);
  });

  test('deny: a negative or fractional count throws', () => {
    expect(rejectedFields(() => makeAuditLine(base({ tool: 'decrypt_fields', count: -1 })))).toEqual(['count']);
    expect(rejectedFields(() => makeAuditLine(base({ tool: 'decrypt_fields', count: 1.5 })))).toEqual(['count']);
  });
});

describe('makeAuditLine: HTTP decisions', () => {
  test("an http line with rule_index 'default' and action 'block'", () => {
    const line = makeAuditLine(
      base({
        tool: 'http_call',
        service: 'harbor-admin',
        target: 'SSFB_HARBOR_API_URL',
        decision: 'deny',
        reason: 'POST /v1/trigger-delivery: no rule allows it (default deny)',
        rule_index: 'default',
        action: 'block',
        exit: 'refused',
      }),
    );
    expect(line.rule_index).toBe('default');
    expect(line.action).toBe('block');
    expect(line.reason).toContain('default deny');
  });

  test('an allowed http line carries a numeric rule_index and allow', () => {
    const line = makeAuditLine(
      base({ tool: 'http_call', target: 'SSFB_HARBOR_API_URL', rule_index: 2, action: 'allow', exit: 200 }),
    );
    expect(line.rule_index).toBe(2);
    expect(line.action).toBe('allow');
  });

  test('deny: an allowed http_call or cbs_call without rule_index throws', () => {
    for (const tool of ['http_call', 'cbs_call']) {
      expect(rejectedFields(() => makeAuditLine(base({ tool, target: 'SSFB_HARBOR_API_URL' })))).toEqual(['rule_index']);
    }
  });

  test('a refused http_call before the rules gate may omit rule_index', () => {
    const line = makeAuditLine(
      base({ tool: 'http_call', target: 'SSFB_HARBOR_API_URL', decision: 'deny', reason: 'path contains ..' }),
    );
    expect(line.rule_index).toBeUndefined();
  });

  test('deny: rule_index without action, or action without rule_index, throws', () => {
    expect(rejectedFields(() => makeAuditLine(base({ tool: 'http_call', rule_index: 1 })))).toEqual(['action']);
    expect(rejectedFields(() => makeAuditLine(base({ tool: 'http_call', action: 'allow' })))).toEqual(['rule_index']);
  });

  test("deny: action 'block' on an allow decision throws", () => {
    expect(
      rejectedFields(() => makeAuditLine(base({ tool: 'http_call', rule_index: 0, action: 'block' }))),
    ).toEqual(['decision']);
  });

  test('deny: a negative rule_index throws', () => {
    expect(
      rejectedFields(() => makeAuditLine(base({ tool: 'http_call', rule_index: -1, action: 'allow' }))),
    ).toEqual(['rule_index']);
  });
});

// ------------------------------------------------------------------ sinks

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'triage-audit-'));
  made.push(dir);
  return dir;
}

function readLines(path: string): string[] {
  return readFileSync(path, 'utf8').split('\n').filter((l) => l.length > 0);
}

describe('createJsonlAuditSink', () => {
  test('two writes give two lines in both the global log and the run mirror', () => {
    const dir = tempDir();
    const auditLogPath = join(dir, 'state', 'audit.jsonl');
    const runsDir = join(dir, 'runs');
    const sink = createJsonlAuditSink({ auditLogPath, runsDir });
    const mirror = join(runsDir, RUN_ID, 'audit.jsonl');

    expect(existsSync(join(runsDir, RUN_ID))).toBe(false);
    const first = makeAuditLine(base({ summary: 'first' }));
    sink.write(first);
    expect(existsSync(mirror)).toBe(true);
    const second = makeAuditLine(base({ decision: 'deny', reason: 'second', exit: 'refused' }));
    sink.write(second);

    for (const path of [auditLogPath, mirror]) {
      const lines = readLines(path);
      expect(lines).toHaveLength(2);
      expect(lines.map((l) => JSON.parse(l) as AuditLine)).toEqual([first, second]);
    }
    expect(readFileSync(auditLogPath, 'utf8').endsWith('\n')).toBe(true);
  });

  test('appends to an existing log instead of replacing it', () => {
    const dir = tempDir();
    const opts = { auditLogPath: join(dir, 'audit.jsonl'), runsDir: join(dir, 'runs') };
    createJsonlAuditSink(opts).write(makeAuditLine(base()));
    createJsonlAuditSink(opts).write(makeAuditLine(base()));
    expect(readLines(opts.auditLogPath)).toHaveLength(2);
    expect(readLines(join(opts.runsDir, RUN_ID, 'audit.jsonl'))).toHaveLength(2);
  });

  test('lines from two runs share the global log and get separate mirrors', () => {
    const dir = tempDir();
    const opts = { auditLogPath: join(dir, 'audit.jsonl'), runsDir: join(dir, 'runs') };
    const sink = createJsonlAuditSink(opts);
    sink.write(makeAuditLine(base({ run_id: 'run-a' })));
    sink.write(makeAuditLine(base({ run_id: 'run-b' })));
    expect(readLines(opts.auditLogPath)).toHaveLength(2);
    expect(readLines(join(opts.runsDir, 'run-a', 'audit.jsonl'))).toHaveLength(1);
    expect(readLines(join(opts.runsDir, 'run-b', 'audit.jsonl'))).toHaveLength(1);
  });

  test("a field with '\\n' stays one physical line", () => {
    const dir = tempDir();
    const opts = { auditLogPath: join(dir, 'audit.jsonl'), runsDir: join(dir, 'runs') };
    const line = makeAuditLine(
      base({
        decision: 'deny',
        reason: 'line one\nline two\r\nline three four five',
        summary: 'a\nb',
        exit: 'refused\nx',
      }),
    );
    createJsonlAuditSink(opts).write(line);
    for (const path of [opts.auditLogPath, join(opts.runsDir, RUN_ID, 'audit.jsonl')]) {
      const raw = readFileSync(path, 'utf8');
      expect(raw.split('\n')).toHaveLength(2); // one record plus the trailing newline
      expect(raw).not.toContain('\r');
      expect(raw).not.toContain(' ');
      expect(raw).not.toContain(' ');
      expect(JSON.parse(raw.trimEnd())).toEqual(line);
    }
  });

  test('deny: a line with a bad run_id is refused before any path is built', () => {
    const dir = tempDir();
    const opts = { auditLogPath: join(dir, 'audit.jsonl'), runsDir: join(dir, 'runs') };
    const bad = { ...makeAuditLine(base()), run_id: '../escape' } as AuditLine;
    expect(() => createJsonlAuditSink(opts).write(bad)).toThrow(AuditLineError);
    expect(existsSync(opts.auditLogPath)).toBe(false);
    expect(existsSync(join(dir, 'escape'))).toBe(false);
  });

  test('deny: a hand-built line with a DSN target is refused', () => {
    const dir = tempDir();
    const opts = { auditLogPath: join(dir, 'audit.jsonl'), runsDir: join(dir, 'runs') };
    const bad = { ...makeAuditLine(base()), target: 'postgres://u:p@h/db' } as AuditLine;
    expect(() => createJsonlAuditSink(opts).write(bad)).toThrow(AuditLineError);
    expect(existsSync(opts.auditLogPath)).toBe(false);
  });
});

describe('createMemoryAuditSink', () => {
  test('records lines in write order', () => {
    const sink = createMemoryAuditSink();
    const lines = ['one', 'two', 'three'].map((summary) => makeAuditLine(base({ summary })));
    for (const line of lines) sink.write(line);
    expect(sink.lines.map((l) => l.summary_redacted)).toEqual(['one', 'two', 'three']);
    expect(sink.lines).toEqual(lines);
  });

  test('deny: refuses a line without transport', () => {
    const sink = createMemoryAuditSink();
    const { transport: _drop, ...rest } = makeAuditLine(base());
    expect(() => sink.write(rest as AuditLine)).toThrow(AuditLineError);
    expect(sink.lines).toHaveLength(0);
  });
});

describe('makeAuditLine: sqlstate', () => {
  test('a SQL failure keeps its SQLSTATE; lines without one have no field', () => {
    expect(makeAuditLine(base({ exit: 'query_error', sqlstate: '42703' })).sqlstate).toBe('42703');
    expect('sqlstate' in makeAuditLine(base())).toBe(false);
  });

  test('deny: a value that is not a SQLSTATE throws', () => {
    expect(rejectedFields(() => makeAuditLine(base({ sqlstate: 'column "x" does not exist' })))).toEqual(['sqlstate']);
  });
});
