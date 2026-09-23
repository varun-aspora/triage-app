// The investigate_<entity> and investigate_<entity>_deep delegates (HLD §1.2,
// §1.3; D3, D23).
//
// This is a plain module without the agent directive, so the build never
// registers these agent functions as top-level agents. investigatorFor()
// returns a defineSubagent() definition the Triage root mounts once per
// enabled entity.
//
// Entity and run id reach the tools only through the ToolContext built here
// by closure, so no tool schema carries them. The delegate body mounts tools
// and skills with useTool and useSkill and returns its instruction text. It
// uses no other hook: model, sandbox, persistent state and lifecycle hooks
// throw inside a delegate render, and the sandbox is inherited from the root.
//
// The normal variant has no model override and inherits the run's tier
// model. The deep variant runs on MODEL_TIER_STRONG with thinking high and
// also gets the code tools (toolsFor('investigator_deep') is the investigator
// set plus the code tools).

import { defineSubagent, useSkill, useTool, type SkillDefinition, type SubagentDefinition } from '@flue/runtime';
import type { ToolDefinition } from '@flue/runtime/tool';
import * as v from 'valibot';
import type { Config } from '../../config/env.ts';
import type { Registry } from '../../config/registry.ts';
import { modelForTier } from '../../models.ts';
import { toolsFor } from '../../tools/index.ts';
import type { Mount, ToolContext, ToolDeps } from '../../tools/types.ts';
import { EntitySchema, RunIdSchema, type Entity, type RunId } from '../../types/core.ts';
import { currentKnowledge, methodDoc, serviceSkills, type Knowledge } from '../skills.ts';

/** Thinking level of the deep variant (HLD §1.3). */
export const DEEP_THINKING = 'high' as const;

/** What a delegate needs from the run besides entity and run id. */
export type DelegateEnv = {
  readonly config: Config;
  readonly registry: Registry;
  /**
   * The run's ToolDeps, or a getter called at each delegation. Tools read
   * deps only inside run(), so building the tool set never touches them.
   */
  readonly deps: ToolDeps | (() => ToolDeps);
  /** Defaults to the knowledge loaded at boot. */
  readonly knowledge?: Knowledge;
};

/**
 * The two hooks a delegate body may call. Defaults to Flue's. Tests pass
 * recorders so the body can run outside a Flue render.
 */
export type DelegateHooks = {
  readonly useTool: (tool: ToolDefinition) => void;
  readonly useSkill: (skill: SkillDefinition) => void;
};

export const FLUE_HOOKS: DelegateHooks = Object.freeze({
  useTool: (tool: ToolDefinition) => useTool(tool),
  useSkill: (skill: SkillDefinition) => useSkill(skill),
});

/** What one delegate render mounts. */
export type DelegateMounts = {
  readonly tools: readonly ToolDefinition[];
  readonly skills: readonly SkillDefinition[];
  readonly instructions: string;
};

export class DelegateError extends Error {
  override readonly name = 'DelegateError';
}

export type InvestigatorOptions = {
  readonly deep?: boolean;
  readonly env: DelegateEnv;
  readonly hooks?: DelegateHooks;
};

/** investigate_<entity>, or investigate_<entity>_deep. */
export function investigatorName(entity: Entity, deep = false): string {
  return deep ? `investigate_${entity}_deep` : `investigate_${entity}`;
}

/** The knowledge/method files an investigator gets, in order (knowledge/README.md). */
export function investigatorDocs(entity: Entity): readonly string[] {
  return ['investigator.md', 'logs.md', `logs-${entity}.md`];
}

/**
 * The subagent definition for one entity. Throws DelegateError for an entity
 * that is not an id (aliases such as 'shivalik' included), an entity that is
 * not enabled in this deployment, or a bad run id. The deep variant also
 * throws the ConfigError from modelForTier when MODEL_TIER_STRONG is unusable.
 */
export function investigatorFor(entity: Entity, runId: RunId, options: InvestigatorOptions): SubagentDefinition {
  const deep = options.deep === true;
  const { env } = options;
  checkEntity(entity, env);
  checkRunId(runId);
  const hooks = options.hooks ?? FLUE_HOOKS;
  const name = investigatorName(entity, deep);

  // Rendered fresh at each delegation, so a deps getter is read then.
  const agent = (): string => mountAll(investigatorMounts(entity, runId, { deep, env }), hooks);

  return defineSubagent({
    name,
    description: describeInvestigator(entity, deep),
    agent,
    ...(deep ? { model: modelForTier('strong', env.config), thinkingLevel: DEEP_THINKING } : {}),
  });
}

/**
 * The tools, skills and instruction text one investigator render mounts.
 * Pure apart from reading the cached knowledge and calling toolsFor, so it
 * is what the tests check.
 */
export function investigatorMounts(
  entity: Entity,
  runId: RunId,
  options: { readonly deep?: boolean; readonly env: DelegateEnv },
): DelegateMounts {
  const deep = options.deep === true;
  const { env } = options;
  const mount: Mount = deep ? 'investigator_deep' : 'investigator';
  const ctx = delegateContext(runId, entity, env);
  const knowledge = env.knowledge ?? currentKnowledge();
  const services = env.registry.services(entity);
  const notes = serviceSkills(entity, services, knowledge);
  const tools = toolsFor(mount, ctx);

  const docs = investigatorDocs(entity)
    .map((file) => methodDoc(file, knowledge))
    .filter((text): text is string => text !== undefined && text !== '');
  const footer = [
    '## This delegate',
    '',
    `- Entity: ${entity}. Your tools already use it; never pass it.`,
    `- Services in the registry: ${services.length > 0 ? services.join(', ') : 'none'}.`,
    ...(notes.missing.length > 0 ? [`- No service notes yet for: ${notes.missing.join(', ')}.`] : []),
    `- Tools mounted: ${tools.map((t) => t.name).join(', ')}.`,
    ...(deep ? ['- You are the deep variant: use the code tools only to explain what the data and logs show.'] : []),
  ].join('\n');

  return Object.freeze({
    tools: Object.freeze(tools),
    skills: notes.skills,
    instructions: `${[...docs, footer].join('\n\n')}\n`,
  });
}

// ---------------------------------------------------------- shared helpers

/** The T01.6 ToolContext for a delegate. Entity and run id are fixed here, by closure. */
export function delegateContext(runId: RunId, entity: Entity | null, env: DelegateEnv): ToolContext {
  const deps = typeof env.deps === 'function' ? env.deps() : env.deps;
  return Object.freeze({ runId, entity, config: env.config, registry: env.registry, deps });
}

/** Calls the hooks for every tool and skill and returns the instruction text. */
export function mountAll(mounts: DelegateMounts, hooks: DelegateHooks): string {
  for (const tool of mounts.tools) hooks.useTool(tool);
  for (const skill of mounts.skills) hooks.useSkill(skill);
  return mounts.instructions;
}

export function checkRunId(runId: string): void {
  if (!v.is(RunIdSchema, runId)) throw new DelegateError('delegate run id is not a valid run id');
}

function checkEntity(entity: string, env: DelegateEnv): asserts entity is Entity {
  if (!v.is(EntitySchema, entity)) {
    throw new DelegateError(`'${String(entity)}' is not an entity id (ssfb, atspl or rtl)`);
  }
  if (!env.config.entities.includes(entity) || !env.registry.isEnabled(entity)) {
    throw new DelegateError(`entity '${entity}' is not enabled in TRIAGE_ENTITIES`);
  }
}

function describeInvestigator(entity: Entity, deep: boolean): string {
  const who = entity.toUpperCase();
  if (deep) {
    return (
      `Deep investigator for ${who} on the strong model, with the ${entity} tools plus code navigation. ` +
      `Use it when escalation fires or investigate_${entity} came back with low confidence or conflicting evidence. ` +
      'Send a complete brief: entity, question, ids, window, services in play and what to return.'
    );
  }
  return (
    `Investigates one question about ${who} with its admin API, database and log tools, and records EntityFindings. ` +
    'It sees only the brief, so send a complete one: entity, question, ids, window, services in play and what to return.'
  );
}
