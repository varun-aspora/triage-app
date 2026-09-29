import { describe, expect, test } from 'bun:test';
import { defineTool, type ToolDefinition } from '@flue/runtime/tool';
import * as v from 'valibot';
import { FakeDepsAccessError, makeToolContext } from '../../test/support/fake-tool-context.ts';
import { CODE_TOOLS } from '../gate/budget.ts';
import type { Entity } from '../types/core.ts';
import { ok } from '../types/tool-result.ts';
import {
  agentToolName,
  allToolModules,
  allToolNames,
  bareToolName,
  buildToolIndex,
  conformanceCases,
  conformanceProblems,
  DuplicateToolNameError,
  generatedToolSources,
  mountPlan,
  ReservedToolNameError,
  splitAgentToolName,
  TOOL_NAME_PATTERN,
  ToolIndexError,
  ToolNameMismatchError,
  toolsFor,
} from './index.ts';
import type { Mount, ToolContext, ToolModule } from './types.ts';

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

describe('the agent mount (D109)', () => {
  const root = (entities = 'ssfb,atspl,rtl'): ToolContext => makeToolContext({ env: { TRIAGE_ENTITIES: entities } });
  const ctx = (entity: Entity): ToolContext => makeToolContext({ entity });
  const agentModules = (): ToolModule[] => [
    fake('sql_select', { mounts: ['investigator', 'agent'], perEntity: true }),
    fake('logs_search', { mounts: ['investigator', 'agent'], perEntity: true }),
    fake('get_account_statement', { mounts: ['investigator', 'agent'], entities: ['ssfb'], perEntity: true }),
    fake('repo_grep', { mounts: ['investigator', 'code_walker', 'agent'] }),
    fake('finish_report', { mounts: ['triage', 'agent'] }),
    fake('investigator_only', { mounts: ['investigator'] }),
  ];

  test('one prefixed set per enabled entity, shared tools once and unprefixed', () => {
    const index = buildToolIndex(agentModules());
    expect(names(index.toolsFor('agent', root()))).toEqual([
      'ssfb_sql_select',
      'atspl_sql_select',
      'rtl_sql_select',
      'ssfb_logs_search',
      'atspl_logs_search',
      'rtl_logs_search',
      'ssfb_get_account_statement',
      'repo_grep',
      'finish_report',
    ]);
  });

  test('only enabled entities get a set, and an ssfb-only module exists only as ssfb_*', () => {
    const index = buildToolIndex(agentModules());
    expect(names(index.toolsFor('agent', root('atspl,rtl')))).toEqual([
      'atspl_sql_select',
      'rtl_sql_select',
      'atspl_logs_search',
      'rtl_logs_search',
      'repo_grep',
      'finish_report',
    ]);
    const all = names(index.toolsFor('agent', root()));
    expect(all.filter((n) => n.endsWith('get_account_statement'))).toEqual(['ssfb_get_account_statement']);
  });

  test('each prefixed tool is built with its entity in the context; shared tools with none', () => {
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

  test('enabled() is asked per entity, and mountPlan has one row per entity and module', () => {
    const index = buildToolIndex([
      fake('decrypt_fields', {
        mounts: ['agent'],
        perEntity: true,
        enabled: (c) => (c.entity === 'ssfb' ? { on: true } : { on: false, reason: `no key for ${String(c.entity)}` }),
      }),
      fake('stop_blocked', { mounts: ['agent'] }),
    ]);
    expect(names(index.toolsFor('agent', root()))).toEqual(['ssfb_decrypt_fields', 'stop_blocked']);
    expect(index.mountPlan('agent', root())).toEqual([
      { name: 'ssfb_decrypt_fields', on: true },
      { name: 'atspl_decrypt_fields', on: false, reason: 'no key for atspl' },
      { name: 'rtl_decrypt_fields', on: false, reason: 'no key for rtl' },
      { name: 'stop_blocked', on: true },
    ]);
  });

  test('the description of a prefixed tool starts with its entity and services', () => {
    const ctx = root();
    const [ssfb, rtl] = buildToolIndex([fake('sql_select', { mounts: ['agent'], perEntity: true, entities: ['ssfb', 'rtl'] })]).toolsFor(
      'agent',
      ctx,
    );
    expect(ssfb!.description).toStartWith('SSFB entity (also called shivalik; services: ');
    expect(ssfb!.description).toEndWith('. fake sql_select');
    expect(rtl!.description).toStartWith(`RTL entity (services: ${ctx.registry.services('rtl').join(', ')}). fake sql_select`);
  });

  test('a prefixed tool keeps the created tool apart from its name and description', () => {
    const created = tool('sql_select');
    const [prefixed] = buildToolIndex([fake('sql_select', { mounts: ['agent'], perEntity: true, create: () => created })]).toolsFor(
      'agent',
      root('rtl'),
    );
    expect(prefixed!.name).toBe('rtl_sql_select');
    expect(prefixed!.input).toBe(created.input);
    expect(prefixed!.run).toBe(created.run);
    expect(Object.isFrozen(prefixed)).toBe(true);
  });

  test('the agent mount refuses a context with an entity', () => {
    const index = buildToolIndex(agentModules());
    expect(() => index.toolsFor('agent', makeToolContext({ entity: 'rtl' }))).toThrow(/without an entity/);
  });

  test('the created name is still checked against the bare module name', () => {
    const index = buildToolIndex([fake('sql_select', { mounts: ['agent'], perEntity: true, created: 'rtl_sql_select' })], {
      sources: ['src/tools/sql-select.tool.ts'],
    });
    expect(() => index.toolsFor('agent', root())).toThrow(ToolNameMismatchError);
  });

  test('two modules under one name clash per entity, even when one is disabled', () => {
    const index = buildToolIndex([
      fake('sql_select', { mounts: ['agent'], perEntity: true }),
      fake('sql_select', { mounts: ['agent'], perEntity: true, enabled: () => ({ on: false, reason: 'off' }) }),
    ]);
    expect(() => index.toolsFor('agent', root())).toThrow(DuplicateToolNameError);
    expect(() => index.mountPlan('agent', root())).toThrow(/duplicate tool name 'ssfb_sql_select' on mount agent/);
  });

  test('a shared name with an entity prefix is refused on every entity-free mount', () => {
    for (const mount of ['agent', 'triage', 'code_walker'] as const) {
      const index = buildToolIndex([fake('rtl_sql_select', { mounts: [mount] })], { sources: ['src/tools/rtl-sql-select.tool.ts'] });
      expect(() => index.toolsFor(mount, root())).toThrow(/rtl-sql-select\.tool\.ts: tool name 'rtl_sql_select' starts with an entity prefix/);
    }
    // An investigator's own tools are not read by prefix, so the name is allowed there.
    expect(names(buildToolIndex([fake('rtl_only')]).toolsFor('investigator', ctx('rtl')))).toEqual(['rtl_only']);
  });

  test('names longer than 64 characters are refused, prefix included', () => {
    const long = `a${'_b'.repeat(29)}x`; // 60 characters: fits bare, not with a prefix
    expect(long).toHaveLength(60);
    const index = buildToolIndex([fake(long, { mounts: ['investigator', 'agent'], perEntity: true })], {
      sources: ['src/tools/long.tool.ts'],
    });
    expect(names(index.toolsFor('investigator', ctx('atspl')))).toEqual([long]);
    expect(() => index.toolsFor('agent', root())).toThrow(/long\.tool\.ts: tool name 'ssfb_a_b.*' is longer than 64 characters/);
    expect(() => buildToolIndex([fake(`a${'b'.repeat(64)}`)]).toolsFor('investigator', ctx('rtl'))).toThrow(/longer than 64/);
  });

  test('other mounts ignore perEntity', () => {
    const index = buildToolIndex([fake('sql_select', { mounts: ['investigator', 'agent'], perEntity: true })]);
    expect(names(index.toolsFor('investigator', ctx('rtl')))).toEqual(['sql_select']);
  });
});

describe('agent tool names', () => {
  test('agentToolName prefixes, and splitAgentToolName and bareToolName undo it', () => {
    expect(agentToolName('rtl', 'sql_select')).toBe('rtl_sql_select');
    expect(splitAgentToolName('rtl_sql_select')).toEqual({ entity: 'rtl', name: 'sql_select' });
    expect(splitAgentToolName('ssfb_note_evidence')).toEqual({ entity: 'ssfb', name: 'note_evidence' });
    expect(bareToolName('atspl_logs_search')).toBe('logs_search');
  });

  test.each(['sql_select', 'repo_grep', 'rtl', 'rtl_', '_rtl_x', 'shivalik_sql_select', 'RTL_sql_select', 'rtlx_sql_select'])(
    '%p has no entity prefix',
    (name) => {
      expect(splitAgentToolName(name)).toBeUndefined();
      expect(bareToolName(name)).toBe(name);
    },
  );
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

  test('every agent-mount name is a shared module name or <entity>_<perEntity module name>', () => {
    const byName = new Map(allToolModules.map((m) => [m.name, m]));
    const built = toolsFor('agent', makeToolContext()).map((t) => t.name);
    expect(built.length).toBeGreaterThan(0);
    for (const name of built) {
      expect(name).toMatch(TOOL_NAME_PATTERN);
      const split = splitAgentToolName(name);
      const module = byName.get(split?.name ?? name);
      expect({ name, perEntity: module?.perEntity === true }).toEqual({ name, perEntity: split !== undefined });
    }
  });
});
