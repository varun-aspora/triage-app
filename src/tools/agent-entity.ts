// The entity of a call on the agent mount (D110). A perEntity module is
// mounted there once under its bare name: with an 'entity' input when it
// serves several entities, or with its one entity fixed (the SSFB-only
// tools). index.ts marks each such tool with the entities it serves; the run
// log, the evidence check and the run section read the mark here. Kept apart
// from index.ts so they can read it without loading every tool module.

import type { ToolDefinition } from '@flue/runtime/tool';
import type { Entity } from '../types/core.ts';

/** The input key that picks the entity of an agent-mount call. */
export const ENTITY_INPUT = 'entity';

/** What an agent-mount tool serves: its entities, and whether the call picks one with ENTITY_INPUT. */
export type AgentEntities = { readonly entities: readonly Entity[]; readonly picked: boolean };

// A symbol, so wrappers that spread a tool ({ ...tool, run }) keep the mark.
const MARK = Symbol('agentEntities');

/** The tool with its mark. */
export function markAgentEntities(tool: ToolDefinition, mark: AgentEntities): ToolDefinition {
  return Object.freeze({ ...tool, [MARK]: Object.freeze({ entities: Object.freeze([...mark.entities]), picked: mark.picked }) });
}

/** The mark of an agent-mount entity tool; undefined for every other tool. */
export function agentEntitiesOf(tool: ToolDefinition): AgentEntities | undefined {
  return (tool as { [MARK]?: AgentEntities })[MARK];
}

/** The entity one call is for: the fixed one, or an ENTITY_INPUT the tool serves. Undefined otherwise. */
export function entityOfCall(mark: AgentEntities | undefined, data: unknown): Entity | undefined {
  if (mark === undefined) return undefined;
  if (!mark.picked) return mark.entities[0];
  const picked = (data as Record<string, unknown> | null | undefined)?.[ENTITY_INPUT];
  return mark.entities.find((e) => e === picked);
}
