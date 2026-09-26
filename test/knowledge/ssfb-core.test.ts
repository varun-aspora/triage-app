// Checks for the SSFB overview, harbor and rhythm notes (T12.4): front-matter,
// the survey 05 contradictions resolved one way, the ID chain matching the
// D69 hops, tool calls with known names, known inputs and placeholder ids, and a
// '## Known issues' heading for the pattern index (T12.8) to cite.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KNOWN_ID_KEYS } from '../../src/types/core.ts';
import {
  KNOWLEDGE_DIR,
  KNOWN_TOOLS,
  lintText,
  parseFrontmatter,
  PLACEHOLDER,
  REPO_ROOT,
  toolsOutside,
  UNVERIFIED_MARKER,
} from './_util.ts';

const NOTES = ['ssfb-overview', 'ssfb-harbor', 'ssfb-rhythm'] as const;
type Note = (typeof NOTES)[number];

const read = (note: Note): string => readFileSync(join(KNOWLEDGE_DIR, note, 'SKILL.md'), 'utf8');
const TEXT: Record<Note, string> = {
  'ssfb-overview': read('ssfb-overview'),
  'ssfb-harbor': read('ssfb-harbor'),
  'ssfb-rhythm': read('ssfb-rhythm'),
};
const ALL = NOTES.map((n) => TEXT[n]).join('\n');

function parsed(note: Note) {
  const p = parseFrontmatter(TEXT[note]);
  if ('error' in p) throw new Error(`${note}: ${p.error}`);
  return p;
}

/** Lines of text that match re. */
const linesMatching = (text: string, re: RegExp): string[] => text.split('\n').filter((line) => re.test(line));

/** The markdown section that starts at the heading line, up to the next heading of the same or higher level. */
function section(text: string, heading: string): string {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l === heading);
  if (start < 0) throw new Error(`no heading ${heading}`);
  const level = /^#+/.exec(heading)![0].length;
  const end = lines.findIndex((l, i) => i > start && new RegExp(`^#{1,${level}} `).test(l));
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n');
}

// ------------------------------------------------------------ front-matter

describe('front-matter', () => {
  const expected: Record<Note, { kind: string; service?: string; sources: string[] }> = {
    'ssfb-overview': {
      kind: 'overview',
      sources: [
        'shivalik/AGENTS.md',
        'shivalik/NRI_ONBOARDING.md',
        'shivalik/audit/AGENTS.md',
        'shivalik/eventbus/AGENTS.md',
      ],
    },
    'ssfb-harbor': {
      kind: 'service',
      service: 'harbor',
      sources: ['shivalik/harbor/AGENTS.md', 'shivalik/NRI_ONBOARDING.md', 'shivalik/AGENTS.md'],
    },
    'ssfb-rhythm': {
      kind: 'service',
      service: 'rhythm',
      sources: ['shivalik/rhythm/AGENTS.md', 'shivalik/NRI_ONBOARDING.md', 'shivalik/AGENTS.md'],
    },
  };

  test.each([...NOTES])('%s has the expected name, kind, entity, service and sources', (note) => {
    const { frontmatter: fm } = parsed(note);
    const want = expected[note];
    expect(fm.name).toBe(note);
    expect(fm.metadata.kind).toBe(want.kind);
    expect(fm.metadata.entity).toBe('ssfb');
    expect(fm.metadata.service).toBe(want.service);
    expect(fm.metadata.status).toBe('ported');
    const sources = (fm.metadata.sources ?? '').split(',').map((s) => s.trim());
    expect(sources.sort()).toEqual([...want.sources].sort());
  });
});

// ------------------------------------------------------- legacy table names

// The survey 05 contradictions: the table is `customer`, the RFI table is
// rfi_requests_v3, and document_verifications replaced form_attachments.
const LEGACY_SQL: Array<[string, RegExp]> = [
  ['customers', /\b(?:FROM|JOIN)\s+customers\b/i],
  ['rfi_requests', /\b(?:FROM|JOIN)\s+rfi_requests\b(?!_v3)/i],
  ['form_attachments', /\b(?:FROM|JOIN)\s+form_attachments\b/i],
];

describe('legacy table detector', () => {
  test.each([
    ['customers', 'SELECT customer_id FROM customers WHERE account_form_id = $1'],
    ['customers', 'select * from\n  customers c'],
    ['rfi_requests', 'SELECT * FROM rfi_requests WHERE form_id = $1'],
    ['rfi_requests', 'SELECT 1 FROM x JOIN rfi_requests r ON true'],
    ['form_attachments', 'SELECT status FROM form_attachments WHERE form_id = $1'],
  ])('catches %s in %p', (name, sample) => {
    const re = LEGACY_SQL.find(([n]) => n === name)![1];
    expect(re.test(sample)).toBe(true);
  });

  test.each([
    'SELECT customer_id FROM customer WHERE account_form_id = $1',
    'SELECT * FROM customer_account_mappings WHERE customer_id = $1',
    'SELECT * FROM rfi_requests_v3 r JOIN rfi_items_v3 i ON i.rfi_id = r.rfi_id',
    'SELECT * FROM document_verifications WHERE form_id = $1',
  ])('passes %p', (sample) => {
    for (const [, re] of LEGACY_SQL) expect(re.test(sample)).toBe(false);
  });
});

describe('resolved contradictions', () => {
  test.each([...NOTES])('%s reads no legacy table', (note) => {
    for (const [, re] of LEGACY_SQL) expect(TEXT[note]).not.toMatch(re);
  });

  test('harbor names the current tables and the CIF lookup', () => {
    const harbor = TEXT['ssfb-harbor'];
    expect(harbor).toMatch(/`account_forms\.status_v2` is authoritative/);
    expect(harbor).toMatch(/FROM rfi_requests_v3\b/);
    expect(harbor).toMatch(/FROM document_verifications\b/);
    expect(harbor).toMatch(/`rfi_requests` is\s+legacy/);
    expect(harbor).toMatch(/`form_attachments` is legacy/);
    expect(harbor).toMatch(/encrypt_lookup_value\(\{ service: "harbor", value: "<cif>", kind: "cif" \}\)/);
    expect(harbor).toMatch(/`customer\.external_reference_id` holds the CIF, AES-SIV encrypted/);
  });

  test('status_v2 is the form status everywhere a form status is selected', () => {
    for (const note of NOTES) {
      for (const sql of sqlStrings(TEXT[note])) {
        if (/\bFROM account_forms\b/.test(sql)) expect(sql).toMatch(/\bstatus_v2\b/);
      }
    }
    expect(TEXT['ssfb-overview']).toMatch(/`status_v2` \(authoritative\)/);
  });

  test('submission_data is read from the workflow-op step-handler response, not decrypted', () => {
    const harbor = TEXT['ssfb-harbor'];
    expect(harbor).toMatch(/submission_data[\s\S]{0,200}workflow-op step-handler response/);
    expect(harbor).toMatch(/logs_search\(\{ service: "workflow", terms: \["<form_id>", "step-handler"\] \}\)/);
    expect(ALL).not.toMatch(/\bfle\b/);
    expect(ALL).not.toMatch(/decrypt_fields\([^)]*submission_data/);
  });

  test('guardian is named as the device and SIM binding owner', () => {
    expect(TEXT['ssfb-overview']).toMatch(/Guardian owns device and SIM binding, not harbor/);
    expect(TEXT['ssfb-overview']).toMatch(/\| Device binding, SIM binding, token scopes \| guardian \|/);
    expect(TEXT['ssfb-harbor']).toMatch(/Device and SIM binding belong to guardian, not harbor/);
    // No note gives binding to harbor.
    expect(ALL).not.toMatch(/harbor (?:owns|handles|does) (?:device|SIM) binding/i);
  });

  test('rhythm scaffolding tables are called empty', () => {
    expect(TEXT['ssfb-rhythm']).toMatch(/`sync_state`, `reconciliation_reports` and `cdc_events` are disabled\s+scaffolding with no rows/);
    expect(ALL).not.toMatch(/\bFROM (?:sync_states?|reconciliation_reports|cdc_events)\b/i);
  });

  // Each contradiction left open is marked unverified exactly once across the three notes.
  const UNVERIFIED_ONCE: Array<[string, RegExp]> = [
    ['x-customer-id is checked by adminV1', /Whether the header is checked is not known \(unverified: /],
    ['IMPS COMPLETED and SUCCESS both mean success', /`COMPLETED` and `SUCCESS`[\s\S]{0,120}\(unverified: /],
    ['harbor /v1/device/register is FCM only', /`\/v1\/device\/register` stores the app's FCM push token[\s\S]{0,80}\(unverified: /],
  ];

  test.each(UNVERIFIED_ONCE)('%s is marked unverified once', (_label, re) => {
    const hits = NOTES.filter((n) => re.test(TEXT[n]));
    expect(hits.length).toBe(1);
    const global = new RegExp(re.source, 'g');
    expect([...ALL.matchAll(global)].length).toBe(1);
  });

  test('the header is set by the tool, never passed by the model', () => {
    expect(TEXT['ssfb-rhythm']).toMatch(/`http_call` sets `x-customer-id` from the id chain; the model never passes it/);
    for (const call of toolCalls(ALL).filter((c) => c.tool === 'http_call')) {
      expect(call.text).not.toMatch(/x-customer-id|headers/);
    }
  });

  test('every unverified marker has a reason', () => {
    const markers = ALL.match(/\(unverified[^)]*\)/g) ?? [];
    expect(markers.length).toBeGreaterThan(0);
    for (const m of markers) expect(m).toMatch(new RegExp(`^${UNVERIFIED_MARKER.source}$`));
  });

  test('each resolved naming fact is stated with its basis once', () => {
    const basis = [
      /The customer table is `customer`, singular \(basis: /,
      /`rfi_requests` is\s+legacy and empty \(basis: /,
      /`form_attachments` is legacy\s+and empty \(basis: /,
      /Guardian owns device and SIM binding, not harbor \(basis: /,
    ];
    for (const re of basis) expect([...ALL.matchAll(new RegExp(re.source, 'g'))].length).toBe(1);
  });
});

// ----------------------------------------------------------------- ID chain

type Hop = { have: string; tables: string[]; query: string };

const SERVICE_TABLE = /\b(?:harbor|rhythm|guardian|workflow_op)\.[a-z_]+/g;

/** Rows of the first markdown table in text whose header starts with '| Have | Query'. */
function hopTable(text: string): Hop[] {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith('| Have | Query'));
  if (start < 0) throw new Error('no hop table');
  const rows: Hop[] = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith('|')) break;
    const cells = line.split(' | ').map((c) => c.replace(/^\|\s*|\s*\|$/g, ''));
    const have = /`([^`]+)`/.exec(cells[0] as string)?.[1] ?? (cells[0] as string);
    const query = cells[1] as string;
    rows.push({ have, tables: query.match(SERVICE_TABLE) ?? [], query });
  }
  return rows;
}

describe('ID chain', () => {
  // The hops of D69, in the order resolve_identity tries them
  // (src/tools/_lib/identity-core.ts). docs/04 §2.2 still shows the hops
  // from before D69, so the overview is checked against this list instead.
  const d69Hops: Omit<Hop, 'query'>[] = [
    { have: 'account_id', tables: ['rhythm.customer_account_mappings'] },
    { have: 'account_number', tables: ['rhythm.customer_account_mappings'] },
    { have: 'customer_id', tables: ['harbor.customer'] },
    { have: 'aspora_user_id', tables: ['harbor.account_forms'] },
    { have: 'account_form_id', tables: ['harbor.account_forms'] },
    { have: 'account_form_id', tables: ['harbor.customer'] },
    { have: 'customer_id', tables: ['rhythm.customer_account_mappings'] },
    { have: 'account_form_id', tables: ['workflow_op.workflow_executions'] },
  ];
  const ourHops = hopTable(section(TEXT['ssfb-overview'], '## ID chain'));

  test('the overview has the D69 hops, in the same order, over the same tables', () => {
    expect(ourHops.map((h) => ({ have: h.have, tables: h.tables }))).toEqual(d69Hops);
  });

  test('every hop starts from a known id key', () => {
    for (const h of ourHops) expect(KNOWN_ID_KEYS as readonly string[]).toContain(h.have);
  });

  test('the fallbacks are stated', () => {
    for (const key of ['account_id', 'account_number']) {
      expect(ourHops.find((h) => h.have === key)!.query).toContain(`WHERE ${key} = $1`);
    }
    const workflow = ourHops.find((h) => h.tables.includes('workflow_op.workflow_executions'))!;
    expect(workflow.query).toMatch(/SSFB copy; if empty, the RTL copy/);
  });

  test('the chain uses the singular customer table', () => {
    expect(ourHops.some((h) => h.tables.includes('harbor.customer'))).toBe(true);
    expect(TEXT['ssfb-overview']).not.toMatch(/harbor\.customers\b/);
  });

  test('audit and eventbus have their own section and no data access', () => {
    const s = section(TEXT['ssfb-overview'], '## Services with no triage data access');
    expect(s).toMatch(/\*\*audit\*\*/);
    expect(s).toMatch(/\*\*eventbus\*\*/);
    expect(s).toMatch(/no\s+database or API key for audit/);
    expect(s).toMatch(/No database is known\s+for it/);
  });
});

// --------------------------------------------------------------- tool calls

type Call = { tool: string; text: string; keys: string[] };

/** Top-level input keys the notes may use, per tool (HLD §2). */
const INPUT_KEYS: Record<string, readonly string[]> = {
  sql_select: ['service', 'sql', 'params'],
  http_call: ['service', 'path', 'method', 'query', 'body'],
  logs_search: [
    'service', 'message', 'error', 'terms', 'fields', 'from', 'to', 'level', 'max_hits', 'group_by', 'normalize', 'count',
  ],
  get_account_statement: ['account_id', 'from', 'to', 'page'],
  detect_silent_reversals: ['account_id', 'customer_id', 'since', 'limit'],
  encrypt_lookup_value: ['service', 'value', 'kind'],
  decrypt_fields: ['service', 'values'],
};

/** Every `name({ ... })` call in text, with its top-level keys. */
function toolCalls(text: string): Call[] {
  const calls: Call[] = [];
  for (const m of text.matchAll(/\b([a-z][a-z_]*)\(\{/g)) {
    let depth = 0;
    let end = (m.index as number) + m[1]!.length + 1;
    let inString = false;
    for (; end < text.length; end++) {
      const ch = text[end];
      if (ch === '"') inString = !inString;
      if (inString) continue;
      if (ch === '{') depth++;
      if (ch === '}' && --depth === 0) break;
    }
    const body = text.slice((m.index as number) + m[1]!.length + 2, end);
    let flat = body.replace(/"[^"]*"/g, '""');
    while (/\{[^{}]*\}/.test(flat)) flat = flat.replace(/\{[^{}]*\}/g, '');
    const keys = [...flat.matchAll(/(?:^|[,\s])([a-z_]+):/g)].map((k) => k[1] as string);
    calls.push({ tool: m[1] as string, text: text.slice(m.index as number, end + 2), keys });
  }
  return calls;
}

/** The sql strings of every sql_select call in text. */
function sqlStrings(text: string): string[] {
  return toolCalls(text)
    .filter((c) => c.tool === 'sql_select')
    .map((c) => /sql: "([^"]*)"/.exec(c.text)?.[1] ?? '');
}

describe('tool calls', () => {
  test('the call parser reads keys and ignores nested maps', () => {
    const [call] = toolCalls('logs_search({ service: "harbor", fields: { form_id: "<form_id>" }, from: "<from>" })');
    expect(call!.tool).toBe('logs_search');
    expect(call!.keys).toEqual(['service', 'fields', 'from']);
  });

  test('the harbor and rhythm notes phrase checks as tool calls', () => {
    for (const note of ['ssfb-harbor', 'ssfb-rhythm'] as const) {
      const tools = new Set(toolCalls(TEXT[note]).map((c) => c.tool));
      for (const t of ['sql_select', 'http_call', 'logs_search']) expect(tools.has(t)).toBe(true);
    }
  });

  test.each([...NOTES])('%s calls only known tools with known inputs', (note) => {
    for (const call of toolCalls(TEXT[note])) {
      expect(KNOWN_TOOLS.has(call.tool)).toBe(true);
      const allowed = INPUT_KEYS[call.tool];
      expect(allowed).toBeDefined();
      for (const key of call.keys) expect(allowed).toContain(key);
    }
  });

  test('the service notes mention only tools the SSFB investigator has', () => {
    expect(toolsOutside(TEXT['ssfb-harbor'], 'investigator', 'ssfb')).toEqual([]);
    expect(toolsOutside(TEXT['ssfb-rhythm'], 'investigator', 'ssfb')).toEqual([]);
  });

  test('the overview mentions only tools Triage has', () => {
    expect(toolsOutside(TEXT['ssfb-overview'], 'triage')).toEqual([]);
  });

  test('every service argument is a registry service key', () => {
    const registry = JSON.parse(readFileSync(join(REPO_ROOT, 'resources', 'ssfb.entity.json'), 'utf8')) as {
      services: Record<string, unknown>;
    };
    for (const call of toolCalls(ALL)) {
      const service = /service: "([^"]+)"/.exec(call.text)?.[1];
      if (service !== undefined) expect(Object.keys(registry.services)).toContain(service);
    }
  });

  test('sql is parameterised: $n placeholders with a matching params list, no quoted ids', () => {
    const calls = toolCalls(ALL).filter((c) => c.tool === 'sql_select');
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      const sql = /sql: "([^"]*)"/.exec(call.text)?.[1] ?? '';
      expect(sql).toMatch(/^(?:SELECT|WITH)\b/);
      expect(sql).not.toMatch(/'<[a-z_]+>'/);
      const max = Math.max(0, ...[...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
      const params = /params: \[([^\]]*)\]/.exec(call.text)?.[1];
      const count = params === undefined ? 0 : params.split(',').filter((p) => p.trim() !== '').length;
      expect(count).toBe(max);
    }
  });

  test('ids in calls are placeholders', () => {
    for (const call of toolCalls(ALL)) {
      for (const m of call.text.matchAll(/"(<[^"]*>)"/g)) {
        expect(m[1]).toMatch(new RegExp(`^${PLACEHOLDER.source}$`));
      }
    }
  });
});

// -------------------------------------------------------------- known issues

describe('known issues', () => {
  test.each<Note>(['ssfb-harbor', 'ssfb-rhythm'])('%s has one ## Known issues heading with entries', (note) => {
    expect(linesMatching(TEXT[note], /^## Known issues$/).length).toBe(1);
    const s = section(TEXT[note], '## Known issues');
    expect(linesMatching(s, /^### /).length).toBeGreaterThanOrEqual(3);
    expect(toolCalls(s).length).toBeGreaterThan(0);
  });

  test('the notes carry symptom-to-first-check tables', () => {
    for (const note of ['ssfb-harbor', 'ssfb-rhythm'] as const) {
      expect(TEXT[note]).toMatch(/^## Symptom to first check$/m);
      expect(TEXT[note]).toMatch(/^\| Symptom \| First check \|$/m);
    }
  });
});

// ------------------------------------------------------------------ hygiene

describe('hygiene', () => {
  test.each([...NOTES])('%s passes the knowledge lint', (note) => {
    expect(lintText(TEXT[note])).toEqual([]);
  });

  const BANNED: Array<[string, RegExp]> = [
    ['script path', /\.(?:sh|py)\b/],
    ['env var name', /\b(?:SSFB|SHIVALIK|LITBIT|FINACLE|RTL|ATSPL)_[A-Z0-9_]+/],
    ['env-shaped key', /\b[A-Z][A-Z0-9]*_[A-Z0-9_]*(?:_URL|_KEY|_TOKEN|_DSN|_CONN)\b/],
    ['local repo path', /\brepos\//],
    ['slash command', /(?:^|\s)\/aspora-/m],
    ['wrapper flag', /(?:^|\s)--(?:service|path|raw|from|to|since)\b/m],
  ];

  test.each(BANNED)('the detector for %s fires on a sample', (_label, re) => {
    const samples: Record<string, string> = {
      'script path': 'run lookup.sh first',
      'env var name': 'set SSFB_HARBOR_DB_URL',
      'env-shaped key': 'FIELD_ENCRYPTION_SECRET_KEY',
      'local repo path': 'see repos/harbor/internal',
      'slash command': 'use /aspora-logs-finder',
      'wrapper flag': 'search --service harbor',
    };
    expect(re.test(samples[_label] as string)).toBe(true);
  });

  test.each([...NOTES])('%s names no script, env var, local path or wrapper flag', (note) => {
    for (const [, re] of BANNED) expect(TEXT[note]).not.toMatch(re);
  });
});
