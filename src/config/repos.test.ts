import { afterEach, describe, expect, test } from 'bun:test';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';
import { configFromRecord, type Config } from './env.ts';
import { RegistryError, loadRegistry, type Registry } from './registry.ts';
import { infraRepoFor, loadRepos, parseRepos, repoEnum, type RepoPin } from './repos.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const RESOURCES = join(ROOT, 'resources');
const EXAMPLE: Readonly<Record<string, string>> = parse(readFileSync(join(ROOT, '.env.example'), 'utf8'));

function config(overrides: Readonly<Record<string, string>> = {}): Config {
  return configFromRecord({ ...EXAMPLE, ...overrides }, '/triage/home');
}

function registry(overrides: Readonly<Record<string, string>> = {}): Registry {
  return loadRegistry(config(overrides), { resourcesDir: RESOURCES });
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
  const dir = mkdtempSync(join(tmpdir(), 'triage-repos-test-'));
  made.push(dir);
  cpSync(RESOURCES, dir, { recursive: true });
  return dir;
}

describe('resources/repos.json', () => {
  test('the shipped manifest is valid', () => {
    const pins = loadRepos(config(), registry(), { resourcesDir: RESOURCES });
    expect(pins.length).toBeGreaterThan(0);
    expect(pins.find((p) => p.repo === 'harbor')).toEqual({ repo: 'harbor', entities: ['ssfb'] });
    expect(pins.find((p) => p.repo === 'workflow-op')?.entities).toEqual(['ssfb', 'rtl']);
  });

  test('the shipped manifest pins every registry repo', () => {
    const r = registry();
    const e = repoEnum(r, loadRepos(config(), r, { resourcesDir: RESOURCES }));
    expect(e.unpinned).toEqual([]);
  });

  test('a missing or unreadable manifest is a RegistryError naming the file', () => {
    const dir = tempResources();
    writeFileSync(join(dir, 'repos.json'), '[{ nope');
    expect(registryError(() => loadRepos(config(), registry(), { resourcesDir: dir })).keys).toEqual(['resources/repos.json']);
    rmSync(join(dir, 'repos.json'));
    expect(registryError(() => loadRepos(config(), registry(), { resourcesDir: dir })).message).toContain('is missing');
  });
});

describe('parseRepos', () => {
  test('a valid manifest parses, and a missing branch means the default branch', () => {
    const pins = parseRepos(
      [
        { repo: 'harbor', entities: ['ssfb'], branch: 'pre-prod' },
        { repo: 'kyc-service', entities: ['rtl'] },
      ],
      registry(),
    );
    expect(pins[0]).toEqual({ repo: 'harbor', entities: ['ssfb'], branch: 'pre-prod' });
    expect(pins[1]?.branch).toBeUndefined();
    expect(pins[1] && 'branch' in pins[1]).toBe(false);
  });

  test('an unknown entity in a pin is an error', () => {
    const err = registryError(() => parseRepos([{ repo: 'harbor', entities: ['ssfb', 'mars'] }], registry()));
    expect(err.message).toContain('unknown entity');
    expect(err.keys).toEqual(['resources/repos.json']);
  });

  test('an alias is not accepted in a pin; use the id', () => {
    expect(() => parseRepos([{ repo: 'harbor', entities: ['shivalik'] }], registry())).toThrow(RegistryError);
  });

  test('an empty entity list, a duplicate repo, or an unknown field is an error', () => {
    const r = registry();
    expect(() => parseRepos([{ repo: 'harbor', entities: [] }], r)).toThrow(RegistryError);
    expect(() => parseRepos([{ repo: 'harbor', entities: ['ssfb'] }, { repo: 'harbor', entities: ['rtl'] }], r)).toThrow(/repeats repo/);
    expect(() => parseRepos([{ repo: 'harbor', entities: ['ssfb'], url: 'git@x:y' }], r)).toThrow(RegistryError);
    expect(() => parseRepos({ repos: [] }, r)).toThrow(RegistryError);
  });

  test('unsafe repo or branch names are refused', () => {
    const r = registry();
    for (const repo of ['../harbor', '-x', 'a b', '']) {
      expect(() => parseRepos([{ repo, entities: ['ssfb'] }], r)).toThrow(RegistryError);
    }
    for (const branch of ['--force', 'a..b', 'a b', 'x.lock', 'x/', '']) {
      expect(() => parseRepos([{ repo: 'harbor', entities: ['ssfb'], branch }], r)).toThrow(RegistryError);
    }
  });
});

describe('repoEnum', () => {
  const pins: readonly RepoPin[] = [
    { repo: 'harbor', entities: ['ssfb'] },
    { repo: 'vance-android', entities: ['ssfb', 'rtl'] },
    { repo: 'kyc-service', entities: ['ssfb'] },
  ];

  test('is the union of repos.json and registry repo/repos_extra', () => {
    const r = registry();
    const e = repoEnum(r, pins);
    const fromRegistry = r.entities.flatMap((x) => r.repos(x));
    for (const name of [...fromRegistry, 'vance-android']) expect(e.names).toContain(name);
    expect(e.names).toEqual([...new Set([...fromRegistry, 'harbor', 'vance-android', 'kyc-service'])].sort());
  });

  test('reports registry repos missing from repos.json, per entity', () => {
    const e = repoEnum(registry(), pins);
    expect(e.unpinned).toContainEqual({ entity: 'ssfb', repo: 'rhythm' });
    expect(e.unpinned).toContainEqual({ entity: 'atspl', repo: 'pulse-backend' });
    // kyc-service is pinned, but for the wrong entity.
    expect(e.unpinned).toContainEqual({ entity: 'rtl', repo: 'kyc-service' });
    expect(e.unpinned).not.toContainEqual({ entity: 'ssfb', repo: 'harbor' });
  });

  test('narrowing to entities limits both sources', () => {
    const e = repoEnum(registry(), pins, ['atspl']);
    expect(e.names).toContain('pulse-backend');
    expect(e.names).not.toContain('harbor');
    expect(e.names).not.toContain('vance-android');
  });
});

describe('infraRepoFor', () => {
  const pins = (): readonly RepoPin[] => loadRepos(config(), registry(), { resourcesDir: RESOURCES });

  test('every prod and stage infra repo is pinned for its entity', () => {
    const stage = { SSFB_INFRA_REPO: 'non-prod-aspora-argo', ATSPL_INFRA_REPO: 'stage-atspl-aspora-argo', RTL_INFRA_REPO: 'k8s-manifests:environments/vance-core/stage/ap-south-1' };
    for (const r of [registry(), registry(stage)]) {
      for (const entity of r.entities) expect(infraRepoFor(r, pins(), entity).status).toBe('ok');
    }
  });

  test('a repo pinned for another entity is off, naming the key and repo', () => {
    const r = registry({ ATSPL_INFRA_REPO: 'k8s-manifests' });
    expect(infraRepoFor(r, pins(), 'atspl')).toEqual({
      status: 'off',
      envName: 'ATSPL_INFRA_REPO',
      reason: 'ATSPL_INFRA_REPO names k8s-manifests, which is not pinned for atspl in resources/repos.json',
    });
  });

  test('blank is off', () => {
    expect(infraRepoFor(registry({ RTL_INFRA_REPO: '' }), pins(), 'rtl')).toMatchObject({ status: 'off', reason: 'RTL_INFRA_REPO is blank' });
  });
});
