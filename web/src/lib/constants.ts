// Enum lists the console needs, copied from src/ so no valibot or node code
// ends up in the bundle. constants.test.ts pins each one to its source.

export const RUN_PHASES = [
  'created',
  'preflight',
  'identity',
  'classifying',
  'dispatched',
  'investigating',
  'needs_input',
  'completed',
  'failed',
  'stopped',
] as const;
export type RunPhase = (typeof RUN_PHASES)[number];

/** GET /triage status filter. running is any phase that is not completed, failed or stopped. */
export const RUN_STATUSES = ['running', 'completed', 'failed', 'stopped'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const CATEGORIES = [
  'onboarding',
  'auth',
  'delivery',
  'transfer_out',
  'funding_in',
  'card',
  'beneficiary',
  'account_view',
  'upi_third_party',
  'fd_td',
  'systemic',
  'unknown',
] as const;

export const TIERS = ['cheap', 'mid', 'strong'] as const;

export const ENTITIES = ['ssfb', 'atspl', 'rtl'] as const;

export const KNOWN_ID_KEYS = [
  'horus_customer_id',
  'customer_id',
  'user_id',
  'old_user_id',
  'form_id',
  'account_form_id',
  'alphadesk_user_id',
  'device_id',
  'account_id',
  'account_number',
  'phone',
  'utr',
] as const;

export const REPORT_STATUSES = ['root_cause_confirmed', 'resolved', 'pending_user', 'pending_bank', 'inconclusive'] as const;

export const FEEDBACK_VERDICTS = ['correct', 'partial', 'wrong', 'pending'] as const;
export type FeedbackVerdict = (typeof FEEDBACK_VERDICTS)[number];

/** A verdict on one finding. The console sets correct (accept) or wrong (reject). */
export const FINDING_VERDICTS = ['correct', 'partial', 'wrong'] as const;
export type FindingVerdict = (typeof FINDING_VERDICTS)[number];

export const EVIDENCE_LADDER_STEPS = ['api', 'db', 'logs', 'cbs', 'code'] as const;

/** Evidence record keys: one per entity plus code. */
export const EVIDENCE_KEYS = [...ENTITIES, 'code'] as const;
export type EvidenceKey = (typeof EVIDENCE_KEYS)[number];

export const DOCTOR_STATUSES = ['ok', 'warn', 'fail', 'disabled', 'skipped'] as const;
export type DoctorStatus = (typeof DOCTOR_STATUSES)[number];

export const GUIDE_STATUSES = ['ported', 'written', 'stub'] as const;
export type GuideStatus = (typeof GUIDE_STATUSES)[number];

/** Upper-case entity names as the wireframes show them. */
export const ENTITY_LABELS: Readonly<Record<(typeof ENTITIES)[number], string>> = { ssfb: 'SSFB', atspl: 'ATSPL', rtl: 'RTL' };
