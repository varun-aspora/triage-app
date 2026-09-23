// Doctor check: which tools each agent would get (HLD §7 Doctor).
//
// One ok row per mount lists the tool names toolsFor() mounts: triage and
// code_walker once, and investigator plus investigator_deep's extras per
// enabled entity. Tools that are off get a separate disabled row with the
// reason each module gives, which names env keys only. create() builds the
// tool definitions and never touches run dependencies, so no I/O happens.

import { RegistryError, loadRegistry, type Registry } from '../../config/registry.ts';
import { mountPlan, toolsFor } from '../../tools/index.ts';
import type { Mount, ToolContext, ToolDeps } from '../../tools/types.ts';
import type { Entity } from '../../types/core.ts';
import type { DoctorCheck, DoctorContext, NamedCheck } from './types.ts';

export type ToolListing = {
  readonly toolsFor: (mount: Mount, ctx: ToolContext) => readonly { readonly name: string }[];
  readonly mountPlan: (mount: Mount, ctx: ToolContext) => readonly ({ readonly name: string; readonly on: true } | { readonly name: string; readonly on: false; readonly reason: string })[];
};

declare module './types.ts' {
  interface DoctorContext {
    /** Tool index for the mounted tools check. Defaults to src/tools/index.ts. */
    readonly tools?: ToolListing;
  }
}

const ID = 'tools';
const DOCTOR_RUN_ID = 'doctor';
const ENV_NAME = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/g;

const DEFAULT_LISTING: ToolListing = { toolsFor, mountPlan };

function toolContext(ctx: DoctorContext, registry: Registry, entity: Entity | null): ToolContext {
  return Object.freeze({
    runId: DOCTOR_RUN_ID,
    entity,
    config: ctx.config,
    registry,
    deps: Object.freeze({}) as ToolDeps,
  });
}

const list = (names: readonly string[]): string => (names.length === 0 ? '(none)' : names.join(', '));

function offRow(listing: ToolListing, mount: Mount, tc: ToolContext, entity?: Entity): DoctorCheck | undefined {
  const off = listing.mountPlan(mount, tc).filter((r): r is { name: string; on: false; reason: string } => !r.on);
  if (off.length === 0) return undefined;
  const keys = [...new Set(off.flatMap((r) => r.reason.match(ENV_NAME) ?? []))];
  const message = `${mount} off: ${off.map((r) => `${r.name} (${r.reason})`).join(', ')}`;
  return entity === undefined
    ? { id: ID, status: 'disabled', key_names: keys, message }
    : { id: ID, entity, status: 'disabled', key_names: keys, message };
}

async function mountedTools(ctx: DoctorContext): Promise<DoctorCheck[]> {
  let registry: Registry;
  try {
    registry = ctx.registry ?? loadRegistry(ctx.config);
  } catch (err) {
    // The env check (T11.6) lists registry problems.
    if (!(err instanceof RegistryError)) throw err;
    return [{ id: ID, status: 'skipped', key_names: [], message: 'tools not listed: the entity registry did not load' }];
  }
  const listing = ctx.tools ?? DEFAULT_LISTING;
  const rows: DoctorCheck[] = [];

  for (const mount of ['triage', 'code_walker'] as const) {
    const tc = toolContext(ctx, registry, null);
    const names = listing.toolsFor(mount, tc).map((t) => t.name);
    rows.push({ id: ID, status: 'ok', key_names: [], message: `${mount}: ${list(names)}` });
    const off = offRow(listing, mount, tc);
    if (off !== undefined) rows.push(off);
  }

  for (const entity of registry.enabledEntities()) {
    const tc = toolContext(ctx, registry, entity);
    const base = listing.toolsFor('investigator', tc).map((t) => t.name);
    const deep = listing.toolsFor('investigator_deep', tc).map((t) => t.name).filter((n) => !base.includes(n));
    rows.push({ id: ID, entity, status: 'ok', key_names: [], message: `investigator: ${list(base)}; investigator_deep adds: ${list(deep)}` });
    const off = offRow(listing, 'investigator_deep', tc, entity);
    if (off !== undefined) rows.push(off);
  }
  return rows;
}

export const mountedToolsCheck: NamedCheck = Object.freeze({ id: ID, run: mountedTools });
