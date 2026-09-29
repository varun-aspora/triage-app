// Tool names on the agent mount (D109). A perEntity module is mounted once
// per enabled entity as '<entity>_<name>'; shared modules keep their name,
// and buildToolIndex refuses a shared name that starts with an entity prefix,
// so a name splits one way only. Kept apart from index.ts so the run log and
// the eval checks can read a name without loading every tool module.

import { ENTITIES, type Entity } from '../types/core.ts';

/** The agent-mount name of a perEntity module built for one entity, e.g. rtl_sql_select. */
export function agentToolName(entity: Entity, name: string): string {
  return `${entity}_${name}`;
}

/** The entity and bare module name of a prefixed name; undefined when the name has no entity prefix. */
export function splitAgentToolName(name: string): { readonly entity: Entity; readonly name: string } | undefined {
  const cut = name.indexOf('_');
  if (cut <= 0 || cut === name.length - 1) return undefined;
  const prefix = name.slice(0, cut);
  const entity = ENTITIES.find((e) => e === prefix);
  return entity === undefined ? undefined : { entity, name: name.slice(cut + 1) };
}

/** The module name behind a tool name: the name without its entity prefix, or the name itself. */
export function bareToolName(name: string): string {
  return splitAgentToolName(name)?.name ?? name;
}
