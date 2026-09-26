// The deterministic ID chain (LLD 04 §2.2 and §3, HLD 02 §1.5, D22, D26, D33, D69).
//
// resolveIdChain(ids, deps) walks the hop table with the fixed statements in
// identity-statements.ts and then runs the three basic-state reads. The
// ingress identity step (T07.3) and the resolve_identity tool (T05.5) both
// call it, so there is one implementation. phone_number and country have no
// hop; they stay in the chain as given.
//
// Each statement:
// - runs through the T04.2 SQL connector inside the read-only transaction
//   from buildReadOnlyTxn(); the model SQL gate is skipped on purpose,
//   because the statements are trusted constants;
// - in mock mode is answered from a 'resolve_identity' fixture keyed by the
//   hop name and its parameters, and never reaches the connector; a strict
//   miss throws, naming the fixture key;
// - writes one audit line whose target is the env var name of the DSN.
//
// An unreachable database never throws. The hop is marked unreachable, the
// same database is not tried again in this call, and hops that needed an id
// the failed hop would have produced are marked unreachable too. The
// connector's error (already scrubbed of DSN parts by pg-client.ts) goes into
// errors, so the resolve_identity tool can tell the model why a hop failed.
//
// SQL is never built here: this file has no template literals and no string
// concatenation (checked by identity-core.test.ts).
import * as v from 'valibot';
import type { Registry } from '../../config/registry.ts';
import { withMock, type MockPort } from '../../connectors/mock.ts';
import type { SqlConnector, SqlRows } from '../../connectors/sql/pg-client.ts';
import { isConnectorError, type ConnectorContext } from '../../connectors/types.ts';
import { makeAuditLine } from '../../gate/audit.ts';
import type { AuditSink } from '../../gate/audit-sink.ts';
import { buildReadOnlyTxn, type TxnTimeouts } from '../../gate/sql-txn.ts';
import type { AuditTransport } from '../../types/audit.ts';
import { type Interface, type KnownIdKey, type KnownIds, KnownIdsSchema } from '../../types/core.ts';
import {
  type BasicStateItem,
  type HopStatus,
  type IdChain,
  IdChainSchema,
  type IdHop,
} from '../../types/id-chain.ts';
import { IDENTITY_STATEMENTS, type IdentityStatement } from './identity-statements.ts';

export const IDENTITY_TOOL = 'resolve_identity';

export type IdentityRunInfo = {
  readonly runId: string;
  readonly interface: Interface;
  /** Ingress-collected names for the persisted redaction profile (D24). */
  readonly redactionNames?: readonly string[];
};

export type IdentityCoreDeps = {
  readonly sql: Pick<SqlConnector, 'runSelect'>;
  readonly mock: MockPort;
  readonly audit: AuditSink;
  readonly now: () => Date;
  readonly signal: AbortSignal;
  /** The registry: which entities are enabled and which env var holds each DSN. */
  readonly entities: Pick<Registry, 'isEnabled' | 'serviceDb'>;
  /** Run id and interface for the audit lines. */
  readonly run: IdentityRunInfo;
  /** From config.sql. */
  readonly sqlTimeouts: TxnTimeouts;
};

/** Why a statement failed: the connector code and its message. Not part of the IdChain. */
export type HopError = {
  readonly hop: string;
  readonly source: string;
  readonly code: string;
  readonly error: string;
};

export type IdChainResult = {
  readonly id_chain: IdChain;
  /** The same items as id_chain.basic_state. */
  readonly basic_state: readonly BasicStateItem[];
  /** Statements that failed, with the reason. Absent when none did. */
  readonly errors?: readonly HopError[];
};

/** Thrown for bad input or a malformed fixture. Names fields and hops, never values. */
export class IdentityCoreError extends Error {
  override readonly name = 'IdentityCoreError';
}

// A port that makes withMock take the real branch and never record. It is
// handed to the connector for the inner call, so the connector does not look
// up or record a sql_select fixture of its own.
const REAL_ONLY_PORT: MockPort = Object.freeze({
  enabled: false,
  strict: true,
  lookup: () => {
    throw new IdentityCoreError('the identity core never reads sql_select fixtures');
  },
});

type Rows = readonly Record<string, unknown>[];

type StatementResult =
  | { readonly kind: 'rows'; readonly rows: Rows; readonly taken_at: string }
  | { readonly kind: 'unreachable'; readonly taken_at: string }
  | { readonly kind: 'skipped'; readonly taken_at: string };

type Found = { readonly status: HopStatus; readonly rows: Rows };

const CONNECTION_CODES = new Set(['unreachable', 'timeout', 'not_configured', 'readonly_role_required']);

/** Resolves the ID chain and reads the basic state. Throws only for bad input, a strict mock miss or an abort. */
export async function resolveIdChain(input: Partial<KnownIds>, deps: IdentityCoreDeps): Promise<IdChainResult> {
  const parsed = v.safeParse(KnownIdsSchema, stripBlank(input));
  if (!parsed.success) {
    const fields = [...new Set(parsed.issues.map((i) => v.getDotPath(i) ?? '(ids)'))];
    throw new IdentityCoreError(['invalid ids:', fields.join(', ')].join(' '));
  }
  deps.signal.throwIfAborted();

  const walk = new Walk(deps, { ...parsed.output });
  await walk.hops();
  await walk.basicState();

  const id_chain = v.parse(IdChainSchema, { ids: walk.ids, hops: walk.hopList, basic_state: walk.state });
  const errors = walk.errors.length > 0 ? { errors: Object.freeze([...walk.errors]) } : {};
  return Object.freeze({ id_chain, basic_state: id_chain.basic_state, ...errors });
}

function stripBlank(input: Partial<KnownIds>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(input ?? {})) {
    if (typeof val === 'string' && val.trim() === '') continue;
    if (val === undefined) continue;
    out[k] = val;
  }
  return out;
}

class Walk {
  readonly ids: { -readonly [K in KnownIdKey]?: string };
  readonly hopList: IdHop[] = [];
  readonly state: BasicStateItem[] = [];
  readonly errors: HopError[] = [];
  /** Ids a failed hop would have produced. */
  private readonly blocked = new Set<KnownIdKey>();
  /** Env var names that could not be reached in this call. */
  private readonly down = new Set<string>();
  private readonly deps: IdentityCoreDeps;

  constructor(deps: IdentityCoreDeps, ids: KnownIds) {
    this.deps = deps;
    this.ids = ids;
  }

  // ---------------------------------------------------------- hop table

  async hops(): Promise<void> {
    const S = IDENTITY_STATEMENTS;

    // An account id or bank account number leads back to the customer
    // through the rhythm mapping. These run first, and only while no
    // customer id is known, so the customer hops below can use what they give.
    if (this.ids.customer_id === undefined) {
      const byId = await this.hop(S.account_id, 'account_id', ['customer_id'], 'customer_id');
      if (byId !== null) this.fromMappingRows(byId.rows);
    }
    if (this.ids.customer_id === undefined) {
      const byNumber = await this.hop(S.account_number, 'account_number', ['customer_id'], 'customer_id');
      if (byNumber !== null) this.fromMappingRows(byNumber.rows);
    }

    // customer_id is the harbor customer_id, not the CIF id.
    const customer = await this.hop(S.customer_id, 'customer_id', ['account_form_id'], 'account_form_id');
    if (customer !== null) this.fromCustomerRows(customer.rows);

    // The Aspora user id is harbor external_user_ref. The newest form is taken.
    const user = await this.hop(S.aspora_user_id, 'aspora_user_id', ['account_form_id'], 'account_form_id');
    if (user !== null) this.fromFormRows(user.rows);

    // account_form_id / nstp_application_id. The form row names the user.
    const form = await this.hop(S.account_form_id, 'account_form_id', ['aspora_user_id'], 'aspora_user_id');
    if (form !== null) this.fromFormRows(form.rows);

    // The harbor customer for the form, when no customer id is known yet.
    if (this.ids.customer_id === undefined) {
      const byForm = await this.hop(S.customer_by_form, 'account_form_id', ['customer_id'], 'customer_id');
      if (byForm !== null) this.fromCustomerRows(byForm.rows);
    }

    await this.workflow();

    // customer_id to the rhythm accounts.
    const accounts = await this.hop(S.customer_accounts, 'customer_id', ['account_id', 'account_number'], 'account_id');
    if (accounts !== null && accounts.status === 'resolved') {
      const row = accounts.rows[0] as Record<string, unknown>;
      this.set('account_id', row.account_id);
      this.set('account_number', row.account_number);
    }
  }

  /** account_form_id on the SSFB workflow copy, then the RTL copy when the first has nothing. */
  private async workflow(): Promise<void> {
    const S = IDENTITY_STATEMENTS;
    const ssfb = await this.hop(S.workflow_ssfb, 'account_form_id', [], undefined);
    if (ssfb === null) return;
    if (ssfb.status === 'resolved') {
      this.workflowState(S.workflow_ssfb, ssfb.rows);
      this.record(S.workflow_rtl, 'account_form_id', 'skipped', this.nowIso());
      return;
    }
    const rtl = await this.hop(S.workflow_rtl, 'account_form_id', [], undefined);
    if (rtl !== null && rtl.status === 'resolved') this.workflowState(S.workflow_rtl, rtl.rows);
  }

  private workflowState(stmt: IdentityStatement, rows: Rows): void {
    const row = rows[0] as Record<string, unknown>;
    const taken_at = (this.hopList[this.hopList.length - 1] as IdHop).taken_at;
    const source = sourceOf(stmt);
    this.state.push(
      { item: 'workflow_identifier', value: text(row.workflow_identifier), taken_at, source, status: 'read' },
      { item: 'workflow_status', value: text(row.status), taken_at, source, status: 'read' },
      { item: 'workflow_current_step', value: text(row.current_step_identifier), taken_at, source, status: 'read' },
    );
  }

  private fromCustomerRows(rows: Rows): void {
    const row = rows[0];
    if (row === undefined) return;
    this.set('customer_id', row.customer_id);
    this.set('account_form_id', row.account_form_id);
  }

  private fromFormRows(rows: Rows): void {
    const row = rows[0];
    if (row === undefined) return;
    this.set('aspora_user_id', row.external_user_ref);
    this.set('account_form_id', row.form_id);
  }

  private fromMappingRows(rows: Rows): void {
    const row = rows[0];
    if (row === undefined) return;
    this.set('customer_id', row.customer_id);
    this.set('account_id', row.account_id);
    this.set('account_number', row.account_number);
  }

  /** Sets an id only when it is not known yet. Input ids always win. */
  private set(key: KnownIdKey, raw: unknown): void {
    if (this.ids[key] !== undefined) return;
    const value = text(raw).trim();
    if (value !== '') this.ids[key] = value;
  }

  /**
   * Runs one hop from the id under `from`. Returns null when there is no such
   * id (after recording an unreachable hop if a failed hop would have given
   * it), else the status and rows. An unreachable hop blocks `produces`.
   */
  private async hop(
    stmt: IdentityStatement,
    from: KnownIdKey,
    produces: readonly KnownIdKey[],
    to: KnownIdKey | undefined,
  ): Promise<Found | null> {
    const value = this.ids[from];
    if (value === undefined) {
      if (this.blocked.has(from)) {
        this.record(stmt, from, 'unreachable', this.nowIso());
        for (const k of produces) if (this.ids[k] === undefined) this.blocked.add(k);
      }
      return null;
    }
    const result = await this.run(stmt, [[from, value]]);
    if (result.kind === 'skipped') {
      this.record(stmt, from, 'skipped', result.taken_at);
      return { status: 'skipped', rows: [] };
    }
    if (result.kind === 'unreachable') {
      this.record(stmt, from, 'unreachable', result.taken_at);
      for (const k of produces) if (this.ids[k] === undefined) this.blocked.add(k);
      return { status: 'unreachable', rows: [] };
    }
    const status: HopStatus = result.rows.length > 0 ? 'resolved' : 'not_found';
    this.record(stmt, from, status, result.taken_at, status === 'resolved' ? to : undefined);
    return { status, rows: result.rows };
  }

  private record(stmt: IdentityStatement, from: KnownIdKey, status: HopStatus, taken_at: string, to?: KnownIdKey): void {
    this.hopList.push({ from, ...(to !== undefined ? { to } : {}), source: sourceOf(stmt), status, taken_at });
  }

  // ---------------------------------------------------------- basic state

  async basicState(): Promise<void> {
    const S = IDENTITY_STATEMENTS;

    const customer = await this.read(S.state_harbor_customer, 'customer_id', ['harbor_customer_state', 'harbor_customer_sub_state']);
    if (customer !== null) {
      const row = customer.rows[0];
      this.items(S.state_harbor_customer, customer, [
        ['harbor_customer_state', row?.state],
        ['harbor_customer_sub_state', row?.sub_state],
      ]);
    }

    const form = await this.read(S.state_account_form, 'account_form_id', ['account_form_status_v2']);
    if (form !== null) this.items(S.state_account_form, form, [['account_form_status_v2', form.rows[0]?.status_v2]]);

    const names = ['rhythm_account_status', 'rhythm_debit_allowed'];
    const rhythm = await this.read(S.state_rhythm_account, 'customer_id', names);
    if (rhythm !== null) {
      if (rhythm.rows.length === 0) {
        this.items(S.state_rhythm_account, rhythm, [
          [names[0] as string, undefined],
          [names[1] as string, undefined],
        ]);
      }
      rhythm.rows.forEach((row, i) => {
        const suffix = accountSuffix(row.account_type, i, rhythm.rows.length);
        this.items(S.state_rhythm_account, rhythm, [
          [[names[0], suffix].join(''), row.account_status],
          [[names[1], suffix].join(''), row.debit_allowed],
        ]);
      });
    }
  }

  /** Runs one basic-state read. null when there is no id to read with and nothing failed. */
  private async read(
    stmt: IdentityStatement,
    from: KnownIdKey,
    itemNames: readonly string[],
  ): Promise<{ status: 'read' | 'not_found' | 'unreachable'; rows: Rows; taken_at: string } | null> {
    const value = this.ids[from];
    if (value === undefined) {
      if (!this.blocked.has(from)) return null;
      const taken_at = this.nowIso();
      for (const item of itemNames) {
        this.state.push({ item, value: '', taken_at, source: sourceOf(stmt), status: 'unreachable' });
      }
      return null;
    }
    const result = await this.run(stmt, [[from, value]]);
    if (result.kind !== 'rows') return { status: 'unreachable', rows: [], taken_at: result.taken_at };
    return { status: result.rows.length > 0 ? 'read' : 'not_found', rows: result.rows, taken_at: result.taken_at };
  }

  private items(
    stmt: IdentityStatement,
    read: { status: 'read' | 'not_found' | 'unreachable'; taken_at: string },
    pairs: readonly (readonly [string, unknown])[],
  ): void {
    for (const [item, raw] of pairs) {
      this.state.push({
        item,
        value: read.status === 'read' ? text(raw) : '',
        taken_at: read.taken_at,
        source: sourceOf(stmt),
        status: read.status,
      });
    }
  }

  // ---------------------------------------------------------- one statement

  /** Runs one fixed statement, mock or real, and writes its audit line. */
  private async run(stmt: IdentityStatement, params: readonly (readonly [KnownIdKey, string])[]): Promise<StatementResult> {
    const { deps } = this;
    deps.signal.throwIfAborted();
    const started = deps.now();
    const taken_at = started.toISOString();

    if (!deps.entities.isEnabled(stmt.entity)) return { kind: 'skipped', taken_at };
    const cap = deps.entities.serviceDb(stmt.entity, stmt.service);
    if (cap === undefined) return { kind: 'skipped', taken_at };
    const target = cap.envName;
    if (this.down.has(target)) return { kind: 'unreachable', taken_at };

    const values = params.map(([, value]) => value);
    const audit = (transport: AuditTransport, exit: string, rows: number | null): void => {
      const summary = [IDENTITY_TOOL, ' hop ', stmt.hop, ': ', exit, rows === null ? '' : [', ', String(rows), ' row(s)'].join('')].join('');
      deps.audit.write(
        makeAuditLine(
          {
            run_id: deps.run.runId,
            ts: taken_at,
            interface: deps.run.interface,
            entity: stmt.entity,
            tool: IDENTITY_TOOL,
            decision: 'allow',
            service: stmt.service,
            target,
            transport,
            summary,
            duration_ms: Math.max(0, deps.now().getTime() - started.getTime()),
            exit,
          },
          { names: deps.run.redactionNames ?? [] },
        ),
      );
    };

    if (!deps.mock.enabled && cap.status !== 'ok') {
      this.down.add(target);
      audit('real', 'not_configured', null);
      return { kind: 'unreachable', taken_at };
    }

    const ctx: ConnectorContext = {
      signal: deps.signal,
      now: deps.now,
      mock: deps.mock,
      runId: deps.run.runId,
      ...(deps.run.redactionNames !== undefined ? { redactionNames: deps.run.redactionNames } : {}),
    };
    const plan = buildReadOnlyTxn(deps.sqlTimeouts, stmt.sql);

    try {
      const outcome = await withMock(
        ctx,
        'resolve_identity',
        { hop: stmt.hop, ids: params },
        async (signal) => {
          const inner = await deps.sql.runSelect(
            { ...ctx, signal, mock: REAL_ONLY_PORT },
            {
              entity: stmt.entity,
              service: stmt.service,
              plan,
              params: values,
              keyInput: { entity: stmt.entity, service: stmt.service, tables: [stmt.table], params: values },
            },
          );
          if (inner.fixture_miss === true) throw new IdentityCoreError('the SQL connector answered from a fixture in real mode');
          return { data: inner.data };
        },
        { target_env: target },
      );
      if (outcome.fixture_miss === true) {
        audit('mock', 'fixture_miss', 0);
        return { kind: 'rows', rows: [], taken_at: outcome.taken_at };
      }
      const rows = rowsOf(outcome.data, stmt);
      audit(outcome.transport, 'ok', rows.length);
      return { kind: 'rows', rows, taken_at: outcome.taken_at };
    } catch (err) {
      if (deps.signal.aborted) throw err;
      if (!isConnectorError(err) || err.code === 'strict_miss') throw err;
      if (CONNECTION_CODES.has(err.code)) this.down.add(target);
      audit(deps.mock.enabled ? 'mock' : 'real', err.code, null);
      this.errors.push({ hop: stmt.hop, source: sourceOf(stmt), code: err.code, error: err.message });
      return { kind: 'unreachable', taken_at };
    }
  }

  private nowIso(): string {
    return this.deps.now().toISOString();
  }
}

/** Rows from a connector result or a fixture ({rows: [...]}, the SqlRows shape). */
function rowsOf(data: unknown, stmt: IdentityStatement): Rows {
  const rows = (data as Partial<SqlRows> | null)?.rows;
  if (!Array.isArray(rows) || !rows.every((r) => r !== null && typeof r === 'object' && !Array.isArray(r))) {
    throw new IdentityCoreError(['resolve_identity hop', stmt.hop, 'returned no rows array'].join(' '));
  }
  return rows as Rows;
}

function sourceOf(stmt: IdentityStatement): string {
  return [stmt.entity, ':', stmt.service, '.', stmt.table].join('');
}

function text(raw: unknown): string {
  if (raw === null || raw === undefined) return '';
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number' || typeof raw === 'boolean' || typeof raw === 'bigint') return String(raw);
  if (raw instanceof Date) return raw.toISOString();
  return JSON.stringify(raw) ?? '';
}

const ACCOUNT_TYPE = /^[A-Za-z0-9_]{1,16}$/;

/** ':NRE' for one account of several, from account_type when it is a short word, else ':<index>'. */
function accountSuffix(accountType: unknown, index: number, count: number): string {
  if (count <= 1) return '';
  const t = text(accountType);
  return [':', ACCOUNT_TYPE.test(t) ? t : String(index)].join('');
}
