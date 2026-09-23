// Validates the real knowledge/ tree that ships with the repo: every SKILL.md
// has valid frontmatter, its name matches its directory and names are unique.
// This replaces the check a build-time SKILL.md import used to do (D42). It is
// skipped until the knowledge content (T12) is merged.

import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { basename, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KnowledgeError, loadKnowledge } from './skills.ts';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const KNOWLEDGE = fileURLToPath(new URL('../../knowledge', import.meta.url));
const present = existsSync(KNOWLEDGE);

describe.skipIf(!present)('knowledge/ tree', () => {
  test('every SKILL.md loads with valid frontmatter and a unique name', () => {
    let problems: string[] = [];
    try {
      loadKnowledge(KNOWLEDGE);
    } catch (error) {
      if (!(error instanceof KnowledgeError)) throw error;
      problems = error.problems.map((p) => `${relative(REPO_ROOT, p.path)}: ${p.reason}`);
    }
    expect(problems).toEqual([]);
  });

  test('skill names follow the convention and carry a routing description', () => {
    const k = loadKnowledge(KNOWLEDGE);
    for (const [name, skill] of k.skills) {
      expect(skill.name).toBe(name);
      expect(name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(skill.description.trim().length).toBeGreaterThan(0);
    }
  });

  test('knowledge/method is instruction text, not a skill', () => {
    const k = loadKnowledge(KNOWLEDGE);
    expect(k.skills.has('method')).toBe(false);
    for (const file of k.method.keys()) expect(basename(file)).toMatch(/\.md$/);
  });
});
