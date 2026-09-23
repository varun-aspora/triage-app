import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';

import { REPORT_STATUSES } from '../types/core.ts';
import { checkPlaceholders, ReportDraftSchema, ReportSchema, SuggestedFixSchema } from './schema.ts';

// All values in the fixture are synthetic and pseudonymised.
const FIXTURE_PATH = join(import.meta.dir, '__fixtures__', 'sample-report.json');
const FIXTURE_TEXT = readFileSync(FIXTURE_PATH, 'utf8');
const sample = (): Record<string, any> => JSON.parse(FIXTURE_TEXT);

const parses = (schema: v.GenericSchema, value: unknown) => v.safeParse(schema, value).success;
const messages = (schema: v.GenericSchema, value: unknown): string[] => {
  const result = v.safeParse(schema, value);
  return result.success ? [] : result.issues.map((i) => i.message);
};

const curlFix = (command: string) => ({
  title: 'Retry dispatch',
  kind: 'curl',
  command,
  preconditions: [],
  verify_with: 'SELECT status FROM card_dispatch_requests WHERE id = $1',
});
const sqlFix = (command: string) => ({ ...curlFix(command), title: 'Read state', kind: 'sql' });
const withFix = (fix: unknown) => ({ ...sample(), suggested_fix: [fix] });

const GOOD_CURL = 'curl -X POST "$SSFB_RHYTHM_API_URL/v1/retry" -H "Authorization: Bearer $TOKEN"';

describe('sample report', () => {
  test('the fixture built from the LLD shape parses', () => {
    const result = v.safeParse(ReportSchema, sample());
    if (!result.success) throw new Error(JSON.stringify(v.flatten(result.issues)));
  });

  test('the draft without harness-filled fields parses', () => {
    const draft = sample();
    for (const key of ['run_id', 'env_label', 'generated_at', 'repo_commits', 'cost']) delete draft[key];
    expect(parses(ReportDraftSchema, draft)).toBe(true);
  });

  test.each([...REPORT_STATUSES])('status %s is accepted', (status) => {
    expect(parses(ReportSchema, { ...sample(), status })).toBe(true);
  });
});

describe('fixture hygiene', () => {
  const strings: string[] = [];
  const walk = (value: unknown) => {
    if (typeof value === 'string') strings.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') {
      for (const [k, inner] of Object.entries(value)) {
        strings.push(k);
        walk(inner);
      }
    }
  };
  walk(sample());

  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const UUID_ANYWHERE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
  const ISO_TS = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;

  test('every id in the id chain is a UUID', () => {
    const ids = Object.values(sample().id_chain.ids) as string[];
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(id).toMatch(UUID);
  });

  test('every UUID-shaped string in the fixture is one of the id chain UUIDs', () => {
    const ids = new Set(Object.values(sample().id_chain.ids) as string[]);
    for (const m of FIXTURE_TEXT.matchAll(UUID_ANYWHERE)) expect(ids.has(m[0])).toBe(true);
  });

  test('no phone or account-number-like digit runs', () => {
    for (const s of strings) {
      const stripped = s.replace(ISO_TS, '').replace(UUID_ANYWHERE, '');
      expect(stripped).not.toMatch(/\d[\d\s-]{8,}\d/);
      expect(stripped).not.toMatch(/\+\d{2}/);
    }
  });

  test('no name-like strings or email addresses', () => {
    for (const s of strings) {
      // Two capitalised words in a row, such as a first and last name.
      expect(s).not.toMatch(/\b[A-Z][a-z]+\s+[A-Z][a-z]+\b/);
      expect(s).not.toMatch(/[^\s@]+@[^\s@]+\.[a-z]{2,}/i);
    }
    expect(sample().request.requested_by).toMatch(/^[a-z0-9-]+$/);
  });
});

describe('suggested_fix', () => {
  test('kind outside curl|sql|manual is rejected', () => {
    expect(parses(ReportSchema, withFix({ ...curlFix(GOOD_CURL), kind: 'bash' }))).toBe(false);
    expect(parses(SuggestedFixSchema, { ...curlFix(GOOD_CURL), kind: 'shell' })).toBe(false);
  });

  test('curl with $SSFB_RHYTHM_API_URL and $TOKEN passes', () => {
    expect(checkPlaceholders(GOOD_CURL, 'curl')).toEqual([]);
    expect(parses(ReportSchema, withFix(curlFix(GOOD_CURL)))).toBe(true);
  });

  test('curl with a literal https host is rejected', () => {
    const cmd = 'curl -X POST "https://rhythm.bank.example/v1/retry" -H "Authorization: Bearer $TOKEN"';
    expect(checkPlaceholders(cmd, 'curl').length).toBeGreaterThan(0);
    expect(parses(ReportSchema, withFix(curlFix(cmd)))).toBe(false);
  });

  test('curl with a bare literal host is rejected', () => {
    expect(checkPlaceholders('curl -s localhost:8080/v1/retry', 'curl')).toContain(
      'curl URL argument 1 must start with a $VAR placeholder',
    );
  });

  test('curl with a literal bearer token is rejected', () => {
    const cmd = 'curl -X POST "$SSFB_RHYTHM_API_URL/v1/retry" -H "Authorization: Bearer abc.def.ghi"';
    const problems = checkPlaceholders(cmd, 'curl');
    expect(problems).toContain('the Authorization header value must be a $VAR placeholder');
    expect(parses(ReportSchema, withFix(curlFix(cmd)))).toBe(false);
  });

  test('a literal token-like header value is rejected', () => {
    const cmd = 'curl "$SSFB_RHYTHM_API_URL/x" -H "X-Api-Token: s3cr3t"';
    expect(checkPlaceholders(cmd, 'curl')).toContain('the X-Api-Token header value must be a $VAR placeholder');
    expect(checkPlaceholders('curl "$SSFB_RHYTHM_API_URL/x" -H "X-Api-Token: ${API_TOKEN}"', 'curl')).toEqual([]);
  });

  test('a literal -u credential is rejected and a placeholder pair passes', () => {
    expect(checkPlaceholders('curl -u admin:hunter2 "$API_URL/x"', 'curl').length).toBeGreaterThan(0);
    expect(checkPlaceholders('curl -u "$API_USER:$API_PASS" "$API_URL/x"', 'curl')).toEqual([]);
  });

  test('a literal token in an inline assignment is rejected', () => {
    expect(checkPlaceholders('TOKEN=abc123 curl "$API_URL/x"', 'curl')).toContain(
      'the inline assignment TOKEN must take a $VAR placeholder',
    );
  });

  test('problems never quote the literal value', () => {
    const problems = checkPlaceholders('curl "https://secret-host.example/x" -H "Authorization: Bearer tok_live_123"', 'curl');
    expect(problems.join(' ')).not.toContain('secret-host');
    expect(problems.join(' ')).not.toContain('tok_live_123');
  });

  test('${VAR}, scheme://$HOST, line continuations and a pipe to jq pass', () => {
    const cmd = [
      'curl -sS -X POST \\',
      '  "${SSFB_RHYTHM_API_URL}/v1/retry" \\',
      '  -H "Authorization: Bearer ${TOKEN}" \\',
      "  -d '{\"form_id\": \"id\"}' | jq .status",
    ].join('\n');
    expect(checkPlaceholders(cmd, 'curl')).toEqual([]);
    expect(checkPlaceholders('curl "https://$RHYTHM_HOST/v1/x" --max-time 10', 'curl')).toEqual([]);
  });

  test('a curl fix that does not run curl is rejected', () => {
    expect(checkPlaceholders('wget "$API_URL/x"', 'curl')).toContain('a curl fix must run curl');
  });

  test('a sql command with a DSN is rejected and one reading $VAR passes', () => {
    const dsn = 'psql "postgres://svc:pw@db.internal:5432/rhythm" -c "SELECT 1"';
    expect(checkPlaceholders(dsn, 'sql').length).toBeGreaterThan(0);
    expect(parses(ReportSchema, withFix(sqlFix(dsn)))).toBe(false);
    const good = 'psql "$SSFB_RHYTHM_DB_URL" -c "SELECT status FROM card_dispatch_requests WHERE id = $1"';
    expect(checkPlaceholders(good, 'sql')).toEqual([]);
    expect(parses(ReportSchema, withFix(sqlFix(good)))).toBe(true);
  });

  test('user:pass@ without a scheme and a psql literal host are rejected', () => {
    expect(checkPlaceholders('psql -d svc:pw@db.internal/rhythm', 'sql').length).toBeGreaterThan(0);
    expect(checkPlaceholders('psql -h db.internal -U svc -c "SELECT 1"', 'sql')).toContain(
      'the psql host must be a $VAR placeholder',
    );
    expect(checkPlaceholders('psql -h "$DB_HOST" -c "SELECT 1"', 'sql')).toEqual([]);
  });

  test('a DSN is rejected in a manual fix, in verify_with and in preconditions', () => {
    expect(checkPlaceholders('Open postgres://db.internal/rhythm and check', 'manual').length).toBeGreaterThan(0);
    const inVerify = { ...curlFix(GOOD_CURL), verify_with: 'psql "postgresql://svc:pw@db/x" -c "SELECT 1"' };
    expect(messages(SuggestedFixSchema, inVerify).join(' ')).toContain('verify_with');
    const inPrecondition = { ...curlFix(GOOD_CURL), preconditions: ['connect with svc:pw@db.internal'] };
    expect(messages(SuggestedFixSchema, inPrecondition).join(' ')).toContain('precondition');
  });

  test('a curl verify_with gets the curl rules', () => {
    const fix = { ...sqlFix('psql "$DB_URL" -c "SELECT 1"'), verify_with: 'curl "https://rhythm.example/status"' };
    expect(parses(SuggestedFixSchema, fix)).toBe(false);
  });
});

describe('point-in-time and escalation rules', () => {
  test('a current_state item without taken_at is rejected', () => {
    const r = sample();
    delete r.current_state[0].taken_at;
    expect(parses(ReportSchema, r)).toBe(false);
  });

  test('a current_state item with a non-ISO taken_at is rejected', () => {
    const r = sample();
    r.current_state[0].taken_at = 'this morning';
    expect(parses(ReportSchema, r)).toBe(false);
  });

  test('escalated true with empty escalation_reasons is rejected', () => {
    expect(messages(ReportSchema, { ...sample(), escalated: true, escalation_reasons: [] })).toContain(
      'escalation_reasons must list at least one reason when escalated is true',
    );
    expect(parses(ReportSchema, { ...sample(), escalated: true, escalation_reasons: ['  '] })).toBe(false);
    const draft = sample();
    for (const key of ['run_id', 'env_label', 'generated_at', 'repo_commits', 'cost']) delete draft[key];
    expect(parses(ReportDraftSchema, { ...draft, escalated: true, escalation_reasons: [] })).toBe(false);
  });

  test('escalated false with no reasons is accepted', () => {
    expect(parses(ReportSchema, { ...sample(), escalated: false, escalation_reasons: [] })).toBe(true);
  });
});

describe('enums', () => {
  test('status outside the five values is rejected', () => {
    expect(parses(ReportSchema, { ...sample(), status: 'done' })).toBe(false);
  });

  const cx = (patch: Record<string, unknown>) => {
    const r = sample();
    return { ...r, cx_answer: { ...r.cx_answer, ...patch } };
  };

  test('unknown action_owner is rejected', () => {
    for (const owner of ['user', 'backend', 'bank', 'unknown']) expect(parses(ReportSchema, cx({ action_owner: owner }))).toBe(true);
    expect(parses(ReportSchema, cx({ action_owner: 'vendor' }))).toBe(false);
  });

  test('money_safe outside yes|no|unknown is rejected', () => {
    for (const value of ['yes', 'no', 'unknown']) expect(parses(ReportSchema, cx({ money_safe: value }))).toBe(true);
    expect(parses(ReportSchema, cx({ money_safe: 'maybe' }))).toBe(false);
  });

  test('should_retry outside yes|no|wait is rejected', () => {
    for (const value of ['yes', 'no', 'wait']) expect(parses(ReportSchema, cx({ should_retry: value }))).toBe(true);
    expect(parses(ReportSchema, cx({ should_retry: 'unknown' }))).toBe(false);
  });

  test('escalate_to is optional', () => {
    const r = sample();
    delete r.cx_answer.escalate_to;
    expect(parses(ReportSchema, r)).toBe(true);
  });
});

describe('root_cause (D42)', () => {
  test('the schema has no root_cause.service field', () => {
    const rootCause = ReportSchema.entries.root_cause.wrapped;
    expect(Object.keys(rootCause.entries)).not.toContain('service');
  });

  test('a service sent by the model does not reach the output', () => {
    const r = sample();
    r.root_cause.service = 'rhythm';
    const out = v.parse(ReportSchema, r);
    expect(out.root_cause).not.toHaveProperty('service');
  });
});
