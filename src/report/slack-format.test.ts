import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';

import { ReportSchema, type Report } from './schema.ts';
import {
  DISCLAIMER,
  formatSlackReport,
  MAX_BULLETS,
  MIN_BULLETS,
  pickBullets,
  pickReviewer,
  type ReviewerTag,
} from './slack-format.ts';

// All values in the fixture are synthetic and pseudonymised.
const FIXTURE_TEXT = readFileSync(join(import.meta.dir, '__fixtures__', 'sample-report.json'), 'utf8');
const sample = (): Report => v.parse(ReportSchema, JSON.parse(FIXTURE_TEXT));

const REVIEWER: ReviewerTag = { kind: 'user', id: 'U0PSEUDO01' };
const GROUP = '@banking-triage';

// The bullets between the TL;DR line and the customer reply.
const bulletLines = (text: string) => {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.startsWith('*TL;DR:*'));
  const end = lines.indexOf('*Reply for the customer*');
  return lines.slice(start + 1, end).filter((line) => line.startsWith('• '));
};

const stateItem = (i: number): Report['current_state'][number] => ({
  item: `state item ${i}`,
  value: `value ${i}`,
  taken_at: `2026-09-20T10:0${i}:00.000Z`,
  source: { source: 'db', entity: 'ssfb', service: 'rhythm' },
});
const timelineItem = (i: number): Report['timeline'][number] => ({
  at: `2026-09-18T08:0${i}:00.000Z`,
  entity: 'ssfb',
  what: `event ${i}`,
  source: { source: 'logs', entity: 'ssfb', service: 'rhythm' },
});
const withCandidates = (state: number, timeline: number, scopeKnown: boolean): Report => ({
  ...sample(),
  current_state: Array.from({ length: state }, (_, i) => stateItem(i)),
  timeline: Array.from({ length: timeline }, (_, i) => timelineItem(i)),
  scope: scopeKnown ? { kind: 'single', affected_count: 1 } : { kind: 'unknown' },
});

describe('formatSlackReport', () => {
  test('the sample report matches the snapshot', () => {
    expect(formatSlackReport(sample(), REVIEWER)).toMatchInlineSnapshot(`
      "<@U0PSEUDO01> please validate this before acting on it. It was written by an automated triage run and may be wrong.
      *Triage report* \`01J8ZQ7XK3PSEUDRUN00000001\` · local

      *TL;DR:* Root cause confirmed. The vendor rejected the dispatch because the address had no pincode, and no retry is scheduled after an address rejection. Confidence: high.
      • *card dispatch request:* ADDRESS_REJECTED (as of 2026-09-20 10:04 UTC)
      • *vendor callback count:* 1 (as of 2026-09-20 10:06 UTC)
      • 2026-09-18 08:30 UTC, ssfb: dispatch request created
      • 2026-09-18 09:10 UTC, ssfb: vendor rejected the address: pincode missing
      • *Scope:* single, 1 affected (count of dispatch requests in ADDRESS_REJECTED for this form)

      *Reply for the customer*
      > The card was not dispatched because the delivery address was incomplete. We are fixing the address and will dispatch it again; no action is needed from the customer.

      *Recommended actions* (recommendations only; nothing has been run)
      _CX_
      • Tell the customer the card will be dispatched again after the address fix.
      _Eng_
      • Add the pincode to the stored address, then trigger dispatch again.

      3 suggested fixes are in report.md with their preconditions. Commands are not posted in Slack."
    `);
  });

  test('the reviewer tag and disclaimer are the first line', () => {
    const [first] = formatSlackReport(sample(), REVIEWER).split('\n');
    expect(first).toBe(`<@U0PSEUDO01> ${DISCLAIMER}`);
    const [groupFirst] = formatSlackReport(sample(), { kind: 'group', handle: 'banking-triage' }).split('\n');
    expect(groupFirst).toBe(`@banking-triage ${DISCLAIMER}`);
  });

  test('sections come in the documented order', () => {
    const text = formatSlackReport(sample(), REVIEWER);
    const order = [
      DISCLAIMER,
      '*Triage report*',
      '*TL;DR:*',
      '• ',
      '*Reply for the customer*',
      '*Recommended actions*',
      'suggested fixes are in report.md',
    ].map((marker) => text.indexOf(marker));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test('the Triage report line carries run_id as code and env_label', () => {
    const report = sample();
    const line = formatSlackReport(report, REVIEWER).split('\n')[1];
    expect(line).toBe(`*Triage report* \`${report.run_id}\` · local`);
  });

  test('ids render inline as code', () => {
    const report = sample();
    report.cx_answer.reply_text = `Form ${report.id_chain.ids.form_id} is waiting.`;
    const text = formatSlackReport(report, REVIEWER);
    expect(text).toContain(`> Form \`${report.id_chain.ids.form_id}\` is waiting.`);
  });

  test('suggested_fix command text never appears', () => {
    const report = sample();
    const text = formatSlackReport(report, REVIEWER);
    for (const fix of report.suggested_fix) {
      expect(text).not.toContain(fix.command);
      if (fix.verify_with !== '') expect(text).not.toContain(fix.verify_with);
    }
    expect(text).not.toContain('curl');
    expect(text).not.toContain('psql');
    expect(text).not.toContain('$SSFB_RHYTHM');
  });

  test('command text copied into actions, bullets or the reply is removed', () => {
    const report = sample();
    const [curlFix, sqlFix] = report.suggested_fix;
    report.actions.eng = [`Run ${curlFix!.command}`];
    report.cx_answer.reply_text = `Please run ${sqlFix!.command}`;
    report.current_state[0]!.value = curlFix!.verify_with;
    const text = formatSlackReport(report, REVIEWER);
    for (const fix of report.suggested_fix) {
      expect(text).not.toContain(fix.command);
      if (fix.verify_with !== '') expect(text).not.toContain(fix.verify_with);
    }
    expect(text).not.toContain('curl');
    expect(text).not.toContain('psql');
    expect(text).toContain('(command in report.md)');
  });

  test('a command split over several lines is removed from one-line text', () => {
    const report = sample();
    report.suggested_fix[0]!.command = 'curl -sS \\\n  "$SSFB_RHYTHM_API_URL/v1/cards/dispatch/retry"';
    report.actions.eng = [report.suggested_fix[0]!.command];
    const text = formatSlackReport(report, REVIEWER);
    expect(text).not.toContain('dispatch/retry');
  });

  test('model text cannot mention channels or open code blocks', () => {
    const report = sample();
    report.cx_answer.reply_text = '<!channel> hi <@U999> ```rm -rf```';
    const text = formatSlackReport(report, REVIEWER);
    expect(text).not.toContain('<!channel>');
    expect(text).not.toContain('<@U999>');
    expect(text).not.toContain('```');
    expect(text).toContain('&lt;!channel&gt;');
  });

  test('a blank reply, no actions and no fixes still render', () => {
    const report: Report = {
      ...sample(),
      root_cause: null,
      status: 'inconclusive',
      suggested_fix: [],
      actions: { cx: [], eng: [], ops_bank: [] },
      cx_answer: { ...sample().cx_answer, reply_text: '  ' },
    };
    const text = formatSlackReport(report, REVIEWER);
    expect(text).toContain('*TL;DR:* Inconclusive. No root cause was confirmed. Confidence: high.');
    expect(text).toContain('_No customer reply was drafted._');
    expect(text).toContain('None recorded.');
    expect(text).toContain('No suggested fixes.');
  });

  test('the formatter is pure: same input, same output', () => {
    expect(formatSlackReport(sample(), REVIEWER)).toBe(formatSlackReport(sample(), REVIEWER));
  });
});

describe('bullet clamp', () => {
  const cases: [string, Report, number][] = [
    ['0 candidates', withCandidates(0, 0, false), MIN_BULLETS],
    ['1 candidate (scope only)', withCandidates(0, 0, true), MIN_BULLETS],
    ['1 candidate (state only)', withCandidates(1, 0, false), MIN_BULLETS],
    ['9 candidates', withCandidates(4, 4, true), MAX_BULLETS],
    ['9 state items', withCandidates(9, 0, false), MAX_BULLETS],
    ['9 timeline events', withCandidates(0, 9, false), MAX_BULLETS],
    ['3 candidates', withCandidates(1, 1, true), 3],
  ];
  for (const [name, report, expected] of cases) {
    test(`${name} gives ${expected} bullets`, () => {
      expect(pickBullets(report)).toHaveLength(expected);
      expect(bulletLines(formatSlackReport(report, REVIEWER))).toHaveLength(expected);
    });
  }

  test('with 0 candidates the fillers say nothing was measured', () => {
    expect(pickBullets(withCandidates(0, 0, false))).toEqual([
      '*Scope:* not measured',
      'Nothing else was recorded; the gaps are listed in report.md',
    ]);
  });

  test('with 9 candidates the scope is kept and state and timeline share the rest', () => {
    const bullets = pickBullets(withCandidates(4, 5, true));
    expect(bullets.filter((b) => b.includes('state item'))).toHaveLength(2);
    // The latest timeline events, in order.
    expect(bullets.filter((b) => b.includes('event'))).toEqual([
      '2026-09-18 08:03 UTC, ssfb: event 3',
      '2026-09-18 08:04 UTC, ssfb: event 4',
    ]);
    expect(bullets.at(-1)).toBe('*Scope:* single, 1 affected');
  });

  test('unused slots go to whichever list has more items', () => {
    const bullets = pickBullets(withCandidates(1, 9, false));
    expect(bullets.filter((b) => b.includes('state item'))).toHaveLength(1);
    expect(bullets.filter((b) => b.includes('event'))).toHaveLength(4);
  });
});

describe('pickReviewer', () => {
  const reviewer = { id: 'U0PSEUDO01', active: true };
  const group = { kind: 'group', handle: GROUP } as const;
  const cases: [string, Parameters<typeof pickReviewer>[0], ReviewerTag][] = [
    ['normal case', { reviewer, approverSlackId: 'U0PSEUDO02', requesterSlackId: 'U0PSEUDO03', fallbackHandle: GROUP }, { kind: 'user', id: 'U0PSEUDO01' }],
    ['normal case without approver or requester', { reviewer, fallbackHandle: GROUP }, { kind: 'user', id: 'U0PSEUDO01' }],
    ['no reviewer', { fallbackHandle: GROUP }, group],
    ['blank reviewer id', { reviewer: { id: '  ', active: true }, fallbackHandle: GROUP }, group],
    ['inactive reviewer', { reviewer: { ...reviewer, active: false }, fallbackHandle: GROUP }, group],
    ['reviewer is the approver', { reviewer, approverSlackId: 'U0PSEUDO01', fallbackHandle: GROUP }, group],
    ['reviewer is the requester', { reviewer, requesterSlackId: ' U0PSEUDO01 ', fallbackHandle: GROUP }, group],
    ['reviewer id is not a Slack id', { reviewer: { id: 'U1> <!channel', active: true }, fallbackHandle: GROUP }, group],
    ['blank approver and requester do not match', { reviewer, approverSlackId: '', requesterSlackId: ' ', fallbackHandle: GROUP }, { kind: 'user', id: 'U0PSEUDO01' }],
  ];
  for (const [name, input, expected] of cases) {
    test(name, () => {
      expect(pickReviewer(input)).toEqual(expected);
    });
  }

  test('a subteam mention is accepted as the fallback', () => {
    expect(pickReviewer({ fallbackHandle: '<!subteam^S0PSEUDO|@banking-triage>' })).toEqual({
      kind: 'group',
      handle: '<!subteam^S0PSEUDO|@banking-triage>',
    });
  });

  test('a blank or malformed fallback handle throws', () => {
    for (const fallbackHandle of ['', '   ', '<!channel>', 'two words', '@here>']) {
      expect(() => pickReviewer({ reviewer, fallbackHandle })).toThrow('SLACK_FALLBACK_GROUP_HANDLE');
    }
  });
});

describe('cost stays out of Slack (D59)', () => {
  // Cost is shown in the web UI, the CLI and report.md only.
  const withCost = (): Report => ({
    ...sample(),
    cost: {
      models: {
        'anthropic/claude-sonnet-4-5': {
          calls: 4,
          input_tokens: 1350,
          output_tokens: 520,
          cache_read_tokens: 40000,
          cache_write_tokens: 2000,
          usd: 0.4213,
        },
        'openai/gpt-6-sol': { calls: 2, input_tokens: 700, output_tokens: 70 },
      },
      wall_ms: 61000,
      usd_total: 0.4213,
      unpriced_models: ['openai/gpt-6-sol'],
    },
  });

  test('a report with cost gives no Cost, no $ and no token wording', () => {
    const report = withCost();
    expect(v.is(ReportSchema, report)).toBe(true);
    for (const tag of [REVIEWER, { kind: 'group', handle: 'banking-triage' } as const]) {
      const text = formatSlackReport(report, tag);
      expect(text).not.toMatch(/\bcost\b/i);
      expect(text).not.toContain('$');
      expect(text).not.toMatch(/token/i);
      expect(text).not.toMatch(/\busd\b/i);
      expect(text).not.toMatch(/pricing|claude-sonnet|gpt-6|cache/i);
    }
  });

  test('the Slack text is the same with and without cost', () => {
    const report = withCost();
    expect(formatSlackReport(report, REVIEWER)).toBe(formatSlackReport({ ...report, cost: null }, REVIEWER));
  });
});

describe('slack-format.ts source', () => {
  const source = readFileSync(join(import.meta.dir, 'slack-format.ts'), 'utf8');

  test('does no network I/O and imports no Slack client', () => {
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/from\s+['"][^'"]*slack-(?:client|post)[^'"]*['"]/);
    expect(source).not.toMatch(/from\s+['"]@slack\//);
    expect(source).not.toMatch(/from\s+['"]@flue\/slack/);
    expect(source).not.toMatch(/from\s+['"]node:(?:http|https|net|child_process)['"]/);
  });

  test('imports only the report schema types', () => {
    const imports = [...source.matchAll(/^import .* from ['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    expect(imports).toEqual(['./schema.ts']);
  });
});
