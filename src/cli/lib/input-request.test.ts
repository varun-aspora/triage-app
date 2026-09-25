import { describe, expect, test } from 'bun:test';
import type { WorkerPayload } from '../../ingress/worker-payload.ts';
import { sampleBlock, sampleInputRequest } from '../../runstore/contract.ts';
import type { InputRequest } from '../../types/input-request.ts';
import { answerHint, askAtTerminal, blockLines, copyBlock, questionLines, resumeHint, startAnswer } from './input-request.ts';

const RUN_ID = '01JINPUTLIBAAAAAAAAAAAAAAA';

function reader(lines: readonly (string | null)[]) {
  const queue = [...lines];
  const asked: string[] = [];
  return {
    asked,
    read: async (q: string): Promise<string | null> => {
      asked.push(q);
      return queue.length > 0 ? (queue.shift() as string | null) : null;
    },
  };
}

const writer = () => {
  let out = '';
  return { write: (t: string) => void (out += t), text: () => out };
};

describe('questionLines and answerHint', () => {
  test('numbers the options, shows why, and says free text is allowed', () => {
    const lines = questionLines(RUN_ID, sampleInputRequest('q1'));
    expect(lines[0]).toBe(`run ${RUN_ID} needs an answer before it can go on (question q1):`);
    expect(lines).toContain('    1. 2 Sep, 5,000');
    expect(lines).toContain('    2. 3 Sep, 12,000');
    expect(lines).toContain('  or an answer of your own');
    expect(lines.some((l) => l.startsWith('  (Two transfers match'))).toBe(true);
  });

  test('without options there is no options block, and a blank why is left out', () => {
    const q: InputRequest = { ...sampleInputRequest('q2'), options: [], why: ' ' };
    const lines = questionLines(RUN_ID, q);
    expect(lines.join('\n')).not.toContain('options:');
    expect(lines.some((l) => l.startsWith('  ('))).toBe(false);
    expect(answerHint(RUN_ID)).toEqual([`answer with: triage input ${RUN_ID} "<answer>"`, `skip with:   triage input ${RUN_ID} --skip`]);
  });
});

describe('askAtTerminal', () => {
  test('a number picks an option, a blank line asks again, free text is the answer', async () => {
    const w = writer();
    const r = reader(['', '2']);
    expect(await askAtTerminal(w.write, RUN_ID, sampleInputRequest('q1'), r.read)).toEqual({ kind: 'answer', answer: '3 Sep, 12,000' });
    expect(r.asked).toHaveLength(2);
    expect(w.text()).toContain('needs an answer');
    const free = reader(['  neither, it was on 5 Sep  ']);
    expect(await askAtTerminal(w.write, RUN_ID, sampleInputRequest('q1'), free.read)).toEqual({ kind: 'answer', answer: 'neither, it was on 5 Sep' });
  });

  test('s skips, EOF is null, and with free text off only a listed number is taken', async () => {
    const w = writer();
    expect(await askAtTerminal(w.write, RUN_ID, sampleInputRequest('q1'), reader(['S']).read)).toEqual({ kind: 'skip' });
    expect(await askAtTerminal(w.write, RUN_ID, sampleInputRequest('q1'), reader([null]).read)).toBeNull();
    const fixed: InputRequest = { ...sampleInputRequest('q1'), free_text: false };
    const r = reader(['9', 'the second', '1']);
    expect(await askAtTerminal(w.write, RUN_ID, fixed, r.read)).toEqual({ kind: 'answer', answer: '2 Sep, 5,000' });
    expect(r.asked).toHaveLength(3);
    expect(w.text()).toContain('pick one of the options by number');
  });
});

describe('startAnswer', () => {
  test('spawns the answer payload, records the pid and numbers the submission', async () => {
    const phases: unknown[] = [];
    const store = { setPhase: async (...args: unknown[]) => (phases.push(args), true) };
    const spawned: WorkerPayload[] = [];
    const spawn = async (p: WorkerPayload) => {
      spawned.push(p);
      return { pid: 4242 };
    };
    const started = await startAnswer(store, spawn, {
      runId: RUN_ID,
      questionId: 'q1',
      submissions: 3,
      answer: { kind: 'answer', answer: 'the second' },
      ids: { customer_id: 'CUST-1' },
      by: 'ops',
    });
    expect(started).toEqual({ run_id: RUN_ID, question_id: 'q1', submission_id: 4, skipped: false, pid: 4242 });
    expect(spawned).toEqual([{ kind: 'answer', run_id: RUN_ID, question_id: 'q1', by: 'ops', answer: 'the second', ids: { customer_id: 'CUST-1' } }]);
    expect(phases).toEqual([[RUN_ID, 'dispatched', { worker_pid: 4242 }]]);

    const skipped = await startAnswer(store, spawn, { runId: RUN_ID, questionId: 'q2', submissions: 4, answer: { kind: 'skip' }, ids: {}, by: 'ops' });
    expect(skipped.skipped).toBe(true);
    expect(skipped.submission_id).toBe(5);
    // Empty ids are left out of the payload.
    expect(spawned[1]).toEqual({ kind: 'answer', run_id: RUN_ID, question_id: 'q2', by: 'ops', skip: true });
  });
});

describe('blockLines, resumeHint and copyBlock', () => {
  test('names the systems, the reason, each failure with its time, and since when', () => {
    const block = sampleBlock('b1', ['ssfb:harbor', 'global:codegraph']);
    const lines = blockLines(RUN_ID, block);
    expect(lines[0]).toBe(`run ${RUN_ID} is blocked (b1): ssfb:harbor and global:codegraph did not answer`);
    expect(lines).toContain(`  ${block.reason}`);
    expect(lines).toContain('  recorded failures:');
    expect(lines).toContain(`    ${block.failures[0]?.at}  ssfb:harbor  sql_select: unreachable`);
    expect(lines).toContain(`    ${block.failures[1]?.at}  global:codegraph  sql_select: unreachable`);
    expect(lines.at(-1)).toBe(`  blocked since ${block.blocked_at}`);
    expect(resumeHint(RUN_ID)).toEqual([`resume with: triage resume ${RUN_ID} ["<what was fixed, and anything new to consider>"]`]);
  });

  test('three systems are listed with commas, no failures means no failures block, and the copy shares nothing', () => {
    const block = { ...sampleBlock('b2', ['a:x', 'b:y', 'c:z']), failures: [] };
    const lines = blockLines(RUN_ID, block);
    expect(lines[0]).toContain('a:x, b:y and c:z did not answer');
    expect(lines.join('\n')).not.toContain('recorded failures');
    const original = sampleBlock('b3');
    const copy = copyBlock(original);
    expect(copy).toEqual(original);
    expect(copy.systems).not.toBe(original.systems);
    expect(copy.failures[0]).not.toBe(original.failures[0]);
  });
});
