// Integration check of the tool sets each mount gets from the real generated
// tool list (T05.8). Contexts come from a test home, so no real .env is read,
// and ctx.deps is a spy, so nothing here can reach a connector.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { ToolDefinition } from '@flue/runtime/tool';
import {
  allToolModules,
  mountPlan,
  RESERVED_TOOL_NAMES,
  TOOL_NAME_PATTERN,
  toolsFor,
} from '../../src/tools/index.ts';
import type { Mount, ToolContext, ToolDeps } from '../../src/tools/types.ts';
import { ENTITIES, type Entity } from '../../src/types/core.ts';
import { makeToolContext } from '../support/fake-tool-context.ts';
import { makeTestHome, type TestHome } from '../support/home.ts';
import { spyOnSpawns } from '../support/spawn-spy.ts';

// A synthetic stand-in. The crypto tools only check that the key is non-blank
// when they are mounted; nothing here encrypts or decrypts.
const FAKE_FIELD_KEY = 'test-only-field-key-not-a-real-key';
const FAKE_REPOS_DIR = '/triage-test/repos';

const ENC_KEY = 'SSFB_HARBOR_FIELD_ENC_KEY';
const CBS_FLAG = 'SSFB_CBS_VIA_KUBECTL_ENABLED';

// repo_grep and repo_read are on both investigator variants, scoped to the entity's repos.
const REPO_TOOLS = ['repo_grep', 'repo_read'];
const BASE_INVESTIGATOR = ['http_call', 'logs_search', 'note_evidence', 'sql_select', ...REPO_TOOLS];
const SSFB_ALWAYS = ['detect_silent_reversals', 'get_account_statement'];
const SSFB_CRYPTO = ['decrypt_fields', 'encrypt_lookup_value'];
// Scoped to ssfb in their module. The crypto tools serve any entity with a field-encryption service (D48).
const SSFB_SCOPED = [...SSFB_ALWAYS, 'cbs_call'];
const SSFB_ONLY = [...SSFB_SCOPED, ...SSFB_CRYPTO];
const CODEGRAPH_TOOLS = ['code_explore', 'code_impact', 'code_node'];
const CODE_TOOLS = [...CODEGRAPH_TOOLS, ...REPO_TOOLS];
const MOUNTS: readonly Mount[] = ['triage', 'investigator', 'investigator_deep', 'code_walker'];

const names = (tools: readonly ToolDefinition[]): string[] => tools.map((t) => t.name).sort();
const sorted = (list: readonly string[]): string[] => [...list].sort();

// ------------------------------------------------------------ test homes

const homes: TestHome[] = [];

function home(overrides: Record<string, string> = {}, entities?: readonly Entity[]): TestHome {
  const h = makeTestHome({
    overrides: { TRIAGE_REPOS_DIR: FAKE_REPOS_DIR, ...overrides },
    ...(entities !== undefined ? { entities } : {}),
  });
  homes.push(h);
  return h;
}

function ctxFrom(h: TestHome, entity: Entity | null, deps?: ToolDeps): ToolContext {
  return makeToolContext({ config: h.config, registry: h.registry, entity, ...(deps !== undefined ? { deps } : {}) });
}

/** Every mount/entity pair an agent would build. */
function everySet(h: TestHome, deps?: ToolDeps): { label: string; mount: Mount; ctx: ToolContext }[] {
  const out: { label: string; mount: Mount; ctx: ToolContext }[] = [];
  for (const mount of MOUNTS) {
    const scoped = mount === 'investigator' || mount === 'investigator_deep';
    for (const entity of scoped ? ENTITIES : [null]) {
      out.push({ label: `${mount}/${entity ?? '-'}`, mount, ctx: ctxFrom(h, entity, deps) });
    }
  }
  return out;
}

let plain: TestHome; // .env.example defaults: key blank, CBS flag false
let allOn: TestHome; // key set and CBS flag on

beforeAll(() => {
  plain = home();
  allOn = home({ [ENC_KEY]: FAKE_FIELD_KEY, [CBS_FLAG]: 'true' });
});

afterAll(() => {
  for (const h of homes) h.cleanup();
});

// ------------------------------------------------------------ membership

describe('per-mount and per-entity membership', () => {
  test('the ssfb investigator gets the base tools plus the statement and reversal tools', () => {
    const set = names(toolsFor('investigator', ctxFrom(plain, 'ssfb')));
    expect(set).toEqual(sorted([...BASE_INVESTIGATOR, ...SSFB_ALWAYS]));
    expect(set).toContain('get_account_statement');
    expect(set).toContain('detect_silent_reversals');
  });

  test('with the key and flag on, the ssfb investigator gets every SSFB tool', () => {
    expect(names(toolsFor('investigator', ctxFrom(allOn, 'ssfb')))).toEqual(sorted([...BASE_INVESTIGATOR, ...SSFB_ONLY]));
  });

  test.each(['atspl', 'rtl'] as const)('%s sets hold no SSFB-only tool, even with the key and flag on', (entity) => {
    for (const h of [plain, allOn]) {
      expect(names(toolsFor('investigator', ctxFrom(h, entity)))).toEqual(sorted(BASE_INVESTIGATOR));
      const deep = names(toolsFor('investigator_deep', ctxFrom(h, entity)));
      expect(deep).toEqual(sorted([...BASE_INVESTIGATOR, ...CODEGRAPH_TOOLS]));
      for (const name of SSFB_ONLY) expect(deep).not.toContain(name);
      // Same answer from mountPlan: the SSFB modules are not even considered, and the
      // crypto tools are off because no service of this entity has field encryption.
      const plan = mountPlan('investigator_deep', ctxFrom(h, entity));
      for (const name of SSFB_SCOPED) expect(plan.map((r) => r.name)).not.toContain(name);
      for (const name of SSFB_CRYPTO) {
        expect(plan.find((r) => r.name === name)).toEqual({ name, on: false, reason: 'no service of this entity has field encryption' });
      }
    }
  });

  test('the SSFB-scoped list matches the modules scoped to ssfb', () => {
    const scoped = allToolModules.filter((m) => m.entities !== 'all').map((m) => m.name);
    expect(sorted(scoped)).toEqual(sorted(SSFB_SCOPED));
    for (const m of allToolModules.filter((x) => x.entities !== 'all')) expect(m.entities).toEqual(['ssfb']);
  });

  test.each([...ENTITIES])('the %s deep set is its investigator set plus the three CodeGraph tools', (entity) => {
    for (const h of [plain, allOn]) {
      const base = names(toolsFor('investigator', ctxFrom(h, entity)));
      expect(names(toolsFor('investigator_deep', ctxFrom(h, entity)))).toEqual(sorted([...base, ...CODEGRAPH_TOOLS]));
    }
  });

  test('the investigator sets hold no triage-only or CodeGraph tool', () => {
    for (const entity of ENTITIES) {
      const set = names(toolsFor('investigator', ctxFrom(allOn, entity)));
      for (const name of [...CODEGRAPH_TOOLS, 'resolve_identity', 'finish_report']) expect(set).not.toContain(name);
    }
  });

  test('the triage mount holds ask_requester, stop_blocked, resolve_identity, note_evidence and finish_report only', () => {
    for (const h of [plain, allOn]) {
      const set = names(toolsFor('triage', ctxFrom(h, null)));
      expect(set).toEqual(sorted(['ask_requester', 'finish_report', 'note_evidence', 'resolve_identity', 'stop_blocked']));
    }
  });

  test('code_walker holds the five code tools and note_evidence', () => {
    for (const h of [plain, allOn]) {
      expect(names(toolsFor('code_walker', ctxFrom(h, null)))).toEqual(sorted([...CODE_TOOLS, 'note_evidence']));
    }
  });

  test('an investigator mount without an entity is refused', () => {
    expect(() => toolsFor('investigator', ctxFrom(plain, null))).toThrow(/needs an entity/);
    expect(() => toolsFor('investigator_deep', ctxFrom(plain, null))).toThrow(/needs an entity/);
  });
});

// ------------------------------------------------------------ gating

const planRow = (mount: Mount, ctx: ToolContext, name: string) => mountPlan(mount, ctx).find((r) => r.name === name);

describe('flag and key gating', () => {
  test.each(['', '   '])('crypto tools are off and listed with a reason when the key is %p', (value) => {
    const h = home({ [ENC_KEY]: value });
    const ctx = ctxFrom(h, 'ssfb');
    const set = names(toolsFor('investigator', ctx));
    for (const name of SSFB_CRYPTO) {
      expect(set).not.toContain(name);
      expect(planRow('investigator', ctx, name)).toEqual({ name, on: false, reason: `${ENC_KEY} and SSFB_RHYTHM_FIELD_ENC_KEY are blank` });
    }
  });

  test('crypto tools are on when the key is set, on both ssfb mounts', () => {
    const h = home({ [ENC_KEY]: FAKE_FIELD_KEY });
    for (const mount of ['investigator', 'investigator_deep'] as const) {
      const ctx = ctxFrom(h, 'ssfb');
      const set = names(toolsFor(mount, ctx));
      for (const name of SSFB_CRYPTO) {
        expect(set).toContain(name);
        expect(planRow(mount, ctx, name)).toEqual({ name, on: true });
      }
      // The key does not turn cbs_call on.
      expect(set).not.toContain('cbs_call');
    }
  });

  test.each(['yes', '1'])('a CBS flag of %p is refused when the config loads', (value) => {
    expect(() => home({ [CBS_FLAG]: value })).toThrow(/SSFB_CBS_VIA_KUBECTL_ENABLED must be true or false/);
  });

  test.each(['false', ''])('cbs_call is off and listed with a reason when the flag is %p', (value) => {
    const h = home({ [CBS_FLAG]: value });
    const ctx = ctxFrom(h, 'ssfb');
    expect(names(toolsFor('investigator', ctx))).not.toContain('cbs_call');
    expect(planRow('investigator', ctx, 'cbs_call')).toEqual({ name: 'cbs_call', on: false, reason: `${CBS_FLAG} is not true` });
  });

  test('cbs_call is on only when the flag is true, and the flag does not turn the crypto tools on', () => {
    const h = home({ [CBS_FLAG]: 'true' });
    const ctx = ctxFrom(h, 'ssfb');
    const set = names(toolsFor('investigator', ctx));
    expect(set).toContain('cbs_call');
    expect(planRow('investigator', ctx, 'cbs_call')).toEqual({ name: 'cbs_call', on: true });
    for (const name of SSFB_CRYPTO) expect(set).not.toContain(name);
  });

  test('cbs_call stays off when ssfb is not an enabled entity, even with the flag on', () => {
    const h = home({ [CBS_FLAG]: 'true' }, ['atspl', 'rtl']);
    const ctx = ctxFrom(h, 'ssfb');
    expect(names(toolsFor('investigator', ctx))).not.toContain('cbs_call');
    expect(planRow('investigator', ctx, 'cbs_call')).toEqual({
      name: 'cbs_call',
      on: false,
      reason: 'ssfb is not in TRIAGE_ENTITIES',
    });
  });

  test('every disabled tool shows in mountPlan with a non-empty reason', () => {
    for (const { mount, ctx } of everySet(plain)) {
      const created = new Set(names(toolsFor(mount, ctx)));
      for (const row of mountPlan(mount, ctx)) {
        expect(created.has(row.name)).toBe(row.on);
        if (!row.on) expect(row.reason.trim().length).toBeGreaterThan(0);
      }
    }
  });

  test('repo_read and repo_grep are off with a reason when TRIAGE_REPOS_DIR is blank', () => {
    const h = home({ TRIAGE_REPOS_DIR: '' });
    for (const [mount, entity] of [['code_walker', null], ['investigator_deep', 'rtl']] as const) {
      const ctx = ctxFrom(h, entity);
      const set = names(toolsFor(mount, ctx));
      for (const name of ['repo_read', 'repo_grep']) {
        expect(set).not.toContain(name);
        expect(planRow(mount, ctx, name)).toEqual({ name, on: false, reason: 'TRIAGE_REPOS_DIR is blank' });
      }
    }
  });

  test('resolve_identity is off with a reason when no hop entity is enabled', () => {
    const h = home({}, ['atspl']);
    const ctx = ctxFrom(h, null);
    expect(names(toolsFor('triage', ctx))).not.toContain('resolve_identity');
    expect(planRow('triage', ctx, 'resolve_identity')).toMatchObject({ on: false });
  });
});

// ------------------------------------------------------------ names

describe('names per set', () => {
  test('names in every set are unique, snake_case and not reserved by Flue', () => {
    for (const h of [plain, allOn]) {
      for (const { label, mount, ctx } of everySet(h)) {
        const list = toolsFor(mount, ctx).map((t) => t.name);
        expect({ label, dupes: list.filter((n, i) => list.indexOf(n) !== i) }).toEqual({ label, dupes: [] });
        for (const name of list) {
          expect(RESERVED_TOOL_NAMES).not.toContain(name);
          expect(name).toMatch(TOOL_NAME_PATTERN);
        }
      }
    }
  });
});

// ------------------------------------------------------------ service picklists

/** The picklist options of a tool's `service` input, or undefined when it has none. */
function servicePicklist(tool: ToolDefinition): readonly string[] | undefined {
  const input = tool.input as { entries?: Record<string, { type?: string; options?: unknown }> } | undefined;
  const service = input?.entries?.service;
  if (service?.type !== 'picklist' || !Array.isArray(service.options)) return undefined;
  return service.options as string[];
}

function picklistsOf(h: TestHome, entity: Entity): Map<string, readonly string[]> {
  const out = new Map<string, readonly string[]>();
  for (const tool of toolsFor('investigator_deep', ctxFrom(h, entity))) {
    const options = servicePicklist(tool);
    if (options !== undefined) out.set(tool.name, options);
  }
  return out;
}

describe('service picklists', () => {
  test('sql_select and http_call carry a service picklist for ssfb and rtl; the crypto tools only where a service has a key', () => {
    const expected = { ssfb: [...SSFB_CRYPTO, 'http_call', 'sql_select'], rtl: ['http_call', 'sql_select'] };
    for (const entity of ['ssfb', 'rtl'] as const) {
      const lists = picklistsOf(allOn, entity);
      expect(sorted([...lists.keys()])).toEqual(sorted(expected[entity]));
      for (const options of lists.values()) expect(options.length).toBeGreaterThan(0);
    }
    expect(picklistsOf(allOn, 'ssfb').get('encrypt_lookup_value')).toEqual(['harbor']);
  });

  test('each picklist holds only services of its own entity registry', () => {
    for (const entity of ENTITIES) {
      const own = new Set(allOn.registry.services(entity));
      for (const [tool, options] of picklistsOf(allOn, entity)) {
        expect({ tool, entity, foreign: options.filter((s) => !own.has(s)) }).toEqual({ tool, entity, foreign: [] });
      }
    }
  });

  // ssfb and rtl both register a 'workflow' service (separate copies with
  // separate backing env names), so the picklists share that one name. The
  // test pins that down: apart from names both registries define, the lists
  // are disjoint, and a shared name never resolves to the other entity's
  // backing.
  test('ssfb and rtl picklists are disjoint apart from names both registries define separately', () => {
    const ssfb = picklistsOf(allOn, 'ssfb');
    const rtl = picklistsOf(allOn, 'rtl');
    const ssfbServices = new Set(allOn.registry.services('ssfb'));
    const rtlServices = new Set(allOn.registry.services('rtl'));
    const allSsfb = new Set([...ssfb.values()].flat());
    const allRtl = new Set([...rtl.values()].flat());

    const shared = [...allSsfb].filter((s) => allRtl.has(s));
    for (const name of shared) {
      expect(ssfbServices.has(name) && rtlServices.has(name)).toBe(true);
      const a = allOn.registry.service('ssfb', name);
      const b = allOn.registry.service('rtl', name);
      // At least one backing field is set on both sides, and every field set
      // on both sides differs. A field set on one side only proves nothing.
      const both = (['db', 'api'] as const).filter((k) => a[k] !== undefined && b[k] !== undefined);
      expect(both.length).toBeGreaterThan(0);
      for (const k of both) expect(a[k]).not.toEqual(b[k]);
    }
    // Entity-specific services never cross over.
    for (const s of allSsfb) if (!rtlServices.has(s)) expect(allRtl.has(s)).toBe(false);
    for (const s of allRtl) if (!ssfbServices.has(s)) expect(allSsfb.has(s)).toBe(false);
    // Not vacuous: each side has services the other lacks.
    expect([...allSsfb].filter((s) => !allRtl.has(s)).length).toBeGreaterThan(0);
    expect([...allRtl].filter((s) => !allSsfb.has(s)).length).toBeGreaterThan(0);
  });

  test('the same tool gets a different picklist per entity', () => {
    const ssfb = picklistsOf(allOn, 'ssfb');
    const rtl = picklistsOf(allOn, 'rtl');
    for (const tool of ['sql_select', 'http_call']) expect(ssfb.get(tool)).not.toEqual(rtl.get(tool));
  });
});

// ------------------------------------------------------------ no I/O

type SpyLog = string[];

/**
 * A stand-in that records every property read and every call, at any depth,
 * and answers with another recorder. Used for ctx.deps so a connector, the
 * fixture store or any other dependency touched during construction shows up.
 */
function recorder(label: string, log: SpyLog): unknown {
  const target = function recorded(): void {};
  return new Proxy(target, {
    get(_t, key) {
      const path = `${label}.${String(key)}`;
      log.push(`read ${path}`);
      return recorder(path, log);
    },
    has(_t, key) {
      log.push(`has ${label}.${String(key)}`);
      return true;
    },
    apply() {
      log.push(`call ${label}`);
      return recorder(`${label}()`, log);
    },
    ownKeys() {
      log.push(`keys ${label}`);
      return ['prototype'];
    },
  });
}

describe('construction makes no I/O', () => {
  test('the recorder sees a touch, so an empty log means nothing was touched', () => {
    const log: SpyLog = [];
    const deps = recorder('deps', log) as { connectors: { sql: { query(): void } }; fixtures: { store: { get(): void } } };
    deps.connectors.sql.query();
    deps.fixtures.store.get();
    expect(log).toContain('call deps.connectors.sql.query');
    expect(log).toContain('call deps.fixtures.store.get');
  });

  test('toolsFor touches no dependency, spawns nothing, fetches nothing and returns synchronously', () => {
    const log: SpyLog = [];
    const deps = recorder('deps', log) as ToolDeps;
    const spawns = spyOnSpawns();
    const realFetch = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = Object.assign(
      (..._args: Parameters<typeof fetch>): Promise<Response> => {
        fetches += 1;
        return Promise.reject(new Error('fetch during tool construction'));
      },
      { preconnect: () => {} },
    ) as typeof fetch;
    let built = 0;
    try {
      for (const h of [plain, allOn]) {
        for (const { mount, ctx } of everySet(h, deps)) {
          const result: unknown = toolsFor(mount, ctx);
          expect(Array.isArray(result)).toBe(true);
          expect(result instanceof Promise).toBe(false);
          expect(typeof (result as { then?: unknown }).then).toBe('undefined');
          built += (result as ToolDefinition[]).length;
          mountPlan(mount, ctx);
        }
      }
    } finally {
      globalThis.fetch = realFetch;
      spawns.restore();
    }
    expect(built).toBeGreaterThan(0);
    expect(log.filter((l) => l.includes('deps.connectors'))).toEqual([]);
    expect(log.filter((l) => l.includes('deps.fixtures'))).toEqual([]);
    expect(log).toEqual([]);
    expect(spawns.calls()).toEqual([]);
    expect(fetches).toBe(0);
  });
});
