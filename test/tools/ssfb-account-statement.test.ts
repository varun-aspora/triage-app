import { afterEach, describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { conformanceProblems } from '../../src/tools/index.ts';
import { findStatementItems, normaliseLeg } from '../../src/tools/_lib/reversal-join.ts';
import {
  GetAccountStatementInputSchema,
  noMorePages,
  STATEMENT_MAX_PAGES,
  STATEMENT_MODEL_ROWS,
  STATEMENT_PAGE_SIZE,
  toolModule,
} from '../../src/tools/ssfb/get-account-statement.tool.ts';
import { redactModelFacing } from '../../src/gate/redact.ts';
import { ToolEnvelopeSchema, type ToolEnvelope } from '../../src/types/tool-result.ts';
import { ACCOUNT, callTool, CUSTOMER, json, makeWorld, STRANGER, type World, type WorldOptions } from './ssfb-harness.ts';

const worlds: World[] = [];
afterEach(() => {
  for (const w of worlds.splice(0)) w.cleanup();
});
function world(opts: WorldOptions): World {
  const w = makeWorld(opts);
  worlds.push(w);
  return w;
}

type Data = Record<string, unknown>;
function data(env: ToolEnvelope): Data {
  expect(v.is(ToolEnvelopeSchema, env)).toBe(true);
  expect(env.output.status).toBe('ok');
  return env.output.data as Data;
}

function leg(i: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    created_at: `2026-09-${String(1 + (i % 28)).padStart(2, '0')}T10:00:00Z`,
    transfer_type: 'IMPS',
    amount: 100 + i,
    status: 'SUCCESS',
    txn_ref_id: `TXREF${String(i).padStart(6, '0')}`,
    bank_identifier: `6000000${String(i).padStart(5, '0')}`,
    narration: `IMPS/ASP/6000000${String(i).padStart(5, '0')}/PAYMENT`,
    ...extra,
  };
}
const legs = (n: number, from = 0): Record<string, unknown>[] => Array.from({ length: n }, (_, i) => leg(from + i));

// ------------------------------------------------------------ module shape

describe('get_account_statement module', () => {
  test('SSFB investigators only, and the conformance checks pass', () => {
    expect(toolModule.name).toBe('get_account_statement');
    expect(toolModule.entities).toEqual(['ssfb']);
    expect(toolModule.mounts).toEqual(['investigator']);
    const w = world({ mock: true });
    const tool = toolModule.create(w.ctx, 'investigator');
    expect(tool.name).toBe('get_account_statement');
    expect(conformanceProblems(toolModule, tool)).toEqual([]);
  });

  test('the schema has no path, SQL, service or entity field and refuses them as extras', () => {
    const keys = Object.keys(GetAccountStatementInputSchema.entries).sort();
    expect(keys).toEqual(['account_id', 'from', 'page', 'to']);
    for (const extra of ['path', 'sql', 'service', 'entity', 'url', 'run_id']) {
      expect(v.safeParse(GetAccountStatementInputSchema, { account_id: ACCOUNT, [extra]: 'x' }).success).toBe(false);
    }
    expect(v.safeParse(GetAccountStatementInputSchema, { account_id: ACCOUNT }).success).toBe(true);
  });

  test('deny: the schema refuses an account id that is not an id token, and bad dates and pages', () => {
    for (const bad of ['../etc', 'a/b', 'a?b', 'a b', '', 'x'.repeat(65)]) {
      expect(v.safeParse(GetAccountStatementInputSchema, { account_id: bad }).success).toBe(false);
    }
    for (const bad of ['2026-13-01', '2026-02-30', '20260901', 'yesterday']) {
      expect(v.safeParse(GetAccountStatementInputSchema, { account_id: ACCOUNT, from: bad }).success).toBe(false);
    }
    for (const bad of [0, -1, 1.5, 100_000]) {
      expect(v.safeParse(GetAccountStatementInputSchema, { account_id: ACCOUNT, page: bad }).success).toBe(false);
    }
  });
});

// ------------------------------------------------------------ pagination

describe('pagination', () => {
  test('walks two pages: a full first page and a short second page', async () => {
    const w = world({
      mock: false,
      respond: (url) => {
        const page = Number(url.searchParams.get('page'));
        return page === 1 ? json({ data: legs(STATEMENT_PAGE_SIZE) }) : json({ data: legs(3, STATEMENT_PAGE_SIZE) });
      },
    });
    const out = data(await callTool(toolModule, w, { account_id: ACCOUNT, from: '2026-09-01', to: '2026-09-20' }, { harness: true }));

    expect(w.fetches.length).toBe(2);
    const [first, second] = w.fetches;
    expect(first?.url.pathname).toBe(`/rhythm/admin/v1/accounts/${ACCOUNT}/transactions`);
    expect(first?.url.origin).toBe('https://rhythm.test.invalid');
    expect(first?.url.searchParams.get('page')).toBe('1');
    expect(second?.url.searchParams.get('page')).toBe('2');
    expect(first?.url.searchParams.get('limit')).toBe(String(STATEMENT_PAGE_SIZE));
    expect(first?.url.searchParams.get('start_date')).toBe('2026-09-01');
    expect(first?.url.searchParams.get('end_date')).toBe('2026-09-20');
    expect(first?.init.method).toBe('GET');
    // The customer header comes from the IdChain, not from the model.
    expect((first?.init.headers as Record<string, string>)['x-customer-id']).toBe(CUSTOMER);

    expect(out['pages_fetched']).toBe(2);
    expect(out['more_available']).toBe(false);
    expect(out['transaction_count']).toBe(STATEMENT_PAGE_SIZE + 3);
    expect((out['transactions'] as unknown[]).length).toBe(STATEMENT_MODEL_ROWS);
    expect(out['transactions_truncated']).toBe(true);
    expect(out['shape']).toBe('data');
    expect(typeof out['taken_at']).toBe('string');
    expect(out['staged_file']).toBe('/data/toolu_ssfb_1.json');

    // The staged file holds every transaction.
    expect(w.staged.length).toBe(1);
    const staged = JSON.parse(w.staged[0]?.text ?? '{}') as { transactions: unknown[] };
    expect(staged.transactions.length).toBe(STATEMENT_PAGE_SIZE + 3);

    const lines = w.audit.lines.filter((l) => l.tool === 'get_account_statement');
    expect(lines.length).toBe(1);
    expect(lines[0]?.decision).toBe('allow');
    expect(lines[0]?.transport).toBe('real');
    expect(lines[0]?.target).toBe('SSFB_RHYTHM_API_URL');
  });

  test('stops at the page cap and says more is available', async () => {
    const w = world({ mock: false, respond: () => json({ transactions: legs(STATEMENT_PAGE_SIZE) }) });
    const out = data(await callTool(toolModule, w, { account_id: ACCOUNT }));
    expect(w.fetches.length).toBe(STATEMENT_MAX_PAGES);
    expect(out['more_available']).toBe(true);
  });

  test('stops when the page says there is no next page', async () => {
    const w = world({
      mock: false,
      respond: () => json({ data: { items: legs(STATEMENT_PAGE_SIZE) }, pagination: { has_more: false } }),
    });
    const out = data(await callTool(toolModule, w, { account_id: ACCOUNT }));
    expect(w.fetches.length).toBe(1);
    expect(out['more_available']).toBe(false);
    expect(noMorePages({ meta: { total_pages: 3 } }, 3)).toBe(true);
    expect(noMorePages({ meta: { total_pages: 3 } }, 2)).toBe(false);
    expect(noMorePages({ next: null }, 1)).toBe(true);
    expect(noMorePages({ data: [] }, 1)).toBeUndefined();
  });

  test('a page asked for reads that page only', async () => {
    const w = world({ mock: false, respond: () => json(legs(STATEMENT_PAGE_SIZE)) });
    const out = data(await callTool(toolModule, w, { account_id: ACCOUNT, page: 3 }));
    expect(w.fetches.length).toBe(1);
    expect(w.fetches[0]?.url.searchParams.get('page')).toBe('3');
    expect(out['page']).toBe(3);
  });

  test('a non-2xx page is reported as an error with a scrubbed excerpt of its body', async () => {
    const w = world({
      mock: false,
      respond: () => json({ message: 'account missing', upstream: 'https://core.internal/x', auth: 'Bearer abcdefgh12345678' }, 404),
    });
    const out = data(await callTool(toolModule, w, { account_id: ACCOUNT }));
    expect(String(out['error'])).toStartWith('rhythm answered HTTP 404 on page 1: ');
    expect(String(out['error'])).toContain('account missing');
    expect(String(out['error'])).not.toContain('core.internal');
    expect(String(out['error'])).not.toContain('abcdefgh12345678');
    expect(out['transaction_count']).toBe(0);
  });

  test('a long non-2xx body is capped', async () => {
    const w = world({ mock: false, respond: () => json({ message: 'x'.repeat(5000) }, 500) });
    const out = data(await callTool(toolModule, w, { account_id: ACCOUNT }));
    expect(String(out['error']).length).toBeLessThan(400);
  });
});

// ------------------------------------------------------------ response shapes

describe('response-shape variants', () => {
  const one = {
    created_at: '2026-09-02T10:00:00Z',
    transfer_type: 'IMPS',
    amount: 250,
    status: 'SUCCESS',
    is_reversed: false,
    txn_ref_id: 'TXREF000001',
    bank_identifier: '600000000001',
    narration: 'IMPS/ASP/600000000001/PAYMENT',
  };
  const expected = {
    created_at: '2026-09-02T10:00:00Z',
    type: 'IMPS',
    amount: '250',
    status: 'SUCCESS',
    reversed: false,
    txn_ref_id: 'TXREF000001',
    bank_identifier: '600000000001',
    narration: 'IMPS/ASP/600000000001/PAYMENT',
  };

  const bodies: [string, unknown][] = [
    ['array', [one]],
    ['transactions', { transactions: [one] }],
    ['data', { data: [one] }],
    ['items', { items: [one] }],
    ['results', { results: [one] }],
    ['data.transactions', { data: { transactions: [one] } }],
    ['data.items', { data: { items: [one] } }],
    ['results.data', { results: { data: [one] }, total: 1 }],
    ['transactions', { data: { count: 1 }, transactions: [one] }],
  ];

  test('every wrapper the script probed yields the same array', () => {
    for (const [shape, body] of bodies) {
      const found = findStatementItems(body);
      expect(found.ok).toBe(true);
      if (found.ok) {
        expect(found.shape).toBe(shape);
        expect(found.items.map(normaliseLeg)).toEqual([expected]);
      }
    }
  });

  test('field spellings normalise to one shape', () => {
    const camel = {
      createdAt: '2026-09-02T10:00:00Z',
      transferType: 'IMPS',
      txn_amount: '250',
      txn_status: 'SUCCESS',
      reversed: 'false',
      ref_transaction_id: 'TXREF000001',
      utr: '600000000001',
      description: 'IMPS/ASP/600000000001/PAYMENT',
    };
    const other = {
      transaction_date: '2026-09-02T10:00:00Z',
      txn_type: 'IMPS',
      amount_value: 250,
      state: 'SUCCESS',
      is_reversed: 0,
      reference_id: 'TXREF000001',
      rrn: '600000000001',
      remarks: 'IMPS/ASP/600000000001/PAYMENT',
    };
    expect(normaliseLeg(camel)).toEqual(expected);
    expect(normaliseLeg(other)).toEqual(expected);
    // Blank values fall through to the next spelling, as in the script.
    expect(normaliseLeg({ ...camel, created_at: '', createdAt: '2026-09-02T10:00:00Z' }).created_at).toBe(
      '2026-09-02T10:00:00Z',
    );
    expect(normaliseLeg({ is_reversed: 'REVERSED' }).reversed).toBe(true);
    expect(normaliseLeg({ is_reversed: { at: 'x' } }).reversed).toBeNull();
    expect(normaliseLeg({ amount: 1 }).reversed).toBeNull();
  });

  test('a body with no array and a text body are errors, not empty results', () => {
    expect(findStatementItems({ status: 'ok', count: 0 })).toEqual({ ok: false, reason: 'no_array', top_level_keys: ['status', 'count'] });
    expect(findStatementItems('<html>gateway error</html>')).toEqual({ ok: false, reason: 'not_json', top_level_keys: [] });
    expect(findStatementItems(null).ok).toBe(false);
  });

  test('through the tool in mock mode, each shape gives the same transactions', async () => {
    for (const [, body] of bodies) {
      const w = world({
        mock: true,
        fixtures: [
          {
            kind: 'get_account_statement',
            facts: { entity: 'ssfb', account_id: ACCOUNT },
            result: { limit: 100, pages: [{ page: 1, status: 200, body }], taken_at: '2026-09-19T08:00:00.000Z' },
          },
        ],
      });
      const out = data(await callTool(toolModule, w, { account_id: ACCOUNT }));
      expect(out['transactions']).toEqual([expected]);
      expect(out['taken_at']).toBe('2026-09-19T08:00:00.000Z');
      expect(w.fetches.length).toBe(0);
    }
  });

  test('an unusable page is reported with its top-level keys only', async () => {
    const w = world({
      mock: true,
      fixtures: [
        {
          kind: 'get_account_statement',
          facts: { entity: 'ssfb', account_id: ACCOUNT },
          result: { limit: 100, pages: [{ page: 1, status: 200, body: { status: 'ok', secret_note: 'hidden text' } }] },
        },
      ],
    });
    const out = data(await callTool(toolModule, w, { account_id: ACCOUNT }));
    expect(out['error']).toBe('page 1 has no transactions array (top-level keys: status, secret_note)');
    expect(JSON.stringify(out)).not.toContain('hidden text');
  });

  test('output values pass the model-facing profile', async () => {
    const w = world({
      mock: true,
      fixtures: [
        {
          kind: 'get_account_statement',
          facts: { entity: 'ssfb', account_id: ACCOUNT },
          result: {
            limit: 100,
            pages: [{ page: 1, status: 200, body: [{ ...one, narration: 'refund to test.user@example.com card 4111111111111111' }] }],
          },
        },
      ],
    });
    const env = await callTool(toolModule, w, { account_id: ACCOUNT });
    const out = data(env);
    const text = JSON.stringify(out);
    expect(text).not.toContain('test.user@example.com');
    expect(text).not.toContain('4111111111111111');
    expect(redactModelFacing(out)).toEqual(out);
  });
});

// ------------------------------------------------------------ deny paths

describe('deny paths', () => {
  test('deny: an out-of-scope account_id is refused and audited, with no request', async () => {
    const w = world({ mock: false });
    const env = await callTool(toolModule, w, { account_id: STRANGER });
    expect(env.output.status).toBe('refused');
    expect(w.fetches.length).toBe(0);
    const line = w.audit.lines.at(-1);
    expect(line?.decision).toBe('deny');
    expect(line?.tool).toBe('get_account_statement');
    expect(JSON.stringify(w.audit.lines)).not.toContain(STRANGER);
  });

  test('deny: an account id token that is not id-shaped still has to be in the chain', async () => {
    const w = world({ mock: false });
    const env = await callTool(toolModule, w, { account_id: 'acct-xyz' });
    expect(env.output.status).toBe('refused');
    expect(env.output.message).toContain('account_id is not in the ID chain');
    expect(w.fetches.length).toBe(0);
    expect(w.audit.lines.at(-1)?.decision).toBe('deny');
    expect(w.audit.lines.at(-1)?.reason).toBe('scope: account_id not in the id chain');
  });

  test('deny: a from date after the to date is refused', async () => {
    const w = world({ mock: false });
    const env = await callTool(toolModule, w, { account_id: ACCOUNT, from: '2026-09-10', to: '2026-09-01' });
    expect(env.output.status).toBe('refused');
    expect(w.fetches.length).toBe(0);
  });

  test('deny: extra fields such as path are refused before any request', async () => {
    const w = world({ mock: false });
    const env = await callTool(toolModule, w, { account_id: ACCOUNT, path: '/admin/v1/other' });
    expect(env.output.status).toBe('refused');
    expect(w.fetches.length).toBe(0);
  });

  test('deny: a block rule on the statement path is honoured', async () => {
    const w = world({
      mock: false,
      rules: [{ service: 'rhythm', method: 'GET', api: '/rhythm/admin/v1/accounts/*', action: 'block', reason: 'test block' }],
    });
    const env = await callTool(toolModule, w, { account_id: ACCOUNT });
    expect(env.output.status).toBe('refused');
    expect(w.fetches.length).toBe(0);
    const line = w.audit.lines.at(-1);
    expect(line?.decision).toBe('deny');
    expect(line?.rule_index).toBe(0);
    expect(line?.action).toBe('block');
  });

  test('not configured on blank rhythm API, in real and mock mode', async () => {
    for (const mock of [false, true]) {
      const w = world({ mock, env: { SSFB_RHYTHM_API_URL: '' } });
      const env = await callTool(toolModule, w, { account_id: ACCOUNT });
      expect(env.output.status).toBe('not_configured');
      expect(env.output.message).toBe('not configured for ssfb:rhythm');
      expect(w.fetches.length).toBe(0);
      const line = w.audit.lines.at(-1);
      expect(line?.decision).toBe('deny');
      expect(line?.target).toBe('SSFB_RHYTHM_API_URL');
    }
  });

  test('a run with no http connector answers not configured in real mode', async () => {
    const w = world({ mock: false, withoutConnectors: true });
    const env = await callTool(toolModule, w, { account_id: ACCOUNT });
    expect(env.output.status).toBe('not_configured');
  });
});
