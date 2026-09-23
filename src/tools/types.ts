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

export const MOUNTS = ['triage', 'investigator', 'investigator_deep', 'code_walker'] as const;

/**
 * Which agent a tool set is built for. 'investigator_deep' gets every
 * 'investigator' tool plus its own.
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
  /** The investigator's entity; null for the triage and code_walker mounts. */
  readonly entity: Entity | null;
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
  /** Cheap and pure: decides whether the tool is mounted for this context. */
  enabled(ctx: ToolContext, mount: Mount): ToolEnabled;
  /**
   * Builds the tool. `mount` is the set being built, so an 'investigator'
   * module sees 'investigator_deep' when mounted on the deep variant.
   * Must not read ctx.deps; defer that to run().
   */
  create(ctx: ToolContext, mount: Mount): ToolDefinition;
}
