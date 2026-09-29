// The worker delegate of the single shape (plan 16 S2.5; D103, D108, D109).
//
// A plain module without the agent directive. workerFor(runId) returns a
// defineSubagent() definition the Triage root mounts when the run's shape is
// single. It replaces investigate_<e>, investigate_<e>_deep and code_walker
// there: the root gives it one narrow job (a bulk read, a count over many
// rows or hits, reading many files to answer one question), and it replies
// with a short result plus the /data files it wrote.
//
// Tools: the agent mount (every enabled entity's '<entity>_<tool>' data
// tools and the shared code, run_log and read_staged tools) minus the tools
// only the root may call: finish_report, ask_requester, stop_blocked,
// resolve_identity and every evidence tool ('<entity>_note_evidence' and the
// code one). Like every delegate body it cannot mount a subagent. Skills: the
// same notes as the single root (rootSkills(..., 'single')). Method text:
// logs.md and logs-<e>.md for the enabled entities, then the '## This worker'
// footer.
//
// Model: MODEL_WORKER when set, else the run's tier model (no override).
// Each task may make TRIAGE_MAX_TOOL_CALLS_PER_WORKER tool calls; later
// calls are refused with the reason, so the worker replies with what it has.
// The run's own budgets still apply to every call, through the pipeline.
// Flue renders a delegate once per task, so the counter is per task.

import { defineSubagent, type SubagentDefinition } from '@flue/runtime';
import type { ToolDefinition } from '@flue/runtime/tool';
import { finishByText, runTimes } from '../../gate/budget.ts';
import { workerModel } from '../../models.ts';
import { actionBrief, logActions } from '../../runlog/actions.ts';
import { ASK_REQUESTER } from '../../tools/ask-requester.tool.ts';
import { FINISH_REPORT } from '../../tools/finish-report.tool.ts';
import { toolsFor } from '../../tools/index.ts';
import { RESOLVE_IDENTITY } from '../../tools/resolve-identity.tool.ts';
import { STOP_BLOCKED } from '../../tools/stop-blocked.tool.ts';
import type { ToolContext } from '../../tools/types.ts';
import { ENTITIES, type RunId } from '../../types/core.ts';
import { refused } from '../../types/tool-result.ts';
import { deployManifestLines } from '../deploy-manifests.ts';
import { logsDocs } from '../instruction.ts';
import { currentKnowledge, methodDoc, rootSkills } from '../skills.ts';
import {
  checkRunId,
  delegateContext,
  FLUE_HOOKS,
  freezeMounts,
  mountAll,
  type DelegateEnv,
  type DelegateHooks,
  type DelegateMounts,
} from './investigator.ts';
// Brings in the ToolDeps fields (now).
import type {} from '../../tools/_lib/context.ts';

export const WORKER_NAME = 'worker';

/** Lines of answer the worker's reply may have; the /data paths and the calls made come after them. */
export const WORKER_REPLY_LINES = 20;

// Only the root ends the run, asks the requester, widens the id chain or records evidence.
const ROOT_ONLY: ReadonlySet<string> = new Set([FINISH_REPORT, ASK_REQUESTER, STOP_BLOCKED, RESOLVE_IDENTITY]);

export type WorkerOptions = {
  readonly env: DelegateEnv;
  readonly hooks?: DelegateHooks;
};

/**
 * The worker subagent definition. Throws DelegateError for a bad run id and
 * the ConfigError from workerModel when MODEL_WORKER is set but unusable.
 */
export function workerFor(runId: RunId, options: WorkerOptions): SubagentDefinition {
  checkRunId(runId);
  const { env } = options;
  const hooks = options.hooks ?? FLUE_HOOKS;
  const model = workerModel(env.config);
  // Rendered fresh at each task, so each task gets its own call counter.
  const agent = (): string => mountAll(workerMounts(runId, { env }), hooks);
  return defineSubagent({
    name: WORKER_NAME,
    description:
      'Does one narrow job with the same data and code tools you have: a bulk read, a count over many rows or log hits, ' +
      'or reading many files to answer one question. It sees only the prompt, so give the job, the ids and window, the /data files ' +
      `to use and the notes to activate. It replies with at most ${WORKER_REPLY_LINES} lines, the /data files it wrote and the calls it made; it cannot record evidence or end the run.`,
    agent,
    ...(model !== undefined ? { model } : {}),
  });
}

/**
 * True for the tools the worker does not get: the root-only ones and every
 * evidence tool (note_evidence, '<entity>_note_evidence' and the code one).
 */
export function rootOnlyTool(name: string): boolean {
  return ROOT_ONLY.has(name) || (name.includes('note_') && name.endsWith('_evidence'));
}

/** The tools, skills and instruction text one worker render (one task) mounts. */
export function workerMounts(runId: RunId, options: { readonly env: DelegateEnv }): DelegateMounts {
  const { env } = options;
  const ctx = delegateContext(runId, null, env, WORKER_NAME);
  const knowledge = env.knowledge ?? currentKnowledge();
  const entities = ENTITIES.filter((e) => env.config.entities.includes(e) && env.registry.isEnabled(e));
  const max = env.config.budgets.maxToolCallsPerWorker;
  const own = toolsFor('agent', ctx).filter((t) => !rootOnlyTool(t.name));
  // Capped inside the log, so a refused call still shows in the run's action log.
  const tools = logActions(capToolCalls(own, max, ctx), ctx);
  const docs = logsDocs(entities).map((file) => methodDoc(file, knowledge));
  const times = runTimes(runId);
  const footer = [
    '## This worker',
    '',
    'You do one job for the Triage agent. The job, its inputs and the notes to activate are in the prompt.',
    '',
    '- Do only that job. Do not widen it or start another line of inquiry; name anything else you noticed in one line of the reply.',
    '- Write bulk output (rows, hits, file lists) to files under /data and read slices of them. Never paste it into the reply.',
    `- Reply with the answer in at most ${WORKER_REPLY_LINES} lines, then the /data file paths you wrote and the tool calls you made (tool and main arguments). Say what you could not check and why.`,
    '- You cannot record evidence, resolve identities, ask the requester or end the run. The Triage agent does that from your reply.',
    `- Entities: ${entities.join(', ')}. Data tools are named <entity>_<tool> (for example ${entities[0] ?? 'rtl'}_sql_select) and each reaches only its entity; its description lists the entity's services.`,
    ...deployManifestLines(env.config, env.registry, entities),
    `- Tool calls allowed in this task: ${max}. Calls past that are refused.`,
    `- Tools mounted: ${tools.map((t) => t.name).join(', ')}.`,
    // D87: data tools are refused from this time on.
    ...(times !== undefined ? [`- ${finishByText(times.dataUntil)}`] : []),
    '',
    ...actionBrief(runId, null),
  ];

  return freezeMounts(tools, rootSkills(entities, knowledge, 'single'), docs, footer);
}

/**
 * Wraps the tools so that, together, they run at most max times; each later
 * call returns a refusal that tells the model to reply with what it has.
 */
export function capToolCalls(tools: readonly ToolDefinition[], max: number, ctx: ToolContext): ToolDefinition[] {
  let calls = 0;
  return tools.map((tool) => {
    const run = tool.run.bind(tool) as (context: never) => unknown;
    return {
      ...tool,
      async run(context: never) {
        calls += 1;
        if (calls > max) {
          return refused(
            `This worker task has used its ${max} tool calls (TRIAGE_MAX_TOOL_CALLS_PER_WORKER). ` +
              'Stop calling tools and reply with what you have, the /data files you wrote and what is left to check.',
            () => ctx.deps.now(),
          );
        }
        return run(context);
      },
    } as ToolDefinition;
  });
}
