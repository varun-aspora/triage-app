import { describe, expect, test } from 'bun:test';
import { defineTool, type ToolDefinition } from '@flue/runtime/tool';
import * as v from 'valibot';
import { FakeDepsAccessError, makeToolContext } from '../../test/support/fake-tool-context.ts';
import { CODE_TOOLS } from '../gate/budget.ts';
import type { Entity } from '../types/core.ts';
import { ok } from '../types/tool-result.ts';
import { agentEntitiesOf, entityOfCall, markAgentEntities } from './agent-entity.ts';
import {
  allToolModules,
  allToolNames,
  buildToolIndex,
  conformanceCases,
  conformanceProblems,
  DuplicateToolNameError,
  generatedToolSources,
  mountPlan,
  ReservedToolNameError,
  TOOL_NAME_PATTERN,
  ToolIndexError,
  ToolNameMismatchError,
  toolsFor,
} from './index.ts';
import type { Mount, ToolContext, ToolDeps, ToolModule } from './types.ts';

function tool(name: string, input: v.ObjectSchema<v.ObjectEntries, undefined> = v.object({ q: v.string() })): ToolDefinition {
  return defineTool({ name, description: `fake ${name}`, input, run: async () => ok({}) });
}

type FakeOptions = Partial<Omit<ToolModule, 'name'>> & { created?: string };

function fake(name: string, opts: FakeOptions = {}): ToolModule {
  return {
    name,
    mounts: opts.mounts ?? ['investigator'],
    entities: opts.entities ?? 'all',
    ...(opts.perEntity !== undefined ? { perEntity: opts.perEntity } : {}),
    ...(opts.entityLine !== undefined ? { entityLine: opts.entityLine } : {}),
    enabled: opts.enabled ?? (() => ({ on: true })),
    create: opts.create ?? (() => tool(opts.created ?? name)),
  };
}

const names = (tools: readonly ToolDefinition[]): string[] => tools.map((t) => t.name);

describe('toolsFor', () => {
  const ctx = (entity: Entity | null): ToolContext => makeToolContext({ entity });

  test('filters out modules for other entities', () => {
    const index = buildToolIndex([
      fake('sql_select'),
      fake('get_account_statement', { entities: ['ssfb'] }),
      fake('rtl_only', { entities: ['rtl', 'atspl'] }),
    ]);
    expect(names(index.toolsFor('investigator', ctx('atspl')))).toEqual(['sql_select', 'rtl_only']);
    expect(names(index.toolsFor('investigator', ctx('ssfb')))).toEqual(['sql_select', 'get_account_statement']);
  });

  test('entity-scoped modules are absent where the context has no entity', () => {
    const index = buildToolIndex([fake('note_evidence', { mounts: ['triage'] }), fake('odd', { mounts: ['triage'], entities: ['ssfb'] })]);
    expect(names(index.toolsFor('triage', ctx(null)))).toEqual(['note_evidence']);
  });

  test('investigator mounts refuse a context without an entity', () => {
    const index = buildToolIndex([fake('sql_select')]);
    expect(() => index.toolsFor('investigator', ctx(null))).toThrow(ToolIndexError);
    expect(() => index.toolsFor('investigator_deep', ctx(null))).toThrow(/needs an entity/);
  });

  test('deep is investigator plus investigator_deep, each module once', () => {
    const index = buildToolIndex([
      fake('sql_select'),
      fake('code_explore', { mounts: ['investigator_deep', 'code_walker'] }),
      fake('note_evidence', { mounts: ['investigator', 'investigator_deep', 'code_walker'] }),
      fake('finish_report', { mounts: ['triage'] }),
    ]);
    expect(names(index.toolsFor('investigator', ctx('rtl')))).toEqual(['sql_select', 'note_evidence']);
    expect(names(index.toolsFor('investigator_deep', ctx('rtl')))).toEqual(['sql_select', 'code_explore', 'note_evidence']);
    expect(names(index.toolsFor('code_walker', ctx(null)))).toEqual(['code_explore', 'note_evidence']);
    expect(names(index.toolsFor('triage', ctx(null)))).toEqual(['finish_report']);
  });

  test('create() receives the mount being built', () => {
    const seen: Mount[] = [];
    const index = buildToolIndex([
      fake('note_evidence', {
        mounts: ['investigator', 'code_walker'],
        create: (_ctx, mount) => {
          seen.push(mount);
          return tool('note_evidence');
        },
      }),
    ]);
    index.toolsFor('investigator_deep', ctx('ssfb'));
    index.toolsFor('code_walker', ctx(null));
    expect(seen).toEqual(['investigator_deep', 'code_walker']);
  });

  test('two modules with the same name on one mount name both files', () => {
    const index = buildToolIndex([fake('sql_select'), fake('sql_select', { mounts: ['investigator_deep'] })], {
      sources: ['src/tools/sql-select.tool.ts', 'src/tools/ssfb/sql-select.tool.ts'],
    });
    expect(() => index.toolsFor('investigator_deep', ctx('ssfb'))).toThrow(DuplicateToolNameError);
    expect(() => index.toolsFor('investigator_deep', ctx('ssfb'))).toThrow(
      /src\/tools\/sql-select\.tool\.ts and src\/tools\/ssfb\/sql-select\.tool\.ts/,
    );
    // Not mounted together: no clash.
    expect(names(index.toolsFor('investigator', ctx('ssfb')))).toEqual(['sql_select']);
  });

  test('a duplicate is caught even when one of the pair is disabled', () => {
    const index = buildToolIndex([
      fake('http_call'),
      fake('http_call', { enabled: () => ({ on: false, reason: 'off' }) }),
    ]);
    expect(() => index.toolsFor('investigator', ctx('rtl'))).toThrow(DuplicateToolNameError);
  });

  test.each(['bash', 'task', 'activate_skill', 'read_skill_resource', 'finish', 'give_up', 'read', 'write', 'edit', 'grep', 'glob'])(
    'reserved name %s is refused',
    (name) => {
      const index = buildToolIndex([fake(name)]);
      expect(() => index.toolsFor('investigator', ctx('ssfb'))).toThrow(ReservedToolNameError);
      expect(() => index.mountPlan('investigator', ctx('ssfb'))).toThrow(ReservedToolNameError);
    },
  );

  test.each(['SqlSelect', 'sql-select', 'sql__select', '_sql', 'sql_', '9sql', '', 'mcp__x__y'])('bad name %p is refused', (name) => {
    const index = buildToolIndex([fake(name)], { sources: ['src/tools/x.tool.ts'] });
    expect(() => index.toolsFor('investigator', ctx('ssfb'))).toThrow(/src\/tools\/x\.tool\.ts: tool name .* is not snake_case/);
  });

  test('created name must equal the module name', () => {
    const index = buildToolIndex([fake('sql_select', { created: 'sql_query' })], { sources: ['src/tools/sql-select.tool.ts'] });
    expect(() => index.toolsFor('investigator', ctx('ssfb'))).toThrow(ToolNameMismatchError);
    expect(() => index.toolsFor('investigator', ctx('ssfb'))).toThrow(/sql-select\.tool\.ts.*'sql_query'/);
  });

  test('a disabled module is absent from toolsFor, listed in mountPlan, and never created', () => {
    let created = 0;
    const index = buildToolIndex([
      fake('sql_select'),
      fake('decrypt_fields', {
        entities: ['ssfb'],
        enabled: () => ({ on: false, reason: 'SSFB_HARBOR_FIELD_ENC_KEY is blank' }),
        create: () => {
          created += 1;
          return tool('decrypt_fields');
        },
      }),
    ]);
    expect(names(index.toolsFor('investigator', ctx('ssfb')))).toEqual(['sql_select']);
    expect(index.mountPlan('investigator', ctx('ssfb'))).toEqual([
      { name: 'sql_select', on: true },
      { name: 'decrypt_fields', on: false, reason: 'SSFB_HARBOR_FIELD_ENC_KEY is blank' },
    ]);
    expect(created).toBe(0);
  });

  test('mountPlan never calls create()', () => {
    const index = buildToolIndex([
      fake('sql_select', {
        create: () => {
          throw new Error('create called');
        },
      }),
    ]);
    expect(index.mountPlan('investigator', ctx('atspl'))).toEqual([{ name: 'sql_select', on: true }]);
  });

  test('create() that touches ctx.deps throws in the fake context', () => {
    const eager = fake('sql_select', {
      create: (c) => {
        void c.deps.audit;
        return tool('sql_select');
      },
    });
    const index = buildToolIndex([eager]);
    expect(() => index.toolsFor('investigator', ctx('ssfb'))).toThrow(FakeDepsAccessError);
  });

  test('a tool that defers deps to run() builds fine', () => {
    const lazy = fake('sql_select', {
      create: (c) =>
        defineTool({
          name: 'sql_select',
          description: 'fake',
          input: v.object({ sql: v.string() }),
          run: async () => ok({ has: 'audit' in c.deps }),
        }),
    });
    expect(names(buildToolIndex([lazy]).toolsFor('investigator', ctx('ssfb')))).toEqual(['sql_select']);
  });

  test('bad module shapes are refused when the index is built', () => {
    expect(() => buildToolIndex([fake('a', { mounts: [] })])).toThrow(/mounts/);
    expect(() => buildToolIndex([fake('a', { mounts: ['orchestrator' as Mount] })])).toThrow(/mounts/);
    expect(() => buildToolIndex([fake('a', { entities: ['shivalik' as Entity] })])).toThrow(/entities/);
    expect(() => buildToolIndex([fake('a', { entities: [] })])).toThrow(/entities/);
  });

  test('allToolNames is sorted and unique', () => {
    const index = buildToolIndex([fake('sql_select'), fake('http_call'), fake('sql_select', { mounts: ['code_walker'] })]);
    expect(index.allToolNames()).toEqual(['http_call', 'sql_select']);
  });
});

describe('the agent mount (D109, D110)', () => {
  const root = (entities = 'ssfb,atspl,rtl', deps?: ToolDeps): ToolContext =>
    makeToolContext({ env: { TRIAGE_ENTITIES: entities }, ...(deps !== undefined ? { deps } : {}) });
  const ctx = (entity: Entity): ToolContext => makeToolContext({ entity });
  const agentModules = (): ToolModule[] => [
    fake('sql_select', { mounts: ['investigator', 'agent'], perEntity: true }),
    fake('logs_search', { mounts: ['investigator', 'agent'], perEntity: true }),
    fake('get_account_statement', { mounts: ['investigator', 'agent'], entities: ['ssfb'], perEntity: true }),
    fake('repo_grep', { mounts: ['investigator', 'code_walker', 'agent'] }),
    fake('finish_report', { mounts: ['triage', 'agent'] }),
    fake('investigator_only', { mounts: ['investigator'] }),
  ];
  const entries = (t: ToolDefinition): Record<string, v.GenericSchema> =>
    (t.input as unknown as { entries: Record<string, v.GenericSchema> }).entries;
  const optionsOf = (t: ToolDefinition, key: string): unknown => (entries(t)[key] as unknown as { options?: unknown }).options;
  const clockDeps = { now: () => new Date('2026-09-29T00:00:00.000Z') } as unknown as ToolDeps;

  // A module whose copies differ by their service picklist, like sql_select. run() answers with the copy's entity and data.
  const SERVICES: Record<Entity, string[]> = { ssfb: ['harbor', 'rhythm'], atspl: ['package'], rtl: ['workflow', 'banking'] };
  const serviceModule = (opts: FakeOptions = {}): ToolModule =>
    fake('sql_select', {
      mounts: ['agent'],
      perEntity: true,
      create: (c) =>
        defineTool({
          name: 'sql_select',
          description: 'fake sql_select',
          input: v.object({ service: v.pipe(v.picklist(SERVICES[c.entity as Entity]), v.description('The service.')), q: v.string() }),
          run: async ({ data }) => ok({ entity: c.entity, data }, clockDeps.now),
        }),
      ...opts,
    });
  const call = (t: ToolDefinition, data: Record<string, unknown>): Promise<{ output: { status: string; message?: string; data?: unknown } }> =>
    (t.run as (c: unknown) => Promise<{ output: { status: string; message?: string; data?: unknown } }>)({ data, toolCallId: 'call_1' });

  test('one tool per perEntity module under its bare name, shared tools once', () => {
    const index = buildToolIndex(agentModules());
    expect(names(index.toolsFor('agent', root()))).toEqual(['sql_select', 'logs_search', 'get_account_statement', 'repo_grep', 'finish_report']);
  });

  test('the entity input lists the enabled entities, first; an ssfb-only module is absent without ssfb', () => {
    const index = buildToolIndex(agentModules());
    const tools = index.toolsFor('agent', root('atspl,rtl'));
    expect(names(tools)).toEqual(['sql_select', 'logs_search', 'repo_grep', 'finish_report']);
    const sql = tools[0] as ToolDefinition;
    expect(Object.keys(entries(sql))).toEqual(['entity', 'q']);
    expect(optionsOf(sql, 'entity')).toEqual(['atspl', 'rtl']);
    expect(agentEntitiesOf(sql)).toEqual({ entities: ['atspl', 'rtl'], picked: true });
    expect(agentEntitiesOf(tools[2] as ToolDefinition)).toBeUndefined();
  });

  test('a module scoped to one entity has no entity input, keeps its name and names its entity first', () => {
    const [statement] = buildToolIndex([fake('get_account_statement', { mounts: ['agent'], entities: ['ssfb'], perEntity: true })]).toolsFor(
      'agent',
      root(),
    );
    expect(statement!.name).toBe('get_account_statement');
    expect(Object.keys(entries(statement!))).toEqual(['q']);
    expect(statement!.description).toBe('SSFB (also called shivalik) only. fake get_account_statement');
    expect(agentEntitiesOf(statement!)).toEqual({ entities: ['ssfb'], picked: false });
  });

  test('each copy is built with its entity in the context; shared tools with none', () => {
    const seen: [string, Entity | null, Mount][] = [];
    const spy = (name: string, opts: FakeOptions): ToolModule =>
      fake(name, {
        ...opts,
        create: (c, mount) => {
          seen.push([name, c.entity, mount]);
          return tool(name);
        },
      });
    const index = buildToolIndex([spy('sql_select', { mounts: ['agent'], perEntity: true }), spy('run_log', { mounts: ['agent'] })]);
    index.toolsFor('agent', root('ssfb,rtl'));
    expect(seen).toEqual([
      ['sql_select', 'ssfb', 'agent'],
      ['sql_select', 'rtl', 'agent'],
      ['run_log', null, 'agent'],
    ]);
  });

  test('enabled() is asked per entity; the entity input lists only the enabled copies; mountPlan has one row', () => {
    const decrypt = fake('decrypt_fields', {
      mounts: ['agent'],
      perEntity: true,
      enabled: (c) => (c.entity === 'ssfb' ? { on: true } : { on: false, reason: `no key for ${String(c.entity)}` }),
    });
    const index = buildToolIndex([decrypt, fake('stop_blocked', { mounts: ['agent'] })]);
    const tools = index.toolsFor('agent', root());
    expect(names(tools)).toEqual(['decrypt_fields', 'stop_blocked']);
    expect(optionsOf(tools[0] as ToolDefinition, 'entity')).toEqual(['ssfb']);
    expect(index.mountPlan('agent', root())).toEqual([
      { name: 'decrypt_fields', on: true },
      { name: 'stop_blocked', on: true },
    ]);
    expect(index.mountPlan('agent', root('atspl,rtl'))).toEqual([
      { name: 'decrypt_fields', on: false, reason: 'atspl: no key for atspl; rtl: no key for rtl' },
      { name: 'stop_blocked', on: true },
    ]);
    expect(index.toolsFor('agent', root('atspl,rtl')).map((t) => t.name)).toEqual(['stop_blocked']);
  });

  test('service picklists merge into one, and the description lists each entity with its services', () => {
    const [sql] = buildToolIndex([serviceModule()]).toolsFor('agent', root());
    expect(optionsOf(sql!, 'service')).toEqual(['harbor', 'rhythm', 'package', 'workflow', 'banking']);
    expect(sql!.description).toBe(
      'fake sql_select entity picks the entity each call is for, and the call reaches only that one. ' +
        'ssfb (also called shivalik): services harbor, rhythm. atspl: services package. rtl: services workflow, banking.',
    );
    // One description for the merged key when the copies share it.
    const service = entries(sql!).service as unknown as { pipe: { type: string; description?: string }[] };
    expect(service.pipe.find((i) => i.type === 'description')?.description).toBe('The service.');
  });

  test("entityLine replaces the service list in the module's description", () => {
    const [sql] = buildToolIndex([serviceModule({ entityLine: (c) => `index ${String(c.entity)}-logs` })]).toolsFor('agent', root('rtl'));
    expect(sql!.description).toEndWith('rtl: index rtl-logs.');
  });

  test('a call runs the chosen copy on the rest of its input', async () => {
    const [sql] = buildToolIndex([serviceModule()]).toolsFor('agent', root(undefined, clockDeps));
    const out = await call(sql!, { entity: 'rtl', service: 'banking', q: 'x' });
    expect(out.output).toMatchObject({ status: 'ok', data: { entity: 'rtl', data: { service: 'banking', q: 'x' } } });
  });

  test('a service the entity does not have is refused with the valid pairs, before the copy runs', async () => {
    const [sql] = buildToolIndex([serviceModule()]).toolsFor('agent', root('ssfb,rtl', clockDeps));
    const out = await call(sql!, { entity: 'rtl', service: 'harbor', q: 'x' });
    expect(out.output.status).toBe('refused');
    expect(out.output.message).toBe(
      'Refused: rtl has no such service for sql_select; valid entity:service pairs: ssfb:harbor, ssfb:rhythm, rtl:workflow, rtl:banking.',
    );
  });

  test('an entity the tool does not serve is refused with the valid pairs, or the entities where there is no service', async () => {
    const [sql] = buildToolIndex([serviceModule()]).toolsFor('agent', root('ssfb,rtl', clockDeps));
    const out = await call(sql!, { entity: 'atspl', service: 'package', q: 'x' });
    expect(out.output.status).toBe('refused');
    expect(out.output.message).toBe(
      'Refused: entity must be one this tool serves here; valid entity:service pairs: ssfb:harbor, ssfb:rhythm, rtl:workflow, rtl:banking.',
    );
    const [logs] = buildToolIndex([fake('logs_search', { mounts: ['agent'], perEntity: true })]).toolsFor('agent', root('ssfb,rtl', clockDeps));
    const none = await call(logs!, { q: 'x' });
    expect(none.output.message).toBe('Refused: entity must be one this tool serves here; valid entities: ssfb, rtl.');
  });

  test('copies that differ in description or in a non-picklist input are refused, naming the file', () => {
    const differs = (create: ToolModule['create']) =>
      buildToolIndex([fake('sql_select', { mounts: ['agent'], perEntity: true, create })], { sources: ['src/tools/sql-select.tool.ts'] });
    const byDescription = differs((c) => defineTool({ name: 'sql_select', description: `for ${String(c.entity)}`, input: v.object({ q: v.string() }), run: async () => ok({}) }));
    expect(() => byDescription.toolsFor('agent', root())).toThrow(/sql-select\.tool\.ts: .*one description for every entity/);
    const byInput = differs((c) =>
      defineTool({ name: 'sql_select', description: 'x', input: v.object({ q: v.pipe(v.string(), v.maxLength(c.entity === 'rtl' ? 5 : 9)) }), run: async () => ok({}) }),
    );
    expect(() => byInput.toolsFor('agent', root())).toThrow(ToolIndexError);
    expect(() => byInput.toolsFor('agent', root())).toThrow(/input 'q' differs between entities and is not a picklist/);
  });

  test('the merged input stays a plain object, strict when the copies are', () => {
    const strict = fake('http_call', {
      mounts: ['agent'],
      perEntity: true,
      create: () => defineTool({ name: 'http_call', description: 'x', input: v.strictObject({ path: v.string() }), run: async () => ok({}) }),
    });
    const [http] = buildToolIndex([strict]).toolsFor('agent', root());
    expect((http!.input as unknown as { type: string }).type).toBe('strict_object');
    expect(v.safeParse(http!.input as v.GenericSchema, { entity: 'rtl', path: '/x', extra: 1 }).success).toBe(false);
    expect(v.safeParse(http!.input as v.GenericSchema, { path: '/x' }).success).toBe(false);
  });

  test('the agent mount refuses a context with an entity', () => {
    const index = buildToolIndex(agentModules());
    expect(() => index.toolsFor('agent', makeToolContext({ entity: 'rtl' }))).toThrow(/without an entity/);
  });

  test('the created name is still checked against the module name', () => {
    const index = buildToolIndex([fake('sql_select', { mounts: ['agent'], perEntity: true, created: 'rtl_sql_select' })], {
      sources: ['src/tools/sql-select.tool.ts'],
    });
    expect(() => index.toolsFor('agent', root())).toThrow(ToolNameMismatchError);
  });

  test('two modules under one name clash, even when one is disabled or shared', () => {
    const index = buildToolIndex([
      fake('sql_select', { mounts: ['agent'], perEntity: true }),
      fake('sql_select', { mounts: ['agent'], perEntity: true, enabled: () => ({ on: false, reason: 'off' }) }),
    ]);
    expect(() => index.toolsFor('agent', root())).toThrow(DuplicateToolNameError);
    expect(() => index.mountPlan('agent', root())).toThrow(/duplicate tool name 'sql_select' on mount agent/);
    const shared = buildToolIndex([fake('sql_select', { mounts: ['agent'], perEntity: true }), fake('sql_select', { mounts: ['agent'] })]);
    expect(() => shared.toolsFor('agent', root())).toThrow(DuplicateToolNameError);
  });

  test('names longer than 64 characters are refused', () => {
    expect(() => buildToolIndex([fake(`a${'b'.repeat(64)}`)]).toolsFor('investigator', ctx('rtl'))).toThrow(/longer than 64/);
    expect(() => buildToolIndex([fake(`a${'b'.repeat(64)}`, { mounts: ['agent'], perEntity: true })]).toolsFor('agent', root())).toThrow(
      /longer than 64/,
    );
  });

  test('other mounts ignore perEntity', () => {
    const index = buildToolIndex([fake('sql_select', { mounts: ['investigator', 'agent'], perEntity: true })]);
    const [sql] = index.toolsFor('investigator', ctx('rtl'));
    expect(sql!.name).toBe('sql_select');
    expect(Object.keys(entries(sql!))).toEqual(['q']);
    expect(agentEntitiesOf(sql!)).toBeUndefined();
  });
});

describe('the entity of an agent-mount call', () => {
  test('entityOfCall reads the fixed entity or a served entity input', () => {
    expect(entityOfCall({ entities: ['ssfb'], picked: false }, { account_id: 'x' })).toBe('ssfb');
    expect(entityOfCall({ entities: ['ssfb', 'rtl'], picked: true }, { entity: 'rtl' })).toBe('rtl');
    expect(entityOfCall({ entities: ['ssfb', 'rtl'], picked: true }, { entity: 'atspl' })).toBeUndefined();
    expect(entityOfCall({ entities: ['ssfb', 'rtl'], picked: true }, undefined)).toBeUndefined();
    expect(entityOfCall(undefined, { entity: 'rtl' })).toBeUndefined();
  });

  test('the mark survives a wrapper that spreads the tool', () => {
    const marked = markAgentEntities(tool('sql_select'), { entities: ['rtl'], picked: true });
    expect(agentEntitiesOf({ ...marked, run: async () => ok({}) } as ToolDefinition)).toEqual({ entities: ['rtl'], picked: true });
    expect(agentEntitiesOf(tool('sql_select'))).toBeUndefined();
  });
});

describe('conformanceProblems', () => {
  const m = fake('sql_select');

  test('accepts an object input without entity or run id', () => {
    expect(conformanceProblems(m, tool('sql_select'))).toEqual([]);
    expect(conformanceProblems(m, defineTool({ name: 'sql_select', description: 'x', input: v.strictObject({ a: v.string() }), run: () => 'x' }))).toEqual([]);
  });

  test('flags entity, run_id, a missing input and a name mismatch', () => {
    expect(conformanceProblems(m, tool('sql_select', v.object({ entity: v.string(), run_id: v.string() })))).toEqual([
      "input schema has a 'entity' key",
      "input schema has a 'run_id' key",
    ]);
    const noInput = defineTool({ name: 'sql_query', description: 'x', run: () => 'x' });
    expect(conformanceProblems(m, noInput)).toEqual([
      "created name 'sql_query' differs from module name 'sql_select'",
      'input schema is not a valibot object',
    ]);
  });

  test('conformanceCases covers each mount and entity', () => {
    expect(conformanceCases(fake('a', { mounts: ['triage', 'investigator'] }))).toEqual([
      { mount: 'triage', entity: null },
      { mount: 'investigator', entity: 'ssfb' },
      { mount: 'investigator', entity: 'atspl' },
      { mount: 'investigator', entity: 'rtl' },
    ]);
    expect(conformanceCases(fake('a', { mounts: ['investigator_deep'], entities: ['ssfb'] }))).toEqual([
      { mount: 'investigator_deep', entity: 'ssfb' },
    ]);
  });

  test('on the agent mount, a perEntity module runs per entity and a shared one once', () => {
    expect(conformanceCases(fake('a', { mounts: ['agent'], perEntity: true }))).toEqual([
      { mount: 'agent', entity: 'ssfb' },
      { mount: 'agent', entity: 'atspl' },
      { mount: 'agent', entity: 'rtl' },
    ]);
    expect(conformanceCases(fake('a', { mounts: ['agent'], perEntity: true, entities: ['ssfb'] }))).toEqual([
      { mount: 'agent', entity: 'ssfb' },
    ]);
    expect(conformanceCases(fake('a', { mounts: ['triage', 'agent'] }))).toEqual([
      { mount: 'triage', entity: null },
      { mount: 'agent', entity: null },
    ]);
  });
});

describe('generated tool list', () => {
  test('every repo_* and code_* tool is in CODE_TOOLS (D78)', () => {
    const code = allToolNames().filter((n) => /^(repo|code)_/.test(n));
    expect(code.length).toBeGreaterThan(0);
    for (const name of code) expect(CODE_TOOLS).toContain(name);
  });

  test('exports match the generated list', () => {
    expect(allToolNames()).toEqual([...new Set(allToolModules.map((m) => m.name))].sort());
    expect(generatedToolSources().length).toBe(allToolModules.length);
  });

  // Passes with no cases while the list is empty.
  const cases = allToolModules.flatMap((module) =>
    conformanceCases(module).map((c) => ({ module, ...c, label: `${module.name} on ${c.mount}/${c.entity ?? '-'}` })),
  );
  test.each(cases.length > 0 ? cases : [null])('conformance %#', (c) => {
    if (c === null) return;
    const ctx = makeToolContext({ entity: c.entity });
    const created = c.module.create(ctx, c.mount);
    expect({ tool: c.label, problems: conformanceProblems(c.module, created) }).toEqual({ tool: c.label, problems: [] });
  });

  test('every mount builds from the generated list with the fake context', () => {
    for (const entity of ['ssfb', 'atspl', 'rtl'] as const) {
      toolsFor('investigator_deep', makeToolContext({ entity }));
      mountPlan('investigator', makeToolContext({ entity }));
    }
    toolsFor('triage', makeToolContext());
    toolsFor('code_walker', makeToolContext());
    toolsFor('agent', makeToolContext());
    mountPlan('agent', makeToolContext());
  });

  test('every agent-mount name is a module name, and only perEntity tools carry an entity mark', () => {
    const byName = new Map(allToolModules.map((m) => [m.name, m]));
    const built = toolsFor('agent', makeToolContext());
    expect(built.length).toBeGreaterThan(0);
    for (const t of built) {
      expect(t.name).toMatch(TOOL_NAME_PATTERN);
      const module = byName.get(t.name);
      expect({ name: t.name, perEntity: module?.perEntity === true }).toEqual({ name: t.name, perEntity: agentEntitiesOf(t) !== undefined });
      const picked = agentEntitiesOf(t)?.picked === true;
      expect({ name: t.name, entityInput: Object.hasOwn((t.input as unknown as { entries: object }).entries, 'entity') }).toEqual({ name: t.name, entityInput: picked });
    }
  });
});
