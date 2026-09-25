import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SkillDefinition, SubagentDefinition } from '@flue/runtime';
import type { ToolDefinition } from '@flue/runtime/tool';
import { ConfigError } from '../../config/errors.ts';
import { allToolModules, FORBIDDEN_INPUT_KEYS } from '../../tools/index.ts';
import { ENTITIES, type Entity } from '../../types/core.ts';
import { makeTestHome, REPO_ROOT, type TestHome } from '../../../test/support/home.ts';
import { throwingDeps } from '../../../test/support/fake-tool-context.ts';
import { loadKnowledge, type Knowledge } from '../skills.ts';
import { CODE_WALKER_NAME, codeWalkerFor, codeWalkerMounts } from './code-walker.ts';
import {
  DEEP_THINKING,
  DelegateError,
  delegateContext,
  investigatorFor,
  investigatorMounts,
  investigatorName,
  type DelegateEnv,
  type DelegateHooks,
} from './investigator.ts';

const STRONG = 'anthropic/claude-opus-4-1';
const CODE_WALKER_SPEC = 'openai/gpt-5';
const RUN = 'run_delegates_0001';
// Not a real key: enabled() only checks that the value is non-blank, and no tool runs here.
const FAKE_ENC_KEY = 'QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFB';

const CODE_TOOLS = ['code_explore', 'code_impact', 'code_node', 'repo_grep', 'repo_read'];
const BASE_TOOLS = ['http_call', 'logs_search', 'note_evidence', 'sql_select'];
const SSFB_ALWAYS = ['detect_silent_reversals', 'get_account_statement'];
const SSFB_FLAGGED = ['cbs_call', 'decrypt_fields', 'encrypt_lookup_value'];
const ENTITY_IO = ['sql_select', 'http_call', 'logs_search'];

const sorted = (names: readonly string[]): string[] => [...names].sort();
const namesOf = (tools: readonly ToolDefinition[]): string[] => tools.map((t) => t.name);

let knowledge: Knowledge;
let reposDir: string;
const homes: TestHome[] = [];

type HomeOptions = { flags?: boolean; codeWalker?: string; strong?: string; entities?: readonly Entity[] };

function home(opts: HomeOptions = {}): TestHome {
  const overrides: Record<string, string> = {
    MODEL_TIER_STRONG: opts.strong ?? STRONG,
    TRIAGE_REPOS_DIR: reposDir,
  };
  if (opts.codeWalker !== undefined) overrides.MODEL_CODE_WALKER = opts.codeWalker;
  if (opts.flags === true) {
    overrides.SSFB_HARBOR_FIELD_ENC_KEY = FAKE_ENC_KEY;
    overrides.SSFB_CBS_VIA_KUBECTL_ENABLED = 'true';
  }
  const h = makeTestHome({ overrides, ...(opts.entities ? { entities: opts.entities } : {}) });
  homes.push(h);
  return h;
}

function envOf(h: TestHome, deps: DelegateEnv['deps'] = throwingDeps()): DelegateEnv {
  return { config: h.config, registry: h.registry, deps, knowledge };
}

function recorder(): DelegateHooks & { tools: ToolDefinition[]; skills: SkillDefinition[] } {
  const tools: ToolDefinition[] = [];
  const skills: SkillDefinition[] = [];
  return { tools, skills, useTool: (t) => tools.push(t), useSkill: (s) => skills.push(s) };
}

function render(def: SubagentDefinition): string {
  const out = def.agent();
  if (typeof out !== 'string') throw new Error('delegate returned no instructions');
  return out;
}

beforeAll(() => {
  knowledge = loadKnowledge(join(REPO_ROOT, 'knowledge'));
  reposDir = mkdtempSync(join(tmpdir(), 'triage-repos-'));
});

afterAll(() => {
  for (const h of homes) h.cleanup();
  rmSync(reposDir, { recursive: true, force: true });
});

describe('names', () => {
  test('investigate_<entity>, investigate_<entity>_deep and code_walker are unique across three entities', () => {
    const h = home();
    const env = envOf(h);
    const defs = [
      ...ENTITIES.flatMap((e) => [investigatorFor(e, RUN, { env }), investigatorFor(e, RUN, { env, deep: true })]),
      codeWalkerFor(RUN, { env }),
    ];
    const names = defs.map((d) => d.name);
    expect(names).toEqual([
      'investigate_ssfb',
      'investigate_ssfb_deep',
      'investigate_atspl',
      'investigate_atspl_deep',
      'investigate_rtl',
      'investigate_rtl_deep',
      'code_walker',
    ]);
    expect(new Set(names).size).toBe(names.length);
    expect(investigatorName('rtl', true)).toBe('investigate_rtl_deep');
    expect(CODE_WALKER_NAME).toBe('code_walker');
    for (const d of defs) {
      expect(d.description.length).toBeGreaterThan(20);
      expect(Object.isFrozen(d)).toBe(true);
    }
  });
});

describe('model and thinking', () => {
  test('normal variant has no model or thinking override', () => {
    const env = envOf(home());
    for (const e of ENTITIES) {
      const def = investigatorFor(e, RUN, { env });
      expect(Object.hasOwn(def, 'model')).toBe(false);
      expect(Object.hasOwn(def, 'thinkingLevel')).toBe(false);
      expect(def.model).toBeUndefined();
    }
  });

  test('deep variant runs on MODEL_TIER_STRONG with thinking high', () => {
    const env = envOf(home());
    for (const e of ENTITIES) {
      const def = investigatorFor(e, RUN, { env, deep: true });
      expect(def.model).toBe(STRONG);
      expect(def.thinkingLevel).toBe('high');
    }
    expect(DEEP_THINKING).toBe('high');
  });

  test('deep variant refuses a blank MODEL_TIER_STRONG and names the key only', () => {
    const env = envOf(home({ strong: '' }));
    expect(() => investigatorFor('ssfb', RUN, { env })).not.toThrow();
    let caught: unknown;
    try {
      investigatorFor('ssfb', RUN, { env, deep: true });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect(String((caught as Error).message)).toContain('MODEL_TIER_STRONG');
  });

  test('code_walker uses MODEL_CODE_WALKER, or MODEL_TIER_STRONG when it is blank', () => {
    expect(codeWalkerFor(RUN, { env: envOf(home()) }).model).toBe(STRONG);
    expect(codeWalkerFor(RUN, { env: envOf(home({ codeWalker: CODE_WALKER_SPEC })) }).model).toBe(CODE_WALKER_SPEC);
  });

  test('code_walker refuses a MODEL_CODE_WALKER on openrouter', () => {
    const env = envOf(home({ codeWalker: 'openrouter/vendor/model' }));
    expect(() => codeWalkerFor(RUN, { env })).toThrow(ConfigError);
  });
});

describe('tool sets (mock mode, credentials blank)', () => {
  for (const flags of [false, true]) {
    const label = flags ? 'SSFB flags on' : 'SSFB flags off';

    test(`${label}: investigator tools per entity`, () => {
      const env = envOf(home({ flags }));
      const ssfb = namesOf(investigatorMounts('ssfb', RUN, { env }).tools);
      expect(sorted(ssfb)).toEqual(sorted([...BASE_TOOLS, ...SSFB_ALWAYS, ...(flags ? SSFB_FLAGGED : [])]));
      for (const e of ['atspl', 'rtl'] as const) {
        expect(sorted(namesOf(investigatorMounts(e, RUN, { env }).tools))).toEqual(sorted(BASE_TOOLS));
      }
    });

    test(`${label}: deep set is the normal set plus the code tools, no duplicates`, () => {
      const env = envOf(home({ flags }));
      for (const e of ENTITIES) {
        const normal = namesOf(investigatorMounts(e, RUN, { env }).tools);
        const deep = namesOf(investigatorMounts(e, RUN, { env, deep: true }).tools);
        expect(new Set(deep).size).toBe(deep.length);
        expect(sorted(deep)).toEqual(sorted([...normal, ...CODE_TOOLS]));
        for (const name of CODE_TOOLS) expect(normal).not.toContain(name);
      }
    });

    test(`${label}: atspl and rtl mount no SSFB-only tool`, () => {
      const env = envOf(home({ flags }));
      const ssfbOnly = allToolModules
        .filter((m) => m.entities !== 'all' && !m.entities.includes('atspl') && !m.entities.includes('rtl'))
        .map((m) => m.name);
      // The crypto tools serve any entity with a field-encryption service (D48); none in atspl or rtl.
      expect(sorted(ssfbOnly)).toEqual(sorted([...SSFB_ALWAYS, 'cbs_call']));
      for (const e of ['atspl', 'rtl'] as const) {
        for (const deep of [false, true]) {
          const names = namesOf(investigatorMounts(e, RUN, { env, deep }).tools);
          for (const name of [...SSFB_ALWAYS, ...SSFB_FLAGGED]) expect(names).not.toContain(name);
        }
      }
    });

    test(`${label}: code_walker mounts code tools and note_evidence, no entity I/O`, () => {
      const env = envOf(home({ flags }));
      const names = namesOf(codeWalkerMounts(RUN, { env }).tools);
      expect(sorted(names)).toEqual(sorted([...CODE_TOOLS, 'note_evidence']));
      for (const name of [...ENTITY_IO, ...SSFB_ALWAYS, ...SSFB_FLAGGED, 'resolve_identity', 'finish_report']) {
        expect(names).not.toContain(name);
      }
    });
  }

  test('with TRIAGE_REPOS_DIR blank the deep variant drops repo_read and repo_grep but keeps the rest', () => {
    const h = makeTestHome({ overrides: { MODEL_TIER_STRONG: STRONG, TRIAGE_REPOS_DIR: '' } });
    homes.push(h);
    const env = envOf(h);
    const deep = namesOf(investigatorMounts('atspl', RUN, { env, deep: true }).tools);
    expect(deep).not.toContain('repo_read');
    expect(deep).not.toContain('repo_grep');
    expect(deep).toContain('code_explore');
  });
});

describe('model-visible schemas', () => {
  // The one nested 'entity' key allowed: a timeline item's source pointer in
  // EntityFindings (src/types/findings.ts EvidenceRefSchema). It labels where
  // an event came from and routes no I/O; the evidence file is still keyed by
  // the closure entity.
  const ALLOWED_NESTED = new Set(['note_evidence:timeline[].source.entity']);

  test("no tool on any delegate takes an 'entity' or 'run_id' input", () => {
    const env = envOf(home({ flags: true }));
    const sets: [string, readonly ToolDefinition[]][] = [
      ...ENTITIES.flatMap((e): [string, readonly ToolDefinition[]][] => [
        [investigatorName(e), investigatorMounts(e, RUN, { env }).tools],
        [investigatorName(e, true), investigatorMounts(e, RUN, { env, deep: true }).tools],
      ]),
      [CODE_WALKER_NAME, codeWalkerMounts(RUN, { env }).tools],
    ];
    let scanned = 0;
    for (const [delegate, tools] of sets) {
      for (const tool of tools) {
        const input = tool.input as { entries?: Record<string, unknown> } | undefined;
        const top = Object.keys(input?.entries ?? {}).filter((k) => FORBIDDEN_INPUT_KEYS.includes(k));
        const nested = schemaPaths(tool.input)
          .filter((p) => FORBIDDEN_INPUT_KEYS.includes(p.split('.').pop() as string))
          .filter((p) => !ALLOWED_NESTED.has(`${tool.name}:${p}`));
        expect({ delegate, tool: tool.name, top, nested }).toEqual({ delegate, tool: tool.name, top: [], nested: [] });
        scanned++;
      }
    }
    expect(scanned).toBeGreaterThan(40);
  });

  test('the scanner finds nested keys and reports their path', () => {
    const fake = {
      type: 'object',
      entries: { a: { type: 'array', item: { type: 'object', entries: { run_id: {} } } }, b: { type: 'optional', wrapped: { type: 'object', entries: { entity: {} } } } },
    };
    expect(schemaPaths(fake)).toEqual(['a', 'a[].run_id', 'b', 'b.entity']);
  });
});

describe('delegate body', () => {
  test('investigator mounts its tools and service notes with useTool and useSkill and returns the method text', () => {
    const env = envOf(home());
    const hooks = recorder();
    const def = investigatorFor('ssfb', RUN, { env, hooks });
    const text = render(def);
    expect(sorted(namesOf(hooks.tools))).toEqual(sorted([...BASE_TOOLS, ...SSFB_ALWAYS]));
    const skillNames = hooks.skills.map((s) => s.name);
    expect(skillNames.length).toBeGreaterThan(0);
    for (const name of skillNames) expect(name.startsWith('ssfb-')).toBe(true);
    expect(skillNames).not.toContain('ssfb-overview');
    expect(text).toContain('# Investigator');
    expect(text).toContain('# Logs');
    expect(text).toContain('# SSFB logs');
    expect(text).toContain('Entity: ssfb');
    expect(text).not.toContain('# ATSPL logs');
  });

  test('each entity only gets its own service notes and logs note', () => {
    const env = envOf(home());
    for (const e of ENTITIES) {
      const mounts = investigatorMounts(e, RUN, { env });
      for (const s of mounts.skills) expect(s.name.startsWith(`${e}-`)).toBe(true);
      for (const other of ENTITIES.filter((x) => x !== e)) {
        expect(mounts.instructions).not.toContain(`# ${other.toUpperCase()} logs`);
      }
    }
  });

  test('code_walker mounts repo-map, codegraph-limits and frontend-routing and the code-walker method', () => {
    const env = envOf(home());
    const hooks = recorder();
    const text = render(codeWalkerFor(RUN, { env, hooks }));
    expect(sorted(hooks.skills.map((s) => s.name))).toEqual(['codegraph-limits', 'frontend-routing', 'repo-map']);
    expect(sorted(namesOf(hooks.tools))).toEqual(sorted([...CODE_TOOLS, 'note_evidence']));
    expect(text).toContain('# Code walker');
  });

  test('the render never reads deps and calls a deps getter once per delegation', () => {
    const h = home();
    let calls = 0;
    const env = envOf(h, () => {
      calls++;
      return throwingDeps();
    });
    const inv = investigatorFor('rtl', RUN, { env, deep: true, hooks: recorder() });
    const cw = codeWalkerFor(RUN, { env, hooks: recorder() });
    expect(calls).toBe(0);
    render(inv);
    render(inv);
    render(cw);
    expect(calls).toBe(3);
  });

  test('entity and run id reach the tools by closure', () => {
    const env = envOf(home());
    const ctx = delegateContext(RUN, 'atspl', env);
    expect(ctx.entity).toBe('atspl');
    expect(ctx.runId).toBe(RUN);
    expect(Object.isFrozen(ctx)).toBe(true);
    expect(delegateContext(RUN, null, env).entity).toBeNull();
  });
});

describe('refusals', () => {
  test("an alias such as 'shivalik' or an unknown id is not an entity", () => {
    const env = envOf(home());
    expect(() => investigatorFor('shivalik' as Entity, RUN, { env })).toThrow(DelegateError);
    expect(() => investigatorFor('SSFB' as Entity, RUN, { env, deep: true })).toThrow(DelegateError);
  });

  test('an entity outside TRIAGE_ENTITIES is refused', () => {
    const env = envOf(home({ entities: ['ssfb'] }));
    expect(() => investigatorFor('ssfb', RUN, { env })).not.toThrow();
    expect(() => investigatorFor('rtl', RUN, { env })).toThrow(/not enabled/);
    expect(() => investigatorFor('atspl', RUN, { env, deep: true })).toThrow(DelegateError);
  });

  test('a bad run id is refused by both factories', () => {
    const env = envOf(home());
    for (const bad of ['', 'run id with spaces', '../etc', 'x'.repeat(65)]) {
      expect(() => investigatorFor('ssfb', bad, { env })).toThrow(DelegateError);
      expect(() => codeWalkerFor(bad, { env })).toThrow(DelegateError);
    }
  });
});

describe('static checks', () => {
  const files = ['investigator.ts', 'code-walker.ts'].map((f) => ({
    file: f,
    text: readFileSync(join(import.meta.dir, f), 'utf8'),
  }));

  test('no agent directive in either module', () => {
    for (const { file, text } of files) {
      expect({ file, directive: /['"]use agent['"]/.test(text) }).toEqual({ file, directive: false });
    }
  });

  test('no model, sandbox, persistent state or lifecycle hook is called or imported', () => {
    const banned = ['useModel', 'useSandbox', 'usePersistentState', 'useAgentStart', 'useAgentFinish'];
    for (const { file, text } of files) {
      for (const hook of banned) {
        expect({ file, hook, used: new RegExp(`\\b${hook}\\b`).test(text) }).toEqual({ file, hook, used: false });
      }
    }
  });

  test('no Bun APIs in the source modules', () => {
    for (const { file, text } of files) {
      expect({ file, bun: /\bBun\.|from ['"]bun:/.test(text) }).toEqual({ file, bun: false });
    }
  });
});

// Every object key path in a valibot schema tree: object entries, array
// items ('[]'), wrapped optional/nullable schemas, union options, record
// values, tuple items and pipe members.
function schemaPaths(schema: unknown, prefix = '', ancestors: ReadonlySet<unknown> = new Set()): string[] {
  if (schema === null || typeof schema !== 'object' || ancestors.has(schema)) return [];
  // Ancestors only, so a schema reused in two places is walked at both paths.
  const up = new Set([...ancestors, schema]);
  const s = schema as Record<string, unknown>;
  const out: string[] = [];
  const entries = s.entries;
  if (entries !== null && typeof entries === 'object') {
    for (const [key, child] of Object.entries(entries as Record<string, unknown>)) {
      const path = prefix === '' ? key : `${prefix}.${key}`;
      out.push(path, ...schemaPaths(child, path, up));
    }
  }
  out.push(...schemaPaths(s.item, `${prefix}[]`, up));
  for (const field of ['wrapped', 'value', 'rest']) out.push(...schemaPaths(s[field], prefix, up));
  for (const field of ['options', 'items', 'pipe']) {
    const list = s[field];
    if (Array.isArray(list)) for (const child of list) out.push(...schemaPaths(child, prefix, up));
  }
  return out;
}
