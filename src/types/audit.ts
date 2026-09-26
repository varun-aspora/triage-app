// One audit line per tool decision (HLD 02 §3, D20, D42). DSNs, URLs and
// tokens never appear: target is the name of the env var that holds the
// connection (for example SSFB_HARBOR_DB_URL), never its value.
import * as v from 'valibot';
import {
  EntitySchema,
  InterfaceSchema,
  NonEmptyStringSchema,
  NonNegativeIntSchema,
  RunIdSchema,
  TakenAtSchema,
} from './core.ts';

export const AUDIT_DECISIONS = ['allow', 'deny'] as const;
export const AuditDecisionSchema = v.picklist(AUDIT_DECISIONS);
export type AuditDecision = v.InferOutput<typeof AuditDecisionSchema>;

// What the eval gate reads to prove no real I/O happened (D42).
export const AUDIT_TRANSPORTS = ['real', 'mock'] as const;
export const AuditTransportSchema = v.picklist(AUDIT_TRANSPORTS);
export type AuditTransport = v.InferOutput<typeof AuditTransportSchema>;

// An env var name, never a DSN or URL.
export const EnvVarNameSchema = v.pipe(v.string(), v.regex(/^[A-Z][A-Z0-9_]*$/));
export type EnvVarName = v.InferOutput<typeof EnvVarNameSchema>;

export const AuditLineSchema = v.pipe(
  v.object({
    run_id: RunIdSchema,
    ts: TakenAtSchema,
    interface: InterfaceSchema,
    // Null for tools that act on no entity (code tools, ingress steps).
    entity: v.nullable(EntitySchema),
    tool: NonEmptyStringSchema,
    decision: AuditDecisionSchema,
    reason: v.optional(v.string()),
    service: v.optional(NonEmptyStringSchema),
    // Env var name of the backing connection, never its value.
    target: EnvVarNameSchema,
    transport: AuditTransportSchema,
    // Already passed through the persisted redaction profile.
    summary_redacted: v.string(),
    duration_ms: v.pipe(v.number(), v.minValue(0)),
    // Result code: a process exit code or a short status word.
    exit: v.union([v.pipe(v.number(), v.integer()), NonEmptyStringSchema]),
    // HTTP decisions: index of the matching rule, or 'default'.
    rule_index: v.optional(v.union([NonNegativeIntSchema, v.literal('default')])),
    action: v.optional(v.picklist(['allow', 'block'])),
    // decrypt_fields records a count only.
    count: v.optional(NonNegativeIntSchema),
    // sql_select failures: the Postgres SQLSTATE, e.g. 42703.
    sqlstate: v.optional(v.pipe(v.string(), v.regex(/^[0-9A-Z]{5}$/))),
  }),
  v.forward(
    v.check((line) => line.decision !== 'deny' || (line.reason ?? '').trim().length > 0, 'a deny line needs a reason'),
    ['reason'],
  ),
);
export type AuditLine = v.InferOutput<typeof AuditLineSchema>;
