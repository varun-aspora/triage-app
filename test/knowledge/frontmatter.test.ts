// Layout and front-matter rules from knowledge/README.md. Fixture trees are
// built in a temp dir; the real knowledge/ tree must pass the same checks.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseSkillFile } from '../../src/agents/skills.ts';
import {
  checkSkillTree,
  KNOWLEDGE_DIR,
  parseFrontmatter,
  SKILL_FILE,
  walkKnowledge,
  type TreeProblem,
} from './_util.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'knowledge-'));
  roots.push(root);
  for (const [rel, text] of Object.entries(files)) {
    const path = join(root, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  return root;
}

type SkillSpec = {
  name?: string;
  description?: string;
  metadata?: Record<string, string>;
  body?: string;
};

function skill(spec: SkillSpec = {}): string {
  const lines = ['---'];
  lines.push(`name: ${spec.name ?? 'ssfb-harbor'}`);
  lines.push(`description: ${spec.description ?? 'Harbor tables and checks. Use when a case touches onboarding forms.'}`);
  const metadata = spec.metadata ?? { kind: 'service', entity: 'ssfb', service: 'harbor', status: 'ported' };
  if (Object.keys(metadata).length > 0) {
    lines.push('metadata:');
    for (const [k, v] of Object.entries(metadata)) lines.push(`  ${k}: ${v}`);
  }
  lines.push('---', '', spec.body ?? '# Harbor\n\nLook up the form with sql_select and `<form_id>`.', '');
  return lines.join('\n');
}

const reasons = (problems: TreeProblem[]) => problems.map((p) => `${p.path}: ${p.reason}`);

describe('fixture trees', () => {
  test('a valid tree passes', () => {
    const root = tree({
      'README.md': '# contract\n',
      'method/orchestrator.md': '# Method\n',
      'classifier/categories.json': '[]\n',
      'ssfb-harbor/SKILL.md': skill(),
      'ssfb-overview/SKILL.md': skill({
        name: 'ssfb-overview',
        metadata: { kind: 'overview', entity: 'ssfb', sources: 'shivalik/AGENTS.md' },
      }),
      'patterns/SKILL.md': skill({ name: 'patterns', metadata: { kind: 'patterns', entity: 'shared', status: 'written' } }),
      'patterns/patterns.json': '[]\n',
    });
    expect(reasons(checkSkillTree(root))).toEqual([]);
  });

  test('an empty tree passes', () => {
    expect(checkSkillTree(tree({ 'README.md': '# contract\n' }))).toEqual([]);
  });

  test('name that does not match the directory fails', () => {
    const root = tree({ 'ssfb-rhythm/SKILL.md': skill({ name: 'ssfb-harbor' }) });
    expect(reasons(checkSkillTree(root)).join('\n')).toContain("name 'ssfb-harbor' does not match directory 'ssfb-rhythm'");
  });

  test('uppercase name fails', () => {
    const root = tree({
      'Ssfb-harbor/SKILL.md': skill({ name: 'Ssfb-harbor' }),
    });
    expect(reasons(checkSkillTree(root)).join('\n')).toContain('must be lowercase letters, digits and single hyphens');
  });

  test.each(['ssfb_harbor', 'ssfb--harbor', '-ssfb', 'ssfb-', 'a'.repeat(65)])('bad name charset %p fails', (name) => {
    const root = tree({ [`${name}/SKILL.md`]: skill({ name }) });
    expect(reasons(checkSkillTree(root)).join('\n')).toContain('must be lowercase letters, digits and single hyphens');
  });

  test('empty body fails', () => {
    const root = tree({ 'ssfb-harbor/SKILL.md': skill({ body: '   \n\n' }) });
    expect(reasons(checkSkillTree(root)).join('\n')).toContain('the body after the front-matter is empty');
  });

  test('empty description fails', () => {
    const root = tree({ 'ssfb-harbor/SKILL.md': skill({ description: '""' }) });
    expect(reasons(checkSkillTree(root)).join('\n')).toContain('description is empty');
  });

  test('description over 1024 characters fails, 1024 passes', () => {
    const over = tree({ 'ssfb-harbor/SKILL.md': skill({ description: 'x'.repeat(1025) }) });
    expect(reasons(checkSkillTree(over)).join('\n')).toContain('description is 1025 characters, over 1024');
    const at = tree({ 'ssfb-harbor/SKILL.md': skill({ description: 'x'.repeat(1024) }) });
    expect(checkSkillTree(at)).toEqual([]);
  });

  test('duplicate skill name fails', () => {
    const root = tree({
      'ssfb-harbor/SKILL.md': skill(),
      'group/ssfb-harbor/SKILL.md': skill(),
    });
    const text = reasons(checkSkillTree(root)).join('\n');
    expect(text).toContain("duplicate skill name 'ssfb-harbor'");
    expect(text).toContain('not deeper');
  });

  test.each(['method', 'classifier'])('SKILL.md under knowledge/%s/ fails', (dir) => {
    const root = tree({ [`${dir}/${SKILL_FILE}`]: skill({ name: dir }) });
    expect(reasons(checkSkillTree(root)).join('\n')).toContain(`no SKILL.md may sit under knowledge/${dir}/`);
    const nested = tree({ [`${dir}/ssfb-harbor/${SKILL_FILE}`]: skill() });
    expect(reasons(checkSkillTree(nested)).join('\n')).toContain(`no SKILL.md may sit under knowledge/${dir}/`);
  });

  test.each([
    ['status: true', 'true'],
    ['status: 3', '3'],
    ['status: null', 'null'],
    ['status: 2026-09-23', '2026-09-23'],
  ])('non-string metadata value %p fails', (_label, value) => {
    const root = tree({
      'ssfb-harbor/SKILL.md': skill({ metadata: { kind: 'service', entity: 'ssfb', service: 'harbor', status: value } }),
    });
    expect(reasons(checkSkillTree(root)).join('\n')).toContain('is not a string in YAML; quote it');
  });

  test('metadata list or nested map fails', () => {
    const list = skill().replace('  status: ported', '  sources:\n    - a\n    - b');
    const root = tree({ 'ssfb-harbor/SKILL.md': list });
    expect(reasons(checkSkillTree(root)).join('\n')).toMatch(/metadata sources is empty|not 'key: value'/);
    const flow = skill().replace('  status: ported', '  sources: [a, b]');
    const root2 = tree({ 'ssfb-harbor/SKILL.md': flow });
    expect(reasons(checkSkillTree(root2)).join('\n')).toContain('starts with a YAML indicator');
  });

  test('unknown top-level and metadata keys fail', () => {
    const top = skill().replace('metadata:', 'license: MIT\nmetadata:');
    expect(reasons(checkSkillTree(tree({ 'ssfb-harbor/SKILL.md': top }))).join('\n')).toContain("unknown key 'license'");
    const meta = skill().replace('  status: ported', '  owner: someone');
    expect(reasons(checkSkillTree(tree({ 'ssfb-harbor/SKILL.md': meta }))).join('\n')).toContain(
      "unknown metadata key 'owner'",
    );
  });

  test('metadata rules: kind, entity, service and status', () => {
    const cases: Array<[SkillSpec, string]> = [
      [{ metadata: { entity: 'ssfb', service: 'harbor' } }, 'metadata.kind is required'],
      [{ metadata: { kind: 'note', entity: 'ssfb' } }, "metadata.kind 'note' must be one of"],
      [{ metadata: { kind: 'service', service: 'harbor' } }, 'metadata.entity is required'],
      [{ metadata: { kind: 'service', entity: 'ssfb' } }, 'a service note needs metadata.service'],
      [{ metadata: { kind: 'service', entity: 'ssfb', service: 'rhythm' } }, "a service note is named 'ssfb-rhythm'"],
      [{ metadata: { kind: 'service', entity: 'shivalik', service: 'harbor' } }, "metadata.entity 'shivalik' must be one of"],
      [{ metadata: { kind: 'service', entity: 'ssfb', service: 'harbor', status: 'done' } }, "metadata.status 'done'"],
      [{ name: 'ssfb-overview', metadata: { kind: 'overview', entity: 'ssfb', service: 'harbor' } }, 'an overview has no metadata.service'],
      [{ name: 'repo-map', metadata: { kind: 'repo-map', entity: 'ssfb' } }, "metadata.entity of a repo-map skill is 'shared'"],
      [{ name: 'repo-map', metadata: { kind: 'patterns', entity: 'shared' } }, "a patterns skill is named 'patterns'"],
    ];
    for (const [spec, expected] of cases) {
      const name = spec.name ?? 'ssfb-harbor';
      const root = tree({ [`${name}/SKILL.md`]: skill(spec) });
      expect(reasons(checkSkillTree(root)).join('\n')).toContain(expected);
    }
  });

  test('layout: stray root file, skill dir without SKILL.md, nested method file', () => {
    const root = tree({
      'notes.md': 'x\n',
      'ssfb-harbor/notes.md': 'x\n',
      'method/sub/extra.md': 'x\n',
      'method/data.json': '{}\n',
    });
    const text = reasons(checkSkillTree(root)).join('\n');
    expect(text).toContain('notes.md: only README.md may sit directly under knowledge/');
    expect(text).toContain('ssfb-harbor: a skill directory must hold SKILL.md');
    expect(text).toContain('method/sub/extra.md: knowledge/method/ holds flat *.md files only');
    expect(text).toContain('method/data.json: knowledge/method/ holds flat *.md files only');
  });
});

describe('parseFrontmatter', () => {
  test('reads quoted values and the metadata map', () => {
    const parsed = parseFrontmatter(
      [
        '---',
        'name: ssfb-harbor',
        `description: "Harbor: tables and checks. Use when # matters."`,
        'metadata:',
        "  kind: 'service'",
        '  entity: ssfb',
        '  service: harbor',
        "  status: 'true'",
        '---',
        'Body.',
      ].join('\n'),
    );
    if ('error' in parsed) throw new Error(parsed.error);
    expect(parsed.frontmatter).toEqual({
      name: 'ssfb-harbor',
      description: 'Harbor: tables and checks. Use when # matters.',
      metadata: { kind: 'service', entity: 'ssfb', service: 'harbor', status: 'true' },
    });
    expect(parsed.body).toBe('Body.');
  });

  test.each([
    ['no opening line', 'name: x\n---\nbody'],
    ['not closed', '---\nname: x\ndescription: y\nbody'],
    ['block scalar', '---\nname: x\ndescription: |\n  y\n---\nbody'],
    ['comment', '---\n# note\nname: x\ndescription: y\n---\nbody'],
    ['unquoted colon', '---\nname: x\ndescription: a: b\n---\nbody'],
    ['missing description', '---\nname: x\n---\nbody'],
    ['duplicate key', '---\nname: x\nname: y\ndescription: z\n---\nbody'],
    ['bad double quote', '---\nname: x\ndescription: "y\n---\nbody'],
    ['indented line outside metadata', '---\nname: x\n  kind: service\ndescription: y\n---\nbody'],
  ])('refuses %s', (_label, text) => {
    expect('error' in parseFrontmatter(text)).toBe(true);
  });
});

// The subset must read the same as the runtime loader in src/agents/skills.ts,
// or a note could pass here and load differently at boot.
function expectLoaderAgrees(root: string): void {
  for (const f of walkKnowledge(root).filter((file) => file.rel.endsWith(`/${SKILL_FILE}`))) {
    const text = readFileSync(f.abs, 'utf8');
    const ours = parseFrontmatter(text);
    const loader = parseSkillFile(text);
    if ('error' in ours) throw new Error(`${f.rel}: ${ours.error}`);
    if ('error' in loader) throw new Error(`${f.rel}: loader: ${loader.error}`);
    expect(loader.fields['name']).toBe(ours.frontmatter.name);
    expect(loader.fields['description']).toBe(ours.frontmatter.description);
    expect(loader.fields['metadata'] ?? {}).toEqual(ours.frontmatter.metadata);
    expect(loader.body).toBe(ours.body);
  }
}

describe('agreement with the runtime loader', () => {
  test('a fixture skill with quoted values reads the same', () => {
    const root = tree({
      'ssfb-harbor/SKILL.md': skill({
        description: `"Harbor: forms and customers. Use when # of forms matters."`,
        metadata: { kind: 'service', entity: 'ssfb', service: 'harbor', sources: "'a.md, b.md'", status: 'ported' },
      }),
    });
    expect(checkSkillTree(root)).toEqual([]);
    expectLoaderAgrees(root);
  });
});

describe('the real knowledge/ tree', () => {
  test('passes the layout and front-matter checks', () => {
    expect(reasons(checkSkillTree(KNOWLEDGE_DIR))).toEqual([]);
  });

  test('the runtime loader parses every SKILL.md the same way', () => {
    expectLoaderAgrees(KNOWLEDGE_DIR);
  });
});
