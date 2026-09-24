import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import fs, { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { parse } from 'dotenv';
import {
  applyProviderEnv,
  configFromRecord,
  deployModeForPreflight,
  loadConfig,
  lookupEnv,
  providerEnv,
  type Config,
} from './env.ts';
import { ConfigError } from './errors.ts';
import { DEPLOY_MODE_KEY, ENTITY_KEY_PATTERN, KEYS, PROVIDER_KEYS } from './keys.ts';

const EXAMPLE_PATH = fileURLToPath(new URL('../../.env.example', import.meta.url));

const made: string[] = [];
let savedCwd = '';
let savedHome: string | undefined;

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'triage-env-test-'));
  made.push(dir);
  return dir;
}

function makeHome(envText = ''): string {
  const home = tempDir();
  writeFileSync(join(home, '.env'), envText);
  return home;
}

function fromRecord(record: Record<string, string>, opts?: { policyChecks?: boolean }): Config {
  return configFromRecord(record, '/triage/home', opts);
}

function configError(fn: () => unknown): ConfigError {
  try {
    fn();
  } catch (err) {
    if (err instanceof ConfigError) return err;
    throw err;
  }
  throw new Error('expected a ConfigError');
}

// Every string or number reachable through enumerable properties, with its path.
function leaves(value: unknown, path = 'config'): Array<[string, unknown]> {
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => leaves(v, `${path}.${k}`));
  }
  return [[path, value]];
}

beforeEach(() => {
  savedCwd = process.cwd();
  savedHome = process.env.TRIAGE_HOME;
});

afterEach(() => {
  process.chdir(savedCwd);
  if (savedHome === undefined) delete process.env.TRIAGE_HOME;
  else process.env.TRIAGE_HOME = savedHome;
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('TRIAGE_HOME', () => {
  test('reads <home>/.env and ignores a .env in the cwd', () => {
    const home = makeHome('TRIAGE_ENV_LABEL=from-home\n');
    const cwd = tempDir();
    writeFileSync(join(cwd, '.env'), 'TRIAGE_ENV_LABEL=from-cwd\nTRIAGE_MOCK_MODE=false\nMODEL_TIER_MID=cwd/model\n');
    process.chdir(cwd);
    process.env.TRIAGE_HOME = home;
    const config = loadConfig();
    expect(config.display.envLabel).toBe('from-home');
    expect(config.mock.enabled).toBe(true);
    expect(config.models.tierMid).toBeUndefined();
    expect(config.home).toBe(home);
  });

  test('the home option wins over process.env', () => {
    const a = makeHome('TRIAGE_ENV_LABEL=a\n');
    const b = makeHome('TRIAGE_ENV_LABEL=b\n');
    process.env.TRIAGE_HOME = a;
    expect(loadConfig({ home: b }).display.envLabel).toBe('b');
  });

  test('missing TRIAGE_HOME is a ConfigError naming it', () => {
    delete process.env.TRIAGE_HOME;
    const err = configError(() => loadConfig());
    expect(err.keys).toEqual(['TRIAGE_HOME']);
    expect(err.message).toContain('TRIAGE_HOME');
  });

  test('blank or relative TRIAGE_HOME is refused', () => {
    process.env.TRIAGE_HOME = '  ';
    expect(configError(() => loadConfig()).keys).toEqual(['TRIAGE_HOME']);
    process.env.TRIAGE_HOME = 'relative/home';
    expect(configError(() => loadConfig()).message).toContain('absolute');
  });

  test('a home without a .env is refused', () => {
    process.env.TRIAGE_HOME = tempDir();
    const err = configError(() => loadConfig());
    expect(err.keys).toEqual(['TRIAGE_HOME']);
    expect(err.message).toContain('no .env');
  });

  test('a TRIAGE_HOME line inside the .env is ignored', () => {
    const home = makeHome('TRIAGE_HOME=/somewhere/else\nTRIAGE_DATA_DIR=./d\n');
    const config = loadConfig({ home });
    expect(config.home).toBe(home);
    expect(config.paths.dataDir).toBe(join(home, 'd'));
  });
});

describe('defaults with an empty .env', () => {
  test('every documented default', () => {
    const home = makeHome('');
    const c = loadConfig({ home });
    expect(c.mock).toEqual({ enabled: true, strict: true, record: false });
    expect(c.db.provider).toBe('sqlite');
    expect(c.db.url).toBe(join(home, '.data/triage.sqlite'));
    expect(c.approval.mode).toBe('cli');
    expect(c.sandbox.provider).toBe('virtual');
    expect(c.sandbox.python).toBe(true);
    expect(c.sandbox.timeoutMs).toBe(30000);
    expect(c.budgets.maxToolCallsPerRun).toBe(120);
    expect(c.budgets.maxTasksPerRun).toBe(12);
    expect(c.budgets.maxResponseBytesPerCall).toBe(1048576);
    expect(c.budgets.maxBytesPerRun).toBe(20971520);
    expect(c.budgets.runTimeoutMs).toBe(900000);
    expect(c.budgets.runMaxAttempts).toBe(2);
    expect(c.budgets.httpTimeoutMs).toBe(30000);
    expect(c.budgets.defaultLookbackDays).toBe(7);
    expect(c.sql).toEqual({ maxRows: 200, statementTimeoutMs: 30000, lockTimeoutMs: 2000, requireReadonlyRole: false });
    expect(c.entities).toEqual(['ssfb', 'atspl', 'rtl']);
    expect(c.models.thinkingCheap).toBe('off');
    expect(c.models.thinkingMid).toBe('low');
    expect(c.models.thinkingStrong).toBe('high');
    expect(c.http.port).toBe(3000);
    expect(c.http.allowSlackPost).toBe(false);
    expect(c.runs.priorCases).toBe(false);
    expect(c.code).toEqual({ codegraphBin: 'codegraph', qwBin: 'qw', syncBeforeQuery: true });
    expect({ ...c.git }).toEqual({ protocol: 'ssh', host: 'github.com', org: 'Vance-Club', httpsToken: undefined });
    expect(c.display.envLabel).toBeUndefined();
    expect(deployModeForPreflight(c)).toBe('local');
  });

  test('blank values map to their default or to undefined', () => {
    const c = fromRecord({
      MODEL_CODE_WALKER: '',
      TRIAGE_RUNS_RETENTION_DAYS: '',
      TRIAGE_MOCK_MODE: '',
      TRIAGE_SQL_MAX_ROWS: '   ',
      TRIAGE_REPOS_DIR: '',
      TRIAGE_EVAL_MAX_COST_USD: '',
    });
    expect(c.models.codeWalker).toBeUndefined();
    expect(c.runs.retentionDays).toBeUndefined();
    expect(c.mock.enabled).toBe(true);
    expect(c.sql.maxRows).toBe(200);
    expect(c.paths.reposDir).toBeUndefined();
    expect(c.evals.maxCostUsd).toBeUndefined();
  });

  test('set values are parsed to their types', () => {
    const c = fromRecord({
      TRIAGE_RUNS_RETENTION_DAYS: '30',
      TRIAGE_ENTITIES: ' SSFB , rtl,,rtl ',
      TRIAGE_EVAL_MAX_COST_USD: '2.50',
      TRIAGE_MOCK_STRICT: 'FALSE',
      MODEL_TIER_STRONG: 'anthropic/claude-opus-5-5',
    });
    expect(c.runs.retentionDays).toBe(30);
    expect(c.entities).toEqual(['ssfb', 'rtl']);
    expect(c.evals.maxCostUsd).toBe(2.5);
    expect(c.mock.strict).toBe(false);
    expect(c.models.tierStrong).toBe('anthropic/claude-opus-5-5');
  });
});

describe('cross-field and policy refusals', () => {
  test('recording fixtures in mock mode is refused', () => {
    const err = configError(() => fromRecord({ TRIAGE_RECORD_FIXTURES: 'true', TRIAGE_MOCK_MODE: 'true' }));
    expect(err.keys).toContain('TRIAGE_RECORD_FIXTURES');
    expect(err.message).toContain('TRIAGE_MOCK_MODE=false');
    // The default mock mode is on, so recording alone is refused too.
    expect(configError(() => fromRecord({ TRIAGE_RECORD_FIXTURES: 'true' })).keys).toContain('TRIAGE_RECORD_FIXTURES');
    expect(fromRecord({ TRIAGE_RECORD_FIXTURES: 'true', TRIAGE_MOCK_MODE: 'false' }).mock.record).toBe(true);
  });

  test('the local sandbox is refused and the error names D45', () => {
    const err = configError(() => fromRecord({ TRIAGE_SANDBOX_PROVIDER: 'local' }));
    expect(err.keys).toEqual(['TRIAGE_SANDBOX_PROVIDER']);
    expect(err.message).toContain('D45');
  });

  test('slack approval is reserved for v2', () => {
    const err = configError(() => fromRecord({ TRIAGE_APPROVAL_MODE: 'slack' }));
    expect(err.keys).toEqual(['TRIAGE_APPROVAL_MODE']);
    expect(err.message).toContain('reserved for v2');
  });

  test('e2b and daytona are accepted', () => {
    expect(fromRecord({ TRIAGE_SANDBOX_PROVIDER: 'e2b' }).sandbox.provider).toBe('e2b');
    expect(fromRecord({ TRIAGE_SANDBOX_PROVIDER: 'daytona' }).sandbox.provider).toBe('daytona');
  });

  test('policyChecks:false accepts local and slack', () => {
    const c = fromRecord({ TRIAGE_SANDBOX_PROVIDER: 'local', TRIAGE_APPROVAL_MODE: 'slack' }, { policyChecks: false });
    expect(c.sandbox.provider).toBe('local');
    expect(c.approval.mode).toBe('slack');
  });

  test('policyChecks:false skips nothing else', () => {
    const opts = { policyChecks: false };
    expect(configError(() => fromRecord({ TRIAGE_RECORD_FIXTURES: 'true' }, opts)).keys).toContain('TRIAGE_RECORD_FIXTURES');
    expect(configError(() => fromRecord({ TRIAGE_SANDBOX_PROVIDER: 'docker' }, opts)).keys).toEqual(['TRIAGE_SANDBOX_PROVIDER']);
    expect(configError(() => fromRecord({ TRIAGE_APPROVAL_MODE: 'auto' }, opts)).keys).toEqual(['TRIAGE_APPROVAL_MODE']);
    expect(configError(() => fromRecord({ TRIAGE_MOCK_MODE: 'yes' }, opts)).keys).toEqual(['TRIAGE_MOCK_MODE']);
  });

  test('loadConfig always applies the policy refusals', () => {
    const home = makeHome('TRIAGE_SANDBOX_PROVIDER=local\n');
    expect(configError(() => loadConfig({ home })).keys).toEqual(['TRIAGE_SANDBOX_PROVIDER']);
    const home2 = makeHome('TRIAGE_APPROVAL_MODE=slack\n');
    expect(configError(() => loadConfig({ home: home2 })).keys).toEqual(['TRIAGE_APPROVAL_MODE']);
  });

  test('postgres needs a DSN and sqlite refuses one', () => {
    expect(configError(() => fromRecord({ TRIAGE_DB_PROVIDER: 'postgres' })).keys).toEqual(['TRIAGE_DB_URL']);
    expect(
      configError(() => fromRecord({ TRIAGE_DB_PROVIDER: 'postgres', TRIAGE_DB_URL: './x.sqlite' })).keys,
    ).toEqual(['TRIAGE_DB_URL']);
    expect(configError(() => fromRecord({ TRIAGE_DB_URL: 'postgresql://u:p@h/db' })).keys).toEqual(['TRIAGE_DB_URL']);
    const dsn = 'postgresql://u:p@localhost:5432/triage';
    const c = fromRecord({ TRIAGE_DB_PROVIDER: 'postgres', TRIAGE_DB_URL: dsn });
    expect(c.db).toEqual({ provider: 'postgres', url: dsn });
  });
});

describe('deploy mode', () => {
  test('prod loads raw and only deployModeForPreflight returns it', () => {
    const c = fromRecord({ [DEPLOY_MODE_KEY]: 'prod' });
    expect(deployModeForPreflight(c)).toBe('prod');
    expect(leaves(c).filter(([, v]) => v === 'prod')).toEqual([]);
  });

  test('an unknown value is kept as is for preflight to warn about', () => {
    const c = fromRecord({ [DEPLOY_MODE_KEY]: 'zz-unknown-mode' });
    expect(deployModeForPreflight(c)).toBe('zz-unknown-mode');
    expect(JSON.stringify(leaves(c))).not.toContain('zz-unknown-mode');
    expect(inspect(c, { depth: 10 })).not.toContain('zz-unknown-mode');
  });

  test('env.ts never spells the key name', () => {
    const src = readFileSync(fileURLToPath(new URL('./env.ts', import.meta.url)), 'utf8');
    expect(src).not.toContain(DEPLOY_MODE_KEY);
  });
});

describe('env label', () => {
  test('is exposed only as display.envLabel', () => {
    const c = fromRecord({ TRIAGE_ENV_LABEL: 'label-q7' });
    expect(leaves(c).filter(([, v]) => v === 'label-q7')).toEqual([['config.display.envLabel', 'label-q7']]);
  });
});

describe('type refusals name the key', () => {
  const cases: Array<[string, string]> = [
    ['TRIAGE_DB_PROVIDER', 'mysql'],
    ['TRIAGE_APPROVAL_MODE', 'auto'],
    ['TRIAGE_SANDBOX_PROVIDER', 'docker'],
    ['MODEL_THINKING_MID', 'extreme'],
    ['TRIAGE_MOCK_MODE', 'yes'],
    ['TRIAGE_MOCK_STRICT', '1'],
    ['TRIAGE_SQL_MAX_ROWS', '12abc'],
    ['TRIAGE_MAX_TOOL_CALLS_PER_RUN', '0'],
    ['TRIAGE_MAX_RESPONSE_BYTES_PER_CALL', '1MB'],
    ['TRIAGE_MAX_BYTES_PER_RUN', '-5'],
    ['TRIAGE_HTTP_PORT', '70000'],
    ['TRIAGE_RUNS_RETENTION_DAYS', '1.5'],
    ['TRIAGE_EVAL_MAX_COST_USD', 'cheap'],
    ['TRIAGE_GIT_PROTOCOL', 'git'],
    ['TRIAGE_GIT_HOST', 'github.com/org'],
    ['TRIAGE_GIT_HOST', '-github.com'],
    ['TRIAGE_GIT_ORG', 'org/../x'],
    ['TRIAGE_GIT_ORG', '-org'],
  ];
  for (const [key, value] of cases) {
    test(`${key}=${value}`, () => {
      const err = configError(() => fromRecord({ [key]: value }));
      expect(err.keys).toEqual([key]);
      expect(err.message).toContain(key);
    });
  }

  test('one error lists every bad key', () => {
    const err = configError(() => fromRecord({ TRIAGE_DB_PROVIDER: 'mysql', TRIAGE_MOCK_MODE: 'yes', TRIAGE_HTTP_PORT: 'x' }));
    expect([...err.keys].sort()).toEqual(['TRIAGE_DB_PROVIDER', 'TRIAGE_HTTP_PORT', 'TRIAGE_MOCK_MODE']);
  });
});

describe('.env parsing', () => {
  test('quoted, exported, multi-line and commented values', () => {
    const home = makeHome(
      [
        'TRIAGE_ENV_LABEL="stage laptop"',
        "MODEL_TIER_MID='anthropic/claude-sonnet-5'",
        'export MODEL_TIER_STRONG=anthropic/claude-opus-5-5',
        'export TRIAGE_SQL_MAX_ROWS="50"',
        'TRIAGE_HTTP_PORT=4000   # inline comment',
        'SSFB_BRO_ADMIN_TOKEN="line one',
        'line two"',
        'SSFB_HARBOR_FIELD_ENC_KEY="a\\nb"',
        '# a comment line',
        '   # an indented comment line',
        'SSFB_HARBOR_API_URL=',
      ].join('\n'),
    );
    const c = loadConfig({ home });
    expect(c.display.envLabel).toBe('stage laptop');
    expect(c.models.tierMid).toBe('anthropic/claude-sonnet-5');
    expect(c.models.tierStrong).toBe('anthropic/claude-opus-5-5');
    expect(c.sql.maxRows).toBe(50);
    expect(c.http.port).toBe(4000);
    expect(lookupEnv(c, 'SSFB_BRO_ADMIN_TOKEN')).toEqual({ state: 'set', value: 'line one\nline two' });
    expect(lookupEnv(c, 'SSFB_HARBOR_FIELD_ENC_KEY')).toEqual({ state: 'set', value: 'a\nb' });
    expect(lookupEnv(c, 'SSFB_HARBOR_API_URL')).toEqual({ state: 'blank' });
  });

  test('.env.example itself loads', () => {
    const c = fromRecord(parse(readFileSync(EXAMPLE_PATH, 'utf8')));
    expect(c.mock.enabled).toBe(true);
    expect(c.runs.retentionDays).toBe(365);
  });
});

describe('no values in errors, inspect or JSON', () => {
  const secrets: Record<string, string> = {
    ANTHROPIC_API_KEY: 'fake-anthropic-k3y-1a2b',
    OPENAI_API_KEY: 'fake-openai-k3y-3c4d',
    OPENROUTER_API_KEY: 'fake-openrouter-k3y-5e6f',
    TRIAGE_HTTP_AUTH_TOKEN: 'fake-http-bearer-7g8h',
    SLACK_BOT_TOKEN: 'fake-slack-bot-9i0j',
    SLACK_SIGNING_SECRET: 'fake-slack-signing-1k2l',
    E2B_API_KEY: 'fake-e2b-3m4n',
    DAYTONA_API_KEY: 'fake-daytona-5o6p',
    TRIAGE_ENV_LABEL: 'fake-label-7q8r',
    SSFB_HARBOR_DB_URL: 'postgresql://triage:fake-pg-pass-9s0t@localhost:55432/harbor_db',
    SSFB_BRO_ADMIN_TOKEN: 'fake-bro-admin-1u2v',
    SSFB_HARBOR_FIELD_ENC_KEY: 'fake-enc-key-3w4x',
    ATSPL_QUICKWIT_TOKEN: 'fake-qw-token-5y6z',
    [DEPLOY_MODE_KEY]: 'fake-deploy-mode-7a8b',
  };
  const secretValues = Object.values(secrets);

  function expectClean(text: string): void {
    for (const s of secretValues) expect(text).not.toContain(s);
  }

  test('inspect and JSON.stringify print key names only', () => {
    const home = makeHome(Object.entries(secrets).map(([k, v]) => `${k}="${v}"`).join('\n'));
    const c = loadConfig({ home });
    expect(c.providers.anthropicApiKey).toBe(secrets.ANTHROPIC_API_KEY);

    const outputs = [
      inspect(c),
      inspect(c, { depth: Infinity }),
      JSON.stringify(c),
      String(c),
      ...Object.keys(c).flatMap((k) => {
        const group = (c as unknown as Record<string, unknown>)[k];
        return [inspect(group, { depth: Infinity }), JSON.stringify(group) ?? ''];
      }),
    ];
    for (const out of outputs) expectClean(out);
    expect(JSON.stringify(c)).toContain('SLACK_BOT_TOKEN');
    expect(inspect(c)).toContain('SSFB_HARBOR_DB_URL');
  });

  test('error text never carries a value', () => {
    const bad: Record<string, string> = {
      ...secrets,
      TRIAGE_DB_PROVIDER: 'fake-bad-enum-9c0d',
      TRIAGE_MOCK_MODE: 'fake-bad-bool-1e2f',
      TRIAGE_SQL_MAX_ROWS: 'fake-bad-int-3g4h',
      TRIAGE_MAX_BYTES_PER_RUN: 'fake-bad-int-5i6j',
      TRIAGE_DB_URL: 'postgresql://u:fake-dsn-pass-7k8l@h/db',
      TRIAGE_SANDBOX_PROVIDER: 'local',
    };
    const home = makeHome(Object.entries(bad).map(([k, v]) => `export ${k}='${v}'`).join('\n'));
    const err = configError(() => loadConfig({ home }));
    const all = [...secretValues, ...Object.values(bad).filter((v) => v !== 'local')];
    for (const text of [err.message, String(err), err.stack ?? '', inspect(err), JSON.stringify(err.problems)]) {
      for (const s of all) expect(text).not.toContain(s);
    }
    expect(err.keys).toContain('TRIAGE_DB_PROVIDER');
    expect(err.keys).toContain('TRIAGE_MAX_BYTES_PER_RUN');
  });
});

describe('frozen', () => {
  test('config is deep-frozen', () => {
    const c = fromRecord({});
    const objects: object[] = [];
    const walk = (v: unknown): void => {
      if (v !== null && typeof v === 'object') {
        objects.push(v);
        Object.values(v).forEach(walk);
      }
    };
    walk(c);
    expect(objects.length).toBeGreaterThan(10);
    for (const o of objects) expect(Object.isFrozen(o)).toBe(true);
    expect(() => {
      (c.mock as { enabled: boolean }).enabled = false;
    }).toThrow(TypeError);
    expect(() => {
      (c.entities as string[]).push('x');
    }).toThrow(TypeError);
  });
});

describe('relative paths', () => {
  test('resolve under TRIAGE_HOME, not the cwd', () => {
    const home = makeHome('TRIAGE_REPOS_DIR=../repos\nTRIAGE_FIXTURES_DIR=/abs/fixtures\n');
    process.chdir(tempDir());
    const c = loadConfig({ home });
    expect(c.paths.dataDir).toBe(join(home, '.data'));
    expect(c.paths.auditLog).toBe(join(home, '.data/audit.jsonl'));
    expect(c.paths.runsDir).toBe(join(home, '.data/runs'));
    expect(c.paths.knowledgeDir).toBe(join(home, 'knowledge'));
    expect(c.paths.resourcesDir).toBe(join(home, 'resources'));
    expect(c.paths.reposDir).toBe(join(home, '../repos'));
    expect(c.paths.fixturesDir).toBe('/abs/fixtures');
    expect(c.db.url).toBe(join(home, '.data/triage.sqlite'));
  });

  test('a relative sqlite TRIAGE_DB_URL resolves under the home', () => {
    expect(fromRecord({ TRIAGE_DB_URL: 'db/x.sqlite' }).db.url).toBe('/triage/home/db/x.sqlite');
    expect(fromRecord({ TRIAGE_DB_URL: ':memory:' }).db.url).toBe(':memory:');
  });
});

describe('keys.ts and .env.example stay in sync', () => {
  const example = parse(readFileSync(EXAMPLE_PATH, 'utf8'));
  const tableNames = new Set(KEYS.map((k) => k.name));

  test('every .env.example key is in keys.ts or is an entity key', () => {
    const stray = Object.keys(example).filter((k) => !tableNames.has(k) && !ENTITY_KEY_PATTERN.test(k));
    expect(stray).toEqual([]);
  });

  test('every keys.ts key is in .env.example', () => {
    expect(KEYS.map((k) => k.name).filter((k) => !(k in example))).toEqual([]);
  });

  test('no keys.ts key looks like an entity key, and names are unique', () => {
    expect(KEYS.filter((k) => ENTITY_KEY_PATTERN.test(k.name))).toEqual([]);
    expect(tableNames.size).toBe(KEYS.length);
  });

  test('.env.example shows each default', () => {
    const mismatched = KEYS.filter((k) => (example[k.name] ?? '') !== (k.example ?? k.default ?? '')).map((k) => k.name);
    expect(mismatched).toEqual([]);
  });

  test('the byte budget keys are documented with their defaults', () => {
    expect(example.TRIAGE_MAX_RESPONSE_BYTES_PER_CALL).toBe('1048576');
    expect(example.TRIAGE_MAX_BYTES_PER_RUN).toBe('20971520');
  });
});

describe('lookupEnv', () => {
  test('missing, blank and set', () => {
    const c = fromRecord({ SSFB_HARBOR_API_URL: '', SSFB_BRO_API_URL: 'http://bro.test' });
    expect(lookupEnv(c, 'SSFB_COHORT_API_URL')).toEqual({ state: 'missing' });
    expect(lookupEnv(c, 'SSFB_HARBOR_API_URL')).toEqual({ state: 'blank' });
    expect(lookupEnv(c, 'SSFB_BRO_API_URL')).toEqual({ state: 'set', value: 'http://bro.test' });
  });

  test('refuses keys that config already exposes', () => {
    const c = fromRecord({ SLACK_BOT_TOKEN: 'fake' });
    expect(configError(() => lookupEnv(c, 'SLACK_BOT_TOKEN')).keys).toEqual(['SLACK_BOT_TOKEN']);
    expect(configError(() => lookupEnv(c, DEPLOY_MODE_KEY)).keys).toEqual([DEPLOY_MODE_KEY]);
  });

  test('refuses an object that was not built by the loader', () => {
    const fake = { ...fromRecord({}) } as Config;
    expect(() => lookupEnv(fake, 'SSFB_BRO_API_URL')).toThrow(ConfigError);
    expect(() => deployModeForPreflight(fake)).toThrow(ConfigError);
  });
});

describe('overrides', () => {
  test('take precedence over the file', () => {
    const home = makeHome('TRIAGE_ENV_LABEL=file\nTRIAGE_SQL_MAX_ROWS=10\nSSFB_BRO_API_URL=http://file.test\n');
    const c = loadConfig({
      home,
      overrides: { TRIAGE_ENV_LABEL: 'override', SSFB_BRO_API_URL: 'http://override.test', TRIAGE_MOCK_STRICT: 'false' },
    });
    expect(c.display.envLabel).toBe('override');
    expect(c.sql.maxRows).toBe(10);
    expect(c.mock.strict).toBe(false);
    expect(lookupEnv(c, 'SSFB_BRO_API_URL')).toEqual({ state: 'set', value: 'http://override.test' });
  });

  test('are validated like file values', () => {
    const home = makeHome('');
    expect(configError(() => loadConfig({ home, overrides: { TRIAGE_MOCK_MODE: 'maybe' } })).keys).toEqual([
      'TRIAGE_MOCK_MODE',
    ]);
  });
});

describe('provider env', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of PROVIDER_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of PROVIDER_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  test('providerEnv holds only non-blank provider keys', () => {
    const c = fromRecord({ ANTHROPIC_API_KEY: 'fake-a', OPENAI_API_KEY: '', SLACK_BOT_TOKEN: 'fake-s' });
    expect(providerEnv(c)).toEqual({ ANTHROPIC_API_KEY: 'fake-a' });
  });

  test('applyProviderEnv sets only non-blank keys and writes no file', () => {
    const spies = [
      spyOn(fs, 'writeFileSync'),
      spyOn(fs, 'writeFile'),
      spyOn(fs, 'appendFileSync'),
      spyOn(fs, 'appendFile'),
      spyOn(fs, 'createWriteStream'),
      spyOn(fs.promises, 'writeFile'),
      spyOn(fs.promises, 'appendFile'),
    ];
    try {
      const c = fromRecord({ ANTHROPIC_API_KEY: 'fake-a', OPENAI_API_KEY: '  ', OPENROUTER_API_KEY: 'fake-r' });
      const set = applyProviderEnv(c);
      expect([...set].sort()).toEqual(['ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY']);
      expect(process.env.ANTHROPIC_API_KEY).toBe('fake-a');
      expect(process.env.OPENROUTER_API_KEY).toBe('fake-r');
      expect(process.env.OPENAI_API_KEY).toBeUndefined();
      for (const spy of spies) expect(spy).toHaveBeenCalledTimes(0);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
