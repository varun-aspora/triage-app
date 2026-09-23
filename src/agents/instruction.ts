// The Triage root agent's always-on instruction (HLD §1.1, LLD 04 §2.5).
//
// methodText(init) joins the orchestrator's knowledge/method docs with a
// short fixed rule block and the run's own data: run id, window, enabled
// entities, known ids and a brief skeleton pre-filled with them. It is pure
// and reads only the knowledge cached at boot, so it is safe in a render.

import { ENTITIES, KNOWN_ID_KEYS, type Entity, type KnownIds } from '../types/core.ts';
import type { TriageInit } from '../types/classification.ts';
import { currentKnowledge, type Knowledge } from './skills.ts';

/** knowledge/method files the orchestrator gets, in this order. */
export const ORCHESTRATOR_DOCS = ['orchestrator.md', 'brief-template.md', 'report-format.md'] as const;

/** The brief template fields, in order (LLD 04 §2.5). */
export const BRIEF_FIELDS = ['Entity', 'Question', 'Ids', 'Window', 'Services in play', 'Return'] as const;

export type MethodOptions = {
  /**
   * The run's enabled entities, already narrowed (TRIAGE_ENTITIES narrowed by
   * request.hints.entities). When omitted, request.hints.entities is used.
   */
  readonly entities?: readonly Entity[];
  /** Registry services per entity, shown in the brief skeleton. */
  readonly services?: Partial<Readonly<Record<Entity, readonly string[]>>>;
  /** Defaults to the knowledge loaded at boot. */
  readonly knowledge?: Knowledge;
};

const FIXED_RULES = `## Fixed rules

- Evidence ladder: admin API (when configured), then DB, then logs, then CBS (SSFB only). Read logs before anything else that would repeat a call, and never replay a call to reproduce an issue.
- Confidence: high when two independent sources agree and nothing contradicts them; medium when one source supports the claim and nothing contradicts it; low when the claim rests on inference or sources disagree. Say which it is and why.
- Label every point-in-time read (balances, statuses, current state) with its taken_at timestamp. Current state may have changed since it was read.
- The current ask is the latest message in the thread, not the first.
- Delegates inherit nothing from you. Every brief must carry ${BRIEF_FIELDS.map((f) => f.toLowerCase()).join(', ')}.
- Fan out in parallel: when more than one entity is in play, send one task per entity in a single turn.
- Record what you could not check as a gap instead of guessing, and always end with finish_report.`;

export function methodText(init: TriageInit, options: MethodOptions = {}): string {
  const knowledge = options.knowledge ?? currentKnowledge();
  const docs = ORCHESTRATOR_DOCS.map((name) => knowledge.method.get(name)).filter(
    (text): text is string => text !== undefined && text !== '',
  );
  const entities = enabledFor(init, options.entities);
  const ids = knownIds(init);
  const window = `${init.request.window.from} .. ${init.request.window.to}`;

  const sections = [...docs, FIXED_RULES, runSection(init, entities, ids, window), briefSection(entities, ids, window, options.services)];
  return `${sections.join('\n\n')}\n`;
}

function runSection(init: TriageInit, entities: readonly Entity[], ids: string, window: string): string {
  const entityLine =
    entities.length > 0
      ? `${entities.join(', ')} (each has investigate_<entity> and investigate_<entity>_deep)`
      : 'none were named for this run; brief only the investigate_<entity> subagents you have';
  return [
    '## This run',
    '',
    `- Run id: ${clean(init.request.request_id)}`,
    `- Window: ${window}`,
    `- Enabled entities: ${entityLine}`,
    `- Known ids: ${ids}`,
    `- Tier: ${init.classification.tier_final}`,
  ].join('\n');
}

function briefSection(
  entities: readonly Entity[],
  ids: string,
  window: string,
  services: MethodOptions['services'],
): string {
  const entity = entities.length === 1 ? (entities[0] as Entity) : '<one enabled entity per brief>';
  const inPlay =
    entities.length === 1 && services?.[entities[0] as Entity]?.length
      ? (services[entities[0] as Entity] as readonly string[]).join(', ')
      : '<the services of that entity that matter here>';
  const values: Record<(typeof BRIEF_FIELDS)[number], string> = {
    Entity: entity,
    Question: '<one precise question for that entity>',
    Ids: ids === 'none resolved yet' ? '<the ids that entity can use>' : ids,
    Window: window,
    'Services in play': inPlay,
    Return: 'EntityFindings. <what to quote or count>',
  };
  return [
    '## Brief skeleton for this run',
    '',
    'Fill every field. Narrow the window only with a reason.',
    '',
    '```',
    ...BRIEF_FIELDS.map((field) => `${field}: ${values[field]}`),
    '```',
  ].join('\n');
}

function enabledFor(init: TriageInit, given: readonly Entity[] | undefined): Entity[] {
  const wanted = new Set<string>(given ?? init.request.hints.entities ?? []);
  // Keep the canonical order and drop anything that is not a known entity.
  return ENTITIES.filter((e) => wanted.has(e));
}

function knownIds(init: TriageInit): string {
  // Ids resolved by the identity step win over caller hints.
  const merged: KnownIds = { ...init.request.hints.ids, ...init.id_chain.ids };
  const parts = KNOWN_ID_KEYS.flatMap((key) => {
    const value = merged[key];
    return value === undefined ? [] : [`${key} = ${clean(value)}`];
  });
  return parts.length > 0 ? parts.join(', ') : 'none resolved yet';
}

// Ids come from thread text, so keep them on one line and short: a value
// must not be able to add lines or headings to the instruction.
function clean(value: string): string {
  const flat = value.replace(/[\u0000-\u001f\u007f`]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat;
}
