// The tool extension point. An area adds src/tools/**/<name>.tool.ts
// exporting `toolModule: ToolModule`; bun run gen lists it and toolsFor()
// in ./index.ts mounts it. Nothing else needs editing.
//
// Entity and run id reach a tool only through ToolContext (a closure), never
// through its input schema (D3).

import type { ToolDefinition } from '@flue/runtime/tool';
import type { Config } from '../config/env.ts';
import type { Registry } from '../config/registry.ts';
import type { Entity } from '../types/core.ts';

export const MOUNTS = ['triage', 'investigator', 'investigator_deep', 'code_walker', 'agent'] as const;

/**
 * Which agent a tool set is built for. 'investigator_deep' gets every
 * 'investigator' tool plus its own. 'agent' is the single shape (D109): the
 * one Triage agent and its worker.
 */
export type Mount = (typeof MOUNTS)[number];

/**
 * Run dependencies (budget, audit, connectors, ...). Empty here; areas add
 * fields with `declare module '<path>/src/tools/types.ts' { interface ToolDeps { ... } }`.
 * Tools touch deps only inside run(), never in create() or enabled().
 */
export interface ToolDeps {}

export type ToolContext = {
  readonly runId: string;
  /**
   * The entity the tool is built for: the investigator's, or on the agent
   * mount the one a perEntity module was built for. Null for the triage and
   * code_walker mounts and for shared tools on the agent mount.
   */
  readonly entity: Entity | null;
  /** The mounting agent: 'triage' or the delegate's name. For the run action log (D79). */
  readonly agent?: string;
  readonly config: Config;
  readonly registry: Registry;
  readonly deps: ToolDeps;
};

export type ToolEnabled = { readonly on: true } | { readonly on: false; readonly reason: string };

export interface ToolModule {
  /** Model-facing snake_case name. Must equal the created tool's name. */
  readonly name: string;
  readonly mounts: readonly Mount[];
  /** 'all', or the only entities whose investigators get this tool. */
  readonly entities: 'all' | readonly Entity[];
  /**
   * On the agent mount, the module is built once per enabled entity (limited
   * by `entities`), with that entity in ctx.entity, and named '<entity>_<name>'.
   * Audit, budget, scope and fixture keys keep the bare name. Other mounts
   * ignore it.
   */
  readonly perEntity?: true;
  /** Cheap and pure: decides whether the tool is mounted for this context. */
  enabled(ctx: ToolContext, mount: Mount): ToolEnabled;
  /**
   * Builds the tool. `mount` is the set being built, so an 'investigator'
   * module sees 'investigator_deep' when mounted on the deep variant.
   * Must not read ctx.deps; defer that to run().
   */
  create(ctx: ToolContext, mount: Mount): ToolDefinition;
}
