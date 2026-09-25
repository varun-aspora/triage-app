import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { parse } from 'dotenv';
import * as v from 'valibot';
import { ENTITIES, type Entity } from '../types/core.ts';
import { configFromRecord, type Config } from './env.ts';
import { isEntityKey } from './keys.ts';
import {
  EntityRegistrySchema,
  RegistryError,
  buildRegistry,
  envNamesOf,
  loadRegistry,
  registryFile,
  type EntityRegistry,
  type Registry,
} from './registry.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const RESOURCES = join(ROOT, 'resources');
const EXAMPLE: Readonly<Record<string, string>> = parse(readFileSync(join(ROOT, '.env.example'), 'utf8'));

type Overrides = Readonly<Record<string, string | undefined>>;

// .env.example as the .env, with overrides; undefined removes the key.
function config(overrides: Overrides = {}): Config {
  const record: Record<string, string> = { ...EXAMPLE };
  for (const [k, value] of Object.entries(overrides)) {
    if (value === undefined) delete record[k];
    else record[k] = value;
  }
  return configFromRecord(record, '/triage/home');
}

function registry(overrides: Overrides = {}): Registry {
  return loadRegistry(config(overrides), { resourcesDir: RESOURCES });
}

function shipped(entity: Entity): EntityRegistry {
  return v.parse(EntityRegistrySchema, JSON.parse(readFileSync(join(RESOURCES, registryFile(entity)), 'utf8')));
}

function shippedDocs(edit: (docs: Record<Entity, EntityRegistry>) => void = () => {}): { file: string; doc: unknown }[] {
  const docs = Object.fromEntries(ENTITIES.map((e) => [e, structuredClone(shipped(e))])) as Record<Entity, EntityRegistry>;
  edit(docs);
  return ENTITIES.map((e) => ({ file: `resources/${registryFile(e)}`, doc: docs[e] }));
}

function registryError(fn: () => unknown): RegistryError {
  try {
    fn();
  } catch (err) {
    if (err instanceof RegistryError) return err;
    throw err;
  }
  throw new Error('expected a RegistryError');
}

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempResources(): string {
  const dir = mkdtempSync(join(tmpdir(), 'triage-registry-test-'));
  made.push(dir);
  cpSync(RESOURCES, dir, { recursive: true });
  return dir;
}

describe('shipped registries', () => {
  test('each file parses and names its own entity', () => {
    for (const entity of ENTITIES) {
      const raw = JSON.parse(readFileSync(join(RESOURCES, registryFile(entity)), 'utf8'));
      const parsed = v.safeParse(EntityRegistrySchema, raw);
      expect(parsed.issues).toBeUndefined();
      expect(parsed.success).toBe(true);
      expect(raw.entity).toBe(entity);
    }
  });

  test('every env name they reference exists in .env.example', () => {
    for (const entity of ENTITIES) {
      const absent = envNamesOf(shipped(entity)).filter((name) => !(name in EXAMPLE));
      expect({ entity, absent }).toEqual({ entity, absent: [] });
    }
  });

  test('every env name starts with the entity prefix', () => {
    for (const entity of ENTITIES) {
      for (const name of envNamesOf(shipped(entity))) expect(name.startsWith(`${entity.toUpperCase()}_`)).toBe(true);
    }
  });

  test('load with .env.example as the .env', () => {
    const r = registry();
    expect(r.entities).toEqual(['ssfb', 'atspl', 'rtl']);
    expect(r.enabledEntities()).toEqual(['ssfb', 'atspl', 'rtl']);
  });

  test('services match the plan', () => {
    const r = registry();
    expect(r.services('ssfb')).toEqual([
      'harbor', 'rhythm', 'guardian', 'comms', 'workflow', 'cohort',
      'pdfgen', 'reminder', 'bro', 'eventbus', 'audit', 'finacle',
    ]);
    expect(r.services('atspl')).toEqual(['package', 'pulse']);
    expect(r.services('rtl')).toEqual(['workflow', 'banking', 'kyc']);
  });

  test('ATSPL log service strings come from the qw survey', () => {
    const r = registry();
    expect(r.service('atspl', 'pulse').quickwit_service).toBe('pulse-backend');
    expect(r.service('atspl', 'package').quickwit_service).toBe('package');
  });

  test('the three api.rules.json files are exactly []', () => {
    for (const entity of ENTITIES) {
      const text = readFileSync(join(RESOURCES, `${entity}.api.rules.json`), 'utf8');
      expect(JSON.parse(text)).toEqual([]);
      expect(text.trim()).toBe('[]');
    }
  });
});

describe('aliases', () => {
  test("resolveEntity('shivalik') is ssfb and ids resolve to themselves", () => {
    const r = registry();
    expect(r.resolveEntity('shivalik')).toBe('ssfb');
    expect(r.resolveEntity(' Shivalik ')).toBe('ssfb');
    for (const e of ENTITIES) expect(r.resolveEntity(e)).toBe(e);
  });

  test('an unknown alias returns undefined', () => {
    const r = registry();
    expect(r.resolveEntity('vance')).toBeUndefined();
    expect(r.resolveEntity('')).toBeUndefined();
    expect(r.resolveEntity('constructor')).toBeUndefined();
  });

  test('an alias listed by two entities is a RegistryError', () => {
    const docs = shippedDocs((d) => {
      d.atspl.aliases = ['shivalik'];
    });
    const err = registryError(() => buildRegistry(config(), docs));
    expect(err.message).toContain('alias shivalik');
    expect(err.keys).toContain('resources/atspl.entity.json');
  });

  test("an alias equal to another entity's id is a RegistryError", () => {
    const docs = shippedDocs((d) => {
      d.rtl.aliases = ['ssfb'];
    });
    expect(registryError(() => buildRegistry(config(), docs)).message).toContain('alias ssfb');
  });
});

describe('TRIAGE_ENTITIES', () => {
  test('an unknown id is a RegistryError naming TRIAGE_ENTITIES, not the value', () => {
    const err = registryError(() => registry({ TRIAGE_ENTITIES: 'ssfb,bogusentity' }));
    expect(err.keys).toEqual(['TRIAGE_ENTITIES']);
    expect(err.message).not.toContain('bogusentity');
  });

  test('an alias is accepted and deduplicated', () => {
    expect(registry({ TRIAGE_ENTITIES: 'shivalik,ssfb' }).enabledEntities()).toEqual(['ssfb']);
  });

  test("enabledEntities(['atspl']) with ssfb,atspl enabled is ['atspl']", () => {
    expect(registry({ TRIAGE_ENTITIES: 'ssfb,atspl' }).enabledEntities(['atspl'])).toEqual(['atspl']);
  });

  test('narrowing never widens', () => {
    const r = registry({ TRIAGE_ENTITIES: 'ssfb,atspl' });
    expect(r.enabledEntities(['rtl'])).toEqual([]);
    expect(r.enabledEntities(['rtl', 'atspl'])).toEqual(['atspl']);
    expect(r.enabledEntities(['nope'])).toEqual([]);
    expect(r.enabledEntities(['shivalik'])).toEqual(['ssfb']);
    expect(r.enabledEntities()).toEqual(['ssfb', 'atspl']);
    expect(r.enabledEntities([])).toEqual(['ssfb', 'atspl']);
    expect(r.isEnabled('rtl')).toBe(false);
  });

  test('value accessors refuse a disabled entity', () => {
    const r = registry({ TRIAGE_ENTITIES: 'ssfb' });
    expect(registryError(() => r.serviceDb('rtl', 'kyc')).keys).toEqual(['TRIAGE_ENTITIES']);
    expect(() => r.quickwit('atspl')).toThrow(RegistryError);
    expect(() => r.kube('atspl')).toThrow(RegistryError);
    // Structure stays readable.
    expect(r.services('rtl')).toEqual(['workflow', 'banking', 'kyc']);
  });
});

describe('missing and blank keys', () => {
  test('a key absent from the .env for an enabled entity is a startup error listing the key names', () => {
    const err = registryError(() => registry({ RTL_KYC_DB_URL: undefined, RTL_BANKING_API_URL: undefined }));
    expect(err.keys).toContain('RTL_KYC_DB_URL');
    expect(err.keys).toContain('RTL_BANKING_API_URL');
    expect(err.message).toContain('RTL_KYC_DB_URL');
  });

  test('under http, <ENTITY>_QW_CONTEXT may be absent from the .env', () => {
    const q = registry({ SSFB_QUICKWIT_TRANSPORT: 'http', SSFB_QW_CONTEXT: undefined }).quickwit('ssfb');
    expect(q.status === 'ok' && q.transport).toBe('http');
  });

  test('under qw, an absent <ENTITY>_QW_CONTEXT is a startup error', () => {
    const err = registryError(() => registry({ SSFB_QUICKWIT_TRANSPORT: 'qw', SSFB_QW_CONTEXT: undefined }));
    expect(err.keys).toEqual(['SSFB_QW_CONTEXT']);
  });

  test('under qw, the http url, auth and token keys may be absent from the .env', () => {
    const q = registry({ ATSPL_QUICKWIT_URL: undefined, ATSPL_QUICKWIT_AUTH: undefined, ATSPL_QUICKWIT_TOKEN: undefined }).quickwit('atspl');
    expect(q.status === 'ok' && q.transport).toBe('qw');
  });

  test('with the transport blank or invalid, every quickwit key stays required', () => {
    for (const transport of ['', 'grpc']) {
      const err = registryError(() => registry({ SSFB_QUICKWIT_TRANSPORT: transport, SSFB_QW_CONTEXT: undefined }));
      expect(err.keys).toContain('SSFB_QW_CONTEXT');
    }
  });

  test('the same key absent for a disabled entity is no error', () => {
    const r = registry({ TRIAGE_ENTITIES: 'ssfb,atspl', RTL_KYC_DB_URL: undefined, RTL_BANKING_API_URL: undefined });
    const rows = r.capabilityReport('rtl').rows;
    expect(rows.find((row) => row.envNames[0] === 'RTL_KYC_DB_URL')?.status).toBe('missing');
  });

  test('a blank SSFB_COHORT_API_URL disables serviceApi with reason blank', () => {
    const api = registry({ SSFB_COHORT_API_URL: '' }).serviceApi('ssfb', 'cohort');
    expect(api).toEqual({ status: 'disabled', envName: 'SSFB_COHORT_API_URL', reason: 'blank', transport: 'http' });
  });

  test('a whitespace-only value counts as blank', () => {
    expect(registry({ SSFB_HARBOR_DB_URL: '   ' }).serviceDb('ssfb', 'harbor')?.status).toBe('disabled');
  });

  test('a set value is ok and readable, but hidden from JSON and inspect', () => {
    const db = registry({ SSFB_HARBOR_DB_URL: 'postgresql://u:hunter2-db@db.test:5432/x' }).serviceDb('ssfb', 'harbor');
    if (db?.status !== 'ok') throw new Error('expected ok');
    expect(db.value).toBe('postgresql://u:hunter2-db@db.test:5432/x');
    expect(JSON.stringify(db)).not.toContain('hunter2');
    expect(inspect(db)).not.toContain('hunter2');
    expect({ ...db }).toEqual({ status: 'ok', envName: 'SSFB_HARBOR_DB_URL' } as never);
  });

  test('a service without a db or api key returns undefined', () => {
    const r = registry();
    expect(r.serviceDb('ssfb', 'finacle')).toBeUndefined();
    expect(r.serviceApi('ssfb', 'comms')).toBeUndefined();
    expect(r.serviceAuth('ssfb', 'harbor')).toBeUndefined();
  });

  test('an unknown service is a RegistryError', () => {
    const r = registry();
    expect(() => r.serviceDb('ssfb', 'nope')).toThrow(RegistryError);
    expect(() => r.service('atspl', 'harbor')).toThrow(RegistryError);
    expect(() => r.serviceDb('ssfb', 'toString')).toThrow(RegistryError);
  });

  test('bro auth carries header and scheme; a blank token disables it', () => {
    const on = registry({ SSFB_BRO_ADMIN_TOKEN: 'tok-bro-secret' }).serviceAuth('ssfb', 'bro');
    expect(on?.status).toBe('ok');
    expect(on?.header).toBe('Authorization');
    expect(on?.scheme).toBe('Bearer');
    expect(on?.status === 'ok' ? on.value : '').toBe('tok-bro-secret');
    expect(JSON.stringify(on)).not.toContain('tok-bro-secret');
    const off = registry({ SSFB_BRO_ADMIN_TOKEN: '' }).serviceAuth('ssfb', 'bro');
    expect(off?.status).toBe('disabled');
  });
});

describe('field encryption', () => {
  test('a blank SSFB_HARBOR_FIELD_ENC_KEY disables fieldEncryption', () => {
    const fe = registry({ SSFB_HARBOR_FIELD_ENC_KEY: '' }).fieldEncryption('ssfb', 'harbor');
    expect(fe).toEqual({ status: 'disabled', envName: 'SSFB_HARBOR_FIELD_ENC_KEY', reason: 'blank', algorithm: 'aes-siv' });
  });

  test('a set key enables it without exposing the key', () => {
    const fe = registry({ SSFB_HARBOR_FIELD_ENC_KEY: 'enc-key-secret' }).fieldEncryption('ssfb', 'harbor');
    expect(fe?.status).toBe('ok');
    expect(fe?.status === 'ok' ? fe.value : '').toBe('enc-key-secret');
    expect(inspect(fe)).not.toContain('enc-key-secret');
  });

  test('services without field encryption return undefined', () => {
    expect(registry().fieldEncryption('ssfb', 'guardian')).toBeUndefined();
  });
});

describe('quickwit', () => {
  test('qw with a context is ok, with the default limits when blank', () => {
    const q = registry({ ATSPL_QUICKWIT_MAX_CONCURRENCY: '', ATSPL_QUICKWIT_MAX_HITS: '' }).quickwit('atspl');
    expect(q).toEqual({ status: 'ok', transport: 'qw', index: 'envoy-logs', maxConcurrency: 1, maxHits: 500, context: 'envoy-prod' });
  });

  test('.env.example puts SSFB on http and ATSPL and RTL on qw', () => {
    const r = registry();
    const ssfb = r.quickwit('ssfb');
    expect(ssfb.status === 'ok' && ssfb.transport === 'http' && ssfb.auth).toBe('none');
    expect(EXAMPLE['ATSPL_QUICKWIT_TRANSPORT']).toBe('qw');
    expect(EXAMPLE['RTL_QUICKWIT_TRANSPORT']).toBe('qw');
    expect(EXAMPLE['ATSPL_QW_CONTEXT']).toBe('envoy-prod');
    expect(EXAMPLE['RTL_QW_CONTEXT']).toBe('core-prod-london');
  });

  test('set limits are used', () => {
    const q = registry({ ATSPL_QUICKWIT_MAX_CONCURRENCY: '3', ATSPL_QUICKWIT_MAX_HITS: '50' }).quickwit('atspl');
    expect(q.status === 'ok' && [q.maxConcurrency, q.maxHits]).toEqual([3, 50]);
  });

  test("transport qw with a blank <ENTITY>_QW_CONTEXT is disabled with a reason naming the key", () => {
    const q = registry({ ATSPL_QW_CONTEXT: '' }).quickwit('atspl');
    expect(q.status).toBe('disabled');
    expect(q.status === 'disabled' && q.reason).toContain('ATSPL_QW_CONTEXT');
  });

  test('transport http with auth bearer and a blank token is disabled', () => {
    const q = registry({ ATSPL_QUICKWIT_TRANSPORT: 'http', ATSPL_QUICKWIT_AUTH: 'bearer', ATSPL_QUICKWIT_TOKEN: '' }).quickwit('atspl');
    expect(q.status).toBe('disabled');
    expect(q.status === 'disabled' && q.reason).toContain('ATSPL_QUICKWIT_TOKEN');
  });

  test('transport http with bearer and a token is ok; url and token stay hidden', () => {
    const q = registry({
      ATSPL_QUICKWIT_TRANSPORT: 'http',
      ATSPL_QUICKWIT_URL: 'https://qw.test/secret-path',
      ATSPL_QUICKWIT_AUTH: 'bearer',
      ATSPL_QUICKWIT_TOKEN: 'qw-token-secret',
    }).quickwit('atspl');
    if (q.status !== 'ok' || q.transport !== 'http') throw new Error('expected http ok');
    expect(q.url).toBe('https://qw.test/secret-path');
    expect(q.token).toBe('qw-token-secret');
    expect(q.auth).toBe('bearer');
    expect(JSON.stringify(q)).not.toContain('secret');
    expect(inspect(q)).not.toContain('secret');
  });

  test('transport http with auth none needs no token; blank auth means none', () => {
    const q = registry({ SSFB_QUICKWIT_TRANSPORT: 'http', SSFB_QUICKWIT_AUTH: '' }).quickwit('ssfb');
    expect(q.status === 'ok' && q.transport === 'http' && q.auth).toBe('none');
  });

  test('transport http with a blank url is disabled naming the key', () => {
    const q = registry({ SSFB_QUICKWIT_TRANSPORT: 'http', SSFB_QUICKWIT_URL: '' }).quickwit('ssfb');
    expect(q.status === 'disabled' && q.reason).toContain('SSFB_QUICKWIT_URL');
  });

  test('a blank transport or index is disabled naming the key', () => {
    const t = registry({ SSFB_QUICKWIT_TRANSPORT: '' }).quickwit('ssfb');
    expect(t.status === 'disabled' && t.reason).toContain('SSFB_QUICKWIT_TRANSPORT');
    // RTL_QUICKWIT_INDEX is blank in .env.example.
    const i = registry().quickwit('rtl');
    expect(i.status === 'disabled' && i.reason).toContain('RTL_QUICKWIT_INDEX');
  });

  test("transport value 'grpc' is a startup error", () => {
    const err = registryError(() => registry({ SSFB_QUICKWIT_TRANSPORT: 'grpc' }));
    expect(err.keys).toEqual(['SSFB_QUICKWIT_TRANSPORT']);
    expect(err.message).not.toContain('grpc');
  });

  test('a bad auth value or limit is a startup error', () => {
    expect(registryError(() => registry({ SSFB_QUICKWIT_AUTH: 'basic' })).keys).toEqual(['SSFB_QUICKWIT_AUTH']);
    expect(registryError(() => registry({ SSFB_QUICKWIT_MAX_HITS: 'lots' })).keys).toEqual(['SSFB_QUICKWIT_MAX_HITS']);
    expect(registryError(() => registry({ SSFB_QUICKWIT_MAX_CONCURRENCY: '0' })).keys).toEqual(['SSFB_QUICKWIT_MAX_CONCURRENCY']);
  });

  test('a bad transport on a disabled entity is no startup error and shows as invalid in the report', () => {
    const r = registry({ TRIAGE_ENTITIES: 'ssfb', RTL_QUICKWIT_TRANSPORT: 'grpc' });
    const row = r.capabilityReport('rtl').rows.find((x) => x.capability === 'quickwit');
    expect(row?.status).toBe('invalid');
    expect(row?.reason).toContain('RTL_QUICKWIT_TRANSPORT');
  });

  test('quickwitFields come from the registry file', () => {
    expect(registry().quickwitFields('ssfb')).toContain('x-customer-id');
  });
});

describe('finacle and cbs', () => {
  test('finacle has transport cbs and serviceApi marks it cbs-only', () => {
    const r = registry({ SSFB_CBS_GATEWAY_URL: 'https://gw.test' });
    expect(r.service('ssfb', 'finacle').transport).toBe('cbs');
    expect(r.serviceApi('ssfb', 'finacle')?.transport).toBe('cbs');
    expect(r.serviceApi('ssfb', 'harbor')?.transport).toBe('http');
    const row = r.capabilityReport('ssfb').rows.find((x) => x.service === 'finacle');
    expect(row?.reason).toContain('cbs_call');
  });

  test('cbsEnabled follows the flag', () => {
    expect(registry({ SSFB_CBS_VIA_KUBECTL_ENABLED: 'false' }).cbsEnabled('ssfb')).toBe(false);
    expect(registry({ SSFB_CBS_VIA_KUBECTL_ENABLED: '' }).cbsEnabled('ssfb')).toBe(false);
    expect(registry({ SSFB_CBS_VIA_KUBECTL_ENABLED: 'true' }).cbsEnabled('ssfb')).toBe(true);
    expect(registry().cbsEnabled('atspl')).toBe(false);
  });

  test('a malformed cbs flag is a startup error', () => {
    expect(registryError(() => registry({ SSFB_CBS_VIA_KUBECTL_ENABLED: 'yes' })).keys).toEqual(['SSFB_CBS_VIA_KUBECTL_ENABLED']);
  });

  test('transport cbs without a cbs block is refused', () => {
    const docs = shippedDocs((d) => {
      d.atspl.services.pulse = { ...d.atspl.services.pulse, transport: 'cbs' };
    });
    expect(registryError(() => buildRegistry(config(), docs)).message).toContain('no cbs block');
  });
});

describe('kube and repos', () => {
  test('kube gives both capabilities', () => {
    const k = registry({ SSFB_KUBE_CONTEXT: 'ctx', SSFB_AWS_PROFILE: '' }).kube('ssfb');
    expect(k.context.status).toBe('ok');
    expect(k.awsProfile).toEqual({ status: 'disabled', envName: 'SSFB_AWS_PROFILE', reason: 'blank' });
  });

  test('repos lists service repos then repos_extra, without duplicates', () => {
    const repos = registry().repos('ssfb');
    expect(repos.slice(0, 2)).toEqual(['harbor', 'rhythm']);
    expect(repos).toContain('shivalik-cbs-go');
    expect(new Set(repos).size).toBe(repos.length);
    expect(registry().repos('rtl')).toContain('kyc-service');
  });
});

describe('registry file checks', () => {
  test('a missing registry file is a RegistryError naming the file', () => {
    const dir = tempResources();
    rmSync(join(dir, 'rtl.entity.json'));
    const err = registryError(() => loadRegistry(config(), { resourcesDir: dir }));
    expect(err.keys).toEqual(['resources/rtl.entity.json']);
  });

  test('invalid JSON is a RegistryError that does not echo the content', () => {
    const dir = tempResources();
    writeFileSync(join(dir, 'atspl.entity.json'), '{ "entity": "atspl", secret-ish');
    const err = registryError(() => loadRegistry(config(), { resourcesDir: dir }));
    expect(err.keys).toEqual(['resources/atspl.entity.json']);
    expect(err.message).not.toContain('secret-ish');
  });

  test('an unknown field is refused (strict schema)', () => {
    const docs = shippedDocs((d) => {
      (d.ssfb.services.harbor as Record<string, unknown>).dbb = 'SSFB_HARBOR_DB_URL';
    });
    expect(registryError(() => buildRegistry(config(), docs)).message).toContain('services.harbor');
  });

  test('an env name from another entity is refused', () => {
    const docs = shippedDocs((d) => {
      d.atspl.services.package = { ...d.atspl.services.package, db: 'SSFB_HARBOR_DB_URL' };
    });
    expect(registryError(() => buildRegistry(config(), docs)).message).toContain('does not start with ATSPL_');
  });

  test('a file whose entity does not match its name is refused', () => {
    const [ssfb, atspl] = shippedDocs();
    const docs = [ssfb, { file: 'resources/rtl.entity.json', doc: atspl?.doc }] as { file: string; doc: unknown }[];
    const err = registryError(() => buildRegistry(config({ TRIAGE_ENTITIES: 'ssfb' }), docs));
    expect(err.message).toContain('the file name must match');
  });

  test('a non-entity env name is refused by the schema', () => {
    const docs = shippedDocs((d) => {
      d.rtl.services.kyc = { ...d.rtl.services.kyc, db: 'TRIAGE_DB_URL' };
    });
    expect(() => buildRegistry(config(), docs)).toThrow(RegistryError);
  });
});

describe('capabilityReport', () => {
  test('lists env names and statuses for every capability', () => {
    const report = registry({ SSFB_COHORT_API_URL: '' }).capabilityReport('ssfb');
    expect(report.entity).toBe('ssfb');
    expect(report.enabled).toBe(true);
    const cohort = report.rows.find((r) => r.capability === 'api' && r.service === 'cohort');
    expect(cohort).toEqual({ capability: 'api', service: 'cohort', envNames: ['SSFB_COHORT_API_URL'], status: 'blank' });
    const kinds = new Set(report.rows.map((r) => r.capability));
    for (const k of ['db', 'api', 'auth', 'field_encryption', 'quickwit', 'cbs', 'kube_context', 'aws_profile']) {
      expect(kinds.has(k as never)).toBe(true);
    }
  });

  test('contains no value from the .env (seeded secrets)', () => {
    const seeds: string[] = [];
    const overrides: Record<string, string> = {};
    let i = 0;
    for (const key of Object.keys(EXAMPLE)) {
      if (!isEntityKey(key)) continue;
      if (key.endsWith('_QUICKWIT_TRANSPORT')) overrides[key] = 'http';
      else if (key.endsWith('_QUICKWIT_AUTH')) overrides[key] = 'bearer';
      else if (key.endsWith('_MAX_CONCURRENCY') || key.endsWith('_MAX_HITS')) overrides[key] = '7';
      else if (key === 'SSFB_CBS_VIA_KUBECTL_ENABLED') overrides[key] = 'true';
      // The index name is shown on the quickwit capability on purpose; it is not a credential.
      else if (key.endsWith('_QUICKWIT_INDEX')) overrides[key] = 'logs-index';
      else {
        const seed = `SEEDED-${i++}-x9q`;
        seeds.push(seed);
        overrides[key] = seed;
      }
    }
    const r = registry(overrides);
    const leaks = (text: string): string[] => seeds.filter((s) => text.includes(s));
    for (const entity of ENTITIES) {
      const report = r.capabilityReport(entity);
      expect(report.rows.length).toBeGreaterThan(0);
      expect(leaks(JSON.stringify(report))).toEqual([]);
      expect(leaks(inspect(report, { depth: 10 }))).toEqual([]);
      for (const row of report.rows) {
        expect(Object.keys(row).every((k) => ['capability', 'service', 'envNames', 'status', 'reason'].includes(k))).toBe(true);
        expect(row.status).toBe('ok');
      }
      // Capabilities themselves keep values out of their serialised form too.
      expect(leaks(JSON.stringify(r.quickwit(entity)))).toEqual([]);
      expect(leaks(JSON.stringify(r.kube(entity)))).toEqual([]);
      for (const service of r.services(entity)) {
        const caps = [r.serviceDb(entity, service), r.serviceApi(entity, service), r.serviceAuth(entity, service)];
        expect(leaks(JSON.stringify(caps))).toEqual([]);
        expect(leaks(inspect(caps, { depth: 10 }))).toEqual([]);
      }
    }
  });

  test('startup errors carry no seeded value', () => {
    const err = registryError(() => registry({ SSFB_QUICKWIT_TRANSPORT: 'SEEDED-transport-x9q', SSFB_QUICKWIT_MAX_HITS: 'SEEDED-hits-x9q' }));
    expect(err.message).not.toContain('SEEDED');
    expect(JSON.stringify(err.problems)).not.toContain('SEEDED');
  });
});
