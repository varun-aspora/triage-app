// The Triage root agent's always-on instruction (HLD §1.1, LLD 04 §2.5).
//
// methodText(init) joins the orchestrator's knowledge/method docs with a
// short fixed rule block and the run's own data: run id, window, enabled
// entities, the entities the request names, known ids, the classification,
// the id chain's hops and a brief skeleton pre-filled with the ids. It is pure
// and reads only the knowledge cached at boot, so it is safe in a render.
// When ingress matched a known pattern, a lead section carries that
// pattern's first queries for the briefs, marked as a lead to test (D80).
//
// The single shape (D109) has one agent with every entity's tools and no
// briefs: agent.md, report-format.md and the logs notes of the enabled
// entities, the fixed rules without the delegate lines, a '## One agent'
// section, and a run section that lists the tools each entity has (one tool
// per capability with an entity input, D110). The split text stays exactly
// as it was.
//
// When the scout ran before dispatch (plan 15 P4), both shapes' run sections
// carry its masked lines: where each intake id was counted, counts only.

import { parsePatterns, type Pattern } from '../classify/patterns.ts';
import type { AgentShape } from '../config/env.ts';
import { finishByText } from '../gate/budget.ts';
import { ENTITIES, KNOWN_ID_KEYS, type Entity, type KnownIds } from '../types/core.ts';
import type { TriageInit } from '../types/classification.ts';
import { currentKnowledge, type Knowledge } from './skills.ts';

/** knowledge/method files the orchestrator gets, in this order. */
export const ORCHESTRATOR_DOCS = ['orchestrator.md', 'brief-template.md', 'report-format.md'] as const;

/** knowledge/method files the single agent starts with; the logs notes follow (D109). */
export const AGENT_DOCS = ['agent.md', 'report-format.md'] as const;

/** logs.md, then logs-<entity>.md per given entity, in the given order. The single agent and its worker read these. */
export function logsDocs(entities: readonly Entity[]): string[] {
  return ['logs.md', ...entities.map((e) => `logs-${e}.md`)];
}

/** The knowledge/method files a shape's root gets, in order. Single adds logs.md and logs-<entity>.md per enabled entity. */
export function methodDocsFor(shape: AgentShape, entities: readonly Entity[] = ENTITIES): string[] {
  if (shape === 'split') return [...ORCHESTRATOR_DOCS];
  return [...AGENT_DOCS, ...logsDocs(canonical(entities))];
}

/**
 * The entity tools of the single agent (D109, D110), each mounted once with
 * an entity input, in the order the run section lists them. Some are there
 * only where configured.
 */
export const ENTITY_TOOLS = ['sql_select', 'logs_search', 'http_call', 'encrypt_lookup_value', 'decrypt_fields', 'note_evidence'] as const;
/** Mounted on SSFB only. */
export const SSFB_ONLY_TOOLS = ['get_account_statement', 'detect_silent_reversals'] as const;

/** The brief template fields, in order (LLD 04 §2.5). */
export const BRIEF_FIELDS = ['Entity', 'Question', 'Ids', 'Window', 'Services in play', 'Return'] as const;

export type MethodOptions = {
  /** The run's enabled entities, each with its investigators or, in single, its tools. Defaults to every entity. */
  readonly entities?: readonly Entity[];
  /**
   * The enabled entities the request names, where the root starts. Defaults
   * to request.hints.entities kept to the enabled ones.
   */
  readonly focus?: readonly Entity[];
  /** Registry services per entity, shown in the brief skeleton. */
  readonly services?: Partial<Readonly<Record<Entity, readonly string[]>>>;
  /** Deploy manifests lines from deployManifestLines, one per enabled entity. */
  readonly deployManifests?: readonly string[];
  /** Defaults to the knowledge loaded at boot. */
  readonly knowledge?: Knowledge;
  /** D87: epoch ms the root must finish by (deadline - W). Left out: no finish-by line. */
  readonly finishBy?: number;
  /** The run's agent shape (D109). Defaults to split. */
  readonly shape?: AgentShape;
  /**
   * Single shape: the entity tools mounted per entity, as the run section
   * lists them. Defaults to ENTITY_TOOLS (plus SSFB_ONLY_TOOLS on SSFB).
   */
  readonly entityTools?: Partial<Readonly<Record<Entity, readonly string[]>>>;
};

const COMMON_RULES = [
  '- Evidence: no fixed order of sources. Logs and DB reads first, with code alongside to learn table, field and log message names; an admin API only for live state the DB does not hold, and only where one is configured; CBS on SSFB only. Read logs before anything else that would repeat a call, and never replay a call to reproduce an issue.',
  '- Confidence: high when two independent sources agree and nothing contradicts them; medium when one source supports the claim and nothing contradicts it; low when the claim rests on inference or sources disagree. Say which it is and why.',
  '- Label every point-in-time read (balances, statuses, current state) with its taken_at timestamp. Current state may have changed since it was read.',
  '- The current ask is the latest message in the thread, not the first.',
];

// Split only: the single shape has no delegates and no briefs.
const DELEGATE_RULES = [
  `- Delegates inherit nothing from you. Every brief must carry ${BRIEF_FIELDS.map((f) => f.toLowerCase()).join(', ')}.`,
  '- Fan out in parallel: when more than one entity is in play, send one task per entity in a single turn.',
];

const ENDING_RULE =
  '- Record what you could not check as a gap instead of guessing, and end with finish_report. The two other ways to end a turn are ask_requester, for something only the person who started the run can provide, and stop_blocked, when a tool result said a system did not answer and the investigation cannot go on without it; after either call, stop. A system that is not needed for the current ask is a gap in the report, not a block.';

const rulesText = (lines: readonly string[]): string => ['## Fixed rules', '', ...lines].join('\n');

const FIXED_RULES = rulesText([...COMMON_RULES, ...DELEGATE_RULES, ENDING_RULE]);
const SINGLE_RULES = rulesText([...COMMON_RULES, ENDING_RULE]);

// The test routers tell the single root from the split one by this heading.
const ONE_AGENT = [
  '## One agent',
  '',
  '- You are the only agent in this run. There are no investigators to brief: you read every enabled entity yourself with the data tools, listed per entity under This run.',
  '- A data tool takes the entity to query, such as `logs_search` with `entity: "rtl"`; the notes name the tools the same way, without the entity. The SSFB-only tools take no entity. Where a note mentions an investigator, a delegate or a brief, read it as you and your own plan.',
  '- The one subagent is `worker`, reached with `task`, for bulk jobs.',
].join('\n');

export function methodText(init: TriageInit, options: MethodOptions = {}): string {
  const knowledge = options.knowledge ?? currentKnowledge();
  const shape = options.shape ?? 'split';
  const entities = canonical(options.entities ?? ENTITIES);
  const docs = methodDocsFor(shape, entities)
    .map((name) => knowledge.method.get(name))
    .filter((text): text is string => text !== undefined && text !== '');
  const focus = canonical(options.focus ?? init.request.hints.entities ?? []).filter((e) => entities.includes(e));
  const ids = knownIds(init);
  const window = `${init.request.window.from} .. ${init.request.window.to}`;
  const toolLines = shape === 'single' ? entityToolLines(entities, options.entityTools) : undefined;
  const run = runSection(init, entities, focus, ids, window, options.deployManifests ?? [], options.finishBy, toolLines);

  const sections =
    shape === 'split'
      ? [
          ...docs,
          FIXED_RULES,
          run,
          ...leadSection(init, knowledge, entities, shape),
          briefSection(focus.length > 0 ? focus : entities, ids, window, options.services),
        ]
      : [...docs, SINGLE_RULES, ONE_AGENT, run, ...leadSection(init, knowledge, entities, shape)];
  return `${sections.join('\n\n')}\n`;
}

// Single shape: one line per enabled entity with the tools that reach it.
function entityToolLines(entities: readonly Entity[], given: MethodOptions['entityTools']): string[] {
  return entities.map((e) => {
    const names = given?.[e] ?? [...ENTITY_TOOLS, ...(e === 'ssfb' ? SSFB_ONLY_TOOLS : [])];
    return `  - ${e}: ${names.map(clean).join(', ')}`;
  });
}

function runSection(
  init: TriageInit,
  entities: readonly Entity[],
  focus: readonly Entity[],
  ids: string,
  window: string,
  deployManifests: readonly string[],
  finishBy: number | undefined,
  // Single shape only: the tool line of each enabled entity.
  toolLines: readonly string[] | undefined,
): string {
  const single = toolLines !== undefined;
  const splitLine =
    entities.length > 0
      ? `${entities.join(', ')} (each has investigate_<entity> and investigate_<entity>_deep)`
      : 'none; you have only code_walker';
  const singleLine =
    entities.length > 0
      ? `${entities.join(', ')}. The tools that reach each one, called with that entity; some are there only where configured:`
      : 'none; you have only the code tools';
  const entityLine = single ? singleLine : splitLine;
  const focusLine =
    focus.length > 0
      ? `${focus.join(', ')}. Start there, and ${single ? 'read' : 'brief'} any other enabled entity when the evidence points to it.`
      : 'none. Pick the entities from the category, the id chain and its basic state.';
  return [
    '## This run',
    '',
    `- Run id: ${clean(init.request.request_id)}`,
    `- Window: ${window}`,
    `- Enabled entities: ${entityLine}`,
    ...(toolLines ?? []),
    ...deployManifests,
    `- Named in the request: ${focusLine}`,
    `- Known ids: ${ids}`,
    ...leadsLine(init),
    `- Classification: ${classificationLine(init)}`,
    `- Id chain: ${hopsLine(init)}`,
    ...scoutLines(init),
    // Absolute, so the text stays the same across the submission's renders and the prompt cache holds.
    ...(finishBy !== undefined ? [`- ${finishByText(finishBy)}`] : []),
  ].join('\n');
}

// patterns.json from the loaded patterns skill, parsed once per knowledge
// tree. A string is the reason it could not be read.
const parsedPatterns = new WeakMap<Knowledge, readonly Pattern[] | string>();

function knownPatterns(knowledge: Knowledge): readonly Pattern[] | string {
  let out = parsedPatterns.get(knowledge);
  if (out === undefined) {
    const raw = knowledge.skills.get('patterns')?.files?.['patterns.json'];
    try {
      out = typeof raw === 'string' ? parsePatterns(JSON.parse(raw)) : 'patterns/patterns.json is not loaded';
    } catch (err) {
      out = (err as Error).message;
    }
    parsedPatterns.set(knowledge, out);
  }
  return out;
}

// The pattern ingress matched (category, services and thread text; see
// src/classify/patterns.ts), with its first queries for the briefs, or in
// the single shape for the agent to run first. Past patterns are leads, never
// answers (owner answer Q2). Empty without a match.
function leadSection(init: TriageInit, knowledge: Knowledge, entities: readonly Entity[], shape: AgentShape): string[] {
  const id = init.classification.proposed.matched_pattern_id;
  if (id === undefined) return [];
  const patterns = knownPatterns(knowledge);
  const pattern = typeof patterns === 'string' ? undefined : patterns.find((p) => p.id === id);
  const head = ['## Known pattern lead', ''];
  if (pattern === undefined) {
    const why = typeof patterns === 'string' ? patterns : 'no entry in patterns.json has that id';
    return [[...head, `Ingress matched \`${clean(id)}\`, but its entry could not be read: ${clean(why)}. Investigate as usual.`].join('\n')];
  }
  const queries = (pattern.first_queries ?? []).map((q) => {
    const off = entities.includes(q.entity) ? '' : ' (entity not enabled in this run; list it as a gap)';
    return `- ${q.entity}: ${oneLine(q.query)}${off}`;
  });
  return [
    [
      ...head,
      `The thread matches known pattern \`${pattern.id}\` (${pattern.category}, from ${pattern.source_ref}). It is a lead to test, not an answer: this run can differ.`,
      '',
      shape === 'split'
        ? `- In the brief of each entity below, add a line after Question: \`Lead: known pattern ${pattern.id}, to test, not an answer. First queries: <that entity's queries>\`.`
        : "- Run the first queries below before other reads, each with its entity's tools, and compare the results with the pattern.",
      "- Keep the pattern only when this run's evidence matches it. Otherwise leave `matched_pattern_id` out of the report and add a gap:",
      `  \`pattern ${pattern.id} tried and rejected: <what did not match>\`.`,
      '',
      ...(queries.length > 0
        ? ['First queries:', ...queries]
        : [`First check (query_recipe, for ${pattern.entities.join(', ')}): ${oneLine(pattern.query_recipe)}`]),
      ...(pattern.lesson !== undefined ? ['', `Lesson from a reviewed case: ${oneLine(pattern.lesson)}`] : []),
    ].join('\n'),
  ];
}

function classificationLine(init: TriageInit): string {
  const { proposed, tier_final } = init.classification;
  const entities = proposed.entities_likely.length > 0 ? proposed.entities_likely.join(', ') : 'none';
  return `category ${proposed.category}, entities ${entities}, tier ${tier_final}`;
}

// Hops carry key names and a source, never id values; the values are in Known ids.
function hopsLine(init: TriageInit): string {
  const hops = init.id_chain.hops.map((hop) => {
    const name = hop.to === undefined ? hop.from : `${hop.from} -> ${hop.to}`;
    return `${name} (${clean(hop.source)}): ${hop.status}`;
  });
  return hops.length > 0 ? hops.join('; ') : 'no hops';
}

function briefSection(
  entities: readonly Entity[],
  ids: string,
  window: string,
  services: MethodOptions['services'],
): string {
  const only = entities.length === 1 ? entities[0] : undefined;
  const onlyServices = only === undefined ? undefined : services?.[only];
  const values: Record<(typeof BRIEF_FIELDS)[number], string> = {
    Entity: only ?? '<one enabled entity per brief>',
    Question: '<one precise question for that entity>',
    Ids: ids === 'none resolved yet' ? '<the ids that entity can use>' : ids,
    Window: window,
    'Services in play': onlyServices?.length ? onlyServices.join(', ') : '<the services of that entity that matter here>',
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

// Keep the canonical order and drop anything that is not a known entity.
function canonical(given: readonly string[]): Entity[] {
  const wanted = new Set<string>(given);
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

// The scout's lines ride in initialData as `scout`, already masked by
// ingress (src/tools/_lib/scout.ts). Catalogue names in them come from the
// live databases, so they are kept on one line like thread text.
function scoutLines(init: TriageInit): string[] {
  const lines = init.scout ?? [];
  if (lines.length === 0) return [];
  return ['- Scout before the run (counts only; each id masked to its last characters):', ...lines.map((line) => `  - ${flatten(line, 400)}`)];
}

/** Most leads the run section lists; the rest are counted. */
export const MAX_LISTED_LEADS = 10;

// The id-shaped values the requester wrote (D96); each is usable as is. A
// lead the Known ids line already shows under its key is left out.
function leadsLine(init: TriageInit): string[] {
  const known: KnownIds = { ...init.request.hints.ids, ...init.id_chain.ids };
  const leads = (init.id_chain.leads ?? []).filter((lead) => {
    const held = lead.key === undefined ? undefined : known[lead.key];
    return held === undefined || compact(held) !== compact(lead.value);
  });
  if (leads.length === 0) return [];
  const parts = leads
    .slice(0, MAX_LISTED_LEADS)
    .map((lead) => `${clean(lead.label ?? lead.kind)}: ${clean(lead.value)}${lead.key !== undefined ? ` (${lead.key})` : ''}`);
  const more = leads.length > MAX_LISTED_LEADS ? ` (+${leads.length - MAX_LISTED_LEADS} more)` : '';
  return [`- Leads: ${parts.join('; ')}${more}`];
}

// A value without case, spaces or phone punctuation, so '+971 50' matches '97150'.
function compact(value: string): string {
  return value.toLowerCase().replace(/[\s+().-]/g, '');
}

// Ids come from thread text, so keep them on one line and short: a value
// must not be able to add lines or headings to the instruction.
function clean(value: string): string {
  return flatten(value, 200);
}

function flatten(value: string, max: number): string {
  const flat = value.replace(/[\u0000-\u001f\u007f`]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

// Pattern text is curated in the repo, so it is only kept on one line.
function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
