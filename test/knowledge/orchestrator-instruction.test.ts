// Checks the Triage instruction texts in knowledge/method/ (orchestrator.md,
// brief-template.md, report-format.md) against the runtime lists they
// describe: the brief fields in src/agents/instruction.ts, the Report status
// values, cx_answer and suggested_fix fields in src/types, and the Triage tool
// set in _util.ts. The helpers are tested on bad samples first, so a check
// that stops catching problems fails here too.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BRIEF_FIELDS, ORCHESTRATOR_DOCS } from '../../src/agents/instruction.ts';
import { loadKnowledge } from '../../src/agents/skills.ts';
import { CONFIDENCE_LEVELS, ENTITIES, KNOWN_ID_KEYS, REPORT_STATUSES, type Entity } from '../../src/types/core.ts';
import { EntityFindingsSchema } from '../../src/types/findings.ts';
import {
  CxAnswerSchema,
  ReportDraftSchema,
  RootCauseSchema,
  SUGGESTED_FIX_KINDS,
  SuggestedFixSchema,
} from '../../src/types/report.ts';
import {
  KNOWLEDGE_DIR,
  PLACEHOLDER,
  REPO_ROOT,
  allowedTools,
  lintText,
  mentionedTools,
  methodFilesFor,
  toolsOutside,
} from './_util.ts';

const METHOD_DIR = join(KNOWLEDGE_DIR, 'method');
const read = (name: string): string => readFileSync(join(METHOD_DIR, name), 'utf8');

const orchestrator = read('orchestrator.md');
const brief = read('brief-template.md');
const reportFormat = read('report-format.md');
const ALL = { 'orchestrator.md': orchestrator, 'brief-template.md': brief, 'report-format.md': reportFormat };

/** The tools and delegates the orchestrator may name (acceptance list). */
const ORCHESTRATOR_NAMES = [
  'resolve_identity',
  'note_evidence',
  'finish_report',
  'task',
  'activate_skill',
  'investigate_<entity>',
  'investigate_<entity>_deep',
  'code_walker',
] as const;

/** Write actions that may appear only as suggested_fix (D35). */
const WRITE_ACTIONS = [
  'trigger-delivery',
  'sync-address',
  'trigger-customer-creation',
  'debit-unfreeze',
  'force-sign',
] as const;

// ---------------------------------------------------------------- helpers

/** Lines of the section under an exact `## heading`, up to the next heading. */
function section(text: string, heading: string): string {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line === `## ${heading}`);
  if (start < 0) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^#{1,2} /.test(line));
  return (end < 0 ? rest : rest.slice(0, end)).join('\n');
}

/** Names of list items written "- `name`: ...", in order. */
function itemNames(text: string): string[] {
  return [...text.matchAll(/^- `([a-z_]+)`:/gm)].map((m) => m[1] as string);
}

/** The text of the list item "- `name`: ..." up to the next item or blank line. */
function item(text: string, name: string): string {
  const m = new RegExp('^- `' + name + '`:([\\s\\S]*?)(?=^- |^\\s*$|(?![\\s\\S]))', 'm').exec(text);
  return m ? (m[1] as string) : '';
}

/** Every backticked span. */
function backticked(text: string): string[] {
  return [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1] as string);
}

/** Fenced code blocks. */
function codeBlocks(text: string): string[] {
  return [...text.matchAll(/^```[a-z]*\n([\s\S]*?)^```$/gm)].map((m) => m[1] as string);
}

/** Wording that treats confidence as a number. */
function numericConfidence(text: string): string[] {
  const rules = [/confidence score/gi, /\bscore\b/gi, /\d\s*%/g, /\b0?\.\d+\b/g, /\b\d+\s*(?:\/|out of)\s*\d+\b/gi];
  return rules.flatMap((re) => [...text.matchAll(re)].map((m) => m[0]));
}

/** Wording that belongs to the old workspace or to how the text was written. */
function processNotes(text: string): string[] {
  const rules = [
    /claude/gi,
    /codex/gi,
    /\bT\d{2}\.\d+\b/g,
    /\b(?:TODO|FIXME|TBD|XXX)\b/g,
    /sub-ticket/gi,
    /this ticket/gi,
    /slash command/gi,
    /\bhook\b/gi,
    /AGENTS\.md/g,
    /SKILL\.md/g,
    /approval gate/gi,
    /ask (?:the operator|before)/gi,
  ];
  return rules.flatMap((re) => [...text.matchAll(re)].map((m) => m[0]));
}

/** Words that may appear in backticks in orchestrator.md: its tools and delegates, plus field names. */
const FIELD_NAMES = new Set<string>([
  ...Object.keys(ReportDraftSchema.entries),
  ...Object.keys(EntityFindingsSchema.entries),
  ...Object.keys(RootCauseSchema.entries),
  'taken_at',
]);

/** Backticked snake_case words in text that are neither an allowed name nor a field name. */
function unknownBacktickedNames(text: string, allowed: readonly string[]): string[] {
  const ok = new Set<string>([...allowed, ...FIELD_NAMES]);
  return backticked(text).filter((span) => /^[a-z][a-z0-9_<>]*_[a-z0-9_<>]*$/.test(span) && !ok.has(span));
}

function registryServices(entity: Entity): string[] {
  const file = join(REPO_ROOT, 'resources', `${entity}.entity.json`);
  const registry = JSON.parse(readFileSync(file, 'utf8')) as { services?: Record<string, unknown> };
  return Object.keys(registry.services ?? {});
}

function picklistOptions(schema: unknown): string[] | undefined {
  const options = (schema as { options?: unknown }).options;
  return Array.isArray(options) ? (options as string[]) : undefined;
}

describe('helpers catch bad samples', () => {
  test('a tool Triage does not have is found, in or out of backticks', () => {
    const bad = 'Call sql_select for the rows, then `http_call` the admin API and run logs_search.';
    expect(toolsOutside(bad, 'triage').sort()).toEqual(['http_call', 'logs_search', 'sql_select']);
    expect(unknownBacktickedNames('Use `resolve_identiy` then `sql_select`.', ORCHESTRATOR_NAMES)).toEqual([
      'resolve_identiy',
      'sql_select',
    ]);
    expect(unknownBacktickedNames('Use `resolve_identity` on `taken_at`.', ORCHESTRATOR_NAMES)).toEqual([]);
  });

  test('numeric confidence wording is found', () => {
    expect(numericConfidence('Confidence score: 0.8')).toEqual(['Confidence score', 'score', '0.8']);
    expect(numericConfidence('confidence is 80 %')).toEqual(['0 %']);
    expect(numericConfidence('rate it 7/10')).toEqual(['7/10']);
    expect(numericConfidence('Confidence is high, medium or low.')).toEqual([]);
  });

  test('process notes and old workspace wording are found', () => {
    expect(processNotes('TODO: port from AGENTS.md in T12.2, per Claude')).toEqual([
      'Claude',
      'T12.2',
      'TODO',
      'AGENTS.md',
    ]);
    expect(processNotes('Ask before touching anything; the approval gate is yours.')).toEqual([
      'approval gate',
      'Ask before',
    ]);
  });

  test('section and item parsing', () => {
    const text = '## Status\n\n- `a`: one\n  more\n- `b`: `x` or `y`\n\n## Next\n- `c`: no\n';
    expect(itemNames(section(text, 'Status'))).toEqual(['a', 'b']);
    expect(backticked(item(section(text, 'Status'), 'b'))).toEqual(['x', 'y']);
    expect(section(text, 'Missing')).toBe('');
  });
});

// ------------------------------------------------------------------ files

describe('Triage method files', () => {
  test('are the files the composer reads, and the loader finds them', () => {
    expect(methodFilesFor('triage')).toEqual([...ORCHESTRATOR_DOCS]);
    const k = loadKnowledge(KNOWLEDGE_DIR);
    for (const name of ORCHESTRATOR_DOCS) expect(k.method.get(name)?.length ?? 0).toBeGreaterThan(0);
  });

  test.each(Object.entries(ALL))('%s passes the lint and has no process notes', (_name, text) => {
    expect(lintText(text)).toEqual([]);
    expect(processNotes(text)).toEqual([]);
  });

  test.each(Object.entries(ALL))('%s names no tool Triage does not have', (_name, text) => {
    expect(toolsOutside(text, 'triage')).toEqual([]);
  });

  test.each(Object.entries(ALL))('%s has no numeric confidence wording', (_name, text) => {
    expect(numericConfidence(text)).toEqual([]);
  });
});

describe('orchestrator.md', () => {
  test('names only the tools and delegates Triage has', () => {
    const allowed = new Set<string>(ORCHESTRATOR_NAMES);
    for (const tool of mentionedTools(orchestrator)) expect(allowed.has(tool)).toBe(true);
    for (const tool of mentionedTools(orchestrator)) expect(allowedTools('triage').has(tool)).toBe(true);
    expect(unknownBacktickedNames(orchestrator, ORCHESTRATOR_NAMES)).toEqual([]);
    for (const name of ORCHESTRATOR_NAMES) expect(orchestrator).toContain('`' + name + '`');
  });

  test('never names the entity I/O tools', () => {
    for (const tool of ['sql_select', 'http_call', 'logs_search', 'cbs_call']) {
      expect(orchestrator.includes(tool)).toBe(false);
    }
  });

  test('delegate names use the entity placeholder or a real entity', () => {
    for (const span of backticked(orchestrator).filter((s) => s.startsWith('investigate_'))) {
      const m = /^investigate_(<entity>|[a-z]+)(_deep)?$/.exec(span);
      expect(m).not.toBeNull();
      const entity = (m as RegExpExecArray)[1] as string;
      expect(entity === '<entity>' || (ENTITIES as readonly string[]).includes(entity)).toBe(true);
    }
  });

  test('covers the method rules', () => {
    const text = orchestrator.replace(/\s+/g, ' ');
    expect(text).toContain('admin API (when the service has one configured), then DB, then logs, then CBS (SSFB only)');
    expect(text).toMatch(/logs come first/);
    expect(text).toMatch(/Nobody replays the call/);
    expect(text).toContain('`taken_at`');
    expect(text).toContain('The current ask is the latest message in the thread');
    expect(text).toMatch(/new id appears .* run `resolve_identity`/);
    expect(text).toMatch(/one `task` per entity, all in the same turn/i);
    expect(text).toMatch(/Cross-entity reasoning happens only here, from the delegates' summaries/);
    expect(text).toMatch(/record it in the gaps|goes into the report's gaps/);
    expect(text).toContain('Always end the run with `finish_report`');
  });

  test('confidence is high, medium or low, with a rubric for each level', () => {
    const rubric = section(orchestrator, 'Confidence');
    expect(itemNames(rubric)).toEqual([...CONFIDENCE_LEVELS]);
    for (const level of CONFIDENCE_LEVELS) expect(item(rubric, level).trim().length).toBeGreaterThan(40);
  });

  test('escalation is automatic and not requested by the model', () => {
    const text = section(orchestrator, 'Escalation').replace(/\s+/g, ' ');
    expect(text).toContain('Escalation to strong synthesis is automatic');
    expect(text).toContain('You do not need to request it');
  });

  test('nothing leaves the run except through finish_report, and Slack is a human step', () => {
    const text = orchestrator.replace(/\s+/g, ' ');
    expect(text).toContain('Nothing leaves the run except through `finish_report`');
    expect(text).toMatch(/do not post to Slack/);
    expect(text).toMatch(/A human reads the report .* outside the agent/);
  });

  test('does not ask anyone mid-run', () => {
    expect(orchestrator.replace(/\s+/g, ' ')).toContain('You cannot ask the user or the requester anything during the run');
  });
});

describe('brief-template.md', () => {
  const blocks = codeBlocks(brief);
  const example = blocks[0] ?? '';
  const field = (name: string): string => {
    const m = new RegExp(`^${name}: (.*)$`, 'm').exec(example);
    return m ? (m[1] as string) : '';
  };

  test('describes each of the six brief fields in order', () => {
    expect(BRIEF_FIELDS).toHaveLength(6);
    const positions = BRIEF_FIELDS.map((name) => brief.indexOf(`\n- ${name}: `));
    for (const at of positions) expect(at).toBeGreaterThan(-1);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  test('has exactly one worked example with every field, in order', () => {
    expect(blocks).toHaveLength(1);
    expect(example.trim().split('\n').map((line) => line.split(': ')[0])).toEqual([...BRIEF_FIELDS]);
  });

  test('the example uses only placeholder ids and a placeholder window', () => {
    expect(example).not.toMatch(/\d/);
    const pairs = field('Ids').split(', ').map((pair) => pair.split(' = '));
    expect(pairs.length).toBeGreaterThan(0);
    for (const [key, value] of pairs) {
      expect((KNOWN_ID_KEYS as readonly string[]).includes(key as string)).toBe(true);
      expect(value).toMatch(new RegExp(`^${PLACEHOLDER.source}$`));
    }
    expect(field('Window')).toMatch(new RegExp(`^${PLACEHOLDER.source} \\.\\. ${PLACEHOLDER.source}$`));
  });

  test('the example names a real entity, its registry services and a findings return', () => {
    const entity = field('Entity') as Entity;
    expect(ENTITIES).toContain(entity);
    const services = registryServices(entity);
    for (const service of field('Services in play').split(', ')) expect(services).toContain(service);
    expect(field('Return')).toMatch(/^EntityFindings\. /);
  });
});

describe('report-format.md', () => {
  test('lists exactly the Report status values', () => {
    const statuses = section(reportFormat, 'Status');
    expect(itemNames(statuses).sort()).toEqual([...REPORT_STATUSES].sort());
    // The tie-break order names every status once.
    const order = /use the first that fits in this order: ([^.]+)\./.exec(statuses.replace(/\s+/g, ' '));
    expect(order).not.toBeNull();
    expect(backticked((order as RegExpExecArray)[1] as string).sort()).toEqual([...REPORT_STATUSES].sort());
  });

  test('lists exactly the cx_answer fields and their values', () => {
    const cx = section(reportFormat, 'cx_answer');
    const entries = CxAnswerSchema.entries as Record<string, unknown>;
    expect(itemNames(cx).sort()).toEqual(Object.keys(entries).sort());
    for (const [name, schema] of Object.entries(entries)) {
      const options = picklistOptions(schema);
      if (!options) continue;
      const listed = backticked(item(cx, name).split('.')[0] as string);
      expect(listed.sort()).toEqual([...options].sort());
    }
  });

  test('lists the suggested_fix fields and exactly the kinds curl, sql and manual', () => {
    const fix = section(reportFormat, 'suggested_fix');
    expect(itemNames(fix).sort()).toEqual(Object.keys(SuggestedFixSchema.entries).sort());
    expect([...SUGGESTED_FIX_KINDS]).toEqual(['curl', 'sql', 'manual']);
    expect(backticked(item(fix, 'kind'))).toEqual([...SUGGESTED_FIX_KINDS]);
  });

  test('covers every field of the Report draft', () => {
    const fields = new Set(backticked(section(reportFormat, 'Fields you fill')));
    for (const key of Object.keys(ReportDraftSchema.entries)) expect(fields.has(key)).toBe(true);
  });

  test('says fixes are never executed and uses $VAR placeholders', () => {
    const text = reportFormat.replace(/\s+/g, ' ');
    expect(text).toContain('never executed');
    expect(text).toContain('`$VAR` placeholders');
    const example = codeBlocks(reportFormat).find((block) => block.includes('command:')) ?? '';
    const command = /^command: (.*)$/m.exec(example)?.[1] ?? '';
    expect(command).toMatch(/"\$[A-Z][A-Z0-9_]*\//);
    expect(command).toMatch(/Bearer \$[A-Z][A-Z0-9_]*/);
  });

  test('names every write action, only as a suggested fix', () => {
    const fix = section(reportFormat, 'suggested_fix');
    for (const action of WRITE_ACTIONS) {
      expect(fix).toContain('`' + action + '`');
      expect(orchestrator.includes(action)).toBe(false);
      expect(brief.includes(action)).toBe(false);
    }
    expect(fix.replace(/\s+/g, ' ')).toContain('Write actions appear only as a suggested fix');
  });

  test('lists the section order the team uses', () => {
    const order = section(reportFormat, 'Section order');
    const fields = ['id_chain', 'current_state', 'timeline', 'root_cause', 'scope', 'actions', 'status'];
    const positions = fields.map((f) => order.indexOf('`' + f + '`'));
    for (const at of positions) expect(at).toBeGreaterThan(-1);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });
});
