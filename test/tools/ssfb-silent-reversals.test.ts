import { afterEach, describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import type { PgQuery } from '../../src/connectors/sql/pg-client.ts';
import { redactModelFacing } from '../../src/gate/redact.ts';
import { validateSelect } from '../../src/gate/sql.ts';
import { conformanceProblems } from '../../src/tools/index.ts';
import { isReversalLeg, joinReversals, maskIds } from '../../src/tools/_lib/reversal-join.ts';
import {
  DetectSilentReversalsInputSchema,
  reversalWindow,
  toolModule,
  TRANSFER_SQL,
} from '../../src/tools/ssfb/detect-silent-reversals.tool.ts';
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
type FlagRow = { flag: string; utr: string | null; txn_ref_id: string | null; reversal_at: string | null; matched_legs: number };
function data(env: ToolEnvelope): Data {
  expect(v.is(ToolEnvelopeSchema, env)).toBe(true);
  expect(env.output.status).toBe('ok');
  return env.output.data as Data;
}
function flagOf(out: Data, ref: string): FlagRow | undefined {
  return (out['flags'] as FlagRow[]).find((r) => r.txn_ref_id === ref);
}

// ------------------------------------------------------------ synthetic data

const REVERSED_UTR = '600000000011';
const HEALTHY_UTR = '600000000021';

const DB_ROWS = [
  // DB says success; the statement has a reversal leg for its UTR.
  { txn_ref_id: 'TXA0001', status: 'SUCCESS', initiated_at: '2026-09-10T09:00:00Z', created_at: '2026-09-10T09:00:00Z', bank_identifier: REVERSED_UTR, failure_reason: null },
  // DB says success with no UTR.
  { txn_ref_id: 'TXB0002', status: 'SUCCESS', initiated_at: '2026-09-11T09:00:00Z', created_at: '2026-09-11T09:00:00Z', bank_identifier: null, failure_reason: null },
  // Healthy: its reference is spelled with REVERSED, and the leg has
  // returnCode and reversal_allowed keys. None of that is a reversal.
  { txn_ref_id: 'TXREVERSED21', status: 'SUCCESS', initiated_at: '2026-09-12T09:00:00Z', created_at: '2026-09-12T09:00:00Z', bank_identifier: HEALTHY_UTR, failure_reason: null },
];

const LEGS = [
  { created_at: '2026-09-10T09:00:05Z', transfer_type: 'IMPS', amount: 500, status: 'SUCCESS', narration: `IMPS/ASP/${REVERSED_UTR}/PAYMENT` },
  { created_at: '2026-09-10T09:02:40Z', transfer_type: 'IMPS', amount: 500, status: 'SUCCESS', narration: `REVERSED : IMPS/ASP/${REVERSED_UTR}/PAYMENT` },
  { created_at: '2026-09-11T09:00:05Z', transfer_type: 'IMPS', amount: 300, status: 'SUCCESS', txn_ref_id: 'TXB0002', narration: 'IMPS/ASP/PENDING/PAYMENT' },
  {
    created_at: '2026-09-12T09:00:05Z',
    transfer_type: 'IMPS',
    amount: 700,
    status: 'SUCCESS',
    returnCode: '00',
    reversal_allowed: true,
    is_reversed: false,
    narration: `IMPS/ASP/${HEALTHY_UTR}/TXREVERSED21`,
  },
  // A reversal no DB row matches: rhythm never stored its UTR.
  { created_at: '2026-09-13T09:05:00Z', transfer_type: 'IMPS', amount: 900, status: 'SUCCESS', narration: 'REVERSAL OF IMPS TX 600000000099' },
  // Not a reversal, though its own reference is spelled with RETURN.
  { created_at: '2026-09-14T09:00:00Z', transfer_type: 'NEFT', amount: 50, txn_ref_id: 'RETURN0042', narration: 'NEFT/RETURN0042/SALARY' },
];

function isDataStatement(q: PgQuery): boolean {
  return q.values !== undefined && q.text.includes('FROM transfer_transactions');
}

function realWorld(opts: Partial<WorldOptions> = {}): World {
  return world({
    mock: false,
    respond: () => json({ data: LEGS }),
    pgRespond: (q) => (isDataStatement(q) ? { rows: DB_ROWS, fields: Object.keys(DB_ROWS[0] ?? {}).map((name) => ({ name })) } : undefined),
    ...opts,
  });
}

// ------------------------------------------------------------ module and schema

describe('detect_silent_reversals module', () => {
  test('SSFB investigators only, and the conformance checks pass', () => {
    expect(toolModule.name).toBe('detect_silent_reversals');
    expect(toolModule.entities).toEqual(['ssfb']);
    expect(toolModule.mounts).toEqual(['investigator']);
    const w = world({ mock: true });
    expect(conformanceProblems(toolModule, toolModule.create(w.ctx, 'investigator'))).toEqual([]);
  });

  test('the schema has no path, SQL, service or entity field and refuses them as extras', () => {
    expect(Object.keys(DetectSilentReversalsInputSchema.entries).sort()).toEqual(['account_id', 'customer_id', 'limit', 'since']);
    const good = { account_id: ACCOUNT, customer_id: CUSTOMER };
    expect(v.safeParse(DetectSilentReversalsInputSchema, good).success).toBe(true);
    for (const extra of ['sql', 'path', 'service', 'entity', 'table', 'run_id']) {
      expect(v.safeParse(DetectSilentReversalsInputSchema, { ...good, [extra]: 'x' }).success).toBe(false);
    }
    for (const bad of [0, 201, 2.5]) {
      expect(v.safeParse(DetectSilentReversalsInputSchema, { ...good, limit: bad }).success).toBe(false);
    }
    expect(v.safeParse(DetectSilentReversalsInputSchema, { ...good, since: '2026/09/01' }).success).toBe(false);
  });

  test('the fixed statement passes the SQL gate and reads one table with two params', () => {
    const check = validateSelect(TRANSFER_SQL);
    expect(check.ok).toBe(true);
    if (check.ok) {
      expect(check.tables).toEqual(['transfer_transactions']);
      expect(check.paramCount).toBe(2);
    }
  });

  test('the window defaults to 30 days back and always ends today', () => {
    const now = new Date('2026-09-20T10:00:00Z');
    expect(reversalWindow(now)).toEqual({ since: '2026-08-21', until: '2026-09-20' });
    expect(reversalWindow(now, '2026-01-05')).toEqual({ since: '2026-01-05', until: '2026-09-20' });
  });
});

// ------------------------------------------------------------ the join through the tool

describe('flags', () => {
  test('REVERSED flag: DB success with a reversal leg in the statement', async () => {
    const w = realWorld();
    const out = data(await callTool(toolModule, w, { account_id: ACCOUNT, customer_id: CUSTOMER }, { harness: true }));
    const row = flagOf(out, 'TXA0001');
    expect(row?.flag).toBe('REVERSED');
    expect(row?.reversal_at).toBe('2026-09-10T09:02:40Z');
    expect(row?.matched_legs).toBe(2);
    expect((out['counts'] as Data)['reversed']).toBe(1);
    expect(typeof out['taken_at']).toBe('string');
    expect(out['flag_meanings']).toBeDefined();
    expect(out['staged_file']).toBe('/data/toolu_ssfb_1.json');

    // One fixed read-only plan, with the ids and the window as bind values.
    const statements = w.pg.selectClients().flatMap((c) => c.queries);
    expect(statements.map((q) => q.text.split('\n')[0])).toEqual([
      'BEGIN READ ONLY',
      `SET LOCAL statement_timeout = ${w.config.sql.statementTimeoutMs}`,
      `SET LOCAL lock_timeout = ${w.config.sql.lockTimeoutMs}`,
      'SELECT * FROM (SELECT txn_ref_id, status, initiated_at, created_at, bank_identifier, failure_reason',
      'COMMIT',
    ]);
    const dataStatement = statements.find(isDataStatement);
    expect(dataStatement?.values).toEqual([ACCOUNT, '2026-08-21', w.config.sql.maxRows]);
    expect(dataStatement?.text).not.toContain(ACCOUNT);

    // The statement window runs from since to today, with the customer header.
    expect(w.fetches.length).toBe(1);
    const url = w.fetches[0]?.url;
    expect(url?.pathname).toBe(`/rhythm/admin/v1/accounts/${ACCOUNT}/transactions`);
    expect(url?.searchParams.get('start_date')).toBe('2026-08-21');
    expect(url?.searchParams.get('end_date')).toBe('2026-09-20');
    expect((w.fetches[0]?.init.headers as Record<string, string>)['x-customer-id']).toBe(CUSTOMER);

    const line = w.audit.lines.filter((l) => l.tool === 'detect_silent_reversals');
    expect(line.length).toBe(1);
    expect(line[0]?.decision).toBe('allow');
    expect(line[0]?.summary_redacted).toContain('reversed=1');
  });

  test('a reversal on a transfer the DB already failed is not the headline flag', () => {
    const join = joinReversals([{ ...DB_ROWS[0], status: 'FAILED' }], LEGS);
    expect(join.rows[0]?.flag).toBe('REVERSED_NON_SUCCESS');
    expect(join.counts.reversed).toBe(0);
  });

  test('NO_UTR flag: DB success with no bank_identifier', async () => {
    const out = data(await callTool(toolModule, realWorld(), { account_id: ACCOUNT, customer_id: CUSTOMER }));
    expect(flagOf(out, 'TXB0002')?.flag).toBe('NO_UTR');
    expect((out['counts'] as Data)['no_utr']).toBe(1);
  });

  test('NO_MATCH when a success row has a UTR but no leg carries it', () => {
    const join = joinReversals([{ txn_ref_id: 'TXZ', status: 'COMPLETED', bank_identifier: '600000000777' }], LEGS);
    expect(join.rows[0]?.flag).toBe('NO_MATCH');
  });

  test('orphan leg: a reversal with no DB row is listed', async () => {
    const out = data(await callTool(toolModule, realWorld(), { account_id: ACCOUNT, customer_id: CUSTOMER }));
    const orphans = out['orphan_reversals'] as { narration: string }[];
    expect(orphans.length).toBe(1);
    expect(orphans[0]?.narration).toBe('REVERSAL OF IMPS TX 600000000099');
    expect((out['counts'] as Data)['orphan_reversals']).toBe(1);
  });

  test('an orphan found by the leg flag alone is listed too', () => {
    const join = joinReversals([], [{ amount: 10, is_reversed: true, narration: 'IMPS/ASP/600000000555' }]);
    expect(join.orphans.length).toBe(1);
  });

  test('healthy leg not flagged: a reference spelled with REVERSED is stripped before the match', async () => {
    const out = data(await callTool(toolModule, realWorld(), { account_id: ACCOUNT, customer_id: CUSTOMER }));
    const row = flagOf(out, 'TXREVERSED21');
    expect(row?.flag).toBe('OK');
    expect(row?.matched_legs).toBe(1);
    // Neither the healthy leg nor the NEFT leg whose own id reads RETURN is an orphan.
    expect((out['orphan_reversals'] as unknown[]).length).toBe(1);

    // The same leg would match if the ids were not stripped first.
    expect(isReversalLeg(LEGS[3])).toBe(true);
    expect(isReversalLeg(LEGS[3], [HEALTHY_UTR, 'TXREVERSED21'])).toBe(false);
    expect(maskIds(`IMPS/ASP/${HEALTHY_UTR}/TXREVERSED21`, ['TXREVERSED21'])).toBe(`IMPS/ASP/${HEALTHY_UTR}/`);
    // Key names such as returnCode are never matched: only narration text is.
    expect(isReversalLeg({ returnCode: 'RETURNED', reversal_allowed: true, narration: 'IMPS/ASP/1/PAY' })).toBe(false);
  });

  test('the bank wordings RVSL and RETURN count as reversals', () => {
    expect(isReversalLeg({ narration: 'RVSL IMPS 600000000011' })).toBe(true);
    expect(isReversalLeg({ remarks: 'RETURN OF IMPS 600000000011' })).toBe(true);
    expect(isReversalLeg({ narration: 'IMPS/ASP/600000000011/PAYMENT' })).toBe(false);
  });

  test('an unusable statement gives no join rather than NO_MATCH everywhere', async () => {
    const w = realWorld({ respond: () => json({ status: 'ok' }) });
    const out = data(await callTool(toolModule, w, { account_id: ACCOUNT, customer_id: CUSTOMER }));
    expect(out['flags']).toEqual([]);
    expect((out['statement'] as Data)['error']).toContain('no join was done');
    expect((out['counts'] as Data)['db_transfers']).toBe(3);
  });

  test('mock mode answers from the fixture and the output passes the model-facing profile', async () => {
    const w = world({
      mock: true,
      fixtures: [
        {
          kind: 'detect_silent_reversals',
          facts: { entity: 'ssfb', account_id: ACCOUNT, customer_id: CUSTOMER },
          result: {
            taken_at: '2026-09-19T08:00:00.000Z',
            since: '2026-08-20',
            until: '2026-09-19',
            db: { rows: DB_ROWS },
            statement: {
              limit: 100,
              pages: [
                {
                  page: 1,
                  status: 200,
                  body: { transactions: [...LEGS, { narration: 'RETURN to test.user@example.com card 4111111111111111' }] },
                },
              ],
            },
          },
        },
      ],
    });
    const out = data(await callTool(toolModule, w, { account_id: ACCOUNT, customer_id: CUSTOMER }));
    expect(out['taken_at']).toBe('2026-09-19T08:00:00.000Z');
    expect(flagOf(out, 'TXA0001')?.flag).toBe('REVERSED');
    expect(w.fetches.length).toBe(0);
    expect(w.pg.connects()).toBe(0);
    const text = JSON.stringify(out);
    expect(text).not.toContain('test.user@example.com');
    expect(text).not.toContain('4111111111111111');
    expect(redactModelFacing(out)).toEqual(out);
    expect(w.audit.lines.at(-1)?.transport).toBe('mock');
  });
});

// ------------------------------------------------------------ deny paths

describe('deny paths', () => {
  test('deny: an out-of-scope customer_id is refused and audited, with no query or request', async () => {
    const w = realWorld();
    const env = await callTool(toolModule, w, { account_id: ACCOUNT, customer_id: STRANGER });
    expect(env.output.status).toBe('refused');
    expect(w.fetches.length).toBe(0);
    expect(w.pg.connects()).toBe(0);
    const line = w.audit.lines.at(-1);
    expect(line?.decision).toBe('deny');
    expect(line?.tool).toBe('detect_silent_reversals');
    expect(JSON.stringify(w.audit.lines)).not.toContain(STRANGER);
  });

  test('deny: an out-of-scope account_id is refused', async () => {
    const w = realWorld();
    const env = await callTool(toolModule, w, { account_id: STRANGER, customer_id: CUSTOMER });
    expect(env.output.status).toBe('refused');
    expect(w.pg.connects()).toBe(0);
  });

  test('deny: a customer id token that is not id-shaped still has to be in the chain', async () => {
    const w = realWorld();
    const env = await callTool(toolModule, w, { account_id: ACCOUNT, customer_id: 'cust-xyz' });
    expect(env.output.status).toBe('refused');
    expect(env.output.message).toContain('customer_id is not in the ID chain');
    expect(w.audit.lines.at(-1)?.reason).toBe('scope: customer_id not in the id chain');
  });

  test('deny: since after today is refused', async () => {
    const w = realWorld();
    const env = await callTool(toolModule, w, { account_id: ACCOUNT, customer_id: CUSTOMER, since: '2026-12-01' });
    expect(env.output.status).toBe('refused');
    expect(w.pg.connects()).toBe(0);
  });

  test('deny: a block rule on the statement path refuses before the SQL runs', async () => {
    const w = realWorld({
      rules: [{ service: 'rhythm', method: 'GET', api: '/rhythm/admin/v1/accounts/*', action: 'block', reason: 'test block' }],
    });
    const env = await callTool(toolModule, w, { account_id: ACCOUNT, customer_id: CUSTOMER });
    expect(env.output.status).toBe('refused');
    expect(w.pg.connects()).toBe(0);
    expect(w.fetches.length).toBe(0);
  });

  test('not configured on blank rhythm DB, in real and mock mode', async () => {
    for (const mock of [false, true]) {
      const w = realWorld({ mock, env: { SSFB_RHYTHM_DB_URL: '' } });
      const env = await callTool(toolModule, w, { account_id: ACCOUNT, customer_id: CUSTOMER });
      expect(env.output.status).toBe('not_configured');
      expect(env.output.message).toBe('not configured for ssfb:rhythm');
      expect(w.pg.connects()).toBe(0);
      expect(w.fetches.length).toBe(0);
      expect(w.audit.lines.at(-1)?.target).toBe('SSFB_RHYTHM_DB_URL');
    }
  });

  test('not configured on blank rhythm API', async () => {
    const w = realWorld({ env: { SSFB_RHYTHM_API_URL: '' } });
    const env = await callTool(toolModule, w, { account_id: ACCOUNT, customer_id: CUSTOMER });
    expect(env.output.status).toBe('not_configured');
    expect(env.output.message).toBe('not configured for ssfb:rhythm');
    expect(w.audit.lines.at(-1)?.target).toBe('SSFB_RHYTHM_API_URL');
  });

  test('the DSN never reaches the output or the audit line', async () => {
    const w = realWorld();
    const env = await callTool(toolModule, w, { account_id: ACCOUNT, customer_id: CUSTOMER });
    const text = JSON.stringify(env) + JSON.stringify(w.audit.lines);
    for (const part of ['FakePw123', 'rhythm-db.test.invalid', 'rhythm.test.invalid']) expect(text).not.toContain(part);
  });
});
