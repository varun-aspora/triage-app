import { afterEach, describe, expect, test } from 'bun:test';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';
import { configFromRecord, type Config } from './env.ts';
import { RegistryError, loadRegistry, type Registry } from './registry.ts';
import { loadRepos, parseRepos, repoEnum, type RepoPin } from './repos.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const RESOURCES = join(ROOT, 'resources');
const EXAMPLE: Readonly<Record<string, string>> = parse(readFileSync(join(ROOT, '.env.example'), 'utf8'));

function config(): Config {
  return configFromRecord({ ...EXAMPLE }, '/triage/home');
}

function registry(): Registry {
  return loadRegistry(config(), { resourcesDir: RESOURCES });
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
    expect(() => parseRepos([{ repo: 'harbor', entities: ['ssfb'], remote: 'git@x:y' }], r)).toThrow(RegistryError);
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
