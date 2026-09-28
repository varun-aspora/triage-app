// Checks the plan W13 skill updates (D84): schema lookups in every skill use
// the multi-table form, guardian carries the device path for users who never
// verified and its confirmed columns, harbor says when the form appears, the
// SSFB service notes list the log labels seen in past investigations, and
// frontend-routing says when to read the app code.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KNOWLEDGE_DIR, lintText, parseFrontmatter, toolsOutside, walkKnowledge } from './_util.ts';

function body(skill: string): string {
  const parsed = parseFrontmatter(readFileSync(join(KNOWLEDGE_DIR, skill, 'SKILL.md'), 'utf8'));
  if ('error' in parsed) throw new Error(parsed.error);
  return parsed.body;
}
const flat = (text: string) => text.replace(/\s+/g, ' ');

describe('schema lookups (D84)', () => {
  const files = walkKnowledge(KNOWLEDGE_DIR).filter((f) => f.rel.endsWith('.md'));
  const lookups = files.flatMap((f) =>
    [...readFileSync(f.abs, 'utf8').matchAll(/"(SELECT[^"]*information_schema\.columns[^"]*)"/g)].map((m) => ({ file: f.rel, sql: m[1] as string })),
  );

  test('every column lookup asks for several tables in one call', () => {
    expect(lookups.length).toBeGreaterThan(5);
    for (const l of lookups) {
      expect({ file: l.file, ok: /WHERE table_name IN \(\$1(?:, \$\d)+\)/.test(l.sql) }).toEqual({ file: l.file, ok: true });
      expect({ file: l.file, ok: l.sql.startsWith('SELECT table_name, column_name') }).toEqual({ file: l.file, ok: true });
    }
  });

  test('no skill or method note shows the one-table form', () => {
    for (const f of files) expect({ file: f.rel, one: /table_name = \$1/.test(readFileSync(f.abs, 'utf8')) }).toEqual({ file: f.rel, one: false });
  });

  test('the method says to use the skill column list first', () => {
    const text = flat(readFileSync(join(KNOWLEDGE_DIR, 'method', 'investigator.md'), 'utf8'));
    expect(text).toContain('first use the column list in the service\'s skill');
    expect(text).toContain('`WHERE table_name IN ($1, $2, $3)`');
  });

  test('there are no generated schema files', () => {
    expect(walkKnowledge(KNOWLEDGE_DIR).filter((f) => /schema|\.sql$/i.test(f.rel))).toEqual([]);
  });
});

describe('ssfb-guardian', () => {
  const text = body('ssfb-guardian');
  const t = flat(text);

  test('lists the confirmed device_auth_attempts columns', () => {
    for (const col of ['device_id', 'status', 'verified_at', 'verification_completion_deadline', 'polling_attempts', 'created_at']) {
      expect(t).toContain(`\`${col}\``);
    }
    expect(t).not.toContain('their names are not confirmed');
  });

  test('says an abandoned attempt stays PENDING', () => {
    expect(t).toContain('An abandoned attempt stays PENDING for good');
  });

  test('has the device path for users who never verified, under the journey key rule', () => {
    expect(text).toContain('## Users who never verified: follow the device');
    expect(t).toContain('WHERE device_id = $1');
    expect(t).toContain('`Journey keys:`');
    expect(t).toMatch(/fetched by an id from the chain/);
    expect(t).toMatch(/Rows fetched by the device id do not bring their verification ids into scope/);
  });

  test('says the logs redact phones and gives the inbound SMS trail by exact message', () => {
    expect(t).toContain('A phone search on guardian logs proves nothing');
    const order = ['Twilio callback received', 'Processing Twilio callback', 'Successfully verified token and created session'];
    const at = order.map((label) => t.indexOf(`\`${label}\``));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  test('states the registration limit', () => {
    expect(t).toContain('5 registrations per device in a fixed 24-hour window');
    expect(t).toContain('no row and no log line');
  });

  test('names only tools the SSFB investigator has and passes the lint', () => {
    expect(toolsOutside(text, 'investigator', 'ssfb')).toEqual([]);
    expect(lintText(text)).toEqual([]);
  });
});

describe('ssfb-harbor', () => {
  const t = flat(body('ssfb-harbor'));

  test('the form appears only after SIM binding is VERIFIED', () => {
    expect(t).toContain('writes `external_user_ref`, only after SIM binding is VERIFIED');
  });

  test('the poll lines carry the device and verification id, not the user id', () => {
    expect(t).toMatch(/`checking verification status`[^.]*\. The first carries `device_id`, `verification_id` and `has_data_token`/);
    expect(t).toContain('never the user id');
  });
});

describe('log labels seen in past investigations', () => {
  test.each([
    ['ssfb-harbor', 'checking verification status'],
    ['ssfb-rhythm', 'HTTP Response'],
    ['ssfb-guardian', 'Failed to verify token and create session'],
  ])('%s lists them, including %p', (skill, label) => {
    const text = body(skill);
    expect(text).toContain('Labels seen in past investigations');
    expect(text).toContain(`\`${label}\``);
  });
});

describe('frontend-routing', () => {
  test('says to read the app code when the client cannot report what happened', () => {
    const t = flat(body('frontend-routing'));
    expect(t).toContain('the client cannot report what happened');
    expect(t).toContain('device_binding/');
  });
});
