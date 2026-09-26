// Agent contract: what each agent is actually given (T06.10; HLD 02 §1.1,
// LLD 04 §2.4, §3; D3, D10, D22, D45).
//
// Boots start({ agents: [Triage] }) with the fake model in strict mock mode,
// and asserts mounting from the tool definitions and skill and agent lists
// rendered into each model call's context, not from the mount functions.

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { codeWalkerMounts } from '../../../src/agents/delegates/code-walker.ts';
import { type DelegateEnv, investigatorMounts } from '../../../src/agents/delegates/investigator.ts';
import { loadKnowledge } from '../../../src/agents/skills.ts';
import { FRAMEWORK_TOOL_NAMES, SANDBOX_TOOL_NAMES } from '../../../src/agents/tripwire.ts';
import { createFakeModel, finish, text, toolCall, toolCalls } from '../../../src/mock/fake-model.ts';
import { ENTITIES, type Entity } from '../../../src/types/core.ts';
import { throwingDeps } from '../../support/fake-tool-context.ts';
import {
  type AgentKey,
  auditLines,
  bootTriage,
  type Booted,
  contractHome,
  type ContractHome,
  createRun,
  KNOWLEDGE_DIR,
  listed,
  nextRunId,
  reportDraft,
  runTriage,
  type SeenCall,
  scriptAgents,
  triageInit,
} from './harness.ts';

const fake = createFakeModel();
// TRIAGE_ENTITIES stays at its default, all three entities.
const home = contractHome(fake);
let narrow: ContractHome | undefined;
let b: Booted;

const TRIAGE_TOOLS = ['ask_requester', 'finish_report', 'note_evidence', 'resolve_identity', 'stop_blocked'];
// The sets T06.6 asserts, with the SSFB flags off (the test home leaves them blank).
// Every investigator reads its own entity's repos; the deep one adds CodeGraph.
const REPO_TOOLS = ['repo_grep', 'repo_read'];
const CODEGRAPH_TOOLS = ['code_explore', 'code_impact', 'code_node'];
const BASE_TOOLS = ['http_call', 'logs_search', 'note_evidence', 'sql_select', ...REPO_TOOLS];
const CODE_TOOLS = [...CODEGRAPH_TOOLS, ...REPO_TOOLS];
const SSFB_ALWAYS = ['detect_silent_reversals', 'get_account_statement'];
const SSFB_ONLY = [...SSFB_ALWAYS, 'cbs_call', 'decrypt_fields', 'encrypt_lookup_value'];
const ENTITY_IO = ['sql_select', 'http_call', 'logs_search'];
const HARNESS_TOOLS = new Set([...SANDBOX_TOOL_NAMES, ...FRAMEWORK_TOOL_NAMES]);

const ALL_DELEGATES = [
  'investigate_ssfb',
  'investigate_ssfb_deep',
  'investigate_atspl',
  'investigate_atspl_deep',
  'investigate_rtl',
  'investigate_rtl_deep',
  'code_walker',
] as const;

const sorted = (names: readonly string[]): string[] => [...names].sort();
/** The typed tools in a call, without the sandbox and framework tools. */
const ownTools = (call: SeenCall): string[] => call.tools.filter((t) => !HARNESS_TOOLS.has(t));
/** The framework tools in a call. */
const frameworkTools = (call: SeenCall): string[] => call.tools.filter((t) => FRAMEWORK_TOOL_NAMES.includes(t));

function expectedDelegateTools(entity: Entity, deep: boolean): string[] {
  const base = entity === 'ssfb' ? [...BASE_TOOLS, ...SSFB_ALWAYS] : BASE_TOOLS;
  return sorted(deep ? [...base, ...CODEGRAPH_TOOLS] : base);
}

function delegateEnv(h: ContractHome): DelegateEnv {
  return { config: h.config, registry: h.registry, deps: throwingDeps(), knowledge: loadKnowledge(KNOWLEDGE_DIR) };
}

/** Runs Triage once with a script that ends in a written report. */
async function reportRun(prefix: string, hints: readonly Entity[] | undefined, script: Parameters<typeof scriptAgents>[1] = {}) {
  const id = nextRunId(prefix);
  const init = triageInit(id, hints === undefined ? {} : { hints });
  await createRun(b.store, init);
  const s = scriptAgents(fake, { triage: [finish(reportDraft(init)), text('report written')], ...script });
  const result = await runTriage(b.Triage, id, init);
  return { id, init, s, result };
}

beforeAll(async () => {
  b = await bootTriage(fake, home);
});

afterAll(async () => {
  await b?.flue.stop();
  home.dispose();
  narrow?.dispose();
});

describe('Triage root', () => {
  test('its model context holds exactly its three tools, the six sandbox tools and the framework tools', async () => {
    const { s, result } = await reportRun('mount_root', undefined);
    expect(result.ok).toBe(true);
    const first = s.callsFor('triage')[0] as SeenCall;
    expect(first.model).toBe('mid');
    expect(sorted(ownTools(first))).toEqual(TRIAGE_TOOLS);
    for (const t of SANDBOX_TOOL_NAMES) expect(first.tools).toContain(t);
    expect(frameworkTools(first)).toContain('task');
    expect(frameworkTools(first)).toContain('activate_skill');
    // Nothing outside the three sets, and no entity I/O on the root.
    expect(first.tools.every((t) => TRIAGE_TOOLS.includes(t) || HARNESS_TOOLS.has(t))).toBe(true);
    for (const t of [...ENTITY_IO, ...SSFB_ONLY, ...CODE_TOOLS]) expect(first.tools).not.toContain(t);
    // No duplicate tool names in the rendered context.
    expect(new Set(first.tools).size).toBe(first.tools.length);
  });

  test('with no hints it lists seven delegates with unique names across three entities, and the overview skills', async () => {
    const { init, s } = await reportRun('mount_names', undefined);
    const system = (s.callsFor('triage')[0] as SeenCall).systemPrompt;
    const agents = listed(system, '## Available Agents');
    expect(agents).toEqual([...ALL_DELEGATES]);
    expect(new Set(agents).size).toBe(agents.length);
    const plan = b.plan.triagePlan(init, home.config, home.registry);
    expect(agents).toEqual([...plan.delegates]);
    expect(listed(system, '## Available Skills')).toEqual(['ssfb-overview', 'atspl-overview', 'rtl-overview', 'patterns', 'frontend-routing']);
  });
});

describe('delegates', () => {
  test("each delegate's model context shows the T06.6 tool set, model and skills", async () => {
    const id = nextRunId('mount_delegates');
    const init = triageInit(id);
    await createRun(b.store, init);
    const brief = 'Entity: x\nQuestion: what happened\nIds: none\nWindow: last week\nServices in play: all\nReturn: findings';
    const delegateSteps = Object.fromEntries(ALL_DELEGATES.map((d) => [d, [text(`${d} has nothing to add`)]]));
    const s = scriptAgents(fake, {
      triage: [
        toolCalls(ALL_DELEGATES.map((agent) => ({ name: 'task', args: { agent, prompt: brief } }))),
        finish(reportDraft(init)),
        text('report written'),
      ],
      ...delegateSteps,
    });

    const result = await runTriage(b.Triage, id, init);

    expect(result.ok).toBe(true);
    expect(s.left()).toEqual(Object.fromEntries(['triage', ...ALL_DELEGATES].map((k) => [k, 0])));
    const env = delegateEnv(home);

    for (const entity of ENTITIES) {
      for (const deep of [false, true]) {
        const key = (deep ? `investigate_${entity}_deep` : `investigate_${entity}`) as AgentKey;
        const calls = s.callsFor(key);
        expect(calls, key).toHaveLength(1);
        const call = calls[0] as SeenCall;
        const mounts = investigatorMounts(entity, id, { deep, env });
        expect(sorted(ownTools(call)), key).toEqual(expectedDelegateTools(entity, deep));
        expect(sorted(ownTools(call)), key).toEqual(sorted(mounts.tools.map((t) => t.name)));
        if (entity !== 'ssfb') for (const t of SSFB_ONLY) expect(call.tools, key).not.toContain(t);
        for (const t of SANDBOX_TOOL_NAMES) expect(call.tools, key).toContain(t);
        // The normal variant inherits the run's tier; the deep one runs on the strong tier.
        expect(call.model, key).toBe(deep ? 'strong' : 'mid');
        expect(listed(call.systemPrompt, '## Available Skills'), key).toEqual(mounts.skills.map((sk) => sk.name));
        expect(call.systemPrompt, key).not.toContain('## Fixed rules');
      }
    }

    const walker = s.callsFor('code_walker');
    expect(walker).toHaveLength(1);
    const call = walker[0] as SeenCall;
    const mounts = codeWalkerMounts(id, { env });
    expect(sorted(ownTools(call))).toEqual(sorted([...CODE_TOOLS, 'note_evidence']));
    expect(sorted(ownTools(call))).toEqual(sorted(mounts.tools.map((t) => t.name)));
    for (const t of [...ENTITY_IO, ...SSFB_ONLY]) expect(call.tools).not.toContain(t);
    expect(call.model).toBe('strong');
    expect(listed(call.systemPrompt, '## Available Skills')).toEqual(mounts.skills.map((sk) => sk.name));
    expect(listed(call.systemPrompt, '## Available Skills')).toEqual(['repo-map', 'codegraph-limits', 'frontend-routing']);
  });
});

describe('entity focus', () => {
  test('hints.entities=[atspl] still mounts every enabled entity and names atspl as the start', async () => {
    const { s, result } = await reportRun('mount_hint_atspl', ['atspl']);
    expect(result.ok).toBe(true);
    const first = s.callsFor('triage')[0] as SeenCall;
    expect(listed(first.systemPrompt, '## Available Agents')).toEqual([...ALL_DELEGATES]);
    expect(listed(first.systemPrompt, '## Available Skills')).toEqual(['ssfb-overview', 'atspl-overview', 'rtl-overview', 'patterns', 'frontend-routing']);
    expect(first.systemPrompt).toContain('- Named in the request: atspl.');
    // The focus changes the instruction only; the root's own tools stay the same.
    expect(sorted(ownTools(first))).toEqual(TRIAGE_TOOLS);
  });

  test('a run hinted at ssfb can follow up with the rtl and atspl investigators', async () => {
    const id = nextRunId('mount_follow_up');
    const init = triageInit(id, { hints: ['ssfb'] });
    await createRun(b.store, init);
    const brief = (entity: string) => `Entity: ${entity}\nQuestion: is the form stuck here?\nIds: none\nWindow: last week\nServices in play: workflow\nReturn: findings`;
    const s = scriptAgents(fake, {
      triage: [
        toolCall('task', { agent: 'investigate_ssfb', prompt: brief('ssfb') }),
        toolCalls([
          { name: 'task', args: { agent: 'investigate_rtl', prompt: brief('rtl') } },
          { name: 'task', args: { agent: 'investigate_atspl', prompt: brief('atspl') } },
        ]),
        finish(reportDraft(init)),
        text('report written'),
      ],
      investigate_ssfb: [text('harbor shows the form waiting on workflow-op; check rtl')],
      investigate_rtl: [text('rtl workflow-op has the step failed')],
      investigate_atspl: [text('no welcome letter was requested')],
    });

    const result = await runTriage(b.Triage, id, init);

    expect(result.ok).toBe(true);
    expect(s.left()).toEqual({ triage: 0, investigate_ssfb: 0, investigate_rtl: 0, investigate_atspl: 0 });
    for (const key of ['investigate_ssfb', 'investigate_rtl', 'investigate_atspl'] as const) expect(s.callsFor(key)).toHaveLength(1);
    expect(fake.failures()).toEqual([]);
  });

  describe('with TRIAGE_ENTITIES=ssfb,atspl', () => {
    beforeAll(() => {
      narrow = contractHome(fake, { entities: ['ssfb', 'atspl'], exportHome: false });
      b.use(narrow);
    });

    afterAll(() => {
      b.use(home);
    });

    test('with no hints only the enabled entities are mounted', async () => {
      const { s } = await reportRun('mount_narrow_all', undefined);
      const system = (s.callsFor('triage')[0] as SeenCall).systemPrompt;
      expect(listed(system, '## Available Agents')).toEqual([
        'investigate_ssfb',
        'investigate_ssfb_deep',
        'investigate_atspl',
        'investigate_atspl_deep',
        'code_walker',
      ]);
    });

    test('a hint for an entity outside TRIAGE_ENTITIES mounts nothing extra and is not the focus', async () => {
      const only = await reportRun('mount_narrow_rtl', ['rtl']);
      expect(only.result.ok).toBe(true);
      const system = (only.s.callsFor('triage')[0] as SeenCall).systemPrompt;
      expect(listed(system, '## Available Agents')).toEqual([
        'investigate_ssfb',
        'investigate_ssfb_deep',
        'investigate_atspl',
        'investigate_atspl_deep',
        'code_walker',
      ]);
      expect(listed(system, '## Available Skills')).toEqual(['ssfb-overview', 'atspl-overview', 'patterns', 'frontend-routing']);
      expect(system).not.toContain('investigate_rtl');
      expect(system).toContain('- Named in the request: none.');

      const mixed = await reportRun('mount_narrow_mixed', ['atspl', 'rtl']);
      const mixedSystem = (mixed.s.callsFor('triage')[0] as SeenCall).systemPrompt;
      expect(mixedSystem).toContain('- Named in the request: atspl.');
      expect(mixedSystem).not.toContain('investigate_rtl');
    });

    test('a task to a delegate that is not mounted is refused and no model call reaches it', async () => {
      const id = nextRunId('mount_narrow_task');
      const init = triageInit(id, { hints: ['rtl'] });
      await createRun(b.store, init);
      const s = scriptAgents(fake, {
        triage: [
          toolCall('task', { agent: 'investigate_rtl', prompt: 'Entity: rtl\nQuestion: anything?' }),
          finish(reportDraft(init)),
          text('report written'),
        ],
      });

      const result = await runTriage(b.Triage, id, init);

      expect(result.ok).toBe(true);
      expect(s.callsFor('investigate_rtl')).toHaveLength(0);
      const second = s.callsFor('triage')[1] as SeenCall;
      const task = second.toolResults.find((r) => r.toolName === 'task');
      // Flue answers with a plain text refusal that names what is available.
      expect(task?.text).toContain('"investigate_rtl" is not declared');
      expect(task?.text).toContain(
        'Available subagents: investigate_ssfb, investigate_ssfb_deep, investigate_atspl, investigate_atspl_deep, code_walker.',
      );
      expect(fake.failures()).toEqual([]);
    });
  });
});

test('every audit line written in this file has transport mock', () => {
  const lines = [...auditLines(home), ...(narrow ? auditLines(narrow) : [])];
  expect(lines.length).toBeGreaterThan(0);
  expect(lines.filter((l) => l.transport !== 'mock')).toEqual([]);
});
