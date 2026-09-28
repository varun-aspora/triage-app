import { afterEach, describe, expect, test } from 'bun:test';
import type { ToolDefinition } from '@flue/runtime/tool';
import { makeToolContext } from '../../test/support/fake-tool-context.ts';
import { toolModule as runLogModule } from '../tools/run-log.tool.ts';
import type { ToolContext, ToolDeps } from '../tools/types.ts';
import type { Entity } from '../types/core.ts';
import { ok, refused } from '../types/tool-result.ts';
import { actionBrief, actionsFor, BRIEF_LINES, logActions, releaseActions } from './actions.ts';

const RUN = 'run_actions_0001';
const NOW = new Date('2026-09-28T04:30:18.000Z');
const CUSTOMER = 'c0ffee00-1111-4222-8333-444455556666';
const PHONE = '+919876543210';
const ACCOUNT = '123456789012';
const NAME = 'Ravi Kumar';

afterEach(() => {
  releaseActions(RUN);
});

// Only what logActions reads at call time.
const deps = { run: { redactionNames: [NAME] }, now: () => NOW } as unknown as ToolDeps;

function ctxFor(agent: string, entity: Entity | null): ToolContext {
  return { ...makeToolContext({ runId: RUN, entity }), agent, deps };
}

function fakeTool(name: string, answer: (data: unknown) => unknown): ToolDefinition {
  return { name, description: name, input: {}, run: async ({ data }: { data: unknown }) => answer(data) } as unknown as ToolDefinition;
}

async function callAs(ctx: ToolContext, tool: ToolDefinition, data: unknown, id = 'toolu_1'): Promise<unknown> {
  const [wrapped] = logActions([tool], ctx);
  return (wrapped!.run as (c: unknown) => Promise<unknown>)({ data, toolCallId: id });
}

const sql = fakeTool('sql_select', () => ok({ rows: [{}, {}], row_count: 2, truncated: false, staged_file: '/data/toolu_1.json' }, () => NOW));
const logs = fakeTool('logs_search', () => ok({ hits: [], num_hits: 0 }, () => NOW));
const gate = fakeTool('http_call', () => refused('Refused: POST on this ssfb:harbor path is blocked.', () => NOW));
const note = fakeTool('note_evidence', () => ok({ evidence_id: 'ssfb@v1', version: 1 }, () => NOW));

describe('the action log', () => {
  test('one line per call: time, agent, tool, arguments and outcome, refusal reason and evidence id included', async () => {
    const ssfb = ctxFor('investigate_ssfb', 'ssfb');
    await callAs(ssfb, sql, { service: 'harbor', sql: 'SELECT id FROM users WHERE id = $1', params: [CUSTOMER] });
    await callAs(ssfb, gate, { service: 'harbor', method: 'POST', path: '/x' });
    await callAs(ssfb, note, { summary: 'long findings' });
    const lines = actionBrief(RUN, 'ssfb');
    expect(lines).toContain(
      `- 04:30:18Z investigate_ssfb sql_select {"params":["${CUSTOMER}"],"service":"harbor","sql":"SELECT id FROM users WHERE id = $1"} -> ok rows=2 file=/data/toolu_1.json`,
    );
    expect(lines).toContain(
      '- 04:30:18Z investigate_ssfb http_call {"method":"POST","path":"/x","service":"harbor"} -> refused: Refused: POST on this ssfb:harbor path is blocked.',
    );
    expect(lines).toContain('- 04:30:18Z investigate_ssfb note_evidence -> ok evidence=ssfb@v1');
  });

  test('arguments and outcomes pass the persisted profile: no phone, account number or name survives', async () => {
    const leaky = fakeTool('logs_search', () => refused(`Refused: ${PHONE} for ${NAME} is not in the ID chain.`, () => NOW));
    await callAs(ctxFor('investigate_rtl', 'rtl'), leaky, { message: `${NAME} ${PHONE}`, fields: { account_number: ACCOUNT } });
    const text = JSON.stringify(actionsFor(RUN));
    for (const raw of [PHONE, ACCOUNT, NAME]) expect(text).not.toContain(raw);
    expect(text).toContain('****3210');
  });

  test('a thrown call is logged by error name only and still throws', async () => {
    const boom = fakeTool('sql_select', () => {
      throw new TypeError(`bad ${PHONE}`);
    });
    await expect(callAs(ctxFor('investigate_ssfb', 'ssfb'), boom, {})).rejects.toThrow(TypeError);
    expect(actionsFor(RUN)[0]!.outcome).toBe('error (TypeError)');
  });

  test('the brief keeps the last lines, newest last, and says how many were left out', async () => {
    const ssfb = ctxFor('investigate_ssfb', 'ssfb');
    for (let i = 0; i < BRIEF_LINES + 105; i++) await callAs(ssfb, logs, { message: `m${i}` }, `toolu_${i}`);
    const lines = actionBrief(RUN, 'ssfb');
    // More left out than one run_log page holds: the line says to page.
    expect(lines).toContain('- 105 earlier calls left out; read them with run_log from offset 0 (limit up to 100, then next_offset).');
    const shown = lines.filter((l) => l.includes(' logs_search '));
    expect(shown).toHaveLength(BRIEF_LINES);
    expect(shown.at(-1)).toContain(`m${BRIEF_LINES + 104}`);
    expect(actionBrief('run_actions_none', 'ssfb')).toContain('- none yet');
  });
});

describe('run_log', () => {
  async function seed(): Promise<void> {
    await callAs(ctxFor('triage', null), fakeTool('resolve_identity', () => ok({ ids: {} }, () => NOW)), { phone_number: PHONE });
    await callAs(ctxFor('investigate_ssfb', 'ssfb'), sql, { sql: 'SELECT 1' });
    await callAs(ctxFor('investigate_ssfb', 'ssfb'), logs, { message: 'a' });
    await callAs(ctxFor('investigate_atspl', 'atspl'), sql, { sql: 'SELECT 2' });
    await callAs(ctxFor('code_walker', null), fakeTool('repo_grep', () => ok({ matches: [1] }, () => NOW)), { pattern: 'x' });
  }

  async function page(ctx: ToolContext, input: Record<string, unknown>): Promise<{ total: number; lines: string[]; next_offset?: number }> {
    const tool = runLogModule.create(ctx, 'triage');
    const env = (await (tool.run as (c: unknown) => Promise<{ output: { data: unknown } }>)({ data: input })).output;
    return env.data as { total: number; lines: string[]; next_offset?: number };
  }

  test('filters by tool, agent and entity, and pages oldest first', async () => {
    await seed();
    const root = ctxFor('triage', null);
    expect((await page(root, {})).total).toBe(5);
    expect((await page(root, { tool: 'sql_select' })).lines.map((l) => l.split(' ')[1])).toEqual(['investigate_ssfb', 'investigate_atspl']);
    expect((await page(root, { agent: 'code_walker' })).lines[0]).toContain('repo_grep');
    expect((await page(root, { for_entity: 'atspl' })).total).toBe(1);
    const first = await page(root, { limit: 2 });
    expect(first).toMatchObject({ total: 5, next_offset: 2 });
    const last = await page(root, { offset: 4, limit: 2 });
    expect(last.lines).toHaveLength(1);
    expect(last.next_offset).toBeUndefined();
  });

  test("an investigator sees its own entity's lines and the entity-free ones only", async () => {
    await seed();
    const lines = (await page(ctxFor('investigate_ssfb', 'ssfb'), {})).lines;
    expect(lines).toHaveLength(4);
    expect(lines.join('\n')).not.toContain('investigate_atspl');
    expect(lines.join('\n')).not.toContain(PHONE);
  });

  test('its own calls are not logged', async () => {
    await page(ctxFor('triage', null), {});
    const [wrapped] = logActions([runLogModule.create(ctxFor('triage', null), 'triage')], ctxFor('triage', null));
    await (wrapped!.run as (c: unknown) => Promise<unknown>)({ data: {} });
    expect(actionsFor(RUN)).toHaveLength(0);
  });
});
