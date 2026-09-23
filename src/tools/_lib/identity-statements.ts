// The fixed statements behind the deterministic ID chain (LLD 04 §2.2, D22).
//
// Every statement is a constant string with $n placeholders. Nothing here is
// built at run time: no template literals and no concatenation, and a test in
// identity-core.test.ts checks this file for both. The model never supplies
// SQL for these reads, so they do not go through the model SQL gate; they
// still run inside the read-only transaction from src/gate/sql-txn.ts and
// through the T04.2 connector, and each call writes one audit line.
//
// Table names are unqualified because each service has its own database and
// the tables sit in its default schema.
import type { Entity, KnownIdKey } from '../../types/core.ts';

// ------------------------------------------------------------ hop statements

/** horus_customer_id (and old_user_id tried as a customer_id): the harbor customer row. */
export const HARBOR_CUSTOMER_BY_ID =
  'SELECT customer_id, account_form_id, (external_reference_id IS NOT NULL) AS cif_exists FROM customer WHERE customer_id = $1 LIMIT 5';

/** alphadesk_user_id, user_id and old_user_id tried as external_user_ref: the user's forms, newest first. */
export const HARBOR_FORMS_BY_USER =
  'SELECT form_id, external_user_ref FROM account_forms WHERE external_user_ref = $1 AND is_deleted = false ORDER BY created_at DESC LIMIT 20';

/** account_form_id / nstp_application_id: the form row. NSTP Application ID is the form_id. */
export const HARBOR_FORM_BY_ID =
  'SELECT form_id, external_user_ref, session_id FROM account_forms WHERE form_id = $1 AND is_deleted = false LIMIT 5';

/** account_form_id to the harbor customer, when no customer id is known yet. */
export const HARBOR_CUSTOMER_BY_FORM =
  'SELECT customer_id, account_form_id FROM customer WHERE account_form_id = $1 ORDER BY created_at DESC LIMIT 5';

/** form_id: the workflow executions on the SSFB copy of workflow-op. */
export const SSFB_WORKFLOW_BY_FORM =
  "SELECT workflow_identifier, status, current_step_identifier FROM workflow_executions WHERE reference_id = $1 AND reference_type = 'FORM' ORDER BY created_at DESC LIMIT 5";

/** form_id: the same read on the RTL copy, tried when the SSFB copy has nothing. */
export const RTL_WORKFLOW_BY_FORM =
  "SELECT workflow_identifier, status, current_step_identifier FROM workflow_executions WHERE reference_id = $1 AND reference_type = 'FORM' ORDER BY created_at DESC LIMIT 5";

/** customer_id: the rhythm account mappings. account_id is for admin APIs, account_number for logs. */
export const RHYTHM_ACCOUNTS_BY_CUSTOMER =
  'SELECT account_id, account_number, account_type, scheme_code FROM customer_account_mappings WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 10';

/** device_id: guardian device auth attempt to refresh token subject. The join is unverified (LLD 04 §2.2). */
export const GUARDIAN_USER_BY_DEVICE =
  'SELECT rt.subject FROM device_auth_attempts d JOIN refresh_tokens rt ON rt.verification_id = d.verification_id WHERE d.device_id = $1 ORDER BY rt.created_at DESC LIMIT 5';

// ------------------------------------------------------------ basic state

/** Harbor customer state and sub_state. */
export const STATE_HARBOR_CUSTOMER = 'SELECT state, sub_state FROM customer WHERE customer_id = $1 LIMIT 1';

/** account_forms.status_v2, the authoritative form status. */
export const STATE_ACCOUNT_FORM =
  'SELECT status_v2 FROM account_forms WHERE form_id = $1 AND is_deleted = false LIMIT 1';

/**
 * Rhythm account status and debit flag, one row per account. The column
 * names follow the rhythm admin account response (account_status,
 * debit allowed) and have not been checked against the rhythm schema yet.
 */
export const STATE_RHYTHM_ACCOUNT =
  'SELECT account_type, account_status, debit_allowed FROM customer_account_mappings WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 10';

// ------------------------------------------------------------ statement table

export type IdentityStatement = {
  /** The fixture hop name and the name on the audit line. */
  readonly hop: string;
  readonly entity: Entity;
  readonly service: string;
  readonly table: string;
  readonly sql: string;
  /** The KnownIds keys bound to $1..$n, in order. */
  readonly params: readonly KnownIdKey[];
};

function statement(s: IdentityStatement): IdentityStatement {
  return Object.freeze({ ...s, params: Object.freeze([...s.params]) });
}

export const IDENTITY_STATEMENTS = Object.freeze({
  horus_customer_id: statement({
    hop: 'horus_customer_id',
    entity: 'ssfb',
    service: 'harbor',
    table: 'customer',
    sql: HARBOR_CUSTOMER_BY_ID,
    params: ['horus_customer_id'],
  }),
  old_user_id_as_user: statement({
    hop: 'old_user_id.external_user_ref',
    entity: 'ssfb',
    service: 'harbor',
    table: 'account_forms',
    sql: HARBOR_FORMS_BY_USER,
    params: ['old_user_id'],
  }),
  old_user_id_as_customer: statement({
    hop: 'old_user_id.customer_id',
    entity: 'ssfb',
    service: 'harbor',
    table: 'customer',
    sql: HARBOR_CUSTOMER_BY_ID,
    params: ['old_user_id'],
  }),
  alphadesk_user_id: statement({
    hop: 'alphadesk_user_id',
    entity: 'ssfb',
    service: 'harbor',
    table: 'account_forms',
    sql: HARBOR_FORMS_BY_USER,
    params: ['alphadesk_user_id'],
  }),
  user_id: statement({
    hop: 'user_id',
    entity: 'ssfb',
    service: 'harbor',
    table: 'account_forms',
    sql: HARBOR_FORMS_BY_USER,
    params: ['user_id'],
  }),
  account_form_id: statement({
    hop: 'account_form_id',
    entity: 'ssfb',
    service: 'harbor',
    table: 'account_forms',
    sql: HARBOR_FORM_BY_ID,
    params: ['account_form_id'],
  }),
  customer_by_form: statement({
    hop: 'account_form_id.customer',
    entity: 'ssfb',
    service: 'harbor',
    table: 'customer',
    sql: HARBOR_CUSTOMER_BY_FORM,
    params: ['account_form_id'],
  }),
  form_id_ssfb: statement({
    hop: 'form_id.ssfb_workflow',
    entity: 'ssfb',
    service: 'workflow',
    table: 'workflow_executions',
    sql: SSFB_WORKFLOW_BY_FORM,
    params: ['form_id'],
  }),
  form_id_rtl: statement({
    hop: 'form_id.rtl_workflow',
    entity: 'rtl',
    service: 'workflow',
    table: 'workflow_executions',
    sql: RTL_WORKFLOW_BY_FORM,
    params: ['form_id'],
  }),
  customer_id: statement({
    hop: 'customer_id',
    entity: 'ssfb',
    service: 'rhythm',
    table: 'customer_account_mappings',
    sql: RHYTHM_ACCOUNTS_BY_CUSTOMER,
    params: ['customer_id'],
  }),
  device_id: statement({
    hop: 'device_id',
    entity: 'ssfb',
    service: 'guardian',
    table: 'device_auth_attempts',
    sql: GUARDIAN_USER_BY_DEVICE,
    params: ['device_id'],
  }),
  state_harbor_customer: statement({
    hop: 'state.harbor_customer',
    entity: 'ssfb',
    service: 'harbor',
    table: 'customer',
    sql: STATE_HARBOR_CUSTOMER,
    params: ['customer_id'],
  }),
  state_account_form: statement({
    hop: 'state.account_form',
    entity: 'ssfb',
    service: 'harbor',
    table: 'account_forms',
    sql: STATE_ACCOUNT_FORM,
    params: ['account_form_id'],
  }),
  state_rhythm_account: statement({
    hop: 'state.rhythm_account',
    entity: 'ssfb',
    service: 'rhythm',
    table: 'customer_account_mappings',
    sql: STATE_RHYTHM_ACCOUNT,
    params: ['customer_id'],
  }),
} as const satisfies Record<string, IdentityStatement>);

export type IdentityStatementId = keyof typeof IDENTITY_STATEMENTS;
