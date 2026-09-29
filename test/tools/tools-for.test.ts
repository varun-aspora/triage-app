// Integration check of the tool sets each mount gets from the real generated
// tool list (T05.8). Contexts come from a test home, so no real .env is read,
// and ctx.deps is a spy, so nothing here can reach a connector.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { ToolDefinition } from '@flue/runtime/tool';
import { agentEntitiesOf } from '../../src/tools/agent-entity.ts';
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

// The repo_* tools are on both investigator variants, scoped to the entity's repos.
const REPO_TOOLS = ['repo_find', 'repo_grep', 'repo_read', 'repo_tree'];
const BASE_INVESTIGATOR = ['http_call', 'logs_search', 'note_evidence', 'read_staged', 'run_log', 'sql_select', ...REPO_TOOLS];
const SSFB_ALWAYS = ['detect_silent_reversals', 'get_account_statement'];
const SSFB_CRYPTO = ['decrypt_fields', 'encrypt_lookup_value'];
// Scoped to ssfb in their module. The crypto tools serve any entity with a field-encryption service (D48).
const SSFB_SCOPED = SSFB_ALWAYS;
const SSFB_ONLY = [...SSFB_SCOPED, ...SSFB_CRYPTO];
const CODEGRAPH_TOOLS = ['code_explore', 'code_impact', 'code_node'];
const CODE_TOOLS = [...CODEGRAPH_TOOLS, ...REPO_TOOLS];
const MOUNTS: readonly Mount[] = ['triage', 'investigator', 'investigator_deep', 'code_walker', 'agent'];
// The entity data tools, mounted once on the agent mount with an entity input, or their one entity fixed (D109, D110).
const PER_ENTITY = ['http_call', 'logs_search', 'sql_select', ...SSFB_ONLY];
// Shared tools on the agent mount.
const SHARED_AGENT = ['ask_requester', 'finish_report', 'read_staged', 'resolve_identity', 'run_log', 'stop_blocked', ...CODE_TOOLS];
// note_evidence joins the agent mount through its own module (S2.8); its name is left out of the exact lists here.
const withoutEvidence = (list: readonly string[]): string[] => list.filter((n) => !n.endsWith('note_evidence'));

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

  test('the triage mount holds ask_requester, stop_blocked, resolve_identity, note_evidence, run_log and finish_report only', () => {
    for (const h of [plain, allOn]) {
      const set = names(toolsFor('triage', ctxFrom(h, null)));
      expect(set).toEqual(sorted(['ask_requester', 'finish_report', 'note_evidence', 'resolve_identity', 'run_log', 'stop_blocked']));
    }
  });

  test('code_walker holds the five code tools, note_evidence and run_log', () => {
    for (const h of [plain, allOn]) {
      expect(names(toolsFor('code_walker', ctxFrom(h, null)))).toEqual(sorted([...CODE_TOOLS, 'note_evidence', 'run_log']));
    }
  });

  test('the perEntity modules are the entity data tools', () => {
    expect(sorted(withoutEvidence(allToolModules.filter((m) => m.perEntity === true).map((m) => m.name)))).toEqual(sorted(PER_ENTITY));
  });

  test("the agent mount holds each data tool once, picking among the enabled entities that have it, and the shared tools once", () => {
    for (const h of [plain, allOn]) {
      const served = new Map<string, Entity[]>();
      for (const entity of h.registry.enabledEntities()) {
        for (const name of names(toolsFor('investigator', ctxFrom(h, entity)))) {
          if (PER_ENTITY.includes(name)) served.set(name, [...(served.get(name) ?? []), entity]);
        }
      }
      const agent = toolsFor('agent', ctxFrom(h, null));
      expect(withoutEvidence(names(agent))).toEqual(sorted([...SHARED_AGENT, ...served.keys()]));
      for (const [name, entities] of served) {
        const tool = agent.find((t) => t.name === name)!;
        const want = SSFB_SCOPED.includes(name) ? { entities, picked: false } : { entities, picked: true };
        expect({ name, mark: agentEntitiesOf(tool) }).toEqual({ name, mark: want });
      }
    }
  });

  test('on the agent mount the SSFB-only tools have no entity input; the crypto tools pick ssfb only', () => {
    const set = toolsFor('agent', ctxFrom(allOn, null));
    for (const name of SSFB_SCOPED) {
      const tool = set.find((t) => t.name === name)!;
      expect(entryKeys(tool)).not.toContain('entity');
      expect(tool.description).toStartWith('SSFB (also called shivalik) only. ');
    }
    // The crypto tools serve any entity with a field-encrypted service; only ssfb has one.
    for (const name of SSFB_CRYPTO) {
      const tool = set.find((t) => t.name === name)!;
      expect(entityOptions(tool)).toEqual(['ssfb']);
      expect(planRow('agent', ctxFrom(allOn, null), name)).toEqual({ name, on: true });
      const off = planRow('agent', ctxFrom(plain, null), name);
      expect(off?.on).toBe(false);
      expect(off && !off.on ? off.reason : '').toContain(`rtl: no service of this entity has field encryption`);
    }
  });

  test('an entity not in TRIAGE_ENTITIES gets no tools on the agent mount', () => {
    const h = home({ [ENC_KEY]: FAKE_FIELD_KEY, [CBS_FLAG]: 'true' }, ['atspl', 'rtl']);
    const set = toolsFor('agent', ctxFrom(h, null));
    for (const name of SSFB_ONLY) expect(names(set)).not.toContain(name);
    expect(entityOptions(set.find((t) => t.name === 'sql_select')!)).toEqual(['atspl', 'rtl']);
    expect(entityOptions(set.find((t) => t.name === 'logs_search')!)).toEqual(['atspl', 'rtl']);
  });

  test("each entity's copy is built for that entity: same service picklist as its investigator's tool", async () => {
    const now = () => new Date('2026-09-29T00:00:00.000Z');
    const agent = new Map(toolsFor('agent', ctxFrom(allOn, null, { now } as unknown as ToolDeps)).map((t) => [t.name, t]));
    for (const tool of ['sql_select', 'http_call']) {
      // A service no entity has: the refusal lists every entity's own services.
      const out = (await (agent.get(tool)!.run as (c: unknown) => Promise<{ output: { status: string; message: string } }>)({
        data: { entity: 'rtl', service: 'no_such_service', path: '/x', sql: 'SELECT 1' },
        toolCallId: 'call_1',
      })).output;
      expect(out.status).toBe('refused');
      const pairs = out.message.slice(out.message.indexOf('pairs: ') + 7, -1).split(', ');
      for (const entity of ['ssfb', 'rtl'] as const) {
        const own = picklistsOf(allOn, entity).get(tool);
        expect({ tool, entity, services: pairs.filter((p) => p.startsWith(`${entity}:`)).map((p) => p.slice(entity.length + 1)) }).toEqual({
          tool,
          entity,
          services: [...(own ?? [])],
        });
      }
    }
    const rtlSql = picklistsOf(allOn, 'rtl').get('sql_select')!;
    expect(agent.get('sql_select')!.description).toContain(`rtl: services ${rtlSql.join(', ')}.`);
  });

  test("http_call's finacle note reaches the agent mount on the ssfb line, only when the gateway is on (D110, D111)", () => {
    const httpOf = (h: TestHome) => toolsFor('agent', ctxFrom(h, null)).find((t) => t.name === 'http_call')!;
    const on = httpOf(allOn);
    expect(on.description).toMatch(/ssfb \(also called shivalik\): services [^.]*\bfinacle\b[^.]*; finacle is the bank's Finacle CBS gateway/);
    expect(on.description).toMatch(/rtl: services [^.;]*\.$/);
    // The merged service input carries no per-entity note.
    expect(JSON.stringify(on.input)).not.toContain('Finacle');
    expect(httpOf(plain).description).not.toContain('Finacle');
  });

  test('the agent mount refuses a context with an entity', () => {
    expect(() => toolsFor('agent', ctxFrom(plain, 'rtl'))).toThrow(/without an entity/);
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
    }
  });

  test.each(['yes', '1'])('a CBS flag of %p is refused when the config loads', (value) => {
    expect(() => home({ [CBS_FLAG]: value })).toThrow(/SSFB_CBS_VIA_KUBECTL_ENABLED must be true or false/);
  });

  test('the CBS flag mounts no tool of its own: finacle is an http_call service (D111)', () => {
    const on = names(toolsFor('investigator', ctxFrom(home({ [CBS_FLAG]: 'true' }), 'ssfb')));
    const off = names(toolsFor('investigator', ctxFrom(home({ [CBS_FLAG]: 'false' }), 'ssfb')));
    expect(on).toEqual(off);
    expect(allToolModules.map((m) => m.name)).not.toContain('cbs_call');
    for (const name of SSFB_CRYPTO) expect(on).not.toContain(name);
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
    for (const [mount, entity] of [['code_walker', null], ['investigator_deep', 'rtl'], ['agent', null]] as const) {
      const ctx = ctxFrom(h, entity);
      const set = names(toolsFor(mount, ctx));
      for (const name of REPO_TOOLS) {
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
function entryKeys(tool: ToolDefinition): string[] {
  return Object.keys((tool.input as { entries?: object } | undefined)?.entries ?? {});
}

function entityOptions(tool: ToolDefinition): unknown {
  return (tool.input as { entries?: Record<string, { options?: unknown }> }).entries?.entity?.options;
}

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
