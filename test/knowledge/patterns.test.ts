// knowledge/patterns/patterns.json and SKILL.md (T12.8). Every entry must
// pass the loader's schema (src/classify/patterns.ts) and the curation rules
// on top of it: a known category, registry services, investigator tools in the
// recipe and a source_ref that points at a knowledge note heading or a named
// triage-shivalik skill, never at past case folders.

import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';
import { matchPattern, parsePatterns, PatternSchema, type Pattern } from '../../src/classify/patterns.ts';
import { ENTITIES, TIERS, type Entity } from '../../src/types/core.ts';
import {
  CATEGORIES_FILE,
  INVESTIGATOR_TOOLS,
  KNOWLEDGE_DIR,
  mentionedTools,
  parseFrontmatter,
  PLACEHOLDER,
  REPO_ROOT,
  SHARED_ENTITY,
  SSFB_EXTRA_TOOLS,
  toolsOutside,
} from './_util.ts';

const PATTERNS_DIR = join(KNOWLEDGE_DIR, 'patterns');
const PATTERNS_FILE = join(PATTERNS_DIR, 'patterns.json');
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REQUIRED_KEYS = ['id', 'category', 'signature', 'entities', 'query_recipe', 'tier_hint', 'stable', 'source_ref'];
const SIM_BINDING_REF = 'triage-shivalik .claude/skills/aspora-harbor-shivalik-sim-binding-issue/SKILL.md';

// ---------------------------------------------------------------- context

type Context = {
  readonly categories: ReadonlySet<string>;
  /** Registry keys written entity:service. */
  readonly services: ReadonlySet<string>;
  readonly knowledgeDir: string;
};

function registryServices(): Set<string> {
  const out = new Set<string>();
  for (const entity of ENTITIES) {
    const file = join(REPO_ROOT, 'resources', `${entity}.entity.json`);
    const registry = JSON.parse(readFileSync(file, 'utf8')) as { services?: Record<string, unknown> };
    for (const service of Object.keys(registry.services ?? {})) out.add(`${entity}:${service}`);
  }
  return out;
}

function realContext(): Context {
  const categories = (JSON.parse(readFileSync(CATEGORIES_FILE, 'utf8')) as { id: string }[]).map((c) => c.id);
  return { categories: new Set(categories), services: registryServices(), knowledgeDir: KNOWLEDGE_DIR };
}

// ------------------------------------------------------------------ rules

/** Typed investigator tools an entry's recipe may name, given its entities. */
function recipeTools(entities: readonly string[]): Set<string> {
  const tools = new Set<string>(INVESTIGATOR_TOOLS);
  if (entities.includes('ssfb')) for (const t of SSFB_EXTRA_TOOLS) tools.add(t);
  return tools;
}

function headings(file: string): Set<string> {
  const out = new Set<string>();
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^#{1,6} (.+?)\s*$/.exec(line);
    if (m) out.add(m[1] as string);
  }
  return out;
}

function sourceRefProblems(ref: string, knowledgeDir: string): string[] {
  if (/(?:^|[^A-Za-z0-9_-])refs\//.test(ref)) return ['source_ref points into refs/, which holds customer data'];
  const note = /^knowledge\/([a-z0-9-]+)\/SKILL\.md#(.+)$/.exec(ref);
  if (note) {
    const file = join(knowledgeDir, note[1] as string, 'SKILL.md');
    if (!existsSync(file)) return [`source_ref names a missing note: ${note[1]}`];
    if (!headings(file).has(note[2] as string)) return [`source_ref heading not found in ${note[1]}: ${note[2]}`];
    return [];
  }
  if (/^triage-shivalik [A-Za-z0-9_./-]+\/(?:AGENTS|SKILL)\.md$/.test(ref)) return [];
  return [`source_ref must be knowledge/<note>/SKILL.md#<heading> or a triage-shivalik AGENTS.md or SKILL.md: ${ref}`];
}

/**
 * Curation problems for a list of raw entries, as "id: reason" strings. The
 * loader schema runs first; the rest only runs on entries that pass it.
 */
function checkPatterns(raw: readonly unknown[], ctx: Context): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  raw.forEach((entry, index) => {
    const label = (entry as { id?: unknown } | null)?.id ?? `#${index}`;
    const bad = (reason: string) => out.push(`${String(label)}: ${reason}`);

    const keys = entry && typeof entry === 'object' ? Object.keys(entry) : [];
    for (const key of REQUIRED_KEYS) if (!keys.includes(key)) bad(`missing field ${key}`);
    const parsed = v.safeParse(PatternSchema, entry);
    if (!parsed.success) {
      for (const issue of parsed.issues) bad(`${v.getDotPath(issue) ?? ''}: ${issue.message}`);
      return;
    }
    const p = parsed.output;

    if (!KEBAB.test(p.id)) bad('id is not kebab-case');
    if (seen.has(p.id)) bad('duplicate id');
    seen.add(p.id);
    if (!ctx.categories.has(p.category)) bad(`category ${p.category} is not in categories.json`);

    for (const source of p.signature.regex) {
      for (const flags of ['', 'i']) {
        try {
          new RegExp(source, flags);
        } catch {
          bad(`regex does not compile: ${source}`);
        }
      }
    }

    if (p.entities.length === 0) bad('entities is empty');
    if (new Set(p.entities).size !== p.entities.length) bad('entities has duplicates');
    for (const e of p.entities) if (!(ENTITIES as readonly string[]).includes(e)) bad(`unknown entity ${e}`);
    for (const key of p.signature.services) {
      if (!ctx.services.has(key)) bad(`service ${key} is not in the registry`);
      const entity = key.split(':')[0] as Entity;
      if (!p.entities.includes(entity)) bad(`service ${key} belongs to an entity not in entities`);
    }
    if (!(TIERS as readonly string[]).includes(p.tier_hint)) bad(`tier_hint ${p.tier_hint}`);

    for (const reason of sourceRefProblems(p.source_ref, ctx.knowledgeDir)) bad(reason);
    // The sim-binding skill records symptoms, not confirmed root causes.
    if (p.stable && p.source_ref === SIM_BINDING_REF) bad('an entry from the sim-binding skill cannot be stable');

    const allowed = recipeTools(p.entities);
    const named = mentionedTools(p.query_recipe);
    if (p.query_recipe.trim() === '') bad('query_recipe is empty');
    else if (named.length === 0) bad('query_recipe names no tool');
    for (const tool of named) if (!allowed.has(tool)) bad(`query_recipe names ${tool}, not an investigator tool here`);
    for (const m of p.query_recipe.matchAll(/<[^>\s]*>/g)) {
      if (!new RegExp(`^${PLACEHOLDER.source}$`).test(m[0])) bad(`placeholder ${m[0]} is not <snake_case>`);
    }
  });
  return out;
}

// ---------------------------------------------------------------- the file

const RAW: unknown = JSON.parse(readFileSync(PATTERNS_FILE, 'utf8'));
const ENTRIES = RAW as unknown[];

function loaded(): Pattern[] {
  return parsePatterns(RAW);
}

describe('patterns.json', () => {
  test('is a non-empty array the loader accepts', () => {
    expect(Array.isArray(RAW)).toBe(true);
    expect(ENTRIES.length).toBeGreaterThan(0);
    expect(() => loaded()).not.toThrow();
  });

  test('every entry passes the curation rules', () => {
    expect(checkPatterns(ENTRIES, realContext())).toEqual([]);
  });

  test('ids are unique', () => {
    const ids = loaded().map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('welcome-letter-vendor-fail exists for delivery on atspl and ssfb', () => {
    const p = loaded().find((e) => e.id === 'welcome-letter-vendor-fail');
    expect(p).toBeDefined();
    expect(p?.category).toBe('delivery');
    expect(p?.entities).toContain('atspl');
  });

  test('remittance-order-out-of-reach exists, is strong and is not stable', () => {
    const p = loaded().find((e) => e.id === 'remittance-order-out-of-reach');
    expect(p).toBeDefined();
    expect(p?.tier_hint).toBe('strong');
    expect(p?.stable).toBe(false);
    expect(p?.signature.regex).toContain('/appserver/v3/order');
    expect(p?.query_recipe).toMatch(/out of reach/i);
    expect(p?.query_recipe).toMatch(/escalate/i);
  });

  test('the two design-named entries match their own text', () => {
    const patterns = loaded();
    expect(matchPattern('POST /appserver/v3/order returned 500', [], 'funding_in', patterns)?.matched_pattern_id).toBe(
      'remittance-order-out-of-reach',
    );
    expect(
      matchPattern('welcome letter failed at the courier vendor', ['atspl:package'], 'delivery', patterns)
        ?.matched_pattern_id,
    ).toBe('welcome-letter-vendor-fail');
  });

  test('entries are seeded from Known issues, the patterns note or the sim-binding skill', () => {
    for (const p of loaded()) {
      const ok =
        p.source_ref === SIM_BINDING_REF ||
        p.source_ref.startsWith('knowledge/patterns/SKILL.md#') ||
        /^knowledge\/[a-z0-9-]+\/SKILL\.md#/.test(p.source_ref);
      expect({ id: p.id, ok }).toEqual({ id: p.id, ok: true });
    }
    expect(loaded().some((p) => p.source_ref === SIM_BINDING_REF)).toBe(true);
  });

  test('no source_ref points into refs/', () => {
    for (const p of loaded()) expect(p.source_ref).not.toContain('refs/');
  });
});

// ----------------------------------------------------------- the SKILL.md

describe('patterns SKILL.md', () => {
  const text = readFileSync(join(PATTERNS_DIR, 'SKILL.md'), 'utf8');
  const parsed = parseFrontmatter(text);
  if ('error' in parsed) throw new Error(parsed.error);
  const { frontmatter, body } = parsed;

  test('is the shared patterns skill', () => {
    expect(frontmatter.name).toBe('patterns');
    expect(frontmatter.metadata.kind).toBe('patterns');
    expect(frontmatter.metadata.entity).toBe(SHARED_ENTITY);
    expect(frontmatter.metadata.service).toBeUndefined();
  });

  test('says a match is a hint to try the recipe first, and stable still needs evidence', () => {
    expect(body).toMatch(/hint/i);
    expect(body).toMatch(/not a conclusion/i);
    expect(body).toMatch(/query_recipe` first/);
    expect(body).toMatch(/`stable`[^\n]*\n?[^\n]*still needs\s+evidence/i);
  });

  test('has the heading the remittance entry cites', () => {
    expect(body).toContain('## Out of reach: remittance orders');
    expect(body).toContain('/appserver/v3/order');
  });

  test('names only tools Triage has', () => {
    expect(toolsOutside(body, 'triage')).toEqual([]);
  });
});

// ------------------------------------------------------------- deny paths

describe('the curation rules refuse bad entries', () => {
  const ctx = realContext();
  const good = (): Record<string, unknown> => ({
    id: 'fixture-pattern',
    category: 'onboarding',
    signature: { regex: ['FZYCHCKREVIEW'], services: ['ssfb:harbor'] },
    entities: ['ssfb'],
    query_recipe: 'logs_search on harbor with fields form_id = <form_id>.',
    tier_hint: 'cheap',
    stable: true,
    source_ref: 'knowledge/ssfb-harbor/SKILL.md#Known issues',
  });
  const problems = (patch: Record<string, unknown>) => checkPatterns([{ ...good(), ...patch }], ctx);

  test('the good entry passes', () => {
    expect(checkPatterns([good()], ctx)).toEqual([]);
  });

  test('rejects duplicate ids', () => {
    expect(checkPatterns([good(), good()], ctx)).toEqual(['fixture-pattern: duplicate id']);
  });

  test('rejects a missing field', () => {
    const entry = good();
    delete entry['source_ref'];
    expect(checkPatterns([entry], ctx).join('\n')).toContain('missing field source_ref');
  });

  test.each([
    ['a non-kebab id', { id: 'Fixture_Pattern' }, 'id'],
    ['a category outside categories.json', { category: 'loans' }, 'category'],
    ['a regex that does not compile', { signature: { regex: ['(unclosed'], services: [] } }, 'regex'],
    ['a service outside the registry', { signature: { regex: ['x'], services: ['ssfb:ledger'] } }, 'not in the registry'],
    ['a bare service name', { signature: { regex: ['x'], services: ['harbor'] } }, 'not in the registry'],
    ['a service of an unlisted entity', { signature: { regex: ['x'], services: ['atspl:package'] } }, 'not in entities'],
    ['an unknown entity', { entities: ['shivalik'] }, 'entities'],
    ['empty entities', { entities: [] }, 'entities is empty'],
    ['a bad tier_hint', { tier_hint: 'max' }, 'tier_hint'],
    ['a non-boolean stable', { stable: 'true' }, 'stable'],
    ['a source_ref into refs/', { source_ref: 'refs/harbor-error-classification/taxonomy.json' }, 'refs/'],
    ['a source_ref with refs/ inside', { source_ref: 'triage-shivalik refs/case/AGENTS.md' }, 'refs/'],
    ['a source_ref to a missing note', { source_ref: 'knowledge/ssfb-ledger/SKILL.md#Known issues' }, 'missing note'],
    ['a source_ref to a missing heading', { source_ref: 'knowledge/ssfb-harbor/SKILL.md#No such heading' }, 'heading'],
    ['a source_ref to some other file', { source_ref: 'docs/02-hld-detailed.md' }, 'source_ref must be'],
    ['a stable entry from the sim-binding skill', { source_ref: SIM_BINDING_REF }, 'cannot be stable'],
    ['a recipe with no tool', { query_recipe: 'check harbor for the form' }, 'names no tool'],
    ['an empty recipe', { query_recipe: '' }, 'query_recipe'],
    ['a recipe naming a Triage tool', { query_recipe: 'resolve_identity then logs_search' }, 'resolve_identity'],
    ['a recipe naming a code tool', { query_recipe: 'code_explore on harbor' }, 'code_explore'],
    ['a recipe naming a sandbox tool', { query_recipe: 'logs_search, then `bash` over the rows' }, 'bash'],
    ['a recipe with a bad placeholder', { query_recipe: 'logs_search for <Form-ID>' }, 'placeholder'],
  ])('rejects %s', (_label, patch, reason) => {
    expect(problems(patch).join('\n')).toContain(reason);
  });

  test('rejects a valid category id that categories.json does not list', () => {
    const narrow: Context = { ...ctx, categories: new Set(['delivery']) };
    expect(checkPatterns([good()], narrow)).toEqual(['fixture-pattern: category onboarding is not in categories.json']);
  });

  test('rejects an SSFB-only tool on an entry without ssfb', () => {
    const out = problems({
      entities: ['atspl'],
      signature: { regex: ['x'], services: ['atspl:package'] },
      query_recipe: 'get_account_statement for the account',
    });
    expect(out.join('\n')).toContain('get_account_statement');
  });

  test('allows an SSFB-only tool on an ssfb entry', () => {
    expect(problems({ query_recipe: 'detect_silent_reversals, then get_account_statement' })).toEqual([]);
  });
});
