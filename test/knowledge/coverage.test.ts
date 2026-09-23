// Knowledge coverage against the registries (T12.8): every registry service
// has an <entity>-<service> note, every such note names a registry service,
// every entity has an overview, every method file knowledge/README.md names
// exists, and skill names are unique across the tree. Fixture trees are built
// in a temp dir to show each rule refusing.

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ENTITIES, type Entity } from '../../src/types/core.ts';
import {
  AGENTS,
  GLOBAL_SKILLS,
  KNOWLEDGE_DIR,
  methodFilesFor,
  NON_SKILL_DIRS,
  parseFrontmatter,
  REPO_ROOT,
  SKILL_FILE,
  topLevelDirs,
} from './_util.ts';

type Registry = ReadonlyMap<Entity, readonly string[]>;

function realRegistry(): Registry {
  const out = new Map<Entity, string[]>();
  for (const entity of ENTITIES) {
    const file = join(REPO_ROOT, 'resources', `${entity}.entity.json`);
    const registry = JSON.parse(readFileSync(file, 'utf8')) as { services?: Record<string, unknown> };
    out.set(entity, Object.keys(registry.services ?? {}).sort());
  }
  return out;
}

// ------------------------------------------------------------------ checks

/** Registry services with no knowledge/<entity>-<service>/SKILL.md. */
function servicesWithoutNotes(root: string, registry: Registry): string[] {
  const out: string[] = [];
  for (const [entity, services] of registry) {
    for (const service of services) {
      if (!existsSync(join(root, `${entity}-${service}`, SKILL_FILE))) out.push(`${entity}:${service}`);
    }
  }
  return out;
}

/** Skill directories that are neither a global skill, an overview nor a registry service. */
function notesWithoutServices(root: string, registry: Registry): string[] {
  const out: string[] = [];
  for (const dir of topLevelDirs(root)) {
    if ((NON_SKILL_DIRS as readonly string[]).includes(dir)) continue;
    if ((GLOBAL_SKILLS as readonly string[]).includes(dir)) continue;
    const m = /^([a-z0-9]+)-(.+)$/.exec(dir);
    const entity = m?.[1] as Entity | undefined;
    const rest = m?.[2];
    if (!entity || !rest || !(ENTITIES as readonly string[]).includes(entity)) {
      out.push(`${dir}: not <entity>-<service>, <entity>-overview or a global skill`);
      continue;
    }
    if (rest === 'overview') continue;
    if (!(registry.get(entity) ?? []).includes(rest)) out.push(`${dir}: ${entity}:${rest} is not a registry service`);
  }
  return out;
}

/** Entities with no knowledge/<entity>-overview/SKILL.md. */
function entitiesWithoutOverview(root: string, entities: readonly Entity[] = ENTITIES): string[] {
  return entities.filter((e) => !existsSync(join(root, `${e}-overview`, SKILL_FILE)));
}

/**
 * Method files named in the Instruction column of the README's "Which agent
 * gets what" table, with `<entity>` expanded to each entity.
 */
function readmeMethodFiles(readme: string, entities: readonly Entity[] = ENTITIES): string[] {
  const lines = readme.split('\n');
  const start = lines.findIndex((l) => /^## Which agent gets what\s*$/.test(l));
  if (start < 0) throw new Error('README has no "## Which agent gets what" section');
  const end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  const rows = lines
    .slice(start + 1, end < 0 ? undefined : end)
    .filter((l) => l.startsWith('|') && !/^\|\s*-/.test(l))
    .slice(1); // header row
  const out = new Set<string>();
  for (const row of rows) {
    const cell = row.split('|')[2] ?? '';
    for (const m of cell.matchAll(/`([a-z0-9<>-]+\.md)`/g)) {
      const name = m[1] as string;
      if (name.includes('<entity>')) for (const e of entities) out.add(name.replace('<entity>', e));
      else out.add(name);
    }
  }
  return [...out].sort();
}

/** README method files missing from method/, and method/ files the README does not name. */
function methodProblems(root: string): { missing: string[]; unnamed: string[] } {
  const named = readmeMethodFiles(readFileSync(join(root, 'README.md'), 'utf8'));
  const methodDir = join(root, 'method');
  const onDisk = existsSync(methodDir) ? readdirSync(methodDir).filter((f) => f.endsWith('.md')).sort() : [];
  return {
    missing: named.filter((f) => !onDisk.includes(f)),
    unnamed: onDisk.filter((f) => !named.includes(f)),
  };
}

/** Skill names used more than once, or not equal to their directory. */
function nameProblems(root: string): string[] {
  const out: string[] = [];
  const seen = new Map<string, string>();
  for (const dir of topLevelDirs(root)) {
    const file = join(root, dir, SKILL_FILE);
    if (!existsSync(file)) continue;
    const parsed = parseFrontmatter(readFileSync(file, 'utf8'));
    if ('error' in parsed) {
      out.push(`${dir}: ${parsed.error}`);
      continue;
    }
    const name = parsed.frontmatter.name;
    const earlier = seen.get(name);
    if (earlier !== undefined) out.push(`${dir}: skill name '${name}' is also used by ${earlier}`);
    else seen.set(name, dir);
    if (name !== dir) out.push(`${dir}: skill name '${name}' does not match its directory`);
  }
  return out;
}

// --------------------------------------------------------------- real tree

describe('the knowledge tree covers the registry', () => {
  const registry = realRegistry();

  test('every registry service has <entity>-<service>/SKILL.md', () => {
    expect(servicesWithoutNotes(KNOWLEDGE_DIR, registry)).toEqual([]);
  });

  test('every <entity>-<service> directory names a registry service', () => {
    expect(notesWithoutServices(KNOWLEDGE_DIR, registry)).toEqual([]);
  });

  test('each entity has an overview', () => {
    expect(entitiesWithoutOverview(KNOWLEDGE_DIR)).toEqual([]);
  });

  test('every method file named in README.md exists, and every method file is named', () => {
    expect(methodProblems(KNOWLEDGE_DIR)).toEqual({ missing: [], unnamed: [] });
  });

  test('the README method files are the ones the test helpers compose per agent', () => {
    const fromHelpers = new Set<string>();
    for (const agent of AGENTS) for (const e of ENTITIES) for (const f of methodFilesFor(agent, e)) fromHelpers.add(f);
    const readme = readmeMethodFiles(readFileSync(join(KNOWLEDGE_DIR, 'README.md'), 'utf8'));
    expect(readme).toEqual([...fromHelpers].sort());
  });

  test('every skill name is unique across the tree and equals its directory', () => {
    expect(nameProblems(KNOWLEDGE_DIR)).toEqual([]);
  });
});

// ------------------------------------------------------------- deny paths

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'knowledge-coverage-'));
  roots.push(root);
  for (const [rel, text] of Object.entries(files)) {
    const path = join(root, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  return root;
}

const skill = (name: string) => `---\nname: ${name}\ndescription: Fixture note.\n---\n\nBody.\n`;

const README = [
  '# knowledge/',
  '',
  '## Which agent gets what',
  '',
  '| Agent | Instruction | Skills |',
  '|---|---|---|',
  '| `Triage` | `orchestrator.md` | `patterns` |',
  '| `investigate_<entity>` | `investigator.md`, `logs-<entity>.md` | notes |',
  '',
  '## Next section',
  '',
  'Mentions `other.md`, which is not in the table.',
  '',
].join('\n');

const FIXTURE_REGISTRY: Registry = new Map<Entity, string[]>([
  ['ssfb', ['harbor']],
  ['atspl', []],
  ['rtl', []],
]);

function goodTree(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'README.md': README,
    'method/orchestrator.md': '# m\n',
    'method/investigator.md': '# m\n',
    'method/logs-ssfb.md': '# m\n',
    'method/logs-atspl.md': '# m\n',
    'method/logs-rtl.md': '# m\n',
    'ssfb-overview/SKILL.md': skill('ssfb-overview'),
    'atspl-overview/SKILL.md': skill('atspl-overview'),
    'rtl-overview/SKILL.md': skill('rtl-overview'),
    'ssfb-harbor/SKILL.md': skill('ssfb-harbor'),
    'patterns/SKILL.md': skill('patterns'),
    ...extra,
  };
}

describe('the coverage checks refuse bad trees', () => {
  test('a good fixture tree passes every check', () => {
    const root = tree(goodTree());
    expect(servicesWithoutNotes(root, FIXTURE_REGISTRY)).toEqual([]);
    expect(notesWithoutServices(root, FIXTURE_REGISTRY)).toEqual([]);
    expect(entitiesWithoutOverview(root)).toEqual([]);
    expect(methodProblems(root)).toEqual({ missing: [], unnamed: [] });
    expect(nameProblems(root)).toEqual([]);
  });

  test('a registry service with no note', () => {
    const root = tree(goodTree());
    const registry: Registry = new Map<Entity, readonly string[]>([...FIXTURE_REGISTRY, ['ssfb', ['harbor', 'rhythm']]]);
    expect(servicesWithoutNotes(root, registry)).toEqual(['ssfb:rhythm']);
  });

  test('a note for a service the registry does not have', () => {
    const root = tree(goodTree({ 'ssfb-ledger/SKILL.md': skill('ssfb-ledger') }));
    expect(notesWithoutServices(root, FIXTURE_REGISTRY)).toEqual(['ssfb-ledger: ssfb:ledger is not a registry service']);
  });

  test('a note filed under the wrong entity', () => {
    const root = tree(goodTree({ 'rtl-harbor/SKILL.md': skill('rtl-harbor') }));
    expect(notesWithoutServices(root, FIXTURE_REGISTRY)).toEqual(['rtl-harbor: rtl:harbor is not a registry service']);
  });

  test('a directory that is not an entity note or a global skill', () => {
    const root = tree(goodTree({ 'shivalik-harbor/SKILL.md': skill('shivalik-harbor'), 'notes/SKILL.md': skill('notes') }));
    expect(notesWithoutServices(root, FIXTURE_REGISTRY)).toEqual([
      'notes: not <entity>-<service>, <entity>-overview or a global skill',
      'shivalik-harbor: not <entity>-<service>, <entity>-overview or a global skill',
    ]);
  });

  test('an entity with no overview', () => {
    const files = goodTree();
    delete files['rtl-overview/SKILL.md'];
    expect(entitiesWithoutOverview(tree(files))).toEqual(['rtl']);
  });

  test('a README method file that does not exist, expanded per entity', () => {
    const files = goodTree();
    delete files['method/logs-atspl.md'];
    delete files['method/orchestrator.md'];
    expect(methodProblems(tree(files))).toEqual({ missing: ['logs-atspl.md', 'orchestrator.md'], unnamed: [] });
  });

  test('a method file the README does not name', () => {
    const root = tree(goodTree({ 'method/stray.md': '# m\n' }));
    expect(methodProblems(root)).toEqual({ missing: [], unnamed: ['stray.md'] });
  });

  test('only the table counts, not other mentions in the README', () => {
    expect(readmeMethodFiles(README)).toEqual([
      'investigator.md',
      'logs-atspl.md',
      'logs-rtl.md',
      'logs-ssfb.md',
      'orchestrator.md',
    ]);
  });

  test('a README without the agent table is an error', () => {
    expect(() => readmeMethodFiles('# knowledge/\n')).toThrow();
  });

  test('two skills with the same name', () => {
    const root = tree(goodTree({ 'rtl-overview/SKILL.md': skill('ssfb-overview') }));
    expect(nameProblems(root)).toEqual([
      "rtl-overview: skill name 'ssfb-overview' does not match its directory",
      "ssfb-overview: skill name 'ssfb-overview' is also used by rtl-overview",
    ]);
  });
});
