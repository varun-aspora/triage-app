// Validates the real knowledge/ tree that ships with the repo: every SKILL.md
// has valid frontmatter, its name matches its directory and names are unique.
// This replaces the check a build-time SKILL.md import used to do (D42). It is
// skipped until the knowledge content (T12) is merged.

import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { basename, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENTITIES } from '../types/core.ts';
import { KnowledgeError, loadKnowledge, rootSkills } from './skills.ts';

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

  // The root once spent 40-55 s trying to activate and read a service note it
  // does not mount (trace 6d4d, E1-E4). Sentences are cut on punctuation and
  // table cells, which is rough but enough for this prose.
  test('root-mounted notes do not tell the root to activate or read a note it does not mount', () => {
    const k = loadKnowledge(KNOWLEDGE);
    const mounted = rootSkills(ENTITIES, k);
    const mountedNames = new Set(mounted.map((s) => s.name));
    const others = [...k.skills.keys()].filter((name) => !mountedNames.has(name));
    const noteRef = new RegExp(`\\b(note|${others.join('|')})\\b`, 'i');
    const problems: string[] = [];
    for (const skill of mounted) {
      for (const sentence of skill.instructions.replace(/\s+/g, ' ').split(/(?<=[.!?;])\s|\|/)) {
        // A bare name in a services table is fine; a pointer to a note must say
        // the investigator (or an investigate_<entity> tool) has it.
        const refersToNote = noteRef.test(sentence);
        const points = /\b(activate|read|load|see|says|has)\b/i.test(sentence);
        if (refersToNote && points && !/investigat(or|e_)/i.test(sentence)) problems.push(`${skill.name}: ${sentence.trim()}`);
      }
    }
    expect(mounted.length).toBeGreaterThan(2);
    expect(problems).toEqual([]);
  });
});
