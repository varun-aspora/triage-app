// Checks the investigator, logs and code-walker method texts (T12.3): each
// file names only the tools its agent has, the logs advice matches the gate
// (UUID first-segment rule, no raw_message wildcards, Quickwit on every
// entity), nothing names how logs are reached, and every file passes the
// knowledge lint. Each check is also run on a bad sample so it is known to
// refuse.

import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ENTITIES, type Entity } from '../../src/types/core.ts';
import {
  type AgentKind,
  allowedTools,
  CODE_TOOLS,
  KNOWLEDGE_DIR,
  lintText,
  mentionedTools,
  methodFilesFor,
  TRIAGE_TOOLS,
  UNVERIFIED_MARKER,
} from './_util.ts';

const METHOD_DIR = join(KNOWLEDGE_DIR, 'method');
const read = (file: string): string => readFileSync(join(METHOD_DIR, file), 'utf8');

const LOGS_FILES = ['logs.md', ...ENTITIES.map((e) => `logs-${e}.md`)];
const FILES = ['investigator.md', ...LOGS_FILES, 'code-walker.md'];

// The narrower sets the acceptance criteria give, on top of _util.ts.
const LOGS_ONLY = new Set(['logs_search']);
const CODE_WALKER_ONLY = new Set([...CODE_TOOLS, 'note_evidence']);

/** The agents that read a file, from methodFilesFor, with the entity where it matters. */
function readersOf(file: string): Array<{ agent: AgentKind; entity?: Entity }> {
  const out: Array<{ agent: AgentKind; entity?: Entity }> = [];
  for (const agent of ['investigator', 'investigator_deep'] as const) {
    for (const entity of ENTITIES) if (methodFilesFor(agent, entity).includes(file)) out.push({ agent, entity });
  }
  if (methodFilesFor('code_walker').includes(file)) out.push({ agent: 'code_walker' });
  return out;
}

// Tools the text names that the file's agent may not name.
function toolProblems(file: string, text: string): string[] {
  if (LOGS_FILES.includes(file)) return mentionedTools(text).filter((t) => !LOGS_ONLY.has(t));
  if (file === 'code-walker.md') return mentionedTools(text).filter((t) => !CODE_WALKER_ONLY.has(t));
  // investigator.md serves both variants and every entity: the widest set is
  // the deep SSFB investigator, and each reader must at least have the tools
  // outside the SSFB extras and code tools.
  const widest = allowedTools('investigator_deep', 'ssfb');
  return mentionedTools(text).filter((t) => !widest.has(t));
}

const RAW_MESSAGE_WILDCARD = /raw_message\s*:\s*["']?\*/i;
const SSFB_ONLY_LOGS = /ssfb[- ]only/i;
// How logs are reached lives in the env file and the registry, never in text
// the model reads (D44).
const TRANSPORT_WORDS: Array<[string, RegExp]> = [
  ['qw', /(?<![A-Za-z0-9_-])qw(?![A-Za-z0-9_-])/i],
  ['transport', /\btransport\b/i],
  ['login', /\blog ?in\b/i],
  ['context flag', /--context|--since|context use/i],
  ['index name', /logs-v1|envoy-logs|otel-(?:logs|traces)/i],
  ['api route', /\/api\/v1/i],
  ['port', /:\d{2,5}\b/],
];
const FIRST_SEGMENT = /first segment/gi;

describe('method files exist and pass the lint', () => {
  test.each(FILES)('%s exists, is not empty and is read by an agent', (file) => {
    expect(existsSync(join(METHOD_DIR, file))).toBe(true);
    expect(read(file).trim().length).toBeGreaterThan(0);
    expect(readersOf(file).length).toBeGreaterThan(0);
  });

  test.each(FILES)('%s passes the T12.1 lint', (file) => {
    expect(lintText(read(file))).toEqual([]);
  });
});

describe('tool names per agent', () => {
  test.each(FILES)('%s names only tools its agent has', (file) => {
    expect(toolProblems(file, read(file))).toEqual([]);
  });

  test.each(LOGS_FILES.filter((f) => f !== 'logs.md'))('%s names only tools its own investigator has', (file) => {
    const text = read(file);
    for (const { agent, entity } of readersOf(file)) {
      const allowed = allowedTools(agent, entity);
      expect(mentionedTools(text).filter((t) => !allowed.has(t))).toEqual([]);
    }
  });

  test('code-walker.md names only tools code_walker has', () => {
    const allowed = allowedTools('code_walker');
    expect(mentionedTools(read('code-walker.md')).filter((t) => !allowed.has(t))).toEqual([]);
  });

  test('investigator.md names no orchestrator tool and covers the ladder tools', () => {
    const tools = mentionedTools(read('investigator.md'));
    for (const t of TRIAGE_TOOLS.filter((x) => x !== 'note_evidence')) expect(tools).not.toContain(t);
    for (const t of ['logs_search', 'sql_select', 'http_call', 'note_evidence', 'cbs_call']) expect(tools).toContain(t);
    for (const t of ['encrypt_lookup_value', 'decrypt_fields']) expect(tools).toContain(t);
  });

  test('the checks refuse a tool outside the agent', () => {
    expect(toolProblems('logs-atspl.md', 'Then run sql_select on the table.')).toEqual(['sql_select']);
    expect(toolProblems('code-walker.md', 'Check with `bash` and logs_search.')).toEqual(['bash', 'logs_search']);
    expect(toolProblems('investigator.md', 'Call finish_report when done.')).toEqual(['finish_report']);
  });
});

describe('logs advice', () => {
  test('no raw_message wildcard pattern in any method file', () => {
    for (const file of FILES) expect(read(file)).not.toMatch(RAW_MESSAGE_WILDCARD);
  });

  test('the wildcard check catches the old advice', () => {
    expect('try raw_message:*abc-def*').toMatch(RAW_MESSAGE_WILDCARD);
    expect('raw_message: "*abc*"').toMatch(RAW_MESSAGE_WILDCARD);
  });

  test('logs.md says Quickwit covers every entity and no logs file says SSFB only', () => {
    expect(read('logs.md')).toMatch(/Quickwit covers every entity/);
    for (const file of LOGS_FILES) expect(read(file)).not.toMatch(SSFB_ONLY_LOGS);
    expect('Quickwit is SSFB only').toMatch(SSFB_ONLY_LOGS);
  });

  test('the UUID first-segment rule is stated once, in logs.md', () => {
    const counts = FILES.map((file) => [file, (read(file).match(FIRST_SEGMENT) ?? []).length] as const);
    expect(counts.filter(([, n]) => n > 0)).toEqual([['logs.md', 1]]);
  });

  test('logs.md covers the field model, correlation reuse, zero hits and correlation by time', () => {
    const text = read('logs.md');
    expect(text).toMatch(/`message` is the short label/);
    expect(text).toMatch(/`workflow-op`/);
    expect(text).toMatch(/Correlation ids are reused/);
    expect(text).toMatch(/Zero hits is not an answer/);
    expect(text).toMatch(/no run id/);
    expect(text).toMatch(/window is set by the tool/i);
  });

  test('entity notes keep the exact ATSPL service strings', () => {
    const atspl = read('logs-atspl.md');
    for (const s of ['`package`', '`package-worker-sync`', '`package-worker-queue`', '`pulse-backend`']) {
      expect(atspl).toContain(s);
    }
  });

  test.each([...LOGS_FILES, 'investigator.md'])('%s names no endpoint, index, context, login or transport', (file) => {
    const text = read(file);
    expect(TRANSPORT_WORDS.filter(([, re]) => re.test(text)).map(([name]) => name)).toEqual([]);
  });

  test('the transport check catches each detail', () => {
    const sample = 'qw search logs-v1 --since 7d --context x; run qw login; POST /api/v1/x on host:7080 via the transport';
    expect(TRANSPORT_WORDS.filter(([, re]) => !re.test(sample)).map(([name]) => name)).toEqual([]);
  });

  test('logs-rtl.md is marked unverified', () => {
    const text = read('logs-rtl.md');
    expect(text).toContain('unverified');
    expect(text.match(UNVERIFIED_MARKER)?.length ?? 0).toBeGreaterThan(0);
    expect(text).toMatch(/not_configured/);
  });
});

describe('investigator.md', () => {
  const text = read('investigator.md');

  test('mentions note_evidence, taken_at and EntityFindings with the confidence levels', () => {
    expect(text).toContain('note_evidence');
    expect(text).toContain('taken_at');
    expect(text).toContain('EntityFindings');
    for (const level of ['`high`', '`medium`', '`low`']) expect(text).toContain(level);
  });

  test('covers the brief, the ladder, gaps, scope, /data and a short reply', () => {
    expect(text).toMatch(/brief is the whole context/i);
    expect(text).toMatch(/Admin API[\s\S]*DB[\s\S]*Logs[\s\S]*CBS/);
    expect(text).toContain('not configured for <entity>:<service>');
    expect(text).toContain('unreachable');
    expect(text).toContain("scope: 'systemic'");
    expect(text).toContain('/data/<call_id>.json');
    expect(text).toMatch(/never guess a plaintext/i);
    expect(text).toMatch(/Reply to the parent/);
  });
});

describe('code-walker.md', () => {
  const text = read('code-walker.md');

  test('asks for repo, file and line citations', () => {
    expect(text).toMatch(/cite repo, file and lines/i);
    expect(text).toMatch(/No claim without a file and line citation/);
  });

  test('puts CodeGraph first and repo_grep as the fallback, and writes CodeFindings', () => {
    expect(text.indexOf('code_explore')).toBeLessThan(text.indexOf('repo_grep'));
    expect(text).toMatch(/`repo_grep` as the fallback/);
    expect(text).toContain('CodeFindings');
    expect(text).toContain('note_evidence');
    expect(text).toMatch(/brief is the whole context/i);
  });
});
