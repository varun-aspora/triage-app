// The code_walker delegate (HLD §1.4; D11, D37).
//
// A plain module without the agent directive. codeWalkerFor(runId) returns a
// defineSubagent() definition on codeWalkerModel() (MODEL_CODE_WALKER, blank
// falls back to MODEL_TIER_STRONG). The body mounts toolsFor('code_walker'):
// the CodeGraph tools, repo_read, repo_grep and note_evidence, and no entity
// I/O tool. The tool context has no entity; the run id comes by closure.
// Skills are repo-map and codegraph-limits, plus frontend-routing, which
// knowledge/README.md also assigns to code_walker.

import { defineSubagent, type SkillDefinition, type SubagentDefinition } from '@flue/runtime';
import { codeWalkerModel } from '../../models.ts';
import { toolsFor } from '../../tools/index.ts';
import type { RunId } from '../../types/core.ts';
import { codegraphLimitsSkill, currentKnowledge, frontendRoutingSkill, methodDoc, repoMapSkill } from '../skills.ts';
import {
  checkRunId,
  delegateContext,
  FLUE_HOOKS,
  mountAll,
  type DelegateEnv,
  type DelegateHooks,
  type DelegateMounts,
} from './investigator.ts';

export const CODE_WALKER_NAME = 'code_walker';
export const CODE_WALKER_DOC = 'code-walker.md';

export type CodeWalkerOptions = {
  readonly env: DelegateEnv;
  readonly hooks?: DelegateHooks;
};

/**
 * The code_walker subagent definition. Throws DelegateError for a bad run id
 * and the ConfigError from codeWalkerModel when the model keys are unusable.
 */
export function codeWalkerFor(runId: RunId, options: CodeWalkerOptions): SubagentDefinition {
  checkRunId(runId);
  const { env } = options;
  const hooks = options.hooks ?? FLUE_HOOKS;
  const agent = (): string => mountAll(codeWalkerMounts(runId, { env }), hooks);
  return defineSubagent({
    name: CODE_WALKER_NAME,
    description:
      'Reads code in the pinned repos with CodeGraph, repo_grep and repo_read, and records CodeFindings with repo, file and line citations. ' +
      'Use it to explain an error text, log label or state transition from the code. It sees only the brief, so give the question, the repos or services in play and the exact text to explain.',
    agent,
    model: codeWalkerModel(env.config),
  });
}

/** The tools, skills and instruction text one code_walker render mounts. */
export function codeWalkerMounts(runId: RunId, options: { readonly env: DelegateEnv }): DelegateMounts {
  const { env } = options;
  const ctx = delegateContext(runId, null, env);
  const knowledge = env.knowledge ?? currentKnowledge();
  const tools = toolsFor('code_walker', ctx);
  const skills = [
    repoMapSkill(knowledge),
    codegraphLimitsSkill(knowledge),
    frontendRoutingSkill(knowledge),
  ].filter((s): s is SkillDefinition => s !== undefined);

  const doc = methodDoc(CODE_WALKER_DOC, knowledge);
  const footer = [
    '## This delegate',
    '',
    `- Tools mounted: ${tools.map((t) => t.name).join(', ')}.`,
    '- You have no database, API or log tools. If the brief needs runtime data, say so in the reply.',
  ].join('\n');

  return Object.freeze({
    tools: Object.freeze(tools),
    skills: Object.freeze(skills),
    instructions: `${[...(doc ? [doc] : []), footer].join('\n\n')}\n`,
  });
}
