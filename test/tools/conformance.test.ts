// T01.6's conformance rules run over the real generated tool list (T05.8):
// every created input is a valibot object with no entity or run id key at any
// depth (D3; the one exception is the entity data label of two shared
// schemas, see ENTITY_LABEL_SCHEMAS), names match their module and file, are
// unique per mount and avoid the names Flue owns. Contexts come from a test home with every gate
// open, so the gated tools are created and checked too.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { defineTool, type ToolDefinition } from '@flue/runtime/tool';
import * as v from 'valibot';
import {
  allToolModules,
  allToolNames,
  conformanceCases,
  conformanceProblems,
  FORBIDDEN_INPUT_KEYS,
  generatedToolSources,
  RESERVED_TOOL_NAMES,
  TOOL_NAME_PATTERN,
  toolsFor,
} from '../../src/tools/index.ts';
import type { Mount, ToolContext, ToolModule } from '../../src/tools/types.ts';
import { ENTITIES, type Entity } from '../../src/types/core.ts';
import { EvidenceRefSchema } from '../../src/types/findings.ts';
import { ReportTimelineItemSchema } from '../../src/types/report.ts';
import { makeToolContext } from '../support/fake-tool-context.ts';
import { makeTestHome, type TestHome } from '../support/home.ts';

/** The T05 tools; the generated list must hold at least these. */
const T05_TOOLS = [
  'sql_select',
  'http_call',
  'logs_search',
  'resolve_identity',
  'note_evidence',
  'get_account_statement',
  'detect_silent_reversals',
  'encrypt_lookup_value',
  'decrypt_fields',
  'cbs_call',
  'code_explore',
  'code_node',
  'code_callers',
  'code_impact',
  'repo_read',
  'repo_grep',
] as const;

const FLUE_RESERVED = [
  'task',
  'activate_skill',
  'read_skill_resource',
  'finish',
  'give_up',
  'read',
  'write',
  'edit',
  'bash',
  'grep',
  'glob',
] as const;

const MOUNTS: readonly Mount[] = ['triage', 'investigator', 'investigator_deep', 'code_walker'];

// ------------------------------------------------------------ schema walk

type SchemaNode = {
  kind?: unknown;
  type?: unknown;
  entries?: Record<string, unknown>;
  wrapped?: unknown;
  item?: unknown;
  items?: unknown;
  options?: unknown;
  pipe?: unknown;
  key?: unknown;
  value?: unknown;
  rest?: unknown;
};

// Two shared schemas carry an `entity` field as a data label, not as a
// parameter: EvidenceRef.entity says which entity a cited source belongs to,
// and ReportTimelineItem.entity labels a row of the cross-entity report
// timeline. The tool's own entity still comes only from the closure (D3), so
// an `entity` key is let through inside exactly these schema objects, by
// identity. A copy, a lookalike or any other nested `entity` is flagged, and
// run_id / runId are flagged everywhere.
const ENTITY_LABEL_SCHEMAS: ReadonlySet<unknown> = new Set([EvidenceRefSchema, ReportTimelineItemSchema]);

type SchemaWalk = {
  /** Forbidden keys, as dotted paths from the input root. */
  readonly forbidden: string[];
  /** `entity` keys let through as data labels, as dotted paths. */
  readonly labels: string[];
};

/**
 * Walks a valibot schema at any depth and lists forbidden keys. Follows object
 * entries, optional/nullable wrappers, arrays, tuples, unions, records and
 * pipes.
 */
function walkSchema(schema: unknown): SchemaWalk {
  const forbidden = new Set<string>();
  const labels = new Set<string>();
  const visit = (node: unknown, path: string, ancestors: readonly unknown[]): void => {
    if (node === null || typeof node !== 'object' || ancestors.includes(node)) return;
    const s = node as SchemaNode;
    if (s.kind !== 'schema') return;
    const seen = [...ancestors, node];
    if (s.entries !== undefined) {
      for (const [key, child] of Object.entries(s.entries)) {
        if (FORBIDDEN_INPUT_KEYS.includes(key)) {
          const labelled = key === 'entity' && path !== 'input' && ENTITY_LABEL_SCHEMAS.has(node);
          (labelled ? labels : forbidden).add(`${path}.${key}`);
        }
        visit(child, `${path}.${key}`, seen);
      }
    }
    for (const child of [s.wrapped, s.item, s.key, s.value, s.rest]) visit(child, path, seen);
    for (const list of [s.items, s.options]) {
      if (Array.isArray(list)) list.forEach((child, i) => visit(child, `${path}[${i}]`, seen));
    }
    // A pipe's first element is the piped schema again, so it keeps the path.
    if (Array.isArray(s.pipe)) for (const child of s.pipe) visit(child, path, seen);
  };
  visit(schema, 'input', []);
  return { forbidden: [...forbidden], labels: [...labels] };
}

const forbiddenKeyPaths = (schema: unknown): string[] => walkSchema(schema).forbidden;

describe('the schema walk', () => {
  // Deny paths: the walk must find a forbidden key wherever it hides.
  test.each([
    ['top level', v.object({ entity: v.string() }), ['input.entity']],
    ['nested object', v.object({ a: v.object({ run_id: v.string() }) }), ['input.a.run_id']],
    ['optional wrapper', v.object({ a: v.optional(v.strictObject({ runId: v.string() })) }), ['input.a.runId']],
    ['array item', v.object({ a: v.array(v.object({ entity: v.string() })) }), ['input.a.entity']],
    ['union option', v.object({ a: v.union([v.string(), v.object({ entity: v.string() })]) }), ['input.a[1].entity']],
    ['record value', v.object({ a: v.record(v.string(), v.object({ run_id: v.string() })) }), ['input.a.run_id']],
    ['pipe', v.object({ a: v.pipe(v.object({ entity: v.string() }), v.description('x')) }), ['input.a.entity']],
    ['tuple item', v.object({ a: v.tuple([v.object({ entity: v.string() })]) }), ['input.a[0].entity']],
  ])('finds a forbidden key in a %s', (_label, schema, expected) => {
    expect(forbiddenKeyPaths(schema)).toEqual(expected);
  });

  test('lets entity through only inside the shared label schemas, by identity', () => {
    expect(walkSchema(v.object({ refs: v.array(EvidenceRefSchema) }))).toEqual({ forbidden: [], labels: ['input.refs.entity'] });
    expect(walkSchema(v.object({ timeline: v.array(ReportTimelineItemSchema) }))).toEqual({
      forbidden: [],
      labels: ['input.timeline.entity', 'input.timeline.source.entity'],
    });
    // A lookalike with the same entries is not the shared schema.
    const lookalike = v.object({ ...EvidenceRefSchema.entries });
    expect(forbiddenKeyPaths(v.object({ refs: v.array(lookalike) }))).toEqual(['input.refs.entity']);
    // run_id is never a label.
    const withRun = v.object({ ref: EvidenceRefSchema, run_id: v.string() });
    expect(walkSchema(withRun)).toEqual({ forbidden: ['input.run_id'], labels: ['input.ref.entity'] });
  });

  test('passes a schema with entity-like but allowed names', () => {
    expect(forbiddenKeyPaths(v.object({ entity_hint: v.optional(v.string()), entities_consulted: v.array(v.string()) }))).toEqual([]);
  });
});

// ------------------------------------------------------------ contexts

let home: TestHome;

beforeAll(() => {
  home = makeTestHome({
    overrides: {
      TRIAGE_REPOS_DIR: '/triage-test/repos',
      SSFB_HARBOR_FIELD_ENC_KEY: 'test-only-field-key-not-a-real-key',
      SSFB_CBS_VIA_KUBECTL_ENABLED: 'true',
    },
  });
});

afterAll(() => home.cleanup());

const ctxFor = (entity: Entity | null): ToolContext =>
  makeToolContext({ config: home.config, registry: home.registry, entity });

function everySet(): { label: string; mount: Mount; tools: ToolDefinition[] }[] {
  const out: { label: string; mount: Mount; tools: ToolDefinition[] }[] = [];
  for (const mount of MOUNTS) {
    const scoped = mount === 'investigator' || mount === 'investigator_deep';
    for (const entity of scoped ? ENTITIES : [null]) {
      out.push({ label: `${mount}/${entity ?? '-'}`, mount, tools: toolsFor(mount, ctxFor(entity)) });
    }
  }
  return out;
}

// ------------------------------------------------------------ the generated list

describe('the generated tool list', () => {
  test('holds at least the T05 tools', () => {
    const listed = allToolNames();
    expect(listed.length).toBeGreaterThanOrEqual(15);
    for (const name of T05_TOOLS) expect(listed).toContain(name);
  });

  test('module names are unique across the list', () => {
    const list = allToolModules.map((m) => m.name);
    expect(list.filter((n, i) => list.indexOf(n) !== i)).toEqual([]);
  });

  test("each module's file is the kebab form of its name, in the folder its scope calls for", () => {
    const sources = generatedToolSources();
    expect(sources.length).toBe(allToolModules.length);
    allToolModules.forEach((m: ToolModule, i) => {
      const source = sources[i] ?? '';
      const file = source.split('/').pop();
      expect({ name: m.name, file }).toEqual({ name: m.name, file: `${m.name.replaceAll('_', '-')}.tool.ts` });
      if (m.entities !== 'all' && m.entities.length === 1 && m.entities[0] === 'ssfb') {
        expect(source).toStartWith('src/tools/ssfb/');
      }
      if (m.name.startsWith('code_') || m.name.startsWith('repo_')) expect(source).toStartWith('src/tools/code/');
    });
  });

  test('no module name is reserved by Flue or breaks snake_case', () => {
    for (const name of FLUE_RESERVED) expect(RESERVED_TOOL_NAMES).toContain(name);
    for (const name of allToolNames()) {
      expect(RESERVED_TOOL_NAMES).not.toContain(name);
      expect(name).toMatch(TOOL_NAME_PATTERN);
    }
  });
});

// ------------------------------------------------------------ per module and case

const cases = allToolModules.flatMap((module) =>
  conformanceCases(module).map((c) => ({ module, ...c, label: `${module.name} on ${c.mount}/${c.entity ?? '-'}` })),
);

describe('conformance per module, mount and entity', () => {
  test('there are cases to run', () => {
    expect(cases.length).toBeGreaterThanOrEqual(T05_TOOLS.length);
  });

  test.each(cases.map((c) => [c.label, c] as const))('%s', (label, c) => {
    const created = c.module.create(ctxFor(c.entity), c.mount);
    expect({ label, problems: conformanceProblems(c.module, created) }).toEqual({ label, problems: [] });
    expect({ label, forbidden: forbiddenKeyPaths(created.input) }).toEqual({ label, forbidden: [] });
  });

  // Deny path: the rules reject what they are there to reject.
  test('a tool with an entity key, a run_id key deep down or a wrong name is flagged', () => {
    const module: ToolModule = {
      name: 'sql_select',
      mounts: ['investigator'],
      entities: 'all',
      enabled: () => ({ on: true }),
      create: () => bad,
    };
    const bad = defineTool({
      name: 'sql_query',
      description: 'fake',
      input: v.object({ entity: v.string(), filter: v.optional(v.object({ run_id: v.string() })) }),
      run: () => 'fake',
    });
    expect(conformanceProblems(module, bad)).toEqual([
      "created name 'sql_query' differs from module name 'sql_select'",
      "input schema has a 'entity' key",
    ]);
    expect(forbiddenKeyPaths(bad.input)).toEqual(['input.entity', 'input.filter.run_id']);
  });
});

// ------------------------------------------------------------ every set toolsFor returns

describe('every set toolsFor returns', () => {
  test('no schema holds an entity or run id key at any depth', () => {
    let walked = 0;
    for (const { label, tools } of everySet()) {
      for (const tool of tools) {
        walked += 1;
        expect({ set: label, tool: tool.name, forbidden: forbiddenKeyPaths(tool.input) }).toEqual({
          set: label,
          tool: tool.name,
          forbidden: [],
        });
      }
    }
    expect(walked).toBeGreaterThan(T05_TOOLS.length);
  });

  // The only entity labels in the real list. A new one fails here, so it is
  // looked at instead of slipping through the allowance.
  const PINNED_LABELS: Readonly<Record<string, readonly string[]>> = {
    note_evidence: ['input.timeline.source.entity'],
    finish_report: ['input.current_state.source.entity', 'input.timeline.entity', 'input.timeline.source.entity'],
  };

  test('entity appears nested only as the pinned data labels', () => {
    for (const { label, tools } of everySet()) {
      for (const tool of tools) {
        const found = walkSchema(tool.input).labels.sort();
        const pinned = PINNED_LABELS[tool.name] ?? [];
        expect({ set: label, tool: tool.name, unpinned: found.filter((p) => !pinned.includes(p)) }).toEqual({
          set: label,
          tool: tool.name,
          unpinned: [],
        });
      }
    }
  });

  test('every tool has a top-level valibot object input', () => {
    for (const { label, tools } of everySet()) {
      for (const tool of tools) {
        const input = tool.input as { kind?: string; type?: string } | undefined;
        expect({ set: label, tool: tool.name, kind: input?.kind, type: input?.type }).toMatchObject({
          set: label,
          tool: tool.name,
          kind: 'schema',
          type: expect.stringMatching(/^(object|strict_object|loose_object)$/),
        });
      }
    }
  });

  test('names are unique per set and none is reserved by Flue', () => {
    for (const { label, tools } of everySet()) {
      const list = tools.map((t) => t.name);
      expect({ set: label, dupes: list.filter((n, i) => list.indexOf(n) !== i) }).toEqual({ set: label, dupes: [] });
      for (const name of list) expect(FLUE_RESERVED as readonly string[]).not.toContain(name);
    }
  });

  test('with every gate open, the sets together cover every T05 tool', () => {
    const union = new Set(everySet().flatMap((s) => s.tools.map((t) => t.name)));
    for (const name of T05_TOOLS) expect(union.has(name)).toBe(true);
  });
});
