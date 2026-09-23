// Content hygiene over knowledge/. Every banned pattern is caught in an inline
// sample; placeholders and ordinary prose pass; then the real tree is clean.
// The samples are made-up values, never real ids or hosts.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  allowedTools,
  delegateNames,
  KNOWLEDGE_DIR,
  KNOWN_TOOLS,
  LINT_RULE_IDS,
  lintText,
  lintTree,
  mentionedTools,
  methodFilesFor,
  PLACEHOLDER,
  toolsOutside,
  UNVERIFIED_MARKER,
} from './_util.ts';

const rulesIn = (text: string) => [...new Set(lintText(text).map((h) => h.rule))].sort();

// [rule id, sample that must trip it]
const BANNED: Array<[string, string]> = [
  ['uuid', 'customer 123e4567-e89b-12d3-a456-426614174000 is stuck'],
  ['digits', 'account 1234567 was frozen'],
  ['email', 'raised by someone.cx@example.com'],
  ['pan', 'PAN ABCDE1234F did not match'],
  ['url', 'see https://example.com/page'],
  ['url', 'or http://example.com'],
  ['dsn', 'connect with postgres://reader@db/harbor'],
  ['dsn', 'or postgresql://reader@db/harbor'],
  ['url-scheme', 'redis://cache/0'],
  ['url-scheme', 'mongodb://reader/harbor'],
  ['hostname', 'logs live on search.example.internal'],
  ['hostname', 'the gateway at api.example.com'],
  ['hostname', 'quickwit.corp.local answers'],
  ['host-port', 'forward to localhost:5432 first'],
  ['host-port', 'gateway on gw.example:9443'],
  ['ip-address', 'the bastion is 10.0.0.1'],
  ['bearer', 'Authorization: Bearer abc123def456ghi'],
  ['bearer', 'Bearer abcdefghijklmnopqrstuvwxyz'],
  ['jwt', 'token eyJhbGciOiJIUzI1NiJ9.e30.x'],
  ['slack-id', 'ask U01ABCDEF23 in the thread'],
  ['slack-id', 'posted in C0ABC123DEF'],
  ['handle', 'ping @someone for review'],
  ['dotenv', 'set it in .env first'],
  ['dotenv', 'copy .env.example'],
  ['claude-dir', 'the skill under .claude/skills'],
  ['codex-dir', 'hooks in .codex'],
  ['codex-dir', 'paths under .Codex/skills'],
  ['claude-md', 'read CLAUDE.md first'],
  ['refs-dir', 'as seen in refs/some-case'],
  ['safe-sql', 'run safe_sql.sh'],
  ['safe-curl', 'run safe_curl.sh'],
  ['cbs-curl', 'run cbs_curl_via_eventbus.sh'],
  ['search-py', 'python3 search.py'],
  ['lookup-user', 'lookup_user.sh <customer_id>'],
  ['env-flag', 'pass --env to the wrapper'],
  ['debug-env-key', 'SHIVALIK_DEBUG_HARBOR_DB'],
  ['quickwit-env-key', 'DEBUG_AI_QUICKWIT_URL'],
  ['mcp-tool', 'call mcp__codegraph__explore'],
  ['ask-user', 'use AskUserQuestion'],
  ['playwright', 'open it in Playwright'],
  ['grafana', 'check the Grafana board'],
  ['psql', 'run psql against the reader'],
  ['kubectl', 'kubectl exec into the pod'],
  ['env-word', 'only in prod'],
  ['env-word', 'the UAT copy'],
  ['env-word', 'stg cluster'],
  ['env-word', 'a staging deploy'],
  ['env-word', 'ssfb-prod context'],
  ['env-word', 'SHIVALIK_UAT_HARBOR'],
];

describe('banned patterns', () => {
  test.each(BANNED)('%s is caught in %p', (rule, sample) => {
    expect(rulesIn(sample)).toContain(rule);
  });

  test('every rule has at least one sample', () => {
    const covered = new Set(BANNED.map(([rule]) => rule));
    expect(LINT_RULE_IDS.filter((id) => !covered.has(id))).toEqual([]);
  });

  test('hits carry the line number', () => {
    const hits = lintText('line one\nline two in prod\n');
    expect(hits).toEqual([{ rule: 'env-word', match: 'prod', line: 2 }]);
  });
});

describe('allowed text', () => {
  const CLEAN = [
    'Run sql_select with $1 = <customer_id> and $2 = <form_id>.',
    'Placeholders: <account_id>, <account_number>, <run_id>.',
    'The deploy manifests live in prod-ssfb-aspora-argo.',
    'Production traffic, product names and staged rollouts are ordinary words.',
    'See SKILL.md, patterns.json, knowledge/method/logs-ssfb.md and report.md.',
    'The bug is at handler.go:88 and service.ts:120.',
    'The admin API expects a Bearer token in the header.',
    'Flue comes from @flue/runtime.',
    'Java throws java.io.IOException here.',
    'Join harbor.customer to rhythm.customer_account_mappings on customer_id.',
    'Registry keys look like ssfb:harbor and rtl:workflow.',
    'A window of 1024 rows, version 2.0.8, at 10:30 UTC on 2026-09-23.',
    'The environment is one per deployment; nothing branches on it.',
    'cohort owns these tables (unverified: no source documents them).',
    'The remittance order endpoint /appserver/v3/order is out of reach.',
  ];

  test.each(CLEAN)('%p passes', (sample) => {
    expect(lintText(sample)).toEqual([]);
  });

  test('placeholder and unverified marker forms match the README', () => {
    expect('<customer_id> and <form_id>'.match(PLACEHOLDER)).toEqual(['<customer_id>', '<form_id>']);
    expect('<Customer>'.match(PLACEHOLDER)).toBeNull();
    expect('x (unverified: no source) y'.match(UNVERIFIED_MARKER)).toEqual(['(unverified: no source)']);
    expect('x (unverified:) y'.match(UNVERIFIED_MARKER)).toBeNull();
  });
});

describe('lintTree', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  test('reports file, line and rule, and checks file paths too', () => {
    const root = mkdtempSync(join(tmpdir(), 'knowledge-lint-'));
    roots.push(root);
    const write = (rel: string, text: string) => {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    };
    write('ssfb-harbor/SKILL.md', 'fine\nsee https://example.com\n');
    write('ssfb-harbor/.env', 'x\n');
    write('method/logs.md', 'clean <customer_id>\n');
    expect(lintTree(root)).toEqual([
      'ssfb-harbor/.env (path) dotenv .env',
      'ssfb-harbor/SKILL.md:2 hostname example.com',
      'ssfb-harbor/SKILL.md:2 url https://',
    ]);
  });
});

describe('the real knowledge/ tree', () => {
  test('has no banned patterns', () => {
    expect(lintTree(KNOWLEDGE_DIR)).toEqual([]);
  });
});

describe('tool sets from HLD §2', () => {
  test('every allowed tool is a known tool', () => {
    for (const agent of ['triage', 'investigator', 'investigator_deep', 'code_walker'] as const) {
      for (const entity of ['ssfb', 'atspl', 'rtl'] as const) {
        for (const tool of allowedTools(agent, entity)) expect(KNOWN_TOOLS.has(tool)).toBe(true);
      }
    }
  });

  test('triage has no entity I/O and investigators have no report tool', () => {
    const triage = allowedTools('triage');
    for (const t of ['sql_select', 'http_call', 'logs_search', 'cbs_call']) expect(triage.has(t)).toBe(false);
    expect(triage.has('finish_report')).toBe(true);
    expect(allowedTools('investigator', 'rtl').has('finish_report')).toBe(false);
  });

  test('SSFB extras only on SSFB investigators, code tools only on deep and code_walker', () => {
    expect(allowedTools('investigator', 'ssfb').has('cbs_call')).toBe(true);
    expect(allowedTools('investigator', 'atspl').has('cbs_call')).toBe(false);
    expect(allowedTools('investigator', 'ssfb').has('code_explore')).toBe(false);
    expect(allowedTools('investigator_deep', 'rtl').has('code_explore')).toBe(true);
    expect(allowedTools('code_walker').has('sql_select')).toBe(false);
    expect(allowedTools('code_walker').has('repo_grep')).toBe(true);
  });

  test('mentionedTools and toolsOutside', () => {
    const text = 'Use sql_select, then `grep` the rows; read the notes and call finish_report.';
    expect(mentionedTools(text)).toEqual(['finish_report', 'grep', 'sql_select']);
    expect(toolsOutside(text, 'investigator', 'rtl')).toEqual(['finish_report']);
    expect(toolsOutside(text, 'triage')).toEqual(['sql_select']);
  });

  test('delegate names and method files per agent', () => {
    expect(delegateNames(['ssfb'])).toEqual(['investigate_ssfb', 'investigate_ssfb_deep', 'code_walker']);
    expect(methodFilesFor('triage')).toEqual(['orchestrator.md', 'brief-template.md', 'report-format.md']);
    expect(methodFilesFor('investigator', 'atspl')).toEqual(['investigator.md', 'logs.md', 'logs-atspl.md']);
    expect(methodFilesFor('code_walker')).toEqual(['code-walker.md']);
  });
});
