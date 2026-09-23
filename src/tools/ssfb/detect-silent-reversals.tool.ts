// detect_silent_reversals: rhythm transfer_transactions joined with the
// account statement (D29, HLD 02 §2). A port of transfer_lifecycle.sh.
//
// transfer_transactions.status is wrong for reversed IMPS: rhythm marks the
// transfer SUCCESS and never sees the reversal CBS posts minutes later. The
// reversal is only in the statement, so this tool reads both and joins them
// in code (src/tools/_lib/reversal-join.ts) instead of asking the model to.
//
// - One fixed parameterised SELECT on rhythm transfer_transactions (account
//   id and window start as $1 and $2, row cap as $3), run as the read-only
//   transaction plan through the SQL connector.
// - The same statement read as get_account_statement, from `since` to today,
//   because a reversal posts after the debit even when `since` is old.
// - account_id and customer_id must be in the run's ID chain; customer_id is
//   sent as x-customer-id.
// - A blank SSFB_RHYTHM_DB_URL or SSFB_RHYTHM_API_URL answers
//   'not configured for ssfb:rhythm'.
// - The output carries taken_at, the flag table, the orphan reversal legs and
//   what each flag means. The full table is staged to /data.

import type { FlueLogger } from '@flue/runtime';
import { defineTool, type ToolDefinition } from '@flue/runtime/tool';
import * as v from 'valibot';
import { ConnectorError } from '../../connectors/types.ts';
import { validateSelect } from '../../gate/sql.ts';
import { buildReadOnlyTxn, wrapWithCap } from '../../gate/sql-txn.ts';
import { semanticKey } from '../../mock/key.ts';
import type { ToolEnvelope } from '../../types/tool-result.ts';
import { type BackingRef, type GateDecision, runIoTool, type StagingHarness } from '../_lib/pipeline.ts';
import { type DbTransfer, FLAG_MEANINGS, joinReversals, NARRATION_KEYS, REVERSAL_PATTERN } from '../_lib/reversal-join.ts';
import type { ToolContext, ToolDeps, ToolModule } from '../types.ts';
import {
  connectorContext,
  DateSchema,
  decideStatement,
  fetchStatement,
  IdTokenSchema,
  inIdChain,
  outOfChain,
  readStatement,
  RHYTHM,
  rhythmApiBacking,
  rhythmApiBase,
  rhythmDbBacking,
  SSFB,
  SSFB_MOUNTS,
  ssfbRules,
  STATEMENT_PAGE_SIZE,
  statementGate,
  StatementFetchSchema,
} from './get-account-statement.tool.ts';

export const DETECT_SILENT_REVERSALS = 'detect_silent_reversals';

/** Days before today the window starts when `since` is left out. */
export const DEFAULT_SINCE_DAYS = 30;
/** Highest statement page size the model may ask for. */
export const MAX_STATEMENT_LIMIT = 200;
/** Flag rows and orphan legs the model sees; the rest are in the staged file. */
export const MODEL_FLAG_ROWS = 100;
export const MODEL_ORPHANS = 20;

/** The only table the statement reads. */
export const TRANSFER_TABLE = 'transfer_transactions';

/**
 * The fixed statement. Only columns attested for transfer_transactions are
 * read; amount and transfer type come from the statement instead.
 */
export const TRANSFER_SQL = [
  'SELECT txn_ref_id, status, initiated_at, created_at, bank_identifier, failure_reason',
  `FROM ${TRANSFER_TABLE}`,
  'WHERE account_id = $1 AND initiated_at >= $2',
  'ORDER BY initiated_at DESC',
].join('\n');

export const DetectSilentReversalsInputSchema = v.strictObject({
  account_id: v.pipe(
    IdTokenSchema,
    v.description(
      'Rhythm account id (customer_account_mappings.account_id), not the CBS account number. Must be in the ID chain.',
    ),
  ),
  customer_id: v.pipe(
    IdTokenSchema,
    v.description('Harbor customer_id for the account, sent as x-customer-id. Must be in the ID chain.'),
  ),
  since: v.optional(
    v.pipe(DateSchema, v.description(`Window start, YYYY-MM-DD. Default ${DEFAULT_SINCE_DAYS} days ago. The window always ends today.`)),
  ),
  limit: v.optional(
    v.pipe(
      v.number(),
      v.integer(),
      v.minValue(1),
      v.maxValue(MAX_STATEMENT_LIMIT),
      v.description(`Statement page size, default ${STATEMENT_PAGE_SIZE}. Raise it for a busy account.`),
    ),
  ),
});
export type DetectSilentReversalsInput = v.InferOutput<typeof DetectSilentReversalsInputSchema>;

const DbRowsSchema = v.object({
  rows: v.array(v.record(v.string(), v.unknown())),
  /** True when the row cap or the size cap cut the rows. */
  capped: v.optional(v.boolean(), false),
});

/** What real() returns and what a fixture holds: the two raw sources. */
export const SilentReversalsAnswerSchema = v.object({
  taken_at: v.optional(v.string()),
  since: v.string(),
  until: v.string(),
  db: DbRowsSchema,
  statement: StatementFetchSchema,
});
export type SilentReversalsAnswer = v.InferOutput<typeof SilentReversalsAnswerSchema>;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** The window: since (or DEFAULT_SINCE_DAYS ago) to today, UTC dates. */
export function reversalWindow(now: Date, since?: string): { since: string; until: string } {
  const until = isoDate(now);
  const start = since ?? isoDate(new Date(now.getTime() - DEFAULT_SINCE_DAYS * 86_400_000));
  return { since: start, until };
}

/** Both env vars must be set; the DB is checked first. */
function backingFor(ctx: ToolContext): BackingRef {
  const db = rhythmDbBacking(ctx);
  if (db.status !== 'ok') return db;
  return rhythmApiBacking(ctx);
}

const COVERAGE_NOTE =
  `Reversals are found in the narration text of each statement leg (${NARRATION_KEYS.slice(0, 3).join('/')} and ` +
  `${NARRATION_KEYS.length - 3} other spellings) with /${REVERSAL_PATTERN}/i, after the UTR and reference are ` +
  'stripped out, or from the leg\'s own reversal flag. No REVERSED row means no match in those fields, not a ' +
  'guarantee that nothing reversed.';

type RunInput = {
  readonly data: unknown;
  readonly signal?: AbortSignal;
  readonly toolCallId: string;
  readonly log: FlueLogger;
  readonly harness?: StagingHarness;
};

function parseAnswer(value: unknown): SilentReversalsAnswer {
  const parsed = v.safeParse(SilentReversalsAnswerSchema, value);
  if (!parsed.success) throw new Error(`${DETECT_SILENT_REVERSALS}: the answer has the wrong shape`);
  return parsed.output;
}

function takenAt(answer: SilentReversalsAnswer, deps: ToolDeps): string {
  const t = answer.taken_at;
  return t !== undefined && !Number.isNaN(Date.parse(t)) ? t : deps.now().toISOString();
}

type Joined = {
  readonly answer: SilentReversalsAnswer;
  readonly statement: ReturnType<typeof readStatement>;
  readonly join: ReturnType<typeof joinReversals> | null;
};

function joined(value: unknown): Joined {
  const answer = parseAnswer(value);
  const statement = readStatement(answer.statement, DETECT_SILENT_REVERSALS);
  // With an unusable statement every success row would read NO_MATCH, which
  // is wrong, so there is no join.
  const join = statement.error === null ? joinReversals(answer.db.rows as DbTransfer[], statement.legs) : null;
  return { answer, statement, join };
}

async function runDetect(ctx: ToolContext, flue: RunInput): Promise<ToolEnvelope> {
  const deps = ctx.deps;
  const parsed = v.safeParse(DetectSilentReversalsInputSchema, flue.data);
  const input: Partial<DetectSilentReversalsInput> = parsed.success ? parsed.output : {};
  const accountId = input.account_id ?? '';
  const customerId = input.customer_id ?? '';
  const limit = input.limit ?? STATEMENT_PAGE_SIZE;
  const window = reversalWindow(deps.now(), input.since);

  const gate = (): GateDecision => {
    if (!parsed.success) {
      return { ok: false, message: 'Refused: the input does not match the schema.', reason: 'input failed the schema' };
    }
    if (!inIdChain(deps, accountId)) return outOfChain('account_id');
    if (!inIdChain(deps, customerId)) return outOfChain('customer_id');
    if (window.since > window.until) {
      return { ok: false, message: 'Refused: since is after today.', reason: 'date window reversed' };
    }
    const check = validateSelect(TRANSFER_SQL);
    if (!check.ok || check.paramCount !== 2) {
      return { ok: false, message: 'Refused: the fixed statement did not pass the SQL gate.', reason: 'fixed sql refused' };
    }
    const base = rhythmApiBase(ctx);
    // A blank base is answered by the not-configured step that follows.
    if (base === undefined) return { ok: true };
    const rules = ssfbRules(ctx);
    if (!rules.ok) return rules.gate;
    return statementGate(decideStatement(base, rules.rules, { accountId, page: 1, limit, from: window.since, to: window.until }));
  };

  return runIoTool<'detect_silent_reversals', SilentReversalsAnswer>(
    {
      tool: DETECT_SILENT_REVERSALS,
      service: RHYTHM,
      input: flue.data,
      entity: SSFB,
      backing: backingFor(ctx),
      scope: {},
      gate,
      fixture: () => ({
        kind: 'detect_silent_reversals',
        entity: SSFB,
        key: semanticKey('detect_silent_reversals', {
          entity: SSFB,
          account_id: accountId,
          customer_id: customerId,
          ...(input.since !== undefined ? { since: input.since } : {}),
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
        }),
      }),
      real: async (signal) => {
        const { sql, http } = deps.connectors;
        if (sql === undefined) throw new ConnectorError('not_configured', 'no sql connector for this run');
        if (http === undefined) throw new ConnectorError('not_configured', 'no http connector for this run');
        const base = rhythmApiBase(ctx);
        if (base === undefined) throw new ConnectorError('not_configured', 'ssfb:rhythm API is blank');
        const rules = ssfbRules(ctx);
        if (!rules.ok) throw new ConnectorError('refused', 'ssfb rules file did not load');
        const taken_at = deps.now().toISOString();

        const cap = ctx.config.sql.maxRows;
        const capped = wrapWithCap(TRANSFER_SQL, 2);
        const plan = buildReadOnlyTxn(
          { statementTimeoutMs: ctx.config.sql.statementTimeoutMs, lockTimeoutMs: ctx.config.sql.lockTimeoutMs },
          capped.sql,
        );
        const params = [accountId, window.since, cap];
        const db = await sql.runSelect(connectorContext(ctx, signal), {
          entity: SSFB,
          service: RHYTHM,
          plan,
          params,
          keyInput: { entity: SSFB, service: RHYTHM, tables: [TRANSFER_TABLE], params },
        });
        if (db.fixture_miss === true) throw new ConnectorError('refused', 'the sql connector answered from fixtures');
        signal.throwIfAborted();

        const statement = await fetchStatement({
          ctx,
          http,
          base,
          rules: rules.rules,
          accountId,
          customerId,
          from: window.since,
          to: window.until,
          limit,
          signal,
        });
        return {
          taken_at,
          since: window.since,
          until: window.until,
          db: { rows: db.data.rows.map((r) => ({ ...r })), capped: db.truncated === true || db.data.row_count >= cap },
          statement,
        };
      },
      render: (value) => {
        const { answer, statement, join } = joined(value);
        const rows = join?.rows ?? [];
        const orphans = join?.orphans ?? [];
        return {
          account_id: accountId,
          customer_id: customerId,
          since: answer.since,
          until: answer.until,
          taken_at: takenAt(answer, deps),
          counts: join?.counts ?? {
            db_transfers: answer.db.rows.length,
            statement_legs: statement.legs.length,
          },
          db_rows_capped: answer.db.capped,
          statement: {
            pages_fetched: statement.pages_fetched,
            more_available: statement.more_available,
            shape: statement.shape,
            ...(statement.error !== null ? { error: `${statement.error}; no join was done` } : {}),
          },
          flags: rows.slice(0, MODEL_FLAG_ROWS),
          flags_truncated: rows.length > MODEL_FLAG_ROWS,
          orphan_reversals: orphans.slice(0, MODEL_ORPHANS),
          orphans_truncated: orphans.length > MODEL_ORPHANS,
          flag_meanings: FLAG_MEANINGS,
          note: COVERAGE_NOTE,
        };
      },
      stage: (value) => {
        const { answer, join } = joined(value);
        return {
          account_id: accountId,
          since: answer.since,
          until: answer.until,
          taken_at: takenAt(answer, deps),
          flags: join?.rows ?? [],
          orphan_reversals: join?.orphans ?? [],
        };
      },
      summary: (value) => {
        const { join } = joined(value);
        const c = join?.counts;
        return c === undefined
          ? `${DETECT_SILENT_REVERSALS} ssfb:rhythm statement unusable`
          : `${DETECT_SILENT_REVERSALS} ssfb:rhythm transfers=${c.db_transfers} legs=${c.statement_legs} ` +
              `reversed=${c.reversed} no_utr=${c.no_utr} orphans=${c.orphan_reversals}`;
      },
    },
    {
      toolContext: ctx,
      toolCallId: flue.toolCallId,
      log: flue.log,
      ...(flue.signal !== undefined ? { signal: flue.signal } : {}),
      ...(flue.harness !== undefined ? { harness: flue.harness } : {}),
    },
  );
}

export const toolModule: ToolModule = Object.freeze({
  name: DETECT_SILENT_REVERSALS,
  mounts: SSFB_MOUNTS,
  entities: [SSFB],
  enabled: () => ({ on: true }) as const,
  create(ctx: ToolContext): ToolDefinition {
    return defineTool({
      name: DETECT_SILENT_REVERSALS,
      description:
        'Find SSFB transfers that rhythm marks SUCCESS but the account statement shows as reversed. Reads rhythm ' +
        'transfer_transactions for the account and the statement from `since` to today, joins them by UTR and ' +
        'txn_ref_id, and flags REVERSED, NO_UTR, NO_MATCH and orphan reversal legs. Use it for any "debited but ' +
        'not received" or reversed IMPS question instead of joining by hand.',
      input: DetectSilentReversalsInputSchema,
      harness: true,
      run: async ({ data, signal, toolCallId, log, harness }): Promise<ToolEnvelope> =>
        runDetect(ctx, {
          data,
          toolCallId,
          log,
          ...(signal !== undefined ? { signal } : {}),
          ...(harness !== undefined ? { harness: harness as unknown as StagingHarness } : {}),
        }),
    });
  },
});
