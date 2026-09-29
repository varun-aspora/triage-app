import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SkillDefinition, SubagentDefinition } from '@flue/runtime';
import type { ToolDefinition } from '@flue/runtime/tool';
import { ConfigError } from '../../config/errors.ts';
import { clearRunDeadline, setRunDeadline } from '../../gate/budget.ts';
import { agentEntitiesOf } from '../../tools/agent-entity.ts';
import { allToolModules, FORBIDDEN_INPUT_KEYS, toolsFor } from '../../tools/index.ts';
import { logActions, releaseActions } from '../../runlog/actions.ts';
import type { ToolDeps } from '../../tools/types.ts';
import { ENTITIES, type Entity } from '../../types/core.ts';
import { ok } from '../../types/tool-result.ts';
import { makeTestHome, REPO_ROOT, type TestHome } from '../../../test/support/home.ts';
import { throwingDeps } from '../../../test/support/fake-tool-context.ts';
import { loadKnowledge, rootSkills, type Knowledge } from '../skills.ts';
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
import { capToolCalls, rootOnlyTool, WORKER_NAME, WORKER_REPLY_LINES, workerFor, workerMounts } from './worker.ts';

const STRONG = 'anthropic/claude-opus-4-1';
const CODE_WALKER_SPEC = 'openai/gpt-5';
const RUN = 'run_delegates_0001';
// Not a real key: enabled() only checks that the value is non-blank, and no tool runs here.
const FAKE_ENC_KEY = 'QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFB';

const CODE_TOOLS = ['code_explore', 'code_impact', 'code_node', 'repo_find', 'repo_grep', 'repo_read', 'repo_tree'];
const REPO_TOOLS = ['repo_find', 'repo_grep', 'repo_read', 'repo_tree'];
const CODEGRAPH_TOOLS = ['code_explore', 'code_impact', 'code_node'];
const BASE_TOOLS = ['http_call', 'logs_search', 'note_evidence', 'read_staged', 'run_log', 'sql_select', ...REPO_TOOLS];
const SSFB_ALWAYS = ['detect_silent_reversals', 'get_account_statement'];
const SSFB_FLAGGED = ['decrypt_fields', 'encrypt_lookup_value'];
const ENTITY_IO = ['sql_select', 'http_call', 'logs_search'];

const sorted = (names: readonly string[]): string[] => [...names].sort();
const namesOf = (tools: readonly ToolDefinition[]): string[] => tools.map((t) => t.name);

let knowledge: Knowledge;
let reposDir: string;
const homes: TestHome[] = [];

type HomeOptions = {
  flags?: boolean;
  codeWalker?: string;
  strong?: string;
  worker?: string;
  workerCalls?: number;
  entities?: readonly Entity[];
};

function home(opts: HomeOptions = {}): TestHome {
  const overrides: Record<string, string> = {
    MODEL_TIER_STRONG: opts.strong ?? STRONG,
    TRIAGE_REPOS_DIR: reposDir,
  };
  if (opts.codeWalker !== undefined) overrides.MODEL_CODE_WALKER = opts.codeWalker;
  if (opts.worker !== undefined) overrides.MODEL_WORKER = opts.worker;
  if (opts.workerCalls !== undefined) overrides.TRIAGE_MAX_TOOL_CALLS_PER_WORKER = String(opts.workerCalls);
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

  test('code_walker refuses a TypeSafe decision model as MODEL_CODE_WALKER', () => {
    const env = envOf(home({ codeWalker: 'openrouter/typesafe/jev-1.13' }));
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

    test(`${label}: both variants mount repo_grep and repo_read; deep adds the CodeGraph tools, no duplicates`, () => {
      const env = envOf(home({ flags }));
      for (const e of ENTITIES) {
        const normal = namesOf(investigatorMounts(e, RUN, { env }).tools);
        const deep = namesOf(investigatorMounts(e, RUN, { env, deep: true }).tools);
        expect(new Set(deep).size).toBe(deep.length);
        expect(sorted(deep)).toEqual(sorted([...normal, ...CODEGRAPH_TOOLS]));
        for (const name of REPO_TOOLS) expect(normal).toContain(name);
        for (const name of CODEGRAPH_TOOLS) expect(normal).not.toContain(name);
      }
    });

    test(`${label}: atspl and rtl mount no SSFB-only tool`, () => {
      const env = envOf(home({ flags }));
      const ssfbOnly = allToolModules
        .filter((m) => m.entities !== 'all' && !m.entities.includes('atspl') && !m.entities.includes('rtl'))
        .map((m) => m.name);
      // The crypto tools serve any entity with a field-encryption service (D48); none in atspl or rtl.
      expect(sorted(ssfbOnly)).toEqual(sorted(SSFB_ALWAYS));
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
      expect(sorted(names)).toEqual(sorted([...CODE_TOOLS, 'note_evidence', 'run_log']));
      for (const name of [...ENTITY_IO, ...SSFB_ALWAYS, ...SSFB_FLAGGED, 'resolve_identity', 'finish_report']) {
        expect(names).not.toContain(name);
      }
    });
  }

  test('with TRIAGE_REPOS_DIR blank both variants drop repo_read and repo_grep; deep keeps CodeGraph', () => {
    const h = makeTestHome({ overrides: { MODEL_TIER_STRONG: STRONG, TRIAGE_REPOS_DIR: '' } });
    homes.push(h);
    const env = envOf(h);
    const normal = namesOf(investigatorMounts('atspl', RUN, { env }).tools);
    const deep = namesOf(investigatorMounts('atspl', RUN, { env, deep: true }).tools);
    for (const name of REPO_TOOLS) {
      expect(normal).not.toContain(name);
      expect(deep).not.toContain(name);
    }
    expect(sorted(normal)).toEqual(sorted(ENTITY_IO.concat('note_evidence', 'read_staged', 'run_log')));
    expect(deep).toContain('code_explore');
  });

  test('an investigator repo list holds only its entity pins: rtl gets workflow-op, not harbor', () => {
    const env = envOf(home());
    const repoInput = (e: Entity, deep: boolean): string[] => {
      const tool = investigatorMounts(e, RUN, { env, deep }).tools.find((t) => t.name === 'repo_read');
      const repo = (tool?.input as { entries?: { repo?: { options?: string[] } } } | undefined)?.entries?.repo;
      return [...(repo?.options ?? [])];
    };
    for (const deep of [false, true]) {
      const rtl = repoInput('rtl', deep);
      expect(rtl).toContain('workflow-op');
      expect(rtl).toContain('banking-service');
      expect(rtl).not.toContain('harbor');
      expect(rtl).not.toContain('prod-ssfb-aspora-argo');
      expect(repoInput('ssfb', deep)).toContain('harbor');
      expect(repoInput('ssfb', deep)).not.toContain('banking-service');
    }
  });
});

describe('model-visible schemas', () => {
  // The one nested 'entity' key allowed: a timeline item's source pointer in
  // EntityFindings (src/types/findings.ts EvidenceRefSchema). It labels where
  // an event came from and routes no I/O; the evidence file is still keyed by
  // the closure entity.
  const ALLOWED_NESTED = new Set(['note_evidence:timeline[].source.entity']);

  test("no tool on any delegate takes an 'entity' or 'run_id' input, except the worker's entity picker", () => {
    const env = envOf(home({ flags: true }));
    const sets: [string, readonly ToolDefinition[]][] = [
      ...ENTITIES.flatMap((e): [string, readonly ToolDefinition[]][] => [
        [investigatorName(e), investigatorMounts(e, RUN, { env }).tools],
        [investigatorName(e, true), investigatorMounts(e, RUN, { env, deep: true }).tools],
      ]),
      [CODE_WALKER_NAME, codeWalkerMounts(RUN, { env }).tools],
      [WORKER_NAME, workerMounts(RUN, { env }).tools],
    ];
    let scanned = 0;
    for (const [delegate, tools] of sets) {
      for (const tool of tools) {
        const input = tool.input as { entries?: Record<string, unknown> } | undefined;
        // The agent mount's own entity picker (D110), added by the index; the module's input still has none.
        const picker = agentEntitiesOf(tool)?.picked === true ? 'entity' : undefined;
        const top = Object.keys(input?.entries ?? {}).filter((k) => FORBIDDEN_INPUT_KEYS.includes(k) && k !== picker);
        const nested = schemaPaths(tool.input)
          .filter((p) => FORBIDDEN_INPUT_KEYS.includes(p.split('.').pop() as string) && p !== picker)
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
  test('the instructions end with the calls already made in the run (D79)', async () => {
    const env = envOf(home());
    const runId = 'run_delegates_brief_0001';
    const deps = { run: { redactionNames: [] }, now: () => new Date('2026-09-28T04:30:18.000Z') } as unknown as ToolDeps;
    const tool = { name: 'sql_select', run: async () => ok({ row_count: 3 }) } as unknown as ToolDefinition;
    const call = async (agent: string, entity: Entity | null, sql: string): Promise<void> => {
      const ctx = { runId, entity, agent, config: env.config, registry: env.registry, deps };
      await (logActions([tool], ctx)[0]!.run as (c: unknown) => Promise<unknown>)({ data: { sql }, toolCallId: 't' });
    };
    try {
      expect(investigatorMounts('ssfb', runId, { env }).instructions).toContain('## Already done in this run\n');
      await call('investigate_ssfb', 'ssfb', 'SELECT 1');
      await call('investigate_atspl', 'atspl', 'SELECT 2');
      const ssfb = investigatorMounts('ssfb', runId, { env, deep: true }).instructions;
      expect(ssfb).toEndWith('- 04:30:18Z investigate_ssfb sql_select {"sql":"SELECT 1"} -> ok rows=3\n');
      expect(ssfb).not.toContain('SELECT 2');
      const walker = codeWalkerMounts(runId, { env }).instructions;
      expect(walker).toContain('investigate_atspl sql_select {"sql":"SELECT 2"}');
    } finally {
      releaseActions(runId);
    }
  });

  test('with a recorded deadline the footer says to finish by deadline - 2W (D87)', () => {
    const env = envOf(home());
    const runId = 'run_delegates_deadline_0001';
    expect(investigatorMounts('rtl', runId, { env }).instructions).not.toContain('- Finish by');
    setRunDeadline(runId, Date.parse('2026-09-28T08:15:00Z'), 240_000);
    try {
      expect(investigatorMounts('rtl', runId, { env }).instructions).toContain('\n- Finish by 2026-09-28T08:07:00Z\n');
    } finally {
      clearRunDeadline(runId);
    }
  });

  test('investigator mounts its tools and service notes with useTool and useSkill and returns the method text', () => {
    const env = envOf(home());
    const hooks = recorder();
    const def = investigatorFor('ssfb', RUN, { env, hooks });
    const text = render(def);
    expect(sorted(namesOf(hooks.tools))).toEqual(sorted([...BASE_TOOLS, ...SSFB_ALWAYS]));
    const skillNames = hooks.skills.map((s) => s.name);
    expect(skillNames.length).toBeGreaterThan(1);
    expect(skillNames).toContain('repo-map');
    expect(skillNames).not.toContain('codegraph-limits');
    for (const name of skillNames.filter((n) => n !== 'repo-map')) expect(name.startsWith('ssfb-')).toBe(true);
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
      for (const s of mounts.skills.filter((x) => x.name !== 'repo-map')) expect(s.name.startsWith(`${e}-`)).toBe(true);
      for (const other of ENTITIES.filter((x) => x !== e)) {
        expect(mounts.instructions).not.toContain(`# ${other.toUpperCase()} logs`);
      }
    }
  });

  test('the RTL investigators, and only they, mount the rtl-nri-onboarding journey note', () => {
    const env = envOf(home());
    for (const e of ENTITIES) {
      for (const deep of [false, true]) {
        const names = investigatorMounts(e, RUN, { env, deep }).skills.map((s) => s.name);
        expect(names.includes('rtl-nri-onboarding')).toBe(e === 'rtl');
      }
    }
  });

  test('the deep variant also mounts codegraph-limits; both carry the fallback order', () => {
    const env = envOf(home());
    const deep = investigatorMounts('rtl', RUN, { env, deep: true });
    const normal = investigatorMounts('rtl', RUN, { env });
    expect(deep.skills.map((s) => s.name)).toEqual(expect.arrayContaining(['repo-map', 'codegraph-limits']));
    expect(normal.skills.map((s) => s.name)).not.toContain('codegraph-limits');
    for (const m of [normal, deep]) {
      expect(m.instructions).toContain('## When a source fails or lacks the data');
      const order = ['Read the error', 'Look it up in the code', 'Try another source', 'Only then record the gap'];
      const at = order.map((phrase) => m.instructions.indexOf(phrase));
      expect(at.every((i) => i >= 0)).toBe(true);
      expect([...at].sort((a, b) => a - b)).toEqual(at);
    }
  });

  test('code_walker mounts repo-map, codegraph-limits and frontend-routing and the code-walker method', () => {
    const env = envOf(home());
    const hooks = recorder();
    const text = render(codeWalkerFor(RUN, { env, hooks }));
    expect(sorted(hooks.skills.map((s) => s.name))).toEqual(['codegraph-limits', 'frontend-routing', 'repo-map']);
    expect(sorted(namesOf(hooks.tools))).toEqual(sorted([...CODE_TOOLS, 'note_evidence', 'run_log']));
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
    const ctx = delegateContext(RUN, 'atspl', env, 'investigate_atspl');
    expect(ctx.entity).toBe('atspl');
    expect(ctx.runId).toBe(RUN);
    expect(ctx.agent).toBe('investigate_atspl');
    expect(Object.isFrozen(ctx)).toBe(true);
    expect(delegateContext(RUN, null, env, CODE_WALKER_NAME).entity).toBeNull();
  });
});

describe('worker (single shape, D103)', () => {
  const ROOT_ONLY = ['finish_report', 'ask_requester', 'stop_blocked', 'resolve_identity'];
  const isEvidenceTool = (name: string): boolean => name === 'note_evidence' || name === 'codebase_note_evidence';

  test('the definition is named worker, frozen, and describes the job and the reply', () => {
    const def = workerFor(RUN, { env: envOf(home()) });
    expect(def.name).toBe('worker');
    expect(WORKER_NAME).toBe('worker');
    expect(Object.isFrozen(def)).toBe(true);
    expect(def.description).toContain(`at most ${WORKER_REPLY_LINES} lines, the /data files it wrote and the calls it made`);
    expect(def.description).toContain('/data');
  });

  test('MODEL_WORKER blank: no model override, so the worker inherits the tier model', () => {
    const def = workerFor(RUN, { env: envOf(home({ worker: '' })) });
    expect(Object.hasOwn(def, 'model')).toBe(false);
    expect(Object.hasOwn(def, 'thinkingLevel')).toBe(false);
  });

  test('MODEL_WORKER set: the worker runs on it; a TypeSafe decision model is refused', () => {
    expect(workerFor(RUN, { env: envOf(home({ worker: CODE_WALKER_SPEC })) }).model).toBe(CODE_WALKER_SPEC);
    expect(() => workerFor(RUN, { env: envOf(home({ worker: 'openrouter/typesafe/jev-1.13' })) })).toThrow(ConfigError);
  });

  test('tools: the agent mount minus the ending tools, resolve_identity and every evidence tool', () => {
    const env = envOf(home({ flags: true }));
    const names = namesOf(workerMounts(RUN, { env }).tools);
    const agentMount = namesOf(toolsFor('agent', delegateContext(RUN, null, env, WORKER_NAME)));
    expect(sorted(names)).toEqual(sorted(agentMount.filter((n) => !ROOT_ONLY.includes(n) && !isEvidenceTool(n))));
    for (const name of [...ENTITY_IO, ...CODE_TOOLS, 'run_log', 'read_staged']) expect(names).toContain(name);
    for (const name of ROOT_ONLY) expect(names).not.toContain(name);
    expect(names.filter(isEvidenceTool)).toEqual([]);
    expect(agentMount.filter(isEvidenceTool).length).toBeGreaterThan(0);
    expect(names.filter((n) => /^(ssfb|atspl|rtl)_/.test(n))).toEqual([]);
    expect(new Set(names).size).toBe(names.length);
    // The same one-tool form as the root (D110): sql_select picks among every enabled entity.
    const sql = workerMounts(RUN, { env }).tools.find((t) => t.name === 'sql_select')!;
    expect(agentEntitiesOf(sql)).toEqual({ entities: ENTITIES.filter((e) => env.registry.isEnabled(e)), picked: true });
  });

  test('rootOnlyTool covers the ending tools, resolve_identity and both evidence tools', () => {
    for (const name of [...ROOT_ONLY, 'note_evidence', 'codebase_note_evidence']) {
      expect({ name, off: rootOnlyTool(name) }).toEqual({ name, off: true });
    }
    for (const name of ['sql_select', 'repo_read', 'code_explore', 'run_log', 'read_staged']) {
      expect({ name, off: rootOnlyTool(name) }).toEqual({ name, off: false });
    }
  });

  test('an entity outside TRIAGE_ENTITIES gets no tools, notes or logs note', () => {
    const env = envOf(home({ entities: ['rtl'] }));
    const mounts = workerMounts(RUN, { env });
    const names = namesOf(mounts.tools);
    expect(names).toContain('sql_select');
    const sql = mounts.tools.find((t) => t.name === 'sql_select')!;
    expect(agentEntitiesOf(sql)?.entities).toEqual(['rtl']);
    expect(names).not.toContain('get_account_statement');
    expect(mounts.skills.some((s) => s.name.startsWith('ssfb-') || s.name.startsWith('atspl-'))).toBe(false);
    expect(mounts.instructions).toContain('# RTL logs');
    expect(mounts.instructions).not.toContain('# SSFB logs');
  });

  test('skills are the single root set; the method text is the logs notes and the worker footer', () => {
    const env = envOf(home());
    const hooks = recorder();
    const text = render(workerFor(RUN, { env, hooks }));
    expect(hooks.skills.map((s) => s.name)).toEqual(rootSkills(ENTITIES, knowledge, 'single').map((s) => s.name));
    expect(hooks.tools.length).toBeGreaterThan(10);
    for (const heading of ['# Logs', '# SSFB logs', '# ATSPL logs', '# RTL logs']) expect(text).toContain(heading);
    expect(text).not.toContain('# Investigator');
    expect(text).not.toContain('## This delegate');
  });

  test('the instruction ends with the reply contract, the call limit and the action log', () => {
    const env = envOf(home({ workerCalls: 7 }));
    const text = workerMounts(RUN, { env }).instructions;
    const footer = text.slice(text.indexOf('## This worker'));
    expect(text).toContain('\n## This worker\n');
    expect(footer).toContain('Do only that job');
    expect(footer).toContain('under /data');
    expect(footer).toContain(`Reply with the answer in at most ${WORKER_REPLY_LINES} lines, then the /data file paths you wrote and the tool calls you made`);
    expect(footer).toContain('Tool calls allowed in this task: 7.');
    expect(footer).toContain('- Tools mounted: ');
    expect(footer).toContain('sql_select with entity "ssfb"');
    expect(footer).toContain('sql_select');
    expect(footer).not.toMatch(/\b(ssfb|atspl|rtl)_sql_select\b/);
    expect(footer).toContain('## Already done in this run');
    expect(footer).not.toContain('- Finish by');
  });

  test('with a recorded deadline the footer says to finish by deadline - 2W (D87)', () => {
    const env = envOf(home());
    const runId = 'run_delegates_worker_deadline_0001';
    setRunDeadline(runId, Date.parse('2026-09-28T08:15:00Z'), 240_000);
    try {
      expect(workerMounts(runId, { env }).instructions).toContain('\n- Finish by 2026-09-28T08:07:00Z\n');
    } finally {
      clearRunDeadline(runId);
    }
  });

  test('the per-task cap is shared by all tools and refuses later calls with the reason', async () => {
    const env = envOf(home());
    const now = () => new Date('2026-09-28T04:30:18.000Z');
    const ctx = { runId: RUN, entity: null, agent: WORKER_NAME, config: env.config, registry: env.registry, deps: { now } as unknown as ToolDeps };
    let ran = 0;
    const fake = (name: string) => ({ name, run: async () => (ran++, ok({ name })) }) as unknown as ToolDefinition;
    const call = (t: ToolDefinition): Promise<unknown> => (t.run as (c: unknown) => Promise<unknown>)({ data: {}, toolCallId: 't' });
    const [a, b] = capToolCalls([fake('sql_select'), fake('repo_read')], 2, ctx);
    expect(((await call(a!)) as { output: { status: string } }).output.status).toBe('ok');
    expect(((await call(b!)) as { output: { status: string } }).output.status).toBe('ok');
    const third = (await call(a!)) as { output: { status: string; message: string; taken_at: string } };
    expect(third.output.status).toBe('refused');
    expect(third.output.message).toContain('used its 2 tool calls (TRIAGE_MAX_TOOL_CALLS_PER_WORKER)');
    expect(third.output.message).toContain('reply with what you have');
    expect(third.output.taken_at).toBe('2026-09-28T04:30:18.000Z');
    expect(ran).toBe(2);
    // A new task renders again and gets its own count.
    const [fresh] = capToolCalls([fake('repo_read')], 2, ctx);
    expect(((await call(fresh!)) as { output: { status: string } }).output.status).toBe('ok');
  });

  test('the render calls a deps getter once per task and mounts no subagent', () => {
    let calls = 0;
    const env = envOf(home(), () => {
      calls++;
      return throwingDeps();
    });
    const def = workerFor(RUN, { env, hooks: recorder() });
    expect(calls).toBe(0);
    render(def);
    render(def);
    expect(calls).toBe(2);
    const source = readFileSync(join(import.meta.dir, 'worker.ts'), 'utf8');
    expect(source).not.toMatch(/\buseSubagent\b/);
  });

  test('a bad run id is refused', () => {
    const env = envOf(home());
    expect(() => workerFor('../etc', { env })).toThrow(DelegateError);
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
  const files = ['investigator.ts', 'code-walker.ts', 'worker.ts'].map((f) => ({
    file: f,
    text: readFileSync(join(import.meta.dir, f), 'utf8'),
  }));

  test('no agent directive in any delegate module', () => {
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
