import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'dotenv';
import { ENTITY_KEY_PATTERN, PROVIDER_KEYS } from '../../src/config/keys.ts';
import { ENTITIES } from '../../src/types/core.ts';
import {
  EXAMPLE_ENV,
  isBlankedKey,
  looksLikeHost,
  makeTestHome,
  testEnvRecord,
  type TestHome,
} from './home.ts';

const homes: TestHome[] = [];
function home(options?: Parameters<typeof makeTestHome>[0]): TestHome {
  const h = makeTestHome(options);
  homes.push(h);
  return h;
}

afterEach(() => {
  for (const h of homes.splice(0)) h.cleanup();
});

function tempHomes(): string[] {
  return readdirSync(tmpdir()).filter((d) => d.startsWith('triage-home-'));
}

// Parses the .env the helper wrote, not the one it returned, so the file itself is checked.
function writtenEnv(h: TestHome): Record<string, string> {
  return parse(readFileSync(join(h.home, '.env'), 'utf8'));
}

describe('makeTestHome', () => {
  test('returns a loadable config and registry', () => {
    const h = home();
    expect(h.config.home).toBe(h.home);
    expect(h.config.paths.resourcesDir).toBe(join(h.home, 'resources'));
    expect(existsSync(join(h.home, 'resources', 'ssfb.entity.json'))).toBe(true);
    expect(h.registry.enabledEntities()).toEqual([...ENTITIES]);
  });

  test('every example key is present, so no registry key is missing', () => {
    const h = home();
    const example = parse(readFileSync(EXAMPLE_ENV, 'utf8'));
    const written = writtenEnv(h);
    for (const name of Object.keys(example)) {
      if (name === 'TRIAGE_HOME') continue;
      expect(Object.hasOwn(written, name)).toBe(true);
    }
    expect(Object.hasOwn(written, 'TRIAGE_HOME')).toBe(false);
  });

  test('credential and host keys are blank', () => {
    const written = writtenEnv(home());
    const blanked = Object.keys(written).filter(isBlankedKey);
    // The suffix list must actually match the known credential keys.
    for (const name of [
      'SSFB_HARBOR_DB_URL',
      'SSFB_HARBOR_API_URL',
      'SSFB_QUICKWIT_URL',
      'SSFB_QUICKWIT_TOKEN',
      'SSFB_BRO_ADMIN_TOKEN',
      'SSFB_HARBOR_FIELD_ENC_KEY',
      'SSFB_CBS_CREDS_SECRET',
      'SSFB_CBS_GATEWAY_URL',
      'SSFB_CBS_OAUTH_SCOPE',
      'SSFB_CBS_BASTION',
      'SSFB_DB_TUNNEL_BASTION',
      'SSFB_DB_TUNNEL_IDENTITY_FILE',
      'SSFB_DB_TUNNEL_REMOTE_HOST',
      'ATSPL_PACKAGE_DB_URL',
      'RTL_BANKING_DB_URL',
      'SLACK_BOT_TOKEN',
      'SLACK_SIGNING_SECRET',
      'TRIAGE_HTTP_AUTH_TOKEN',
      'TRIAGE_DB_URL',
      'OLLAMA_BASE_URL',
      'E2B_API_KEY',
      'DAYTONA_API_KEY',
      'DAYTONA_API_URL',
      ...PROVIDER_KEYS,
    ]) {
      expect(blanked).toContain(name);
    }
    for (const name of blanked) expect(written[name]).toBe('');
  });

  test('no entity or provider value holds @, :// or a host name', () => {
    const written = writtenEnv(home());
    const offenders = Object.entries(written)
      .filter(([name]) => ENTITY_KEY_PATTERN.test(name) || isBlankedKey(name))
      .filter(([, value]) => value.includes('@') || value.includes('://') || looksLikeHost(value))
      .map(([name]) => name);
    expect(offenders).toEqual([]);
  });

  test('a host in an entity key the suffix list misses is still blanked', () => {
    const record = testEnvRecord('SSFB_NEW_ENDPOINT=db.example.invalid\nSSFB_OTHER=user@box\nSSFB_PLAIN=logs-v1\n');
    expect(record.SSFB_NEW_ENDPOINT).toBe('');
    expect(record.SSFB_OTHER).toBe('');
    expect(record.SSFB_PLAIN).toBe('logs-v1');
  });

  test('every registry capability that needs a credential is disabled', () => {
    const { registry } = home();
    for (const entity of registry.enabledEntities()) {
      for (const service of registry.services(entity)) {
        for (const cap of [
          registry.serviceDb(entity, service),
          registry.serviceApi(entity, service),
          registry.serviceAuth(entity, service),
          registry.fieldEncryption(entity, service),
        ]) {
          if (cap !== undefined) expect(cap.status).toBe('disabled');
        }
      }
      const kube = registry.kube(entity);
      expect(kube.context.status).toBe('disabled');
      expect(kube.awsProfile.status).toBe('disabled');
      expect(registry.cbsEnabled(entity)).toBe(false);
      // Quickwit over http needs a URL and maybe a token; both are blank. The qw
      // transport carries no credential in the .env (SSO login lives in the CLI).
      const qw = registry.quickwit(entity);
      if (qw.status === 'ok') expect(qw.transport).toBe('qw');
      const report = registry.capabilityReport(entity);
      const okRows = report.rows.filter((r) => r.status === 'ok').map((r) => r.capability);
      expect(okRows.every((c) => c === 'quickwit')).toBe(true);
    }
  });

  test('mock mode and strict are forced on, recording off', () => {
    const { config } = home();
    expect(config.mock.enabled).toBe(true);
    expect(config.mock.strict).toBe(true);
    expect(config.mock.record).toBe(false);
  });

  test('overrides are applied', () => {
    const h = home({
      overrides: {
        TRIAGE_ENV_LABEL: 'test # label',
        TRIAGE_SQL_MAX_ROWS: '5',
        SSFB_HARBOR_DB_URL: 'postgresql://fixture.invalid/harbor',
        TRIAGE_MOCK_MODE: 'true',
      },
    });
    expect(h.config.display.envLabel).toBe('test # label');
    expect(h.config.sql.maxRows).toBe(5);
    const cap = h.registry.serviceDb('ssfb', 'harbor');
    expect(cap?.status).toBe('ok');
    expect(cap?.status === 'ok' ? cap.value : undefined).toBe('postgresql://fixture.invalid/harbor');
    expect(h.config.mock.enabled).toBe(true);
  });

  test('entities narrows TRIAGE_ENTITIES', () => {
    const h = home({ entities: ['atspl'] });
    expect(h.config.entities).toEqual(['atspl']);
    expect(h.registry.enabledEntities()).toEqual(['atspl']);
  });

  test('refuses to turn mock mode or strict off, or recording on', () => {
    expect(() => makeTestHome({ overrides: { TRIAGE_MOCK_MODE: 'false' } })).toThrow(/forced/);
    expect(() => makeTestHome({ overrides: { TRIAGE_MOCK_STRICT: 'false' } })).toThrow(/forced/);
    expect(() => makeTestHome({ overrides: { TRIAGE_RECORD_FIXTURES: 'true' } })).toThrow(/forced/);
  });

  test('refuses bad override names and values', () => {
    expect(() => makeTestHome({ overrides: { TRIAGE_HOME: '/elsewhere' } })).toThrow(/chosen by the helper/);
    expect(() => makeTestHome({ overrides: { 'bad-name': 'x' } })).toThrow(/not an env name/);
    expect(() => makeTestHome({ overrides: { TRIAGE_ENV_LABEL: 'a\nSSFB_X=y' } })).toThrow(/one line/);
    expect(() => makeTestHome({ entities: ['ssfb'], overrides: { TRIAGE_ENTITIES: 'rtl' } })).toThrow(/not both/);
  });

  test('a home that fails to load is removed before the error surfaces', () => {
    const before = new Set(tempHomes());
    let err: unknown;
    try {
      makeTestHome({ overrides: { TRIAGE_SANDBOX_PROVIDER: 'local' } });
    } catch (e) {
      err = e;
    }
    expect((err as Error | undefined)?.name).toBe('ConfigError');
    expect(tempHomes().filter((d) => !before.has(d))).toEqual([]);
  });

  test('cleanup removes the temp dir and is safe to repeat', () => {
    const h = makeTestHome();
    expect(existsSync(h.home)).toBe(true);
    h.cleanup();
    expect(existsSync(h.home)).toBe(false);
    h.cleanup();
  });
});
