// Checks knowledge/method/agent.md, the single-shape method note (D109):
// it is the file the composer reads, passes the knowledge lint, names only
// the single agent's tools (data tools by name, called with an entity), covers
// the order of work, and carries none of the split notes' rules about
// briefs, delegates or not querying new ids.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_DOCS, ENTITY_TOOLS, methodDocsFor, SSFB_ONLY_TOOLS } from '../../src/agents/instruction.ts';
import { loadKnowledge } from '../../src/agents/skills.ts';
import { CODEBASE_NOTE_EVIDENCE } from '../../src/tools/note-evidence.tool.ts';
import { ENTITIES, KNOWN_ID_KEYS } from '../../src/types/core.ts';
import { CodeClaimSchema, CodeFindingsSchema, EntityFindingsSchema, EvidenceItemSchema } from '../../src/types/findings.ts';
import { ReportDraftSchema } from '../../src/types/report.ts';
import { KNOWLEDGE_DIR, lintText, methodFilesFor, toolsOutside } from './_util.ts';

const METHOD_DIR = join(KNOWLEDGE_DIR, 'method');
const agent = readFileSync(join(METHOD_DIR, 'agent.md'), 'utf8');
const flat = agent.replace(/\s+/g, ' ');

/** Plain tool and subagent names agent.md may name. */
const PLAIN_NAMES = [
  'resolve_identity',
  'repo_grep',
  'repo_read',
  'repo_find',
  'repo_tree',
  'code_explore',
  'code_node',
  'code_impact',
  'read_staged',
  'run_log',
  'finish_report',
  'ask_requester',
  'stop_blocked',
  'activate_skill',
  CODEBASE_NOTE_EVIDENCE,
] as const;

/** Field and key names that may appear in backticks. */
const FIELD_NAMES = new Set<string>([
  ...Object.keys(ReportDraftSchema.entries),
  ...Object.keys(EntityFindingsSchema.entries),
  ...Object.keys(EvidenceItemSchema.entries),
  ...Object.keys(CodeFindingsSchema.entries),
  ...Object.keys(CodeClaimSchema.entries),
  ...KNOWN_ID_KEYS,
  'taken_at',
  'staged_file',
  'group_by',
]);

/** Backticked snake_case spans that are neither a known name, an entity tool, nor a field. Entity prefixes are gone (D110). */
function unknownNames(text: string): string[] {
  const ok = new Set<string>([...PLAIN_NAMES, ...FIELD_NAMES, ...ENTITY_TOOLS, ...SSFB_ONLY_TOOLS]);
  const spans = [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1] as string);
  return spans.filter((span) => /^[a-z<][a-z0-9_<>]*_[a-z0-9_<>]*$/.test(span) && !ok.has(span));
}

describe('helpers catch bad samples', () => {
  test('an unknown or entity-prefixed tool is found', () => {
    expect(unknownNames('Use `sql_select`, `logs_search`, `get_account_statement` and `read_staged`.')).toEqual([]);
    expect(unknownNames('Use `rtl_sql_select`, `<entity>_logs_search`, `cbs_call`, `investigate_rtl` and `code_walker`.')).toEqual([
      'rtl_sql_select',
      '<entity>_logs_search',
      'cbs_call',
      'investigate_rtl',
      'code_walker',
    ]);
  });
});

describe('agent.md', () => {
  test('is the first single-shape method file, and the loader finds every single-shape file', () => {
    expect(AGENT_DOCS[0]).toBe('agent.md');
    expect(methodFilesFor('agent')).toEqual(methodDocsFor('single'));
    const k = loadKnowledge(KNOWLEDGE_DIR);
    for (const name of methodDocsFor('single')) expect(k.method.get(name)?.length ?? 0).toBeGreaterThan(0);
  });

  test('passes the lint and has no process notes', () => {
    expect(lintText(agent)).toEqual([]);
    expect(agent).not.toMatch(/claude|codex|\bTODO\b|\bT\d{2}\.\d+\b|AGENTS\.md|SKILL\.md|\bD\d{2,3}\b/i);
  });

  test('is short: about a hundred lines', () => {
    const lines = agent.trimEnd().split('\n').length;
    expect(lines).toBeGreaterThan(80);
    expect(lines).toBeLessThan(130);
  });

  test('names only the single agent\'s tools, data tools by their name with an entity input', () => {
    expect(toolsOutside(agent, 'agent')).toEqual([]);
    expect(unknownNames(agent)).toEqual([]);
    for (const tool of ['sql_select', 'logs_search', 'note_evidence']) expect(agent).toContain('`' + tool + '`');
    expect(flat).toContain('each called with the `entity` to query');
    expect(agent).not.toContain('<entity>_');
    for (const name of ['finish_report', 'ask_requester', 'stop_blocked', 'read_staged', 'worker', CODEBASE_NOTE_EVIDENCE]) {
      expect(agent).toContain('`' + name + '`');
    }
  });

  test('orders the work: who and where, then current state, then why', () => {
    const who = agent.indexOf('**Who the customer is and where they are.**');
    const state = agent.indexOf('**Their current state.**');
    const why = agent.indexOf('**Why.**');
    expect(who).toBeGreaterThan(-1);
    expect(state).toBeGreaterThan(who);
    expect(why).toBeGreaterThan(state);
    expect(flat).toContain('Start from the Known ids and Leads under This run');
    expect(flat).toContain('does not resolve in one entity, try it in the others');
    expect(flat).toContain('read the code that writes it instead of guessing');
    expect(flat).toContain("`reference_type = 'USER'`");
  });

  test('covers hypotheses, counting first, /data slices, workers, evidence and the three endings', () => {
    expect(flat).toContain('Write down what could explain the symptom');
    expect(flat).toContain('Count or group before you read hits');
    expect(flat).toContain('An empty lookup is a question, not an answer');
    expect(flat).toContain('Never replay a call');
    expect(flat).toMatch(/full result is in `\/data`\. Read slices of it with `read_staged`/);
    expect(flat).toMatch(/Give it the job .* the `\/data` files, ids and window it needs, and the note names to activate/);
    expect(flat).toContain('at most 20 lines');
    expect(flat).toContain('Call `note_evidence` with the entity after each batch of reads');
    expect(flat).toContain('only saved evidence reaches the report');
    expect(flat).toContain('Code goes to `codebase_note_evidence`');
    expect(flat).toContain('`finish_report` ends the run');
    expect(flat).toContain('`ask_requester` only for what no tool can find');
    expect(flat).toContain('`stop_blocked` when a tool said a system did not answer');
  });

  test('allows ids found in results and linked customers, with counts only for the rest', () => {
    expect(flat).toContain('An id you find in a result');
    expect(flat).toContain('can be used in later calls');
    expect(flat).toContain('a referrer or the other side of a transfer between two customers');
    expect(flat).toContain("count with `scope: 'systemic'`; never list rows");
  });

  test('keeps the masking rule for the report', () => {
    expect(flat).toContain(
      'mask phone numbers, account numbers, PAN, email addresses and names to the last four characters',
    );
    expect(flat).toContain('Nothing leaves the run except the report');
  });

  test('carries none of the split rules about briefs, delegates or new ids', () => {
    expect(agent).not.toMatch(/\bbrief/i);
    expect(agent).not.toMatch(/delegate/i);
    expect(agent).not.toMatch(/investigator|investigate_|code_walker/);
    expect(agent).not.toContain('Journey keys');
    expect(flat).not.toMatch(/do not query it|before you brief/i);
  });
});
