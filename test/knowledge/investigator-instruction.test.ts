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

  test('investigator.md names no orchestrator tool and covers the source tools', () => {
    const tools = mentionedTools(read('investigator.md'));
    for (const t of TRIAGE_TOOLS.filter((x) => x !== 'note_evidence')) expect(tools).not.toContain(t);
    for (const t of ['logs_search', 'sql_select', 'http_call', 'note_evidence', 'cbs_call', 'repo_grep', 'repo_read', 'run_log']) {
      expect(tools).toContain(t);
    }
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

  test('no method file states the old UUID first-segment rule (D76 sends the whole UUID)', () => {
    const counts = FILES.map((file) => [file, (read(file).match(FIRST_SEGMENT) ?? []).length] as const);
    expect(counts.filter(([, n]) => n > 0)).toEqual([]);
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

  test('logs.md carries the logs-finder port: free-form start, query forms, limits, paging, traps and ten templates (W12)', () => {
    const flat = read('logs.md').replace(/\s+/g, ' ');
    expect(flat).toContain('## Start free-form');
    expect(flat).toContain("`NOT 'a' AND NOT 'b'`");
    expect(flat).toContain('does not yet ask Quickwit for the query it actually ran');
    expect(flat).toContain('Over 5,000 hits the call returns early');
    expect(flat).toContain('at most 50 `logs_search` calls');
    expect(flat).toContain('## Paging and counting');
    expect(flat).toMatch(/tokenizer splits words on `_` and `\.`/);
    expect(flat).toContain('columns: ["User-Agent"]');
    const templates = read('logs.md').split('## Query templates')[1] ?? '';
    expect([...templates.matchAll(/^\d+\. /gm)].length).toBe(10);
  });

  test("logs.md's zero-hit ladder follows the tool's 0-hit note", () => {
    const text = read('logs.md');
    const ladder = text.slice(text.indexOf('## Zero hits is not an answer'));
    const order = ['Drop `service`', '`group_by: ["service"]`', 'Move `from` earlier', 'Drop `level`'].map((s) => ladder.indexOf(s));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test('logs-ssfb.md covers the noise filter, recurring labels and guardian redaction (W12)', () => {
    const flat = read('logs-ssfb.md').replace(/\s+/g, ' ');
    expect(flat).toContain('`denoise: "only"`');
    expect(flat).toContain('`denoise: "with_message"`');
    // The labels live in the service skills only.
    expect(flat).toContain('Logs sections of `ssfb-harbor`, `ssfb-rhythm` and `ssfb-guardian`');
    expect(flat).not.toContain('`checking verification status`');
    expect(flat).toMatch(/guardian writes `from`, `to`, `sim_card_number`, `token` and `message_sid` as `\[REDACTED\]`/);
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

  test('covers the brief, the sources, gaps, scope, /data and a short reply', () => {
    expect(text).toMatch(/brief is the whole context/i);
    expect(text).toMatch(/\*\*Logs\*\*[\s\S]*\*\*DB\*\*[\s\S]*\*\*Code\*\*[\s\S]*\*\*Admin API\*\*[\s\S]*\*\*CBS\*\*/);
    expect(text).toContain('not configured for <entity>:<service>');
    expect(text).toContain('unreachable');
    expect(text).toContain("scope: 'systemic'");
    expect(text).toContain('/data/<call_id>.json');
    expect(text).toMatch(/never guess a plaintext/i);
    expect(text).toMatch(/Reply to the parent/);
  });

  test('has no fixed ladder, and covers hypotheses, empty lookups, log text, the window and client code (D81)', () => {
    const flat = text.replace(/\s+/g, ' ');
    expect(flat).not.toMatch(/evidence ladder|\brungs?\b/i);
    expect(flat).toContain('There is no fixed order of sources');
    expect(flat).toContain('only for live state the DB does not hold, and only when it is mounted');
    expect(flat).toContain('say which hypothesis it tests and what result would reject it');
    expect(flat).toContain('## Empty means ask why');
    expect(flat).toMatch(/first make sure the query itself is sound[\s\S]*read the code that writes that row or log line/);
    expect(flat).toContain('do not reword the same text or run the same key again');
    expect(flat).toContain('or a device id or verification id seen in this run\'s results');
    expect(flat).toMatch(/A device id or a verification id is not one of the run's ids, but the tools accept one once a result in this run, fetched by one of the run's ids/);
    expect(flat).toContain('`Journey keys:`');
    expect(flat).not.toMatch(/scope check refuses it: do not query it/);
    expect(flat).toContain('## Where log text comes from');
    expect(flat).toMatch(/`aspora_user_id`[\s\S]*"x-customer-id"[\s\S]*`group_by: \["message"\]`/);
    expect(flat).toMatch(/the run's default window[\s\S]*set `from` to that time/);
    expect(flat).not.toContain('30 days');
    expect(flat).toContain('read the app code that sends or receives on that leg');
  });

  test('saves findings after each batch, each call whole, and stops when every key lookup is empty (plan 13 T6)', () => {
    const flat = text.replace(/\s+/g, ' ');
    expect(flat).toContain('Call `note_evidence` with an `EntityFindings` object after each batch of reads that finds something');
    // The report reads the latest version per entity, so an interim call must not drop earlier evidence.
    expect(flat).toContain('Each call replaces the one before, so send everything found so far');
    expect(flat).not.toContain('Before you reply, call `note_evidence`');
    expect(flat).toContain('When every key lookup is still empty, stop: call `note_evidence` with the empty lookups as evidence and a gap');
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
