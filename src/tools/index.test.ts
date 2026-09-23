import { describe, expect, test } from 'bun:test';
import { defineTool, type ToolDefinition } from '@flue/runtime/tool';
import * as v from 'valibot';
import { FakeDepsAccessError, makeToolContext } from '../../test/support/fake-tool-context.ts';
import type { Entity } from '../types/core.ts';
import { ok } from '../types/tool-result.ts';
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
        void (c.deps as Record<string, unknown>).audit;
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
});

describe('generated tool list', () => {
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
  });
});
