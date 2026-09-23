// Checks the three global skills from T12.7 against the registries and the
// agents that read them: repo-map covers every registry repo, codegraph-limits
// names only code tools and the no-watcher freshness rule, and frontend-routing
// writes backends as registry entity:service keys.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ENTITIES } from '../../src/types/core.ts';
import {
  CODE_TOOLS,
  KNOWLEDGE_DIR,
  mentionedTools,
  parseFrontmatter,
  REPO_ROOT,
  SHARED_ENTITY,
  toolsOutside,
  type ParsedSkill,
} from './_util.ts';

type EntityFile = {
  readonly services: Record<string, { readonly repo?: string }>;
  readonly repos_extra?: readonly string[];
};

function readSkill(name: string): ParsedSkill {
  const parsed = parseFrontmatter(readFileSync(join(KNOWLEDGE_DIR, name, 'SKILL.md'), 'utf8'));
  if ('error' in parsed) throw new Error(`${name}: ${parsed.error}`);
  return parsed;
}

function registry(): Map<string, EntityFile> {
  const out = new Map<string, EntityFile>();
  for (const entity of ENTITIES) {
    const text = readFileSync(join(REPO_ROOT, 'resources', `${entity}.entity.json`), 'utf8');
    out.set(entity, JSON.parse(text) as EntityFile);
  }
  return out;
}

function registryRepos(): { services: Set<string>; extra: Set<string> } {
  const services = new Set<string>();
  const extra = new Set<string>();
  for (const file of registry().values()) {
    for (const spec of Object.values(file.services)) if (spec.repo) services.add(spec.repo);
    for (const repo of file.repos_extra ?? []) extra.add(repo);
  }
  return { services, extra };
}

function registryKeys(): Set<string> {
  const keys = new Set<string>();
  for (const [entity, file] of registry()) for (const service of Object.keys(file.services)) keys.add(`${entity}:${service}`);
  return keys;
}

function manifestRepos(): string[] {
  const text = readFileSync(join(REPO_ROOT, 'resources', 'repos.json'), 'utf8');
  return (JSON.parse(text) as { repo: string }[]).map((r) => r.repo);
}

/** Backticked `entity:service` keys whose entity part is a real entity id. */
function entityServiceKeys(text: string): string[] {
  const re = new RegExp('`((?:' + ENTITIES.join('|') + '):[a-z][a-z0-9_-]*)`', 'g');
  return [...new Set([...text.matchAll(re)].map((m) => m[1] as string))].sort();
}

/** The table row in the body whose first cell is the backticked repo name. */
function row(body: string, repo: string): string | undefined {
  return body.split('\n').find((line) => line.startsWith(`| \`${repo}\` |`));
}

const GLOBALS = ['repo-map', 'codegraph-limits', 'frontend-routing'] as const;

describe('front-matter of the global skills', () => {
  for (const name of GLOBALS) {
    test(`${name} is a shared skill of kind ${name}`, () => {
      const { frontmatter } = readSkill(name);
      expect(frontmatter.name).toBe(name);
      expect(frontmatter.metadata.kind).toBe(name);
      expect(frontmatter.metadata.entity).toBe(SHARED_ENTITY);
      expect(frontmatter.metadata.service).toBeUndefined();
    });
  }
});

describe('repo-map', () => {
  const { body } = readSkill('repo-map');

  test('has a table row for every registry repo and every repos.json repo', () => {
    const { services, extra } = registryRepos();
    const all = new Set([...services, ...extra, ...manifestRepos()]);
    const missing = [...all].filter((repo) => row(body, repo) === undefined);
    expect(missing).toEqual([]);
  });

  test('marks the shared code repos as libraries and argo as deploy manifests', () => {
    for (const repo of ['shivalik-cbs-go', 'go-commons', 'java-commons']) {
      expect(row(body, repo)).toContain('| library |');
    }
    expect(row(body, 'prod-ssfb-aspora-argo')).toContain('| deploy manifests |');
    expect(body).toMatch(/shivalik-cbs-go[^\n]*library, not a deployed service/);
  });

  test('every registry service key it names exists', () => {
    const keys = registryKeys();
    expect(entityServiceKeys(body).filter((k) => !keys.has(k))).toEqual([]);
  });

  test('names each service repo next to its registry keys', () => {
    for (const [entity, file] of registry()) {
      for (const [service, spec] of Object.entries(file.services)) {
        if (!spec.repo) continue;
        expect(row(body, spec.repo)).toContain(`\`${entity}:${service}\``);
      }
    }
  });

  test('uses repo names only, with no git remotes or module paths', () => {
    expect(body).not.toMatch(/git@|github|\.git\b|gitlab|bitbucket/i);
    expect(body).not.toMatch(/\b[a-z0-9-]+\/[A-Za-z0-9-]+\/(?:go-commons|shivalik-cbs-go)\b/);
  });

  test('mentions only tools the code walker has', () => {
    expect(toolsOutside(body, 'code_walker')).toEqual([]);
  });
});

describe('codegraph-limits', () => {
  const { body } = readSkill('codegraph-limits');

  test('names only code tools, and all of them', () => {
    expect(mentionedTools(body)).toEqual([...CODE_TOOLS].sort());
  });

  test('says there is no file watcher and freshness is triage repos sync', () => {
    expect(body).toContain('There is no file watcher.');
    expect(body).toContain('Freshness comes from `triage repos sync`');
  });

  test('marks the YAML indexing claim and the CodeGraph version as unverified', () => {
    expect(body).toMatch(/YAML is also left out \(unverified: /);
    expect(body).toMatch(/CodeGraph \d+\.\d+\.\d+ \(unverified: /);
  });

  test('covers the stated limits, cost and caps', () => {
    for (const phrase of ['no cross-repo edges', 'Structural only', 'Output is capped', 'Docs are not indexed']) {
      expect(body.toLowerCase()).toContain(phrase.toLowerCase());
    }
  });
});

describe('frontend-routing', () => {
  const { body } = readSkill('frontend-routing');

  test('every backend key is a registry entity:service key', () => {
    const keys = registryKeys();
    const found = entityServiceKeys(body);
    expect(found.length).toBeGreaterThan(0);
    expect(found.filter((k) => !keys.has(k))).toEqual([]);
  });

  test('the two owners route to the two workflow copies', () => {
    expect(body).toMatch(/`ASPORA_RTL` \| Part 1[^\n]*`rtl:workflow`/);
    expect(body).toMatch(/`SHIVALIK_BANK` \| Part 2[^\n]*`ssfb:workflow`/);
  });

  test('every screen row names a registry key or says there is none', () => {
    const rows = body.split('\n').filter((line) => /^\| [^|]+ \| `?[a-z_]*(?:nri|efr|loader)/.test(line));
    expect(rows.length).toBeGreaterThan(10);
    for (const line of rows) expect(entityServiceKeys(line).length).toBeGreaterThan(0);
  });

  test('mentions no typed tool, since Triage and code_walker both read it', () => {
    expect(toolsOutside(body, 'triage')).toEqual([]);
    expect(toolsOutside(body, 'code_walker')).toEqual([]);
  });
});

describe('deny paths of the key check', () => {
  test('an unknown service key is caught', () => {
    const keys = registryKeys();
    const found = entityServiceKeys('goes to `ssfb:nosuch` and `rtl:workflow`');
    expect(found.filter((k) => !keys.has(k))).toEqual(['ssfb:nosuch']);
  });

  test('a missing repo row is caught', () => {
    expect(row('| `harbor` | ssfb |', 'rhythm')).toBeUndefined();
    expect(row('| `harbor` | ssfb |', 'harbor')).toBeDefined();
  });
});
