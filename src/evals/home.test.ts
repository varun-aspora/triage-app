import { afterEach, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';
import { configFromRecord, loadConfig, rawKeyState, type Config } from '../config/env.ts';
import { loadRegistry, type Registry } from '../config/registry.ts';
import { ENTITIES } from '../types/core.ts';
import {
  EVAL_FLAGS,
  EvalHomeError,
  SSFB_CBS_KEYS,
  SSFB_DB_TUNNEL_KEYS,
  assertEvalHome,
  credentialKeys,
  forceEvalFlags,
} from './home.ts';
import { materialiseEvalHome, renderEvalEnv } from './make-home.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
const RESOURCES = join(ROOT, 'resources');
const HOME = '/eval/home';
const TEMPLATE: Readonly<Record<string, string>> = parse(renderEvalEnv(ROOT));
// The root template, not a real .env.
const ROOT_EXAMPLE: Readonly<Record<string, string>> = parse(readFileSync(join(ROOT, '.env.example'), 'utf8'));

type Built = { config: Config; registry: Registry };

function build(overrides: Readonly<Record<string, string>> = {}, policyChecks = true): Built {
  const config = configFromRecord({ ...TEMPLATE, ...overrides }, HOME, { policyChecks });
  return { config, registry: loadRegistry(config, { resourcesDir: RESOURCES }) };
}

function refusal(b: Built): EvalHomeError {
  try {
    assertEvalHome(b.config, b.registry);
  } catch (err) {
    expect(err).toBeInstanceOf(EvalHomeError);
    return err as EvalHomeError;
  }
  throw new Error('assertEvalHome did not throw');
}

function expectNoLeak(err: Error, secret: string): void {
  expect(err.message).not.toContain(secret);
  expect(String(err.stack)).not.toContain(secret);
  expect(JSON.stringify((err as EvalHomeError).problems)).not.toContain(secret);
}

const seed = (key: string): string => `seeded-fake-secret-${key.toLowerCase()}-7c41`;

// Category name, the key pattern and the entities that have it. null = not an entity key.
const CATEGORIES: readonly (readonly [string, RegExp, readonly string[] | null])[] = [
  ['DB_URL', /_DB_URL$/, ENTITIES],
  ['API_URL', /_API_URL$/, ENTITIES],
  ['QUICKWIT_URL', /_QUICKWIT_URL$/, ENTITIES],
  ['QUICKWIT_TOKEN', /_QUICKWIT_TOKEN$/, ENTITIES],
  ['QW_CONTEXT', /_QW_CONTEXT$/, ENTITIES],
  ['KUBE_CONTEXT', /_KUBE_CONTEXT$/, ENTITIES],
  ['AWS_PROFILE', /_AWS_PROFILE$/, ENTITIES],
  ['SSFB_CBS_*', /^SSFB_CBS_/, ['ssfb']],
  ['SSFB_DB_TUNNEL_*', /^SSFB_DB_TUNNEL_/, ['ssfb']],
  ['FIELD_ENC_KEY', /_FIELD_ENC_KEY$/, ['ssfb']],
  ['BRO_ADMIN_TOKEN', /_BRO_ADMIN_TOKEN$/, ['ssfb']],
  ['SLACK_BOT_TOKEN', /^SLACK_BOT_TOKEN$/, null],
];

const KEYS = credentialKeys(build().registry);

function keysOf(pattern: RegExp, entity: string | null): string[] {
  return KEYS.filter((k) => pattern.test(k) && (entity === null || k.startsWith(`${entity.toUpperCase()}_`)));
}

const DENY_CASES = CATEGORIES.flatMap(([category, pattern, entities]) =>
  (entities ?? [null]).flatMap((entity) => keysOf(pattern, entity).map((key) => ({ category, entity, key }))),
);

describe('credentialKeys', () => {
  test('every category has at least one key for each entity that has it', () => {
    for (const [category, pattern, entities] of CATEGORIES) {
      for (const entity of entities ?? [null]) {
        expect({ category, entity, keys: keysOf(pattern, entity).length > 0 }).toEqual({ category, entity, keys: true });
      }
    }
  });

  test('every credential key falls in a category', () => {
    const stray = KEYS.filter((k) => !CATEGORIES.some(([, pattern]) => pattern.test(k)));
    expect(stray).toEqual([]);
  });

  test('covers every SSFB_CBS_* and SSFB_DB_TUNNEL_* key of the root .env.example except the CBS flag', () => {
    const inRoot = Object.keys(ROOT_EXAMPLE).filter((k) => /^SSFB_(CBS|DB_TUNNEL)_/.test(k));
    const expected = inRoot.filter((k) => k !== 'SSFB_CBS_VIA_KUBECTL_ENABLED').sort();
    expect([...SSFB_CBS_KEYS, ...SSFB_DB_TUNNEL_KEYS].sort()).toEqual(expected);
    for (const k of expected) expect(KEYS).toContain(k);
  });

  test('includes the registry DB, API and auth keys and leaves out non-credential Quickwit keys', () => {
    expect(KEYS).toContain('SSFB_HARBOR_DB_URL');
    expect(KEYS).toContain('ATSPL_PULSE_API_URL');
    expect(KEYS).toContain('SSFB_CBS_GATEWAY_URL');
    expect(KEYS).toContain('RTL_QW_CONTEXT');
    expect(KEYS).not.toContain('SSFB_QUICKWIT_INDEX');
    expect(KEYS).not.toContain('SSFB_QUICKWIT_TRANSPORT');
    expect(KEYS).not.toContain('SSFB_CBS_VIA_KUBECTL_ENABLED');
    expect(new Set(KEYS).size).toBe(KEYS.length);
  });
});

describe('assertEvalHome', () => {
  test('the all-blank template passes', () => {
    const b = build();
    expect(() => assertEvalHome(b.config, b.registry)).not.toThrow();
  });

  test.each(DENY_CASES)('refuses $category set for $entity ($key)', ({ key }) => {
    const secret = seed(key);
    const err = refusal(build({ [key]: secret }));
    expect(err.keys).toEqual([key]);
    expect(err.message).toContain(key);
    expectNoLeak(err, secret);
  });

  test('a seeded secret in every credential key at once never reaches the error', () => {
    const overrides = Object.fromEntries(KEYS.map((k) => [k, seed(k)]));
    const err = refusal(build(overrides));
    expect([...err.keys].sort()).toEqual([...KEYS].sort());
    for (const k of KEYS) expectNoLeak(err, seed(k));
    expect(err.message).not.toContain('seeded-fake-secret');
    expect(String(err.stack)).not.toContain('seeded-fake-secret');
  });

  test('a whitespace-only value counts as set', () => {
    for (const value of [' ', '   ', '\t']) {
      const err = refusal(build({ SSFB_BRO_ADMIN_TOKEN: value, SLACK_BOT_TOKEN: value }));
      expect([...err.keys].sort()).toEqual(['SLACK_BOT_TOKEN', 'SSFB_BRO_ADMIN_TOKEN']);
    }
  });

  test('refuses SSFB_CBS_VIA_KUBECTL_ENABLED=true and allows false or blank', () => {
    const err = refusal(build({ SSFB_CBS_VIA_KUBECTL_ENABLED: 'true' }));
    expect(err.keys).toEqual(['SSFB_CBS_VIA_KUBECTL_ENABLED']);
    for (const value of ['false', '']) {
      const b = build({ SSFB_CBS_VIA_KUBECTL_ENABLED: value });
      expect(() => assertEvalHome(b.config, b.registry)).not.toThrow();
    }
  });

  test.each(['e2b', 'daytona'])('refuses TRIAGE_SANDBOX_PROVIDER=%s', (provider) => {
    const err = refusal(build({ TRIAGE_SANDBOX_PROVIDER: provider }));
    expect(err.keys).toEqual(['TRIAGE_SANDBOX_PROVIDER']);
  });

  test('refuses TRIAGE_SANDBOX_PROVIDER=local even when the loader policy checks are off', () => {
    const err = refusal(build({ TRIAGE_SANDBOX_PROVIDER: 'local' }, false));
    expect(err.keys).toEqual(['TRIAGE_SANDBOX_PROVIDER']);
  });

  test('refuses TRIAGE_DB_PROVIDER=postgres without printing the DSN', () => {
    const dsn = 'postgresql://evaluser:seeded-db-password-19@127.0.0.1:5432/triage';
    const err = refusal(build({ TRIAGE_DB_PROVIDER: 'postgres', TRIAGE_DB_URL: dsn }));
    expect(err.keys).toEqual(['TRIAGE_DB_PROVIDER']);
    expectNoLeak(err, 'seeded-db-password-19');
  });

  test.each(['openai/text-embedding-3-small', 'openrouter/openai/text-embedding-3-small', 'anthropic/x'])(
    'refuses MODEL_EMBEDDING=%s',
    (spec) => {
      const err = refusal(build({ MODEL_EMBEDDING: spec }));
      expect(err.keys).toEqual(['MODEL_EMBEDDING']);
      expect(err.message).not.toContain(spec);
    },
  );

  test('allows a blank or ollama/* MODEL_EMBEDDING', () => {
    for (const spec of ['', 'ollama/nomic-embed-text']) {
      const b = build({ MODEL_EMBEDDING: spec });
      expect(() => assertEvalHome(b.config, b.registry)).not.toThrow();
    }
  });

  test('refuses mock flags that forceEvalFlags would have set', () => {
    expect(refusal(build({ TRIAGE_MOCK_MODE: 'false' })).keys).toEqual(['TRIAGE_MOCK_MODE']);
    expect(refusal(build({ TRIAGE_MOCK_STRICT: 'false' })).keys).toEqual(['TRIAGE_MOCK_STRICT']);
    const both = refusal(build({ TRIAGE_MOCK_MODE: 'false', TRIAGE_RECORD_FIXTURES: 'true' }));
    expect([...both.keys].sort()).toEqual(['TRIAGE_MOCK_MODE', 'TRIAGE_RECORD_FIXTURES']);
  });

  test('lists every problem in one error', () => {
    const err = refusal(build({ RTL_KYC_DB_URL: 'x', TRIAGE_SANDBOX_PROVIDER: 'e2b', MODEL_EMBEDDING: 'openai/x' }));
    expect([...err.keys].sort()).toEqual(['MODEL_EMBEDDING', 'RTL_KYC_DB_URL', 'TRIAGE_SANDBOX_PROVIDER']);
    expect(err.name).toBe('EvalHomeError');
  });
});

describe('assertEvalHome through the .env loader', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function homeWith(lines: readonly string[]): Built {
    const dir = mkdtempSync(join(tmpdir(), 'triage-eval-guard-'));
    dirs.push(dir);
    const home = materialiseEvalHome(join(dir, 'home'), ROOT);
    appendFileSync(join(home, '.env'), `${lines.join('\n')}\n`);
    const config = loadConfig({ home });
    return { config, registry: loadRegistry(config) };
  }

  test('an untouched materialised home passes', () => {
    const b = homeWith([]);
    expect(() => assertEvalHome(b.config, b.registry)).not.toThrow();
  });

  test('whitespace-only, quoted and exported values count as set', () => {
    const cases: readonly (readonly [string, string])[] = [
      ["SSFB_HARBOR_DB_URL='   '", 'SSFB_HARBOR_DB_URL'],
      ['SSFB_HARBOR_FIELD_ENC_KEY="x"', 'SSFB_HARBOR_FIELD_ENC_KEY'],
      ["ATSPL_QUICKWIT_TOKEN='x'", 'ATSPL_QUICKWIT_TOKEN'],
      ['export RTL_KYC_DB_URL=x', 'RTL_KYC_DB_URL'],
      ['export SLACK_BOT_TOKEN="  "', 'SLACK_BOT_TOKEN'],
      ['export SSFB_DB_TUNNEL_REQUIRED=true', 'SSFB_DB_TUNNEL_REQUIRED'],
    ];
    for (const [line, key] of cases) {
      const err = refusal(homeWith([line]));
      expect(err.keys).toEqual([key]);
    }
  });

  test('forced flags let a home with mock off pass, and the file is left alone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'triage-eval-guard-'));
    dirs.push(dir);
    const home = materialiseEvalHome(join(dir, 'home'), ROOT);
    appendFileSync(join(home, '.env'), 'TRIAGE_MOCK_MODE=false\nTRIAGE_MOCK_STRICT=false\n');
    const unforced = loadConfig({ home });
    expect(refusal({ config: unforced, registry: loadRegistry(unforced) }).keys).toEqual([
      'TRIAGE_MOCK_MODE',
      'TRIAGE_MOCK_STRICT',
    ]);
    const config = loadConfig({ home, overrides: forceEvalFlags({}) });
    expect(config.mock).toEqual({ enabled: true, strict: true, record: false });
    expect(() => assertEvalHome(config, loadRegistry(config))).not.toThrow();
  });
});

describe('forceEvalFlags', () => {
  test('overrides MOCK_MODE=false, MOCK_STRICT=false and RECORD_FIXTURES=true', () => {
    const env: Record<string, string | undefined> = {
      TRIAGE_MOCK_MODE: 'false',
      TRIAGE_MOCK_STRICT: 'false',
      TRIAGE_RECORD_FIXTURES: 'true',
      OTHER: 'kept',
    };
    const out = forceEvalFlags(env);
    expect(out).toBe(env);
    expect(env).toEqual({ ...EVAL_FLAGS, OTHER: 'kept' });
  });

  test('sets the flags when they are absent', () => {
    expect(forceEvalFlags({})).toEqual({
      TRIAGE_MOCK_MODE: 'true',
      TRIAGE_MOCK_STRICT: 'true',
      TRIAGE_RECORD_FIXTURES: 'false',
    });
  });
});

describe('rawKeyState', () => {
  test('reports missing, empty and set without the value', () => {
    const config = configFromRecord({ ...TEMPLATE, SSFB_BRO_ADMIN_TOKEN: '  ', SLACK_BOT_TOKEN: 'x' }, HOME);
    expect(rawKeyState(config, 'NOT_A_KEY')).toBe('missing');
    expect(rawKeyState(config, 'SSFB_KUBE_CONTEXT')).toBe('empty');
    expect(rawKeyState(config, 'SSFB_BRO_ADMIN_TOKEN')).toBe('set');
    expect(rawKeyState(config, 'SLACK_BOT_TOKEN')).toBe('set');
  });
});
