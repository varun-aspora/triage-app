// Builds the one audit line each tool decision produces, refusals included
// (HLD 02 §3, D20, D34, D42). Pure: no I/O here; audit-sink.ts writes lines.
//
// What keeps secrets and PII out of a line:
// - target must be an env var name (SSFB_HARBOR_DB_URL), so a DSN, URL or
//   token value is refused before anything else is looked at;
// - summary and reason pass the persisted redaction profile;
// - encrypt_lookup_value and decrypt_fields keep a count only, and their
//   summary is rebuilt from that count, so plaintext cannot reach the line.
// Errors name the fields that failed, never their values.

import * as v from 'valibot';
import type { Entity, Interface } from '../types/core.ts';
import {
  type AuditDecision,
  type AuditLine,
  AuditLineSchema,
  type AuditTransport,
  AUDIT_TRANSPORTS,
  EnvVarNameSchema,
} from '../types/audit.ts';
import { type PersistedOptions, redactPersisted } from './redact.ts';

/** Tools that touch field-encryption plaintext. Their lines keep a count only (D34). */
export const COUNT_ONLY_TOOLS: ReadonlySet<string> = new Set(['decrypt_fields', 'encrypt_lookup_value']);

/** Tools whose method policy comes from rules.ts, so an allow always has a rule behind it. */
export const HTTP_RULE_TOOLS: ReadonlySet<string> = new Set(['http_call', 'cbs_call']);

export type AuditInput = {
  readonly run_id: string;
  readonly ts: string;
  readonly interface: Interface;
  readonly entity: Entity | null;
  readonly tool: string;
  readonly decision: AuditDecision;
  /** Required when decision is 'deny'. Passes the persisted profile. */
  readonly reason?: string;
  readonly service?: string;
  /** Env var name of the backing connection, never its value. */
  readonly target: string;
  /** Mandatory: the eval gate reads it to prove no real I/O happened (D42). */
  readonly transport: AuditTransport;
  /** Free text about the call. Passes the persisted profile. Ignored for count-only tools. */
  readonly summary: string;
  readonly duration_ms: number;
  readonly exit: number | string;
  /** HTTP decisions: the matching rule index, or 'default'. Comes with action. */
  readonly rule_index?: number | 'default';
  readonly action?: 'allow' | 'block';
  /** Count-only tools: how many values were handled. */
  readonly count?: number;
  /** sql_select failures: the Postgres SQLSTATE. */
  readonly sqlstate?: string;
};

/** Thrown when an audit line cannot be built. Carries field names only. */
export class AuditLineError extends Error {
  readonly fields: readonly string[];
  constructor(fields: readonly string[], detail: string) {
    super(`audit line rejected (${fields.join(', ')}): ${detail}`);
    this.name = 'AuditLineError';
    this.fields = fields;
  }
}

function fail(field: string, detail: string): never {
  throw new AuditLineError([field], detail);
}

function redactText(text: string, opts: PersistedOptions): string {
  return redactPersisted(text, opts).value;
}

/**
 * Builds and validates one audit line. Throws AuditLineError when the input
 * would break a rule; the caller should treat that as a bug, not a refusal.
 */
export function makeAuditLine(input: AuditInput, opts: PersistedOptions = {}): AuditLine {
  // Check target first, so a DSN or URL passed by mistake never reaches the
  // redaction or schema code, and never an error message.
  if (typeof input.target !== 'string' || !v.is(EnvVarNameSchema, input.target)) {
    fail('target', 'target must be an env var name such as SSFB_HARBOR_DB_URL, never a DSN, URL or token');
  }
  if (!(AUDIT_TRANSPORTS as readonly unknown[]).includes(input.transport)) {
    fail('transport', `transport is required and must be one of ${AUDIT_TRANSPORTS.join('|')}`);
  }
  if (typeof input.summary !== 'string') fail('summary', 'summary must be a string');
  if (input.reason !== undefined && typeof input.reason !== 'string') fail('reason', 'reason must be a string');
  if (input.decision === 'deny' && (input.reason ?? '').trim().length === 0) {
    fail('reason', 'a deny line needs a reason');
  }

  const hasRule = input.rule_index !== undefined;
  const hasAction = input.action !== undefined;
  if (hasRule !== hasAction) fail(hasRule ? 'action' : 'rule_index', 'rule_index and action come together');
  if (HTTP_RULE_TOOLS.has(input.tool) && input.decision === 'allow' && !hasRule) {
    fail('rule_index', `an allowed ${input.tool} call must carry rule_index and action`);
  }
  if (input.action === 'block' && input.decision !== 'deny') fail('decision', "action 'block' needs decision 'deny'");

  const countOnly = COUNT_ONLY_TOOLS.has(input.tool);
  if (countOnly && input.count === undefined) fail('count', `${input.tool} lines must carry count`);

  const summary = countOnly ? `${input.tool}: ${input.count} value(s)` : redactText(input.summary, opts);

  // Build from named fields only, so extra properties on the input (for
  // example a plaintext value) never reach the line.
  const candidate: Record<string, unknown> = {
    run_id: input.run_id,
    ts: input.ts,
    interface: input.interface,
    entity: input.entity,
    tool: input.tool,
    decision: input.decision,
    target: input.target,
    transport: input.transport,
    summary_redacted: summary,
    duration_ms: input.duration_ms,
    exit: input.exit,
  };
  if (input.reason !== undefined) candidate.reason = redactText(input.reason, opts);
  if (input.service !== undefined) candidate.service = input.service;
  if (hasRule) {
    candidate.rule_index = input.rule_index;
    candidate.action = input.action;
  }
  if (input.count !== undefined) candidate.count = input.count;
  if (input.sqlstate !== undefined) candidate.sqlstate = input.sqlstate;

  return assertAuditLine(candidate);
}

/** Validates a finished line against AuditLineSchema. The error names fields, never values. */
export function assertAuditLine(candidate: unknown): AuditLine {
  const parsed = v.safeParse(AuditLineSchema, candidate);
  if (!parsed.success) {
    const fields = [...new Set(parsed.issues.map((i) => v.getDotPath(i) ?? '(line)'))];
    throw new AuditLineError(fields, 'field failed the AuditLine schema');
  }
  return parsed.output;
}

/**
 * One JSONL record: JSON.stringify already escapes \n and \r; U+2028 and
 * U+2029 are escaped too, so no reader splits a line on them.
 */
export function serializeAuditLine(line: AuditLine): string {
  return JSON.stringify(line).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}
