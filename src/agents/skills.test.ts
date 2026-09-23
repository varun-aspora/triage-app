import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  codegraphLimitsSkill,
  currentKnowledge,
  KnowledgeError,
  loadKnowledge,
  methodDoc,
  overviewSkill,
  parseSkillFile,
  patternsSkill,
  repoMapSkill,
  serviceSkills,
} from './skills.ts';

const FIXTURE = fileURLToPath(new URL('./__fixtures__/knowledge', import.meta.url));
const SRC = fileURLToPath(new URL('..', import.meta.url));

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'triage-knowledge-test-'));
  made.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const skillMd = (name: string, description = `Notes for ${name}. Use when testing.`, body = 'Body.') =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;

function loadError(dir: string): KnowledgeError {
  try {
    loadKnowledge(dir);
  } catch (error) {
    if (error instanceof KnowledgeError) return error;
    throw error;
  }
  throw new Error('expected loadKnowledge to fail');
}

describe('loadKnowledge over the fixture tree', () => {
  test('returns method text and skills keyed by directory name', () => {
    const k = loadKnowledge(FIXTURE);
    expect([...k.skills.keys()].sort()).toEqual([
      'atspl-overview',
      'codegraph-limits',
      'patterns',
      'repo-map',
      'ssfb-harbor',
      'ssfb-overview',
    ]);
    for (const [key, skill] of k.skills) expect(skill.name).toBe(key);
    expect([...k.method.keys()]).toEqual(['brief-template.md', 'investigator.md', 'orchestrator.md', 'report-format.md']);
    expect(k.method.get('orchestrator.md')).toContain('Fixture text for the orchestrator');
    expect(k.warnings).toEqual([]);
  });

  test('nothing from knowledge/method becomes a skill', () => {
    const k = loadKnowledge(FIXTURE);
    for (const skill of k.skills.values()) {
      expect(skill.name).not.toBe('method');
      expect(skill.instructions).not.toContain('Fixture text for the');
    }
    const withSkillMd = tree({
      'method/SKILL.md': skillMd('method'),
      'method/orchestrator.md': 'Method text.',
      'patterns/SKILL.md': skillMd('patterns'),
    });
    const k2 = loadKnowledge(withSkillMd);
    expect([...k2.skills.keys()]).toEqual(['patterns']);
    expect(k2.method.get('orchestrator.md')).toBe('Method text.');
  });

  test('parses plain, quoted and folded descriptions, metadata and the body', () => {
    const k = loadKnowledge(FIXTURE);
    expect(k.skills.get('atspl-overview')?.description).toBe(
      'ATSPL id chain and service ownership. Use when an ATSPL id needs resolving.',
    );
    expect(k.skills.get('codegraph-limits')?.description).toBe(
      'What CodeGraph output can and cannot show. Use before citing graph output as evidence.',
    );
    const harbor = k.skills.get('ssfb-harbor');
    expect(harbor?.description).toBe('Harbor service notes for SSFB. Use when a question touches account forms or SIM binding.');
    expect(harbor?.metadata).toEqual({ owner: 'fixture' });
    expect(harbor?.instructions).toBe('Fixture notes for harbor. Read notes/errors.md for the error list.');
  });

  test('supporting files are attached with posix relative paths, SKILL.md excluded', () => {
    const k = loadKnowledge(FIXTURE);
    expect(Object.keys(k.skills.get('ssfb-harbor')?.files ?? {})).toEqual(['notes/errors.md']);
    const patterns = k.skills.get('patterns')?.files?.['patterns.json'];
    expect(typeof patterns).toBe('string');
    expect(JSON.parse(patterns as string)[0].id).toBe('fixture-pattern');
    expect(k.skills.get('repo-map')?.files).toBeUndefined();
  });

  test('skills are frozen defineSkill definitions', () => {
    const skill = loadKnowledge(FIXTURE).skills.get('patterns');
    expect(Object.isFrozen(skill)).toBe(true);
  });

  test('a relative or missing dir fails with the path', () => {
    expect(() => loadKnowledge('knowledge')).toThrow('knowledge: knowledge dir must be an absolute path');
    const missing = join(tmpdir(), 'triage-knowledge-does-not-exist');
    expect(() => loadKnowledge(missing)).toThrow(`${missing}: knowledge dir does not exist`);
  });

  test('a missing method dir and a directory without SKILL.md are warnings, not failures', () => {
    const dir = tree({ 'drafts/notes.md': 'x', 'patterns/SKILL.md': skillMd('patterns') });
    const k = loadKnowledge(dir);
    expect(k.method.size).toBe(0);
    expect(k.warnings).toEqual([
      `${join(dir, 'method')}: no method directory, the instruction has run data only`,
      `${join(dir, 'drafts')}: no SKILL.md, skipped`,
    ]);
  });
});

describe('loadKnowledge refuses a bad SKILL.md with its path', () => {
  test('name different from the directory', () => {
    const dir = tree({ 'ssfb-harbor/SKILL.md': skillMd('ssfb-rhythm') });
    const err = loadError(dir);
    expect(err.problems).toEqual([
      { path: join(dir, 'ssfb-harbor', 'SKILL.md'), reason: "name 'ssfb-rhythm' does not match directory 'ssfb-harbor'" },
    ]);
    expect(err.message).toContain(join(dir, 'ssfb-harbor', 'SKILL.md'));
  });

  test('empty description', () => {
    const dir = tree({
      'a-empty/SKILL.md': '---\nname: a-empty\ndescription:\n---\n\nBody.\n',
      'b-blank/SKILL.md': "---\nname: b-blank\ndescription: '  '\n---\n\nBody.\n",
      'c-none/SKILL.md': '---\nname: c-none\n---\n\nBody.\n',
    });
    const err = loadError(dir);
    expect(err.problems.map((p) => [relative(dir, p.path), p.reason])).toEqual([
      [join('a-empty', 'SKILL.md'), 'frontmatter has an empty description'],
      [join('b-blank', 'SKILL.md'), 'frontmatter has an empty description'],
      [join('c-none', 'SKILL.md'), 'frontmatter has an empty description'],
    ]);
  });

  test('missing or unclosed frontmatter', () => {
    const dir = tree({
      'no-front/SKILL.md': '# Just markdown\n\nBody.\n',
      'open-front/SKILL.md': '---\nname: open-front\ndescription: d\n\nBody.\n',
    });
    const err = loadError(dir);
    expect(err.problems).toEqual([
      { path: join(dir, 'no-front', 'SKILL.md'), reason: 'missing frontmatter (the file must start with ---)' },
      { path: join(dir, 'open-front', 'SKILL.md'), reason: 'frontmatter is not closed with ---' },
    ]);
  });

  test('missing name, invalid name and empty body', () => {
    const dir = tree({
      'no-name/SKILL.md': '---\ndescription: d\n---\n\nBody.\n',
      'Bad--Name/SKILL.md': skillMd('Bad--Name'),
      'no-body/SKILL.md': skillMd('no-body', 'd', ''),
    });
    const reasons = loadError(dir).problems.map((p) => `${relative(dir, p.path)}: ${p.reason}`);
    expect(reasons).toEqual([
      `${join('Bad--Name', 'SKILL.md')}: name 'Bad--Name' must be lowercase letters, digits and single hyphens, at most 64 characters`,
      `${join('no-body', 'SKILL.md')}: SKILL.md has no instructions after the frontmatter`,
      `${join('no-name', 'SKILL.md')}: frontmatter has no name`,
    ]);
  });

  test('unsupported frontmatter syntax is an error, not a guess', () => {
    const dir = tree({ 'flow/SKILL.md': '---\nname: flow\ndescription: d\nmetadata: {a: b}\n---\n\nBody.\n' });
    expect(loadError(dir).problems[0]?.reason).toBe('frontmatter metadata: flow collections are not supported');
  });

  test('secret-looking files, symlinks and nested SKILL.md fail with the path', () => {
    const dir = tree({
      'ssfb-harbor/SKILL.md': skillMd('ssfb-harbor'),
      'ssfb-harbor/.env': 'NOT_READ=1',
      'ssfb-rhythm/SKILL.md': skillMd('ssfb-rhythm'),
      'ssfb-rhythm/inner/SKILL.md': skillMd('inner'),
      'ssfb-guardian/SKILL.md': skillMd('ssfb-guardian'),
    });
    symlinkSync(join(dir, 'ssfb-harbor', 'SKILL.md'), join(dir, 'ssfb-guardian', 'link.md'));
    const problems = loadError(dir).problems.map((p) => `${relative(dir, p.path)}: ${p.reason}`);
    expect(problems).toEqual([
      `${join('ssfb-guardian', 'link.md')}: symbolic links are not allowed in a skill directory`,
      `${join('ssfb-harbor', '.env')}: secret-looking file in a skill directory`,
      `${join('ssfb-rhythm', 'inner')}: nested SKILL.md inside skill ssfb-rhythm`,
    ]);
  });

  test('a failed load keeps the previous knowledge', () => {
    const good = loadKnowledge(FIXTURE);
    loadError(tree({ 'x/SKILL.md': 'no frontmatter' }));
    expect(currentKnowledge()).toBe(good);
  });
});

describe('duplicate skill names', () => {
  test('two directories resolving to the same name fail with both paths', () => {
    const dir = tree({
      'ssfb/ssfb-harbor/SKILL.md': skillMd('ssfb-harbor'),
      'legacy/ssfb-harbor/SKILL.md': skillMd('ssfb-harbor'),
    });
    const err = loadError(dir);
    expect(err.problems).toEqual([
      {
        path: join(dir, 'ssfb', 'ssfb-harbor'),
        reason: `duplicate skill name 'ssfb-harbor', also at ${join(dir, 'legacy', 'ssfb-harbor')}`,
      },
    ]);
  });

  test('nested group directories with unique names load', () => {
    const dir = tree({
      'ssfb/ssfb-harbor/SKILL.md': skillMd('ssfb-harbor'),
      'rtl/rtl-workflow/SKILL.md': skillMd('rtl-workflow'),
    });
    expect([...loadKnowledge(dir).skills.keys()]).toEqual(['rtl-workflow', 'ssfb-harbor']);
  });
});

describe('cached accessors', () => {
  test('return the cached skills by conventional name', () => {
    const k = loadKnowledge(FIXTURE);
    expect(overviewSkill('ssfb')).toBe(k.skills.get('ssfb-overview') as never);
    expect(overviewSkill('atspl')?.name).toBe('atspl-overview');
    expect(patternsSkill()?.name).toBe('patterns');
    expect(repoMapSkill()?.name).toBe('repo-map');
    expect(codegraphLimitsSkill()?.name).toBe('codegraph-limits');
    // Same object on every call, so a render does no work.
    expect(patternsSkill()).toBe(patternsSkill() as never);
  });

  test("serviceSkills('ssfb', ['harbor','nosuch']) returns ssfb-harbor and reports nosuch", () => {
    loadKnowledge(FIXTURE);
    const result = serviceSkills('ssfb', ['harbor', 'nosuch']);
    expect(result.skills.map((s) => s.name)).toEqual(['ssfb-harbor']);
    expect(result.missing).toEqual(['nosuch']);
  });

  test('serviceSkills never returns the overview, repeats or another entity’s notes', () => {
    loadKnowledge(FIXTURE);
    const result = serviceSkills('atspl', ['harbor', 'overview', 'Harbor', ' ']);
    expect(result.skills).toEqual([]);
    expect(result.missing).toEqual(['harbor']);
  });

  test('a missing overview or global skill is undefined, not a crash', () => {
    loadKnowledge(tree({ 'method/orchestrator.md': 'x' }));
    expect(overviewSkill('rtl')).toBeUndefined();
    expect(patternsSkill()).toBeUndefined();
    expect(repoMapSkill()).toBeUndefined();
    expect(codegraphLimitsSkill()).toBeUndefined();
    expect(serviceSkills('rtl', ['workflow']).missing).toEqual(['workflow']);
  });

  test('accessors can take an explicit knowledge value', () => {
    const fixture = loadKnowledge(FIXTURE);
    loadKnowledge(tree({ 'method/orchestrator.md': 'x' }));
    expect(overviewSkill('ssfb', fixture)?.name).toBe('ssfb-overview');
    expect(methodDoc('investigator.md', fixture)).toContain('per-entity investigator');
    expect(methodDoc('nosuch.md', fixture)).toBeUndefined();
  });
});

describe('parseSkillFile', () => {
  test('literal block, lists, comments and a CRLF file', () => {
    const text = [
      '---',
      '# a comment',
      'name: x',
      'description: |',
      '  line one',
      '  line two',
      'allowed-tools: sql_select logs_search # trailing comment',
      'tags:',
      '  - a',
      "  - 'b c'",
      '---',
      '',
      'Body',
    ].join('\r\n');
    const parsed = parseSkillFile(text);
    expect(parsed).toEqual({
      fields: {
        name: 'x',
        description: 'line one\nline two',
        'allowed-tools': 'sql_select logs_search',
        tags: ['a', 'b c'],
      },
      body: 'Body',
    });
  });

  test('an indented top-level line is refused', () => {
    expect(parseSkillFile('---\n  name: x\n---\nBody')).toEqual({ error: "frontmatter line 2 is not 'key: value'" });
  });
});

// Build-resolved .md imports do not load under bun test or Vitest, so no
// source file may import one (D42).
const MD_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["'][^"'\n]+\.md(?:\?[^"'\n]*)?["']/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__fixtures__' ? [] : sourceFiles(path);
    return /\.(ts|tsx|js|mjs|cjs)$/.test(entry.name) ? [path] : [];
  });
}

describe('no static .md imports', () => {
  test('the pattern catches every import form', () => {
    const md = '.md';
    for (const line of [
      `import skill from '../skills/x/SKILL${md}';`,
      `import "./notes${md}";`,
      `export { default } from "./a${md}";`,
      `const t = await import('./b${md}');`,
      `const t = require("./c${md}?raw");`,
    ]) {
      expect(MD_IMPORT.test(line)).toBe(true);
    }
    expect(MD_IMPORT.test(`const name = 'SKILL${md}';`)).toBe(false);
    expect(MD_IMPORT.test(`readFileSync(join(dir, 'SKILL${md}'))`)).toBe(false);
  });

  test('no source file under src/ imports a .md file', () => {
    const offenders = sourceFiles(SRC).filter((file) => MD_IMPORT.test(readFileSync(file, 'utf8')));
    expect(offenders.map((f) => relative(SRC, f))).toEqual([]);
  });
});
