import { describe, expect, test } from 'bun:test';
import {
  type Approval,
  type ApprovalInput,
  APPROVED_BY_PATTERN,
  CONFIRM_QUESTION,
  isApproval,
  isYes,
  requireApproval,
} from './approval.ts';

const TEXT = 'Triage report for run 01TEST\nTL;DR: the form is stuck.';
const AT = new Date('2026-09-23T10:00:00.000Z');

type Calls = string[];

function input(over: Partial<ApprovalInput> = {}, answer: string | null = 'y', calls: Calls = []): ApprovalInput {
  return {
    mode: 'cli',
    stdinIsTTY: true,
    yes: false,
    verbatimText: TEXT,
    show: (text) => {
      calls.push(`show:${text}`);
    },
    confirm: async (question) => {
      calls.push(`confirm:${question}`);
      return answer;
    },
    ttyUser: 'operator',
    now: () => AT,
    ...over,
  };
}

describe('exhaustive deny table', () => {
  const modes = ['cli', 'slack', '', 'other'] as const;
  const ttys = [true, false] as const;
  const yeses = [true, false] as const;
  const approvers = { missing: undefined, valid: 'alice@example.com', invalid: 'alice bob' } as const;

  type Expect = { ok: false } | { ok: true; method: 'tty' | 'flag'; by: string };

  function expected(mode: string, tty: boolean, yes: boolean, who: keyof typeof approvers): Expect {
    if (mode !== 'cli') return { ok: false };
    if (who === 'invalid') return { ok: false };
    if (yes && who === 'valid') return { ok: true, method: 'flag', by: 'alice@example.com' };
    if (!yes && who === 'missing' && tty) return { ok: true, method: 'tty', by: 'operator' };
    return { ok: false };
  }

  for (const mode of modes) {
    for (const tty of ttys) {
      for (const yes of yeses) {
        for (const who of Object.keys(approvers) as (keyof typeof approvers)[]) {
          const want = expected(mode, tty, yes, who);
          test(`mode=${JSON.stringify(mode)} tty=${tty} yes=${yes} approvedBy=${who} -> ${want.ok ? 'approve' : 'refuse'}`, async () => {
            // The prompt would say yes, so every refusal here comes from the gate itself.
            const res = await requireApproval(
              input({ mode, stdinIsTTY: tty, yes, approvedBy: approvers[who] }, 'y'),
            );
            expect(res.ok).toBe(want.ok);
            if (res.ok && want.ok) {
              expect(res.approval.method).toBe(want.method);
              expect(res.approval.approved_by).toBe(want.by);
              expect(res.approval.at).toBe(AT.toISOString());
              expect(isApproval(res.approval)).toBe(true);
            }
            if (!res.ok) expect(res.reason.length).toBeGreaterThan(0);
          });
        }
      }
    }
  }

  test('there are 48 cells and exactly 3 approve', () => {
    let approve = 0;
    let total = 0;
    for (const mode of modes)
      for (const tty of ttys)
        for (const yes of yeses)
          for (const who of Object.keys(approvers) as (keyof typeof approvers)[]) {
            total++;
            if (expected(mode, tty, yes, who).ok) approve++;
          }
    expect(total).toBe(48);
    // cli + --yes + valid --approved-by, with and without a TTY (2), and cli + TTY + no flags (1).
    expect(approve).toBe(3);
  });
});

describe('mode refusals', () => {
  test('slack refuses with the v2 message', async () => {
    const res = await requireApproval(input({ mode: 'slack', yes: true, approvedBy: 'alice' }));
    expect(res).toEqual({ ok: false, reason: expect.stringContaining('reserved for v2') });
  });

  for (const mode of ['', '   ', 'CLI', 'auto', 'http', 'cli ']) {
    test(`mode ${JSON.stringify(mode)} refuses`, async () => {
      const res = await requireApproval(input({ mode, yes: true, approvedBy: 'alice' }));
      expect(res.ok).toBe(false);
    });
  }
});

describe('flag combinations', () => {
  test('non-TTY without --yes refuses', async () => {
    const calls: Calls = [];
    const res = await requireApproval(input({ stdinIsTTY: false }, 'y', calls));
    expect(res.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  test('non-TTY with --yes but without --approved-by refuses', async () => {
    const res = await requireApproval(input({ stdinIsTTY: false, yes: true }));
    expect(res).toEqual({ ok: false, reason: expect.stringContaining('--approved-by') });
  });

  test('--approved-by without --yes refuses, with or without a TTY, and never prompts', async () => {
    for (const stdinIsTTY of [true, false]) {
      const calls: Calls = [];
      const res = await requireApproval(input({ stdinIsTTY, approvedBy: 'alice' }, 'y', calls));
      expect(res).toEqual({ ok: false, reason: expect.stringContaining('--yes') });
      expect(calls).toEqual([]);
    }
  });

  test('--yes --approved-by approves with method flag and does not prompt', async () => {
    const calls: Calls = [];
    const res = await requireApproval(input({ stdinIsTTY: false, yes: true, approvedBy: 'alice.b+ops@x-y.io' }, null, calls));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.approval.method).toBe('flag');
      expect(res.approval.approved_by).toBe('alice.b+ops@x-y.io');
    }
    expect(calls).toEqual([]);
  });

  test('empty report text refuses even with flags', async () => {
    const res = await requireApproval(input({ yes: true, approvedBy: 'alice', verbatimText: '  \n' }));
    expect(res.ok).toBe(false);
  });
});

describe('approved_by validation', () => {
  const bad = [
    '',
    'alice bob',
    'alice\nbob',
    'alice\r',
    'alice\t',
    'a;rm -rf',
    'a|b',
    'a&b',
    '$(whoami)',
    '`id`',
    'a>b',
    'a<b',
    "a'b",
    'a"b',
    'a\\b',
    'a*',
    'a/b',
    'x'.repeat(129),
    'ålice',
  ];
  for (const who of bad) {
    test(`refuses ${JSON.stringify(who.length > 20 ? `${who.slice(0, 10)}... (${who.length})` : who)}`, async () => {
      const res = await requireApproval(input({ stdinIsTTY: false, yes: true, approvedBy: who }));
      expect(res.ok).toBe(false);
    });
  }

  test('128 characters is the limit', async () => {
    const res = await requireApproval(input({ stdinIsTTY: false, yes: true, approvedBy: 'x'.repeat(128) }));
    expect(res.ok).toBe(true);
  });

  test('pattern is the documented one', () => {
    expect(APPROVED_BY_PATTERN.source).toBe('^[A-Za-z0-9._@+-]{1,128}$');
  });

  test('a TTY user that fails the pattern refuses instead of prompting', async () => {
    const calls: Calls = [];
    const res = await requireApproval(input({ ttyUser: 'bad user' }, 'y', calls));
    expect(res.ok).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe('prompt answer table', () => {
  const cases: [string | null, boolean][] = [
    ['y', true],
    ['yes', true],
    ['Y', true],
    ['YES', true],
    [' y ', true],
    ['yes\n', true],
    ['\ty\t', true],
    ['', false],
    ['   ', false],
    ['\n', false],
    [null, false],
    ['n', false],
    ['no', false],
    ['N', false],
    ['Y es', false],
    ['ye', false],
    ['yess', false],
    ['yes please', false],
    ['y y', false],
    ['1', false],
    ['true', false],
    ['ok', false],
  ];
  for (const [answer, approves] of cases) {
    test(`${JSON.stringify(answer)} -> ${approves ? 'approve' : 'refuse'}`, async () => {
      expect(isYes(answer)).toBe(approves);
      const res = await requireApproval(input({}, answer));
      expect(res.ok).toBe(approves);
      if (res.ok) {
        expect(res.approval.method).toBe('tty');
        expect(res.approval.approved_by).toBe('operator');
      }
    });
  }

  test('a prompt that throws refuses', async () => {
    const res = await requireApproval(
      input({
        confirm: async () => {
          throw new Error('stdin closed');
        },
      }),
    );
    expect(res.ok).toBe(false);
  });

  test('a display that throws refuses and never asks', async () => {
    const calls: Calls = [];
    const res = await requireApproval(
      input(
        {
          show: () => {
            throw new Error('write failed');
          },
          confirm: async (q) => {
            calls.push(q);
            return 'y';
          },
        },
        'y',
      ),
    );
    expect(res.ok).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe('order', () => {
  test('the verbatim text is shown before confirm is called', async () => {
    const calls: Calls = [];
    await requireApproval(input({}, 'n', calls));
    expect(calls).toEqual([`show:${TEXT}`, `confirm:${CONFIRM_QUESTION}`]);
  });

  test('confirm waits for an async display to finish', async () => {
    const calls: Calls = [];
    await requireApproval(
      input({
        show: async (text) => {
          await Promise.resolve();
          calls.push(`show:${text}`);
        },
        confirm: async (q) => {
          calls.push(`confirm:${q}`);
          return 'y';
        },
      }),
    );
    expect(calls).toEqual([`show:${TEXT}`, `confirm:${CONFIRM_QUESTION}`]);
  });
});

describe('Approval brand', () => {
  test('a hand-built object is not assignable to Approval', () => {
    const handBuilt = { approved_by: 'alice', method: 'flag', at: AT.toISOString() } as const;
    // @ts-expect-error Approval carries a brand only approval.ts can set.
    const forged: Approval = handBuilt;
    expect(isApproval(forged)).toBe(false);
  });

  test('a cast does not pass the runtime check', () => {
    const cast = { approved_by: 'alice', method: 'flag', at: AT.toISOString() } as unknown as Approval;
    expect(isApproval(cast)).toBe(false);
    expect(isApproval(null)).toBe(false);
    expect(isApproval('alice')).toBe(false);
  });

  test('an issued approval is frozen and a copy of it is not an approval', async () => {
    const res = await requireApproval(input({ yes: true, approvedBy: 'alice' }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(Object.isFrozen(res.approval)).toBe(true);
    expect(isApproval({ ...res.approval })).toBe(false);
  });
});
