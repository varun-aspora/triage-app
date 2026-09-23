// Faux routing spike (T10.4). Finds which signal tells the calling agent
// apart, the system prompt or the tool set, and checks that fauxScript()
// routes on it. The result is written in the header of
// src/evals/contract/faux-script.ts.
//
// Runs through the eval driver: an eval home, the fake model, strict mock
// mode and no network.

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { synthesisPrompt } from '../../src/agents/synthesis.ts';
import { checkNoRealIo } from '../../src/evals/audit-gates.ts';
import {
  callerOf,
  type FauxCall,
  type FauxCaller,
  fauxScript,
  PROMPT_MARKERS,
  ROUTING_SIGNAL,
  SYNTHESIS_MARK,
} from '../../src/evals/contract/faux-script.ts';
import { bootEvalRuntime, runCase, stopEvalRuntime } from '../../src/evals/driver.ts';
import { createFakeModel, FakeModelError, finish, text, toolCall, toolCalls } from '../../src/mock/fake-model.ts';
import { brief, evalHome, findings, minimalCase, reportDraft } from './eval-support.ts';

const fake = createFakeModel();
const home = evalHome();

beforeAll(async () => {
  await bootEvalRuntime({ faux: fake });
});

afterAll(async () => {
  await stopEvalRuntime();
  home.dispose();
});

const DELEGATES = ['investigate_ssfb', 'investigate_ssfb_deep', 'investigate_atspl', 'investigate_rtl', 'code_walker'] as const;
const replyOf = (d: string): string => `<reply from="${d}">`;
const only = (calls: readonly FauxCall[], caller: FauxCaller): FauxCall => {
  const hits = calls.filter((c) => c.caller === caller);
  expect(hits, caller).toHaveLength(1);
  return hits[0] as FauxCall;
};
const first = (calls: readonly FauxCall[], caller: FauxCaller): FauxCall => {
  const hit = calls.find((c) => c.caller === caller);
  expect(hit, caller).toBeDefined();
  return hit as FauxCall;
};

describe('delegates started in parallel', () => {
  let calls: readonly FauxCall[];
  let status: string;
  let rootTaskResults: string[];

  beforeAll(async () => {
    const c = minimalCase('spike-parallel', 'mid');
    const result = await runCase(c, {
      turns: {
        root: [
          toolCalls(DELEGATES.map((agent) => ({ name: 'task', args: { agent, prompt: brief(agent) } }))),
          finish(reportDraft('mid')),
          text('report written'),
        ],
        ...Object.fromEntries(DELEGATES.map((d) => [d, [text(replyOf(d))]])),
      },
    });
    status = result.status;
    calls = result.model_calls;
    const second = calls.filter((x) => x.caller === 'root')[1];
    rootTaskResults = (second?.toolResults ?? []).filter((r) => r.toolName === 'task').map((r) => r.text);
    expect(checkNoRealIo(result.audit).ok).toBe(true);
  });

  test('a turn scripted for investigate_ssfb is consumed by that delegate, not the root', () => {
    expect(status).toBe('completed');
    const ssfb = only(calls, 'investigate_ssfb');
    expect(ssfb.systemPrompt).toContain('- Entity: ssfb. ');
    expect(ssfb.systemPrompt).not.toContain(PROMPT_MARKERS.deep);
    // The root used exactly its own three turns and got the ssfb reply back as a task result.
    expect(calls.filter((x) => x.caller === 'root')).toHaveLength(3);
    expect(rootTaskResults.some((t) => t.includes(replyOf('investigate_ssfb')))).toBe(true);
    // Each delegate's reply came back to the root once, so no turn went to the wrong queue.
    for (const d of DELEGATES) expect(rootTaskResults.filter((t) => t.includes(replyOf(d))), d).toHaveLength(1);
    expect(fake.failures()).toEqual([]);
  });

  test('spike: the system prompt tells every caller apart', () => {
    const prompts = ['root', 'classifier', ...DELEGATES].map((k) => first(calls, k as FauxCaller).systemPrompt);
    expect(new Set(prompts).size).toBe(prompts.length);
    const root = first(calls, 'root').systemPrompt;
    expect(root).toContain(PROMPT_MARKERS.rootRules);
    expect(root).toContain(PROMPT_MARKERS.rootBrief);
    expect(only(calls, 'code_walker').systemPrompt).toContain(PROMPT_MARKERS.codeWalker);
    expect(only(calls, 'investigate_ssfb_deep').systemPrompt).toContain(PROMPT_MARKERS.deep);
    expect(ROUTING_SIGNAL).toBe('system_prompt');
  });

  test('spike: the tool set does not tell every caller apart', () => {
    // atspl and rtl investigators are given the same tools, so a tool-set route cannot separate them.
    expect(only(calls, 'investigate_atspl').tools).toEqual(only(calls, 'investigate_rtl').tools);
    expect(only(calls, 'investigate_atspl').systemPrompt).not.toBe(only(calls, 'investigate_rtl').systemPrompt);
  });
});

describe('harness.prompt synthesis', () => {
  let calls: readonly FauxCall[];
  let escalated: boolean | undefined;

  beforeAll(async () => {
    const c = minimalCase('spike-synthesis', 'cheap');
    const draft = reportDraft('cheap');
    const result = await runCase(c, {
      turns: {
        root: [toolCall('task', { agent: 'investigate_ssfb', prompt: brief('ssfb') }), finish(draft), text('report written')],
        investigate_ssfb: [toolCall('note_evidence', findings('low')), text('recorded, low confidence')],
        synthesis: [toolCall('finish', { ...draft, confidence: 'low', confidence_reason: 'rebuilt by the strong synthesis' })],
      },
    });
    expect(result.status).toBe('completed');
    calls = result.model_calls;
    escalated = result.report?.escalated;
  });

  test('spike: harness.prompt runs with the root system prompt, so it is routed by its user text', () => {
    const synthesis = only(calls, 'synthesis');
    expect(synthesis.model).toBe('strong');
    expect(synthesis.systemPrompt).toBe(first(calls, 'root').systemPrompt);
    expect(synthesis.userTexts.some((t) => t.startsWith(SYNTHESIS_MARK))).toBe(true);
    expect(escalated).toBe(true);
  });

  test('the synthesis mark is the first line of the synthesis prompt', () => {
    const prompt = synthesisPrompt({ draft: reportDraft('cheap') as never, evidence: [], reasons: [] });
    expect(prompt.split('\n')[0]).toBe(SYNTHESIS_MARK);
  });
});

describe('router refusals', () => {
  test('an unknown caller key is refused when the script is built', () => {
    expect(() => fauxScript({ investigate_nobody: [text('x')] } as never)).toThrow(FakeModelError);
  });

  test('a prompt from an unknown agent is refused', () => {
    expect(() => callerOf({ systemPrompt: 'You are some other agent.', messages: [] })).toThrow(FakeModelError);
  });

  test('a delegate prompt with no entity is refused', () => {
    expect(() => callerOf({ systemPrompt: `${PROMPT_MARKERS.delegate}\n- Tools mounted: none.`, messages: [] })).toThrow(
      /names no entity/,
    );
  });

  test('a caller with no turns left fails with a fake model error', async () => {
    const c = minimalCase('spike-exhausted', 'mid');
    const result = await runCase(c, { turns: { root: [] } });
    expect(result.status).toBe('failed');
    expect(result.report).toBeNull();
    expect(result.faux_failures.some((f) => f.includes('no scripted turn left for root'))).toBe(true);
    expect(result.model_calls.filter((x) => x.caller === 'root').length).toBeGreaterThan(0);
  });
});
