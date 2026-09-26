import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';

import {
  ACTIONS_BANNER,
  NO_ROOT_CAUSE,
  REPORT_SECTIONS,
  renderReportMarkdown,
  SUGGESTED_FIX_BANNER,
} from './markdown.ts';
import { type Report, ReportSchema } from './schema.ts';

// All values in the fixture are synthetic and pseudonymised.
const FIXTURE_TEXT = readFileSync(join(import.meta.dir, '__fixtures__', 'sample-report.json'), 'utf8');
const sample = (): Report => v.parse(ReportSchema, JSON.parse(FIXTURE_TEXT));
const SOURCE_TEXT = readFileSync(join(import.meta.dir, 'markdown.ts'), 'utf8');

// Level-2 headings outside fenced blocks, as a markdown renderer sees them.
function headings(md: string): string[] {
  const inFence = new Set<number>();
  for (const b of fencedBlocks(md)) {
    for (let i = b.startLine; i <= b.endLine; i++) inFence.add(i);
  }
  return md
    .split('\n')
    .filter((line, i) => !inFence.has(i) && line.startsWith('## '))
    .map((line) => line.slice(3));
}

// The body of one level-2 section, without its heading.
function section(md: string, title: string): string {
  const start = md.indexOf(`\n## ${title}\n`);
  if (start === -1) throw new Error(`section ${title} missing`);
  const bodyStart = start + title.length + 5;
  const next = md.indexOf('\n## ', bodyStart);
  return md.slice(bodyStart, next === -1 ? undefined : next);
}

type Block = { lang: string; body: string; startLine: number; endLine: number };

// A CommonMark-style scan of fenced code blocks: a fence opens with 3+
// backticks and closes only on a line of at least as many backticks.
function fencedBlocks(md: string): Block[] {
  const lines = md.split('\n');
  const blocks: Block[] = [];
  let open: { len: number; lang: string; start: number; body: string[] } | null = null;
  lines.forEach((line, i) => {
    if (open === null) {
      const m = /^ {0,3}(`{3,})([^`]*)$/.exec(line);
      if (m) open = { len: m[1]!.length, lang: m[2]!.trim(), start: i, body: [] };
      return;
    }
    const close = /^ {0,3}(`+)\s*$/.exec(line);
    if (close && close[1]!.length >= open.len) {
      blocks.push({ lang: open.lang, body: open.body.join('\n'), startLine: open.start, endLine: i });
      open = null;
      return;
    }
    open.body.push(line);
  });
  if (open !== null) throw new Error('unclosed fence');
  return blocks;
}

describe('renderReportMarkdown', () => {
  test('sample report matches the committed snapshot', () => {
    expect(renderReportMarkdown(sample())).toMatchSnapshot();
  });

  test('is deterministic for the same input', () => {
    expect(renderReportMarkdown(sample())).toBe(renderReportMarkdown(sample()));
  });

  test('level-2 headings appear in the fixed order', () => {
    expect(headings(renderReportMarkdown(sample()))).toEqual([...REPORT_SECTIONS]);
    expect(REPORT_SECTIONS).toEqual([
      'TL;DR',
      'Customer answer',
      'Current state',
      'Timeline',
      'Findings by entity',
      'Root cause',
      'Scope',
      'Actions',
      'Suggested fixes',
      'Escalation record',
      'Evidence ladder and confidence',
      'Gaps',
      'Cost',
    ]);
  });

  test('header shows run id, env label and generated_at', () => {
    const md = renderReportMarkdown(sample());
    const head = md.slice(0, md.indexOf('\n## '));
    expect(head).toContain('# Triage report `01J8ZQ7XK3PSEUDRUN00000001`');
    expect(head).toContain('- Environment: local');
    expect(head).toContain('- Generated at: 2026-09-20T10:15:00.000Z');
  });

  test('every current_state line carries its taken_at label', () => {
    const r = sample();
    const body = section(renderReportMarkdown(r), 'Current state');
    const lines = body.split('\n').filter((l) => l.startsWith('- '));
    expect(lines).toHaveLength(r.current_state.length);
    r.current_state.forEach((s, i) => {
      expect(lines[i]).toContain(`as of ${s.taken_at}, may have changed since`);
    });
  });

  test('every suggested_fix is in a fenced block under the never-executed banner', () => {
    const r = sample();
    const md = renderReportMarkdown(r);
    const body = section(md, 'Suggested fixes');
    expect(body.trimStart().startsWith(SUGGESTED_FIX_BANNER)).toBe(true);
    const bannerLine = md.split('\n').indexOf(SUGGESTED_FIX_BANNER);
    const escalationLine = md.split('\n').indexOf('## Escalation record');
    const blocks = fencedBlocks(md);
    for (const fix of r.suggested_fix) {
      const block = blocks.find((b) => b.body === fix.command);
      expect(block).toBeDefined();
      expect(block!.startLine).toBeGreaterThan(bannerLine);
      expect(block!.startLine).toBeLessThan(escalationLine);
      expect(block!.lang).toBe({ curl: 'bash', sql: 'sql', manual: 'text' }[fix.kind]);
    }
    // verify_with sits in its own block.
    expect(blocks.some((b) => b.body === r.suggested_fix[0]!.verify_with && b.lang === 'sql')).toBe(true);
    expect(body).toContain('- The stored address has a pincode.');
  });

  test('actions are marked as recommendations', () => {
    const body = section(renderReportMarkdown(sample()), 'Actions');
    expect(body).toContain(ACTIONS_BANNER);
    expect(body).toContain('### CX (recommended)');
    expect(body).toContain('### Engineering (recommended)');
    expect(body).toContain('### Ops and bank (recommended)');
  });

  test('root cause lists code refs and repo commits', () => {
    const body = section(renderReportMarkdown(sample()), 'Root cause');
    expect(body).toContain('`rhythm-service` `src/dispatch/vendor-callback.ts` lines 40-72');
    expect(body).toContain('`rhythm-service` at `abc1234def` on branch `main`');
    expect(body).toContain('`card-dispatch-address-rejected`');
  });

  test('footer uses the team format for evidence ladder and confidence', () => {
    const body = section(renderReportMarkdown(sample()), 'Evidence ladder and confidence');
    expect(body).toContain('Evidence ladder: Code (rungs used in order: DB, Logs, Code)');
    expect(body).toContain(
      'Confidence: High — the vendor rejection is in both the dispatch table and the service logs, and the code shows no retry after it',
    );
  });
});

describe('escaping', () => {
  test('triple backticks inside a command cannot close the fence early', () => {
    const r = sample();
    const command = 'psql "$DB_URL" <<SQL\n```\n## Not a heading\n````\nSELECT 1;\nSQL';
    r.suggested_fix = [{ ...r.suggested_fix[1]!, command }];
    const md = renderReportMarkdown(r);
    const blocks = fencedBlocks(md);
    expect(blocks.some((b) => b.body === command && b.lang === 'sql')).toBe(true);
    expect(md).toContain('`````sql\n');
    expect(headings(md)).toEqual([...REPORT_SECTIONS]);
  });

  test('backticks in reply_text cannot close its fence early', () => {
    const r = sample();
    const reply = 'Please wait.\n```\n# Injected\n```';
    r.cx_answer = { ...r.cx_answer, reply_text: reply };
    const md = renderReportMarkdown(r);
    expect(fencedBlocks(md).some((b) => b.body === reply && b.lang === 'text')).toBe(true);
    expect(headings(md)).toEqual([...REPORT_SECTIONS]);
  });

  test('backticks in verify_with cannot close its fence early', () => {
    const r = sample();
    const verify = "SELECT '```' AS x";
    r.suggested_fix = [{ ...r.suggested_fix[0]!, verify_with: verify }];
    const md = renderReportMarkdown(r);
    expect(fencedBlocks(md).some((b) => b.body === verify)).toBe(true);
  });

  test('single-line text cannot open a fence, heading or HTML', () => {
    const r = sample();
    r.gaps = ['ssfb: tunnel down\n## Fake section\n```bash', '<script>x</script>'];
    r.actions = { ...r.actions, eng: ['```', '# Heading'] };
    r.suggested_fix = [{ ...r.suggested_fix[0]!, title: 'Retry\n## Evil', preconditions: ['```sql'] }];
    const md = renderReportMarkdown(r);
    expect(headings(md)).toEqual([...REPORT_SECTIONS]);
    expect(md).not.toContain('<script>');
    expect(md.split('\n').filter((l) => /^\s*- #/.test(l))).toEqual([]);
    expect(md).toContain('### 1. Retry \\#\\# Evil (curl)');
    // Only the fences the renderer itself writes exist.
    const blocks = fencedBlocks(md);
    expect(blocks.map((b) => b.lang)).toEqual(['text', 'bash', 'sql']);
  });
});

describe('variants', () => {
  test('inconclusive report with root_cause null says so and still lists gaps', () => {
    const r = sample();
    r.status = 'inconclusive';
    r.root_cause = null;
    r.gaps = ['ssfb: logs unreachable for the dispatch window', 'preflight: tunnel did not come up'];
    const md = renderReportMarkdown(r);
    expect(headings(md)).toEqual([...REPORT_SECTIONS]);
    expect(section(md, 'TL;DR')).toContain(NO_ROOT_CAUSE);
    expect(section(md, 'TL;DR')).toContain('Inconclusive');
    expect(section(md, 'Root cause')).toContain(NO_ROOT_CAUSE);
    expect(section(md, 'Root cause')).toContain('`rhythm-service` at `abc1234def`');
    const gaps = section(md, 'Gaps');
    expect(gaps).toContain('- ssfb: logs unreachable for the dispatch window');
    expect(gaps).toContain('- preflight: tunnel did not come up');
    // The entity gap is also grouped under its entity.
    expect(section(md, 'Findings by entity')).toContain('- ssfb: logs unreachable for the dispatch window');
    expect(section(md, 'Findings by entity')).not.toContain('preflight: tunnel');
  });

  test('escalated true lists every reason', () => {
    const r = sample();
    r.escalated = true;
    r.escalation_reasons = ['a write is needed to fix the address', 'money moved without a credit'];
    r.classification = { ...r.classification, tier_override_by: 'cx-oncall' };
    const body = section(renderReportMarkdown(r), 'Escalation record');
    expect(body).toContain('- Escalated: yes');
    expect(body).toContain('  - a write is needed to fix the address');
    expect(body).toContain('  - money moved without a credit');
    expect(body).toContain('- Final tier: mid');
    expect(body).toContain('- Rule fired: `category-default`');
    expect(body).toContain('- Tier override by: cx-oncall');
    expect(body).toContain('- Images seen: no');
  });

  test('escalation record appears when escalated is false', () => {
    const r = sample();
    r.escalated = false;
    r.escalation_reasons = [];
    const md = renderReportMarkdown(r);
    expect(headings(md)).toContain('Escalation record');
    const body = section(md, 'Escalation record');
    expect(body).toContain('- Escalated: no');
    expect(body).toContain('- Reasons: none');
    expect(body).toContain('- Tier override by: nobody');
  });

  test('empty lists and a null cost render placeholders, not missing sections', () => {
    const r = sample();
    r.current_state = [];
    r.timeline = [];
    r.suggested_fix = [];
    r.entities_consulted = [];
    r.evidence_ladder = [];
    r.repo_commits = [];
    r.cost = null;
    r.cx_answer = { ...r.cx_answer, reply_text: '' };
    const md = renderReportMarkdown(r);
    expect(headings(md)).toEqual([...REPORT_SECTIONS]);
    expect(section(md, 'Current state')).toContain('No point-in-time reads recorded.');
    expect(section(md, 'Suggested fixes')).toContain(SUGGESTED_FIX_BANNER);
    expect(section(md, 'Suggested fixes')).toContain('No suggested fixes.');
    expect(section(md, 'Findings by entity')).toContain('No entity was consulted.');
    expect(section(md, 'Evidence ladder and confidence')).toContain('Evidence ladder: none');
    expect(section(md, 'Cost')).toContain('Not costed');
    expect(section(md, 'Customer answer')).toContain('No reply drafted.');
    expect(section(md, 'Gaps')).toContain('No gaps recorded.');
    expect(fencedBlocks(md)).toEqual([]);
  });

  test('cost lists models sorted by name with a USD total when known', () => {
    const r = sample();
    r.cost = {
      models: {
        'fake/strong': { calls: 1, input_tokens: 3000, output_tokens: 500 },
        'fake/mid': { calls: 6, input_tokens: 12000, output_tokens: 1800 },
      },
      wall_ms: 45000,
      usd_total: 0.0123,
    };
    const body = section(renderReportMarkdown(r), 'Cost');
    expect(body).toContain('- USD total: $0.0123');
    expect(body).not.toContain('partial');
    expect(body.indexOf('fake/mid')).toBeLessThan(body.indexOf('fake/strong'));
    // A report from before D59 has no cache or USD per model: those cells show '-'.
    expect(body).toContain('| `fake/mid` | 6 | 12,000 | - | - | 1,800 | - |');
  });

  test('cost shows cache and USD columns and a partial line for unpriced models', () => {
    const r = sample();
    r.cost = {
      models: {
        'anthropic/claude-sonnet-4-5': {
          calls: 4,
          input_tokens: 1350,
          output_tokens: 520,
          cache_read_tokens: 40000,
          cache_write_tokens: 2000,
          usd: 0.0135,
        },
        'faux/cheap': { calls: 3, input_tokens: 90, output_tokens: 30, cache_read_tokens: 0, cache_write_tokens: 0, usd: 0 },
        'openai/gpt-6-sol': { calls: 2, input_tokens: 700, output_tokens: 70, cache_read_tokens: 100, cache_write_tokens: 0 },
      },
      wall_ms: 61000,
      usd_total: 0.0135,
      unpriced_models: ['openai/gpt-6-sol'],
    };
    const body = section(renderReportMarkdown(r), 'Cost');
    expect(body).toContain('- USD total: $0.0135 (partial)');
    expect(body).toContain('- Partial: no pricing for `openai/gpt-6-sol`');
    expect(body).toContain('| Model | Calls | Input tokens | Cache read | Cache write | Output tokens | USD |');
    expect(body).toContain('| `anthropic/claude-sonnet-4-5` | 4 | 1,350 | 40,000 | 2,000 | 520 | $0.0135 |');
    expect(body).toContain('| `faux/cheap` | 3 | 90 | 0 | 0 | 30 | $0.0000 |');
    expect(body).toContain('| `openai/gpt-6-sol` | 2 | 700 | 100 | 0 | 70 | no pricing |');
    expect(body).toMatchSnapshot();
  });

  test('a null cost means no usage was recorded', () => {
    const r = sample();
    r.cost = null;
    expect(section(renderReportMarkdown(r), 'Cost').trim()).toBe('Not costed: no token usage was recorded for this run.');
  });
});

describe('purity', () => {
  test('markdown.ts imports nothing from node:child_process, node:fs or fetch', () => {
    expect(SOURCE_TEXT).not.toMatch(/child_process/);
    expect(SOURCE_TEXT).not.toMatch(/['"](?:node:)?fs(?:\/promises)?['"]/);
    expect(SOURCE_TEXT).not.toMatch(/\bfetch\s*\(/);
    const imports = [...SOURCE_TEXT.matchAll(/^import[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    expect(imports.every((spec) => spec!.startsWith('.'))).toBe(true);
  });

  test('markdown.ts reads no clock or env', () => {
    expect(SOURCE_TEXT).not.toMatch(/process\.env|Date\.now|new Date\(|performance\.now|Bun\./);
  });
});
