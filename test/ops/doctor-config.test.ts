import { afterEach, describe, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configFromRecord, type Config } from '../../src/config/env.ts';
import { ConfigError } from '../../src/config/errors.ts';
import { ENTITY_KEY_PATTERN, KEY_BY_NAME } from '../../src/config/keys.ts';
import type { Embedder } from '../../src/embed/index.ts';
import { createFakeModel } from '../../src/mock/fake-model.ts';
import { EMBEDDING_PROBE_TEXT, configChecks } from '../../src/ops/doctor/checks-config.ts';
import { doctorExitCode, renderDoctorTable, runDoctor } from '../../src/ops/doctor/run.ts';
import type { CheckFn, DoctorCheck, DoctorContext, DoctorReport } from '../../src/ops/doctor/types.ts';
import { REPO_ROOT, RESOURCES_DIR, testEnvRecord } from '../support/home.ts';

// ------------------------------------------------------------------ helpers

type HomeOptions = {
  readonly overrides?: Readonly<Record<string, string>>;
  /** Keys removed from the record, so they are absent from the .env. */
  readonly omit?: readonly string[];
  readonly policyChecks?: boolean;
  /** Create <home>/fixtures (default true). */
  readonly fixtures?: boolean;
};

const homes: string[] = [];

afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

// A temp home with resources/ copied in. The config is built with
// configFromRecord so tests can turn policy checks off; no .env is written.
function makeHome(options: HomeOptions = {}): { home: string; config: Config } {
  const home = mkdtempSync(join(tmpdir(), 'triage-doctor-'));
  homes.push(home);
  cpSync(RESOURCES_DIR, join(home, 'resources'), { recursive: true });
  if (options.fixtures !== false) mkdirSync(join(home, 'fixtures'));
  const record: Record<string, string> = { ...testEnvRecord(), ...options.overrides };
  for (const k of options.omit ?? []) delete record[k];
  const config = configFromRecord(record, home, { policyChecks: options.policyChecks });
  return { home, config };
}

async function doctor(ctx: DoctorContext): Promise<DoctorReport> {
  return runDoctor([configChecks], ctx);
}

function rows(report: DoctorReport, id: string): DoctorCheck[] {
  return report.checks.filter((c) => c.id === id);
}

function rowFor(report: DoctorReport, id: string, key: string): DoctorCheck {
  const found = report.checks.filter((c) => c.id === id && c.key_names.includes(key));
  expect(found.length).toBe(1);
  return found[0] as DoctorCheck;
}

const VALID_MODELS = {
  MODEL_DECISION: 'anthropic/claude-haiku-4-5',
  MODEL_TIER_CHEAP: 'anthropic/claude-haiku-4-5',
  MODEL_TIER_MID: 'anthropic/claude-sonnet-4-5',
  MODEL_TIER_STRONG: 'anthropic/claude-opus-4-5',
  ANTHROPIC_API_KEY: 'fake-anthropic-key-0001',
};

function fakeEmbedder(dims: number): Embedder & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    model: 'ollama/fake-embed',
    calls,
    embed: async (texts) => {
      calls.push(texts.map((t) => t.value));
      return texts.map(() => Array.from({ length: dims }, (_, i) => i / dims));
    },
  };
}

// ------------------------------------------------------------------ run.ts

describe('runDoctor', () => {
  const okCheck: CheckFn = async () => [{ id: 'b', status: 'ok', key_names: ['B_KEY'], message: 'B_KEY is set' }];

  test('a check that throws gives one fail row with its id and the others still run', async () => {
    const secret = 'postgresql://leak:hunter2@db.fixture.invalid/x';
    const report = await runDoctor(
      [
        { id: 'boom', run: async () => { throw new Error(`connect failed ${secret}`); } },
        okCheck,
        { id: 'sync-boom', run: () => { throw new TypeError(secret); } },
      ],
      { config: makeHome().config },
    );
    expect(report.checks.map((c) => [c.id, c.status])).toEqual([
      ['boom', 'fail'],
      ['b', 'ok'],
      ['sync-boom', 'fail'],
    ]);
    expect(report.checks[0]?.message).toBe('threw Error');
    expect(report.checks[2]?.message).toBe('threw TypeError');
    const text = renderDoctorTable(report) + JSON.stringify(report);
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('fixture.invalid');
  });

  test('a ConfigError keeps its key-only message and its key names', async () => {
    const report = await runDoctor(
      [{ id: 'cfg', run: async () => { throw ConfigError.of('MODEL_TIER_MID', 'is not set'); } }],
      { config: makeHome().config },
    );
    expect(report.checks).toEqual([
      { id: 'cfg', status: 'fail', key_names: ['MODEL_TIER_MID'], message: 'invalid config: MODEL_TIER_MID is not set' },
    ]);
  });

  test('doctorExitCode is 1 on any fail and 0 otherwise', async () => {
    const config = makeHome().config;
    const of = (...statuses: DoctorCheck['status'][]) =>
      runDoctor([async () => statuses.map((status, i) => ({ id: `c${i}`, status, key_names: [], message: status }))], { config });
    expect(doctorExitCode(await of('ok', 'warn', 'disabled', 'skipped'))).toBe(0);
    expect(doctorExitCode(await of())).toBe(0);
    expect(doctorExitCode(await of('ok', 'fail'))).toBe(1);
    expect(doctorExitCode(await of('fail'))).toBe(1);
  });

  test('rows with no entity come first, then ssfb, atspl, rtl, keeping check order within each', async () => {
    const row = (id: string, entity?: 'ssfb' | 'atspl' | 'rtl') =>
      ({ id, ...(entity !== undefined ? { entity } : {}), status: 'ok', key_names: [], message: id }) as DoctorCheck;
    const report = await runDoctor(
      [
        async () => [row('a', 'rtl'), row('b', 'ssfb'), row('c')],
        async () => [row('d', 'atspl'), row('e'), row('f', 'ssfb'), row('g', 'rtl')],
      ],
      { config: makeHome().config },
    );
    expect(report.checks.map((c) => `${c.id}:${c.entity ?? '-'}`)).toEqual([
      'c:-', 'e:-', 'b:ssfb', 'f:ssfb', 'd:atspl', 'a:rtl', 'g:rtl',
    ]);
  });

  test("sortBy 'check' groups rows by check id, in the order each id first came in", async () => {
    const row = (id: string, entity?: 'ssfb' | 'atspl' | 'rtl') =>
      ({ id, ...(entity !== undefined ? { entity } : {}), status: 'ok', key_names: [], message: id }) as DoctorCheck;
    const report = await runDoctor(
      [
        async () => [row('env', 'rtl'), row('env', 'ssfb'), row('sandbox')],
        async () => [row('db', 'atspl'), row('env'), row('db', 'ssfb')],
      ],
      { config: makeHome().config },
      { sortBy: 'check' },
    );
    expect(report.checks.map((c) => `${c.id}:${c.entity ?? '-'}`)).toEqual([
      'env:rtl', 'env:ssfb', 'env:-', 'sandbox:-', 'db:atspl', 'db:ssfb',
    ]);
  });

  test('table has stable columns and row order (snapshot)', async () => {
    const report = await runDoctor(
      [
        {
          id: 'env',
          run: async () => [
            { id: 'env', entity: 'ssfb', status: 'ok', key_names: ['SSFB_HARBOR_DB_URL'], message: 'db harbor: set' },
            { id: 'env', entity: 'atspl', status: 'disabled', key_names: ['ATSPL_PACKAGE_API_URL'], message: 'api package: ATSPL_PACKAGE_API_URL is blank, so api package is off' },
          ],
        },
        { id: 'sandbox', run: async () => [{ id: 'sandbox', status: 'fail', key_names: ['TRIAGE_SANDBOX_PROVIDER'], message: 'TRIAGE_SANDBOX_PROVIDER is local, which is refused' }] },
        { id: 'models', run: async () => { throw new Error('x'); } },
        { id: 'fixtures', run: async () => [{ id: 'fixtures', status: 'warn', key_names: ['TRIAGE_FIXTURES_DIR'], message: '3 unreviewed fixture file(s)' }] },
        { id: 'embedding', run: async () => [{ id: 'embedding', status: 'skipped', key_names: ['MODEL_EMBEDDING'], message: 'probe skipped in mock mode' }] },
      ],
      { config: makeHome().config },
    );
    const table = renderDoctorTable(report);
    expect(table.split('\n')[0]).toMatch(/^check\s+entity\s+status\s+detail$/);
    expect(table).toMatchSnapshot();
    expect(report.counts).toEqual({ ok: 1, warn: 1, fail: 2, disabled: 1, skipped: 1 });
  });
});

// ------------------------------------------------------------------ secrets

describe('secret leak', () => {
  // Keys with a fixed format the registry or config validates; they keep their test value.
  const FIXED_FORMAT = /_(TRANSPORT|AUTH|MAX_CONCURRENCY|MAX_HITS|ENABLED|REQUIRED|PORT)$/;

  function seeded(): Record<string, string> {
    const out: Record<string, string> = {};
    let n = 0;
    for (const name of Object.keys(testEnvRecord())) {
      const spec = KEY_BY_NAME.get(name);
      const free = spec === undefined ? ENTITY_KEY_PATTERN.test(name) && !FIXED_FORMAT.test(name) : spec.type === 'string';
      if (!free) continue;
      n += 1;
      out[name] = `seeded-secret-${String(n).padStart(3, '0')}-q7z`;
    }
    // Model specs must parse, so the unique part is the model id.
    for (const k of ['MODEL_DECISION', 'MODEL_TIER_CHEAP', 'MODEL_TIER_MID', 'MODEL_TIER_STRONG', 'MODEL_CODE_WALKER', 'TRIAGE_EVAL_JUDGE_MODEL']) {
      out[k] = `anthropic/seeded-model-${k.toLowerCase()}-q7z`;
    }
    out.MODEL_EMBEDDING = 'ollama/seeded-embed-model-q7z';
    out.SSFB_HARBOR_DB_URL = 'postgresql://seeded-user-q7z:<password>@seeded-host-q7z.invalid:5432/db';
    out.SSFB_RHYTHM_DB_URL = 'postgresql://seeded-user2-q7z:seeded-pass-q7z@seeded-host2-q7z.invalid:5432/db';
    out.TRIAGE_DB_URL = './.data/seeded-sqlite-q7z.sqlite';
    return out;
  }

  // The distinctive parts of each seeded value.
  function fragments(values: Record<string, string>): string[] {
    const out = new Set<string>();
    for (const v of Object.values(values)) {
      out.add(v);
      for (const m of v.matchAll(/seeded-[a-z0-9_-]*q7z/g)) out.add(m[0]);
    }
    return [...out];
  }

  test('the table and JSON name keys only, in mock and real mode', async () => {
    const values = seeded();
    expect(Object.keys(values).length).toBeGreaterThan(40);
    for (const mock of ['true', 'false']) {
      const { config } = makeHome({ overrides: { ...values, TRIAGE_MOCK_MODE: mock } });
      const report = await runDoctor([configChecks], { config, embedder: fakeEmbedder(8) });
      const out = renderDoctorTable(report) + JSON.stringify(report, null, 2);
      for (const f of fragments(values)) expect(out).not.toContain(f);
      expect(out).toContain('SSFB_HARBOR_DB_URL');
    }
  });
});

// ------------------------------------------------------------------ env

describe('env check', () => {
  test('a URL still holding <password> is fail naming the key, without the value', async () => {
    const value = 'postgresql://<user>:<password>@db.fixture.invalid:5432/harbor_db';
    const { config } = makeHome({ overrides: { SSFB_HARBOR_DB_URL: value } });
    const report = await doctor({ config });
    const r = rowFor(report, 'env', 'SSFB_HARBOR_DB_URL');
    expect(r.status).toBe('fail');
    expect(r.entity).toBe('ssfb');
    expect(r.message).toContain('SSFB_HARBOR_DB_URL');
    const out = renderDoctorTable(report) + JSON.stringify(report);
    expect(out).not.toContain(value);
    expect(out).not.toContain('db.fixture.invalid');
  });

  test('a set URL without placeholders is ok', async () => {
    const { config } = makeHome({ overrides: { SSFB_HARBOR_DB_URL: 'postgresql://r:p@db.fixture.invalid/harbor' } });
    expect(rowFor(await doctor({ config }), 'env', 'SSFB_HARBOR_DB_URL').status).toBe('ok');
  });

  test('a blank ATSPL_PACKAGE_API_URL gives a disabled row with a reason', async () => {
    const { config } = makeHome({ overrides: { ATSPL_PACKAGE_API_URL: '' } });
    const r = rowFor(await doctor({ config }), 'env', 'ATSPL_PACKAGE_API_URL');
    expect(r.status).toBe('disabled');
    expect(r.entity).toBe('atspl');
    expect(r.message).toContain('ATSPL_PACKAGE_API_URL is blank');
    expect(r.message).toContain('off');
  });

  test('a key missing from the .env is fail naming it', async () => {
    const { config } = makeHome({ omit: ['SSFB_HARBOR_DB_URL'] });
    const report = await doctor({ config });
    const r = rowFor(report, 'env', 'SSFB_HARBOR_DB_URL');
    expect(r.status).toBe('fail');
    expect(r.entity).toBe('ssfb');
    expect(doctorExitCode(report)).toBe(1);
    expect(rows(report, 'rules').map((x) => x.status)).toEqual(['skipped']);
  });

  test('entities outside TRIAGE_ENTITIES are listed as disabled and not checked', async () => {
    const { config } = makeHome({ overrides: { TRIAGE_ENTITIES: 'ssfb' }, omit: ['ATSPL_PACKAGE_API_URL'] });
    const report = await doctor({ config });
    const atspl = rows(report, 'env').filter((r) => r.entity === 'atspl');
    expect(atspl.map((r) => r.status)).toEqual(['disabled']);
    expect(atspl[0]?.message).toContain('not in TRIAGE_ENTITIES');
  });

  test('an unknown entity in TRIAGE_ENTITIES is fail', async () => {
    const { config } = makeHome({ overrides: { TRIAGE_ENTITIES: 'ssfb,nope' } });
    const r = rowFor(await doctor({ config }), 'env', 'TRIAGE_ENTITIES');
    expect(r.status).toBe('fail');
  });
});

// ------------------------------------------------------------------ sandbox

describe('sandbox check', () => {
  const sandbox = async (overrides: Record<string, string>, omit: string[] = []) => {
    const { config } = makeHome({ overrides, omit, policyChecks: false });
    return rows(await doctor({ config }), 'sandbox');
  };

  test('local is fail', async () => {
    const [r] = await sandbox({ TRIAGE_SANDBOX_PROVIDER: 'local' });
    expect(r?.status).toBe('fail');
    expect(r?.message).toContain('refused');
  });

  test('the config loader refuses local when policy checks are on', () => {
    expect(() => makeHome({ overrides: { TRIAGE_SANDBOX_PROVIDER: 'local' } })).toThrow(ConfigError);
  });

  test('e2b or daytona without its key is fail; with it, ok', async () => {
    expect((await sandbox({ TRIAGE_SANDBOX_PROVIDER: 'e2b', E2B_API_KEY: '' }))[0]).toMatchObject({ status: 'fail', key_names: ['TRIAGE_SANDBOX_PROVIDER', 'E2B_API_KEY'] });
    expect((await sandbox({ TRIAGE_SANDBOX_PROVIDER: 'daytona', DAYTONA_API_KEY: '' }))[0]?.status).toBe('fail');
    expect((await sandbox({ TRIAGE_SANDBOX_PROVIDER: 'e2b', E2B_API_KEY: 'fake-e2b-key-01' }))[0]?.status).toBe('ok');
    expect((await sandbox({ TRIAGE_SANDBOX_PROVIDER: 'daytona', DAYTONA_API_KEY: 'fake-daytona-01' }))[0]?.status).toBe('ok');
  });

  test('an unset provider defaults to virtual and is ok', async () => {
    const [r] = await sandbox({}, ['TRIAGE_SANDBOX_PROVIDER']);
    expect(r?.status).toBe('ok');
    expect(r?.message).toContain('virtual');
  });
});

// ------------------------------------------------------------------ models

describe('models check', () => {
  const models = async (overrides: Record<string, string>, extra: Partial<DoctorContext> = {}) => {
    const { config } = makeHome({ overrides: { ...VALID_MODELS, ...overrides } });
    return rows(await doctor({ config, ...extra }), 'models');
  };
  const slot = (rs: DoctorCheck[], key: string) => rs.find((r) => r.key_names[0] === key && !r.message.includes('image'));

  test('valid anthropic specs with the key set are ok', async () => {
    const rs = await models({}, { modelLookup: () => ({ input: ['text', 'image'] }) });
    expect(rs.every((r) => r.status === 'ok' || r.status === 'disabled')).toBe(true);
  });

  test('openrouter on a tier is fail; on the classifier it is ok', async () => {
    const rs = await models({ MODEL_TIER_MID: 'openrouter/x', MODEL_DECISION: 'openrouter/x', OPENROUTER_API_KEY: 'fake-or-key-01' });
    expect(slot(rs, 'MODEL_TIER_MID')?.status).toBe('fail');
    expect(slot(rs, 'MODEL_DECISION')?.status).toBe('ok');
  });

  test('openrouter on the classifier with a blank OPENROUTER_API_KEY is fail', async () => {
    const rs = await models({ MODEL_DECISION: 'openrouter/x', OPENROUTER_API_KEY: '' });
    expect(slot(rs, 'MODEL_DECISION')).toMatchObject({ status: 'fail', key_names: ['MODEL_DECISION', 'OPENROUTER_API_KEY'] });
  });

  test('typesafe on the classifier is ok with TYPESAFE_API_KEY and fail without it', async () => {
    const ok = await models({ MODEL_DECISION: 'typesafe/jev-1.13', TYPESAFE_API_KEY: 'fake-ts-key-01' });
    expect(slot(ok, 'MODEL_DECISION')?.status).toBe('ok');
    const blank = await models({ MODEL_DECISION: 'typesafe/jev-1.13', TYPESAFE_API_KEY: '' });
    expect(slot(blank, 'MODEL_DECISION')).toMatchObject({ status: 'fail', key_names: ['MODEL_DECISION', 'TYPESAFE_API_KEY'] });
  });

  test('openrouter/typesafe on the classifier needs OPENROUTER_API_KEY', async () => {
    const rs = await models({ MODEL_DECISION: 'openrouter/typesafe/jev-1.13', OPENROUTER_API_KEY: 'fake-or-key-01' });
    expect(slot(rs, 'MODEL_DECISION')?.status).toBe('ok');
  });

  test('typesafe on a tier or the judge is fail', async () => {
    const rs = await models({ MODEL_TIER_MID: 'typesafe/jev-1.13', TRIAGE_EVAL_JUDGE_MODEL: 'typesafe/jev-1.13', TYPESAFE_API_KEY: 'fake-ts-key-01' });
    expect(slot(rs, 'MODEL_TIER_MID')?.status).toBe('fail');
    expect(slot(rs, 'TRIAGE_EVAL_JUDGE_MODEL')?.status).toBe('fail');
  });

  test('openrouter on the code walker and the judge is fail', async () => {
    const rs = await models({ MODEL_CODE_WALKER: 'openrouter/x', TRIAGE_EVAL_JUDGE_MODEL: 'openrouter/x', OPENROUTER_API_KEY: 'fake-or-key-01' });
    expect(slot(rs, 'MODEL_CODE_WALKER')?.status).toBe('fail');
    expect(slot(rs, 'TRIAGE_EVAL_JUDGE_MODEL')?.status).toBe('fail');
  });

  test('anthropic/* with a blank ANTHROPIC_API_KEY is fail', async () => {
    const rs = await models({ ANTHROPIC_API_KEY: '' });
    const r = slot(rs, 'MODEL_TIER_CHEAP');
    expect(r?.status).toBe('fail');
    expect(r?.key_names).toEqual(['MODEL_TIER_CHEAP', 'ANTHROPIC_API_KEY']);
  });

  test('a blank tier or an unparseable spec is fail', async () => {
    const rs = await models({ MODEL_TIER_CHEAP: '', MODEL_TIER_MID: 'no-slash' });
    expect(slot(rs, 'MODEL_TIER_CHEAP')?.status).toBe('fail');
    expect(slot(rs, 'MODEL_TIER_MID')?.status).toBe('fail');
  });

  test('MODEL_TIER_STRONG on a text-only faux model is fail; on faux/strong it is ok', async () => {
    createFakeModel().install();
    const textOnly = await models({ MODEL_TIER_STRONG: 'faux/mid' });
    const image = textOnly.find((r) => r.message.includes('image'));
    expect(image?.status).toBe('fail');
    expect(image?.key_names).toEqual(['MODEL_TIER_STRONG']);
    const withImage = await models({ MODEL_TIER_STRONG: 'faux/strong' });
    expect(withImage.find((r) => r.message.includes('image'))?.status).toBe('ok');
  });

  test('a strong model unknown to the metadata is a warning', async () => {
    const rs = await models({}, { modelLookup: () => undefined });
    expect(rs.find((r) => r.message.includes('image'))?.status).toBe('warn');
  });

  test('a model the catalog lacks triggers one refresh, reported in its own row', async () => {
    const seen: string[] = [];
    const rs = await models(
      { MODEL_TIER_MID: 'openai/gpt-t9-doctor', OPENAI_API_KEY: 'fake-openai-key-01' },
      {
        ensureModels: async (config) => {
          seen.push(config.models.tierMid ?? '');
          return { refreshed: [{ provider: 'openai', ok: true, added: ['gpt-t9-doctor'] }], missing: [] };
        },
      },
    );
    expect(seen).toEqual(['openai/gpt-t9-doctor']);
    expect(rs[0]?.message).toBe('refreshed the openai catalog: 1 models beyond the installed pi-ai');
  });

  test('a refreshable model still unknown after the refresh is a fail', async () => {
    const rs = await models(
      { MODEL_TIER_MID: 'openai/gpt-t9-never', OPENAI_API_KEY: 'fake-openai-key-01' },
      { ensureModels: async () => ({ refreshed: [{ provider: 'openai', ok: false, error: 'offline' }], missing: [] }) },
    );
    expect(rs[0]).toMatchObject({ status: 'warn', message: 'could not refresh the openai catalog: offline' });
    expect(slot(rs, 'MODEL_TIER_MID')).toMatchObject({
      status: 'fail',
      message: 'MODEL_TIER_MID is not in the openai catalog, even after a catalog refresh',
    });
  });

  test('a blank judge is disabled and a blank code walker falls back to the strong tier', async () => {
    const rs = await models({ TRIAGE_EVAL_JUDGE_MODEL: '', MODEL_CODE_WALKER: '' });
    expect(slot(rs, 'TRIAGE_EVAL_JUDGE_MODEL')?.status).toBe('disabled');
    expect(slot(rs, 'MODEL_CODE_WALKER')?.status).toBe('ok');
  });
});

// ------------------------------------------------------------------ embedding

describe('tracing check (D82)', () => {
  const ON = { TRIAGE_BRAINTRUST_ENABLED: 'true', BRAINTRUST_API_KEY: 'seeded-braintrust-key-q7z' };

  test('off by default', async () => {
    const report = await doctor({ config: makeHome().config });
    expect(rows(report, 'tracing')).toEqual([
      { id: 'tracing', status: 'disabled', key_names: ['TRIAGE_BRAINTRUST_ENABLED'], message: 'tracing off: TRIAGE_BRAINTRUST_ENABLED is false' },
    ]);
  });

  test('on: the project name and content mode, never the key', async () => {
    const report = await doctor({ config: makeHome({ overrides: { ...ON, BRAINTRUST_PROJECT_NAME: 'triage-app-dev' } }).config });
    const r = rowFor(report, 'tracing', 'TRIAGE_BRAINTRUST_ENABLED');
    expect(r.status).toBe('ok');
    expect(r.message).toBe('tracing on: project triage-app-dev, content metadata');
    expect(r.key_names).toEqual(['TRIAGE_BRAINTRUST_ENABLED', 'BRAINTRUST_API_KEY', 'BRAINTRUST_PROJECT_NAME', 'TRIAGE_BRAINTRUST_CONTENT']);
    expect(renderDoctorTable(report) + JSON.stringify(report)).not.toContain('seeded-braintrust-key-q7z');
  });

  test('redacted content and an app URL: the URL is named, not printed', async () => {
    const url = 'https://seeded-braintrust-host-q7z.invalid';
    const config = makeHome({ overrides: { ...ON, TRIAGE_BRAINTRUST_CONTENT: 'redacted', BRAINTRUST_APP_URL: url } }).config;
    const report = await doctor({ config });
    const r = rowFor(report, 'tracing', 'BRAINTRUST_APP_URL');
    expect(r.message).toBe('tracing on: project triage-app, content redacted, data plane from BRAINTRUST_APP_URL');
    const out = renderDoctorTable(report) + JSON.stringify(report);
    expect(out).not.toContain('seeded-braintrust-host-q7z');
    expect(out).not.toContain('seeded-braintrust-key-q7z');
  });
});

describe('embedding check', () => {
  const embedding = async (overrides: Record<string, string>, embedder?: Embedder) => {
    const { config } = makeHome({ overrides });
    return rows(await doctor({ config, embedder }), 'embedding');
  };

  test('blank MODEL_EMBEDDING gives a disabled "embeddings off" row', async () => {
    const [r] = await embedding({ MODEL_EMBEDDING: '' });
    expect(r?.status).toBe('disabled');
    expect(r?.message).toContain('embeddings off');
  });

  test('openrouter/x or an unparseable spec is fail', async () => {
    expect((await embedding({ MODEL_EMBEDDING: 'openrouter/x' }))[0]?.status).toBe('fail');
    expect((await embedding({ MODEL_EMBEDDING: 'nomic' }))[0]?.status).toBe('fail');
  });

  test('a provider without its key is fail', async () => {
    const [r] = await embedding({ MODEL_EMBEDDING: 'openai/text-embedding-3-small', OPENAI_API_KEY: '' });
    expect(r).toMatchObject({ status: 'fail', key_names: ['MODEL_EMBEDDING', 'OPENAI_API_KEY'] });
  });

  const real = { MODEL_EMBEDDING: 'ollama/nomic-embed-text', OLLAMA_BASE_URL: 'http://embed.fixture.invalid:11434', TRIAGE_MOCK_MODE: 'false' };

  test('real mode with a fake embedder of 768 floats is ok and shows the length', async () => {
    const e = fakeEmbedder(768);
    const [r] = await embedding(real, e);
    expect(r?.status).toBe('ok');
    expect(r?.message).toContain('768');
    expect(r?.message).toContain(e.model);
    expect(e.calls).toEqual([[EMBEDDING_PROBE_TEXT]]);
  });

  test('a throwing embedder is a warning and its message is not shown', async () => {
    const e: Embedder = { model: 'ollama/fake-embed', embed: async () => { throw new Error('ECONNREFUSED embed.fixture.invalid'); } };
    const [r] = await embedding(real, e);
    expect(r?.status).toBe('warn');
    expect(r?.message).not.toContain('fixture.invalid');
  });

  test('mock mode skips the probe', async () => {
    const e = fakeEmbedder(768);
    const [r] = await embedding({ ...real, TRIAGE_MOCK_MODE: 'true' }, e);
    expect(r?.status).toBe('skipped');
    expect(e.calls).toEqual([]);
  });
});

// ------------------------------------------------------------------ fixtures

describe('fixtures check', () => {
  test('a missing fixtures dir is fail', async () => {
    const { config } = makeHome({ fixtures: false });
    const r = rows(await doctor({ config }), 'fixtures');
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ status: 'fail', key_names: ['TRIAGE_FIXTURES_DIR'] });
  });

  test('_unreviewed with 3 files is a warning mentioning 3', async () => {
    const { home, config } = makeHome();
    const dir = join(home, 'fixtures', '_unreviewed', 'run-1', 'sql', 'ssfb');
    mkdirSync(dir, { recursive: true });
    for (const h of ['a', 'b', 'c']) writeFileSync(join(dir, `${h.repeat(16)}.json`), '{}');
    writeFileSync(join(home, 'fixtures', '_unreviewed', '.gitkeep'), '');
    const r = rows(await doctor({ config }), 'fixtures');
    expect(r.map((x) => x.status)).toEqual(['ok', 'warn']);
    expect(r[1]?.message).toContain('3 ');
  });

  test('an empty _unreviewed gives no warning', async () => {
    const { home, config } = makeHome();
    mkdirSync(join(home, 'fixtures', '_unreviewed'));
    expect(rows(await doctor({ config }), 'fixtures').map((x) => x.status)).toEqual(['ok']);
  });
});

// ------------------------------------------------------------------ rules

describe('rules check', () => {
  const withRules = async (rules: unknown) => {
    const { home, config } = makeHome();
    writeFileSync(join(home, 'resources', 'ssfb.api.rules.json'), JSON.stringify(rules));
    return rows(await doctor({ config }), 'rules').filter((r) => r.entity === 'ssfb');
  };

  test('the shipped empty files are ok', async () => {
    const { config } = makeHome();
    const rs = rows(await doctor({ config }), 'rules');
    expect(rs.map((r) => [r.entity, r.status])).toEqual([
      ['ssfb', 'ok'],
      ['atspl', 'ok'],
      ['rtl', 'ok'],
    ]);
  });

  test('an allow without a reason is a warning', async () => {
    const rs = await withRules([{ service: 'harbor', method: 'POST', api: '/v1/calc', action: 'allow' }]);
    expect(rs.map((r) => r.status)).toEqual(['warn']);
    expect(rs[0]?.message).toContain('no reason');
  });

  test('a shadowed rule is fail', async () => {
    const rs = await withRules([
      { service: 'harbor', method: 'POST', api: '/v1/*', action: 'block' },
      { service: 'harbor', method: 'POST', api: '/v1/x', action: 'block' },
    ]);
    expect(rs.map((r) => r.status)).toEqual(['fail']);
    expect(rs[0]?.message).toContain('shadowed');
  });

  test('a file that is not JSON is fail', async () => {
    const { home, config } = makeHome();
    writeFileSync(join(home, 'resources', 'rtl.api.rules.json'), '{not json');
    const rs = rows(await doctor({ config }), 'rules').filter((r) => r.entity === 'rtl');
    expect(rs.map((r) => r.status)).toEqual(['fail']);
  });
});

// ------------------------------------------------------------------ io and order

describe('no io and stable order', () => {
  test('the config checks make no network call when every model is found, and keep their row order', async () => {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      throw new Error('fetch called');
    }) as unknown as typeof fetch;
    try {
      // Every model key is set to a model the installed pi-ai knows, so no catalog refresh runs.
      const { config } = makeHome({ overrides: { ...VALID_MODELS, MODEL_CODE_WALKER: '', TRIAGE_EVAL_JUDGE_MODEL: '' } });
      const a = await doctor({ config });
      const b = await doctor({ config });
      expect(calls).toBe(0);
      expect(a.checks.map((c) => `${c.id}:${c.entity ?? ''}:${c.key_names.join(',')}`)).toEqual(
        b.checks.map((c) => `${c.id}:${c.entity ?? ''}:${c.key_names.join(',')}`),
      );
      expect([...new Set(a.checks.map((c) => c.id))]).toEqual(['sandbox', 'models', 'embedding', 'tracing', 'fixtures', 'env', 'rules']);
      expect(a.checks.some((c) => c.message.startsWith('threw'))).toBe(false);
    } finally {
      globalThis.fetch = original;
    }
  });

  test('the doctor sources import no network, SQL or subprocess module and never read the deploy mode', () => {
    for (const f of ['checks-config.ts', 'run.ts', 'types.ts']) {
      const src = readFileSync(join(REPO_ROOT, 'src/ops/doctor', f), 'utf8');
      expect(src).not.toMatch(/from '(node:)?(child_process|net|tls|http|https|dgram)'/);
      expect(src).not.toMatch(/from '(pg|@flue\/postgres)'|connectors\//);
      expect(src).not.toMatch(/\bfetch\(/);
      expect(src).not.toContain('deployModeForPreflight');
    }
  });
});
