import { describe, expect, test } from 'bun:test';
import { lintText, parseFrontmatter } from '../../../../test/knowledge/_util.ts';
import type { EntityServices, GuideRow, ServiceRow } from '../../api/types.ts';
import {
  defaultGuideBody,
  envKeyProblem,
  guideMatches,
  guideName,
  knownEnvState,
  leftoverErrors,
  matchesInOtherEntities,
  oneLine,
  registryEntryPreview,
  renderFrontMatter,
  renderSkillFile,
  repoPinAfter,
  repoPinLine,
  serviceKeyProblem,
  serviceMatches,
  servicesWithoutGuide,
  submitErrors,
  suggestDbEnv,
} from './catalog.ts';

const row = (key: string, extra: Partial<ServiceRow> = {}): ServiceRow => ({
  key,
  repo: `${key}-service`,
  quickwit_service: `${key}-service`,
  db_env: null,
  api_env: null,
  transport: null,
  note: null,
  guide: null,
  pending_restart: false,
  ...extra,
});

const groups: EntityServices[] = [
  { entity: 'ssfb', services: [row('reminder', { db_env: { name: 'SSFB_REMINDER_DB_URL', state: 'blank' } }), row('harbor', { guide: { name: 'ssfb-harbor', status: 'ported' } })] },
  { entity: 'rtl', services: [row('banking', { note: 'onboarding part 1' })] },
];

describe('names', () => {
  test('service key rules', () => {
    expect(serviceKeyProblem('reminder', 'rtl', [])).toBeNull();
    expect(serviceKeyProblem('abc2', 'rtl', [])).toBeNull();
    expect(serviceKeyProblem('', 'rtl', [])).not.toBeNull();
    expect(serviceKeyProblem('re-minder', 'rtl', [])).not.toBeNull();
    expect(serviceKeyProblem('re_minder', 'rtl', [])).not.toBeNull();
    expect(serviceKeyProblem('2fa', 'rtl', [])).not.toBeNull();
    expect(serviceKeyProblem('a'.repeat(41), 'rtl', [])).not.toBeNull();
    expect(serviceKeyProblem('overview', 'rtl', [])).not.toBeNull();
    expect(serviceKeyProblem('banking', 'rtl', ['banking'])).toContain('RTL already has');
  });

  test('env key rules', () => {
    expect(envKeyProblem('', 'rtl')).toBeNull();
    expect(envKeyProblem('RTL_REMINDER_DB_URL', 'rtl')).toBeNull();
    expect(envKeyProblem('SSFB_REMINDER_DB_URL', 'rtl')).toBe('Must start with RTL_.');
    expect(envKeyProblem('rtl_reminder', 'rtl')).not.toBeNull();
    expect(envKeyProblem('DATABASE_URL', 'rtl')).not.toBeNull();
  });

  test('suggestions and derived names', () => {
    expect(suggestDbEnv('rtl', 'reminder')).toBe('RTL_REMINDER_DB_URL');
    expect(suggestDbEnv('rtl', '')).toBe('');
    expect(guideName('service', 'rtl', 'reminder')).toBe('rtl-reminder');
    expect(guideName('overview', 'atspl', 'ignored')).toBe('atspl-overview');
    expect(oneLine('a\nb\r\n  c')).toBe('a b c');
  });
});

describe('filters', () => {
  test('service search covers key, repo, log service and note', () => {
    expect(serviceMatches(row('banking', { note: 'Onboarding part 1' }), 'ONBOARD')).toBe(true);
    expect(serviceMatches(row('kyc'), 'kyc-serv')).toBe(true);
    expect(serviceMatches(row('kyc'), 'nope')).toBe(false);
    expect(serviceMatches(row('kyc'), '  ')).toBe(true);
  });

  test('other entities for the no-match state', () => {
    const hits = matchesInOtherEntities(groups, 'rtl', 'reminder');
    expect(hits.map((h) => `${h.entity}:${h.row.key}`)).toEqual(['ssfb:reminder']);
    expect(matchesInOtherEntities(groups, 'rtl', '')).toEqual([]);
  });

  test('services without a guide', () => {
    expect(servicesWithoutGuide(groups, 'ssfb').map((s) => s.key)).toEqual(['reminder']);
    expect(servicesWithoutGuide(groups, 'atspl')).toEqual([]);
  });

  test('known env state comes only from registered services', () => {
    expect(knownEnvState(groups, 'SSFB_REMINDER_DB_URL')).toBe('blank');
    expect(knownEnvState(groups, 'RTL_NEW_DB_URL')).toBeUndefined();
  });

  test('guide filters', () => {
    const g: GuideRow = { name: 'rtl-banking', kind: 'service', entity: 'rtl', service: 'banking', status: 'stub', description: 'Onboarding part 1', sources: null, pending_restart: false };
    const all = { q: '', entity: '', kind: '', status: '' };
    expect(guideMatches(g, all)).toBe(true);
    expect(guideMatches(g, { ...all, q: 'onboarding' })).toBe(true);
    expect(guideMatches(g, { ...all, entity: 'ssfb' })).toBe(false);
    expect(guideMatches(g, { ...all, kind: 'overview' })).toBe(false);
    expect(guideMatches(g, { ...all, status: 'stub' })).toBe(true);
  });
});

describe('previews', () => {
  test('registry entry keeps the server key order and leaves out empty keys', () => {
    const text = registryEntryPreview({ entity: 'rtl', key: 'reminder', repo: 'reminder-service', quickwit_service: 'reminder-service', db_env: 'RTL_REMINDER_DB_URL', api_env: '', note: 'sends\nreminders' });
    expect(text.split('\n')[0]).toBe('// resources/rtl.entity.json  → services');
    const json = JSON.parse(`{${text.split('\n').slice(1).join('\n')}}`) as Record<string, Record<string, string>>;
    expect(Object.keys(json.reminder!)).toEqual(['db', 'quickwit_service', 'repo', 'note']);
    expect(json.reminder!.note).toBe('sends reminders');
  });

  test('repos.json change only when the pin lacks the entity', () => {
    const pin = { repo: 'reminder-service', entities: ['ssfb' as const] };
    expect(repoPinAfter(pin, 'ssfb')).toBeNull();
    expect(repoPinAfter(undefined, 'rtl')).toBeNull();
    const after = repoPinAfter(pin, 'rtl');
    expect(after).not.toBeNull();
    expect(repoPinLine(after!)).toBe('{ "repo": "reminder-service", "entities": ["ssfb", "rtl"] }');
    expect(repoPinLine({ repo: 'x', entities: ['rtl'], branch: 'main' })).toBe('{ "repo": "x", "entities": ["rtl"], "branch": "main" }');
  });

  test('SKILL.md passes the knowledge README front-matter checker', () => {
    const text = renderSkillFile(
      { name: 'rtl-reminder', description: 'Reminders: schedules # and retries, when a nudge is missing', kind: 'service', entity: 'rtl', service: 'reminder', sources: 'rtl/reminder-service/AGENTS.md', status: 'stub' },
      defaultGuideBody('service', 'rtl', 'reminder', 'reminder-service'),
    );
    const parsed = parseFrontmatter(text);
    if ('error' in parsed) throw new Error(parsed.error);
    expect(parsed.frontmatter.name).toBe('rtl-reminder');
    expect(parsed.frontmatter.description).toBe('Reminders: schedules # and retries, when a nudge is missing');
    expect(parsed.frontmatter.metadata).toEqual({ kind: 'service', entity: 'rtl', service: 'reminder', sources: 'rtl/reminder-service/AGENTS.md', status: 'stub' });
    expect(parsed.body).toContain('# reminder (RTL reminder-service)');
    expect(parsed.body).toContain('## Known issues');
  });

  test('the starting bodies pass the knowledge content lint', () => {
    expect(lintText(defaultGuideBody('service', 'rtl', 'reminder', 'reminder-service'))).toEqual([]);
    expect(lintText(defaultGuideBody('overview', 'ssfb', '', null))).toEqual([]);
  });

  test('overview front-matter has no service and empty fields show placeholders', () => {
    const fm = renderFrontMatter({ name: 'rtl-overview', description: '', kind: 'overview', entity: 'rtl', service: 'x', sources: '', status: 'written' });
    expect(fm).not.toContain('service:');
    expect(fm).not.toContain('sources:');
    expect(fm).toContain('description: [what the note covers and when to use it]');
  });
});

describe('submit errors', () => {
  const apiErr = (status: number, body: object) => Object.assign(new Error('x'), { status, body });

  test('400 maps each named field to the reason', () => {
    const e = submitErrors(apiErr(400, { error: 'invalid request', fields: ['db_env'], reason: 'is not in the .env' }));
    expect(e).toEqual({ fields: { db_env: 'is not in the .env' }, form: null });
  });

  test('409 uses the plain copy for the field', () => {
    const e = submitErrors(apiErr(409, { error: 'guide exists', fields: ['key'] }), (f, b) => (f === 'key' ? `${b.error}!` : undefined));
    expect(e.fields.key).toBe('guide exists!');
  });

  test('errors without fields go to the form, and unshown fields are not lost', () => {
    const e = submitErrors(apiErr(409, { error: 'file changed on disk, reload and retry' }));
    expect(e).toEqual({ fields: {}, form: 'file changed on disk, reload and retry' });
    const f = submitErrors(apiErr(400, { error: 'invalid request', fields: ['create_guide'] }));
    expect(leftoverErrors(f, ['key'])).toBe('create_guide: invalid request');
    expect(leftoverErrors({ fields: { key: 'x' }, form: null }, ['key'])).toBeNull();
  });
});
