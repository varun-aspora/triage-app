// Pure logic behind the two SSFB statement tools (D29):
//
// - Statement shape: the rhythm admin API has been seen wrapping the
//   transaction array under several keys, and its legs use several spellings
//   for the same field. findStatementItems() and normaliseLeg() port the
//   probing from list_transactions.sh so both tools read one shape.
// - The join: joinReversals() ports transfer_lifecycle.sh. It lines up
//   rhythm transfer_transactions rows with statement legs by UTR or txn_ref_id
//   and flags the transfers where the DB says success but the statement shows
//   a reversal, success rows with no UTR, and reversal legs with no DB row.
//
// Why the join exists: for reversed IMPS, CBS answers the payment with a
// success code, the status inquiry comes back non-terminal, rhythm stops
// polling, and the reversal CBS posts a few minutes later is never reconciled.
// The reversal only exists in the statement.
//
// No I/O, no config, no env. Everything here runs on data the tools already
// fetched, so the same code runs on fixtures and on real answers.

// ------------------------------------------------------------ statement shape

/** Keys the admin API has been seen using for the transaction array. */
export const ITEM_KEYS = ['transactions', 'data', 'items', 'results'] as const;
/** Keys probed one level down, when the first-level value is an object. */
export const NESTED_ITEM_KEYS = ['transactions', 'data', 'items'] as const;

/** Where the array was found: 'array', a key such as 'data', or 'data.items'. */
export type StatementShape = string;

export type FoundItems =
  | { readonly ok: true; readonly items: readonly unknown[]; readonly shape: StatementShape }
  | { readonly ok: false; readonly reason: 'not_json' | 'no_array'; readonly top_level_keys: readonly string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Key names only, cut and charset-checked, so an odd body cannot push
// arbitrary text into the output through its keys.
function safeKeys(value: Record<string, unknown>): string[] {
  return Object.keys(value)
    .filter((k) => /^[A-Za-z0-9_.-]{1,40}$/.test(k))
    .slice(0, 20);
}

/**
 * Finds the transaction array in one statement response body. The order of
 * probing is the script's: a bare array, then transactions, data, items and
 * results, each either an array or an object holding transactions, data or
 * items. A string body is 'not_json' (the HTTP connector returns text when the
 * body is not JSON).
 */
export function findStatementItems(body: unknown): FoundItems {
  if (Array.isArray(body)) return { ok: true, items: body, shape: 'array' };
  if (!isRecord(body)) return { ok: false, reason: typeof body === 'string' ? 'not_json' : 'no_array', top_level_keys: [] };
  for (const key of ITEM_KEYS) {
    const value = body[key];
    if (Array.isArray(value)) return { ok: true, items: value, shape: key };
    if (isRecord(value)) {
      for (const inner of NESTED_ITEM_KEYS) {
        const nested = value[inner];
        if (Array.isArray(nested)) return { ok: true, items: nested, shape: `${key}.${inner}` };
      }
    }
  }
  return { ok: false, reason: 'no_array', top_level_keys: safeKeys(body) };
}

/** First value under any of keys that is neither null nor ''. */
export function pick(leg: unknown, keys: readonly string[]): unknown {
  if (!isRecord(leg)) return undefined;
  for (const key of keys) {
    const value = leg[key];
    if (value !== null && value !== undefined && value !== '') return value;
  }
  return undefined;
}

function text(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

// The field spellings list_transactions.sh probes, in its order.
export const LEG_KEYS = {
  created_at: ['created_at', 'createdAt', 'initiated_at', 'txn_date', 'transaction_date'],
  type: ['transfer_type', 'transferType', 'type', 'txn_type'],
  amount: ['amount', 'txn_amount', 'amount_value'],
  status: ['status', 'txn_status', 'state'],
  reversed: ['is_reversed', 'reversed', 'reversal'],
  txn_ref_id: ['txn_ref_id', 'ref_transaction_id', 'reference_id', 'txn_id', 'id'],
  bank_identifier: ['bank_identifier', 'utr', 'bank_ref_no', 'rrn'],
} as const;

/** Reversal time on a reversal leg; value_date is the one extra spelling the lifecycle script reads. */
const REVERSAL_AT_KEYS = ['created_at', 'createdAt', 'txn_date', 'transaction_date', 'value_date'] as const;

/**
 * The narration spellings seen so far. The reversal match runs on these
 * fields only: over the whole serialised leg it would also match key names
 * such as returnCode or reversal_allowed on healthy legs.
 */
export const NARRATION_KEYS = [
  'narration',
  'description',
  'remarks',
  'remark',
  'particulars',
  'txn_description',
  'transaction_description',
  'txn_narration',
  'transaction_narration',
  'statement_narration',
  'desc',
] as const;

export function narrationOf(leg: unknown): string {
  if (!isRecord(leg)) return '';
  const parts: string[] = [];
  for (const key of NARRATION_KEYS) {
    const value = leg[key];
    if (typeof value === 'string' && value !== '') parts.push(value);
  }
  return parts.join(' | ');
}

const REVERSED_TRUE: ReadonlySet<unknown> = new Set([true, 'true', 'TRUE', 'REVERSED', 1]);
const REVERSED_FALSE: ReadonlySet<unknown> = new Set([false, 'false', 'FALSE', 0]);

/** The leg's own reversal flag: true, false, or null when it has none or holds something else. */
export function reversedFlag(leg: unknown): boolean | null {
  const value = pick(leg, LEG_KEYS.reversed);
  if (REVERSED_TRUE.has(value)) return true;
  if (REVERSED_FALSE.has(value)) return false;
  return null;
}

export type StatementTransaction = {
  readonly created_at: string | null;
  readonly type: string | null;
  readonly amount: string | null;
  readonly status: string | null;
  /** The leg's own reversal flag, when it has one. */
  readonly reversed: boolean | null;
  readonly txn_ref_id: string | null;
  readonly bank_identifier: string | null;
  readonly narration: string | null;
};

/** One leg in the normalised shape. Unknown fields are dropped. */
export function normaliseLeg(leg: unknown): StatementTransaction {
  const narration = narrationOf(leg);
  return {
    created_at: text(pick(leg, LEG_KEYS.created_at)),
    type: text(pick(leg, LEG_KEYS.type)),
    amount: text(pick(leg, LEG_KEYS.amount)),
    status: text(pick(leg, LEG_KEYS.status)),
    reversed: reversedFlag(leg),
    txn_ref_id: text(pick(leg, LEG_KEYS.txn_ref_id)),
    bank_identifier: text(pick(leg, LEG_KEYS.bank_identifier)),
    narration: narration === '' ? null : narration,
  };
}

// ------------------------------------------------------------ reversal match

/**
 * Wider than the literal word: the bank narrates reversals as "REVERSAL OF
 * IMPS ...", "RVSL" or "RETURN" as well as "REVERSED".
 */
export const REVERSAL_PATTERN = 'revers|rvsl|return';
const REVERSAL_RE = new RegExp(REVERSAL_PATTERN, 'i');

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Removes identifier values from the narration before the reversal match.
 * The bank embeds the UTR or reference in the narration ("IMPS/ASP/<UTR>/..."),
 * so an identifier spelled with letters such as REVERSED or RETURN would
 * otherwise match on a healthy leg.
 */
export function maskIds(narration: string, ids: readonly (string | null | undefined)[]): string {
  let out = narration;
  for (const id of ids) {
    if (typeof id !== 'string' || id.trim() === '') continue;
    out = out.replace(new RegExp(escapeRegExp(id.trim()), 'gi'), '');
  }
  return out;
}

/** The leg's own identifier values, masked out before its narration is matched. */
function ownIds(leg: unknown): string[] {
  const out: string[] = [];
  if (!isRecord(leg)) return out;
  for (const key of [...LEG_KEYS.txn_ref_id, ...LEG_KEYS.bank_identifier]) {
    const value = leg[key];
    if (typeof value === 'string' || typeof value === 'number') out.push(String(value));
  }
  return out;
}

/**
 * True when the leg shows a reversal: its own reversal flag is set, or its
 * narration, with the given ids and the leg's own ids stripped, matches the
 * reversal pattern.
 */
export function isReversalLeg(leg: unknown, ids: readonly (string | null | undefined)[] = []): boolean {
  if (reversedFlag(leg) === true) return true;
  const narration = narrationOf(leg);
  if (narration === '') return false;
  return REVERSAL_RE.test(maskIds(narration, [...ids, ...ownIds(leg)]));
}

// ------------------------------------------------------------ the join

/** The rhythm transfer_transactions columns the fixed SELECT reads. */
export type DbTransfer = {
  readonly txn_ref_id?: unknown;
  readonly status?: unknown;
  readonly initiated_at?: unknown;
  readonly created_at?: unknown;
  readonly bank_identifier?: unknown;
  readonly failure_reason?: unknown;
};

export const FLAGS = ['REVERSED', 'REVERSED_NON_SUCCESS', 'NO_UTR', 'NO_MATCH', 'OK'] as const;
export type Flag = (typeof FLAGS)[number];

/** What each flag means, for the tool output. */
export const FLAG_MEANINGS: Readonly<Record<Flag | 'ORPHAN_REVERSAL', string>> = Object.freeze({
  REVERSED: 'DB says success, the statement shows a reversal for this transfer',
  REVERSED_NON_SUCCESS: 'the statement shows a reversal and the DB already has a non-success status',
  NO_UTR: 'DB says success but there is no bank_identifier (UTR); the status inquiry never confirmed it',
  NO_MATCH: 'DB says success and no statement leg in the window carries its UTR or txn_ref_id',
  OK: 'no reversal found for this transfer',
  ORPHAN_REVERSAL: 'a reversal leg in the statement that matches no DB transfer',
});

/** DB statuses that count as success. */
export const SUCCESS_STATUSES: ReadonlySet<string> = new Set(['SUCCESS', 'COMPLETED']);

export type FlagRow = {
  readonly initiated_at: string | null;
  readonly db_status: string | null;
  readonly utr: string | null;
  readonly txn_ref_id: string | null;
  readonly type: string | null;
  readonly amount: string | null;
  readonly flag: Flag;
  /** Time on the first reversal leg, when there is one. */
  readonly reversal_at: string | null;
  /** Statement legs that carry this transfer's UTR or txn_ref_id. */
  readonly matched_legs: number;
  readonly failure_reason: string | null;
};

export type JoinResult = {
  readonly rows: readonly FlagRow[];
  readonly orphans: readonly StatementTransaction[];
  readonly counts: {
    readonly db_transfers: number;
    readonly statement_legs: number;
    readonly reversed: number;
    readonly no_utr: number;
    readonly no_match: number;
    readonly orphan_reversals: number;
  };
};

function idText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function orNull(s: string): string | null {
  return s === '' ? null : s;
}

function serialised(leg: unknown): string {
  try {
    return (JSON.stringify(leg) ?? '').toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Joins DB transfers with statement legs. Per DB row, in the script's order:
 * a reversal leg gives REVERSED (DB success) or REVERSED_NON_SUCCESS; else
 * success with no UTR gives NO_UTR; else success with no matching leg gives
 * NO_MATCH; else OK. Reversal legs no DB row matched are returned as orphans.
 */
export function joinReversals(dbRows: readonly DbTransfer[], legs: readonly unknown[]): JoinResult {
  // The UTR can sit under any field name, so matching runs on the whole
  // serialised leg. The reversal match runs on the narration only.
  const prepared = legs.map((leg) => ({ leg, all: serialised(leg) }));
  const matched = new Set<number>();
  const rows: FlagRow[] = [];
  let reversed = 0;
  let noUtr = 0;
  let noMatch = 0;

  for (const row of dbRows) {
    const utr = idText(row.bank_identifier);
    const ref = idText(row.txn_ref_id);
    const status = idText(row.status).toUpperCase();
    const keys = [utr, ref].filter((k) => k !== '');

    const hits: number[] = [];
    prepared.forEach((p, i) => {
      if (keys.some((k) => p.all.includes(k.toLowerCase()))) hits.push(i);
    });
    for (const i of hits) matched.add(i);
    const reversals = hits.filter((i) => isReversalLeg(prepared[i]?.leg, keys));
    const success = SUCCESS_STATUSES.has(status);

    let flag: Flag;
    if (reversals.length > 0) flag = success ? 'REVERSED' : 'REVERSED_NON_SUCCESS';
    else if (success && utr === '') flag = 'NO_UTR';
    else if (success && hits.length === 0) flag = 'NO_MATCH';
    else flag = 'OK';
    if (flag === 'REVERSED') reversed += 1;
    if (flag === 'NO_UTR') noUtr += 1;
    if (flag === 'NO_MATCH') noMatch += 1;

    const first = hits.length > 0 ? prepared[hits[0] as number]?.leg : undefined;
    const reversalLeg = reversals.length > 0 ? prepared[reversals[0] as number]?.leg : undefined;
    rows.push({
      initiated_at: text(row.initiated_at ?? null),
      db_status: orNull(status),
      utr: orNull(utr),
      txn_ref_id: orNull(ref),
      type: first === undefined ? null : text(pick(first, LEG_KEYS.type)),
      amount: first === undefined ? null : text(pick(first, LEG_KEYS.amount)),
      flag,
      reversal_at: reversalLeg === undefined ? null : text(pick(reversalLeg, REVERSAL_AT_KEYS)),
      matched_legs: hits.length,
      failure_reason: text(row.failure_reason ?? null),
    });
  }

  // The worst case: a reversal with no DB row behind it, because rhythm never
  // stored a UTR for it, so nothing above could match it.
  const orphans: StatementTransaction[] = [];
  prepared.forEach((p, i) => {
    if (!matched.has(i) && isReversalLeg(p.leg)) orphans.push(normaliseLeg(p.leg));
  });

  return {
    rows,
    orphans,
    counts: {
      db_transfers: dbRows.length,
      statement_legs: legs.length,
      reversed,
      no_utr: noUtr,
      no_match: noMatch,
      orphan_reversals: orphans.length,
    },
  };
}
