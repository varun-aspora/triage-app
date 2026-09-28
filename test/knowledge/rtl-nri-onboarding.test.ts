// Checks the rtl-nri-onboarding journey note (plan W12): it is a journey note
// for RTL, has the six sections, names only tools the RTL investigator has,
// cites patterns that exist, and tells the model never to quote the
// workflow-op-service bodies.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JOURNEY_KIND, KNOWLEDGE_DIR, lintText, parseFrontmatter, toolsOutside } from './_util.ts';

const TEXT = readFileSync(join(KNOWLEDGE_DIR, 'rtl-nri-onboarding', 'SKILL.md'), 'utf8');
const PATTERN_IDS = new Set(
  (JSON.parse(readFileSync(join(KNOWLEDGE_DIR, 'patterns', 'patterns.json'), 'utf8')) as { id: string }[]).map((p) => p.id),
);

describe('rtl-nri-onboarding', () => {
  const parsed = parseFrontmatter(TEXT);
  if ('error' in parsed) throw new Error(parsed.error);
  const { frontmatter, body } = parsed;
  const flat = body.replace(/\s+/g, ' ');

  test('is an RTL journey note that passes the lint', () => {
    expect(frontmatter.metadata).toMatchObject({ kind: JOURNEY_KIND, entity: 'rtl' });
    expect(frontmatter.metadata.service).toBeUndefined();
    expect(lintText(TEXT)).toEqual([]);
  });

  test('has the six sections in order', () => {
    const headings = [...body.matchAll(/^## (\d)\. /gm)].map((m) => m[1]);
    expect(headings).toEqual(['1', '2', '3', '4', '5', '6']);
  });

  test('names only tools the RTL investigator has', () => {
    expect(toolsOutside(body, 'investigator', 'rtl')).toEqual([]);
  });

  test('cites patterns that exist', () => {
    const cited = [
      'form-submission-phone-mismatch',
      'form-submission-execution-not-found',
      'rtl-persona-verdict-not-landing',
      'rtl-workflow-revert-stuck',
      'sim-binding-no-vendor-callback',
    ];
    for (const id of cited) expect(body).toContain(`\`${id}\``);
    expect(cited.filter((id) => !PATTERN_IDS.has(id))).toEqual([]);
  });

  test('covers the handoff, the device id and the personal data rule', () => {
    expect(flat).toContain('`workflow-op-service` logs full outbound request and response bodies');
    expect(flat).toContain('Never quote them');
    expect(flat).toContain("columns: ['x-device-id']");
    expect(flat).toMatch(/empty harbor[\s\S]*expected/);
    expect(flat).toContain('naive and stored in UTC');
    expect(flat).toContain('RTL admin APIs are not configured');
  });
});
