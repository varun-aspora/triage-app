// The approval gate for posting a report to Slack (D13, D28, D39).
//
// requireApproval is the only way to get an Approval. The type is branded
// with a symbol this module never exports, so code elsewhere cannot build
// one by hand, and isApproval checks at runtime that a value really came
// from here (a cast does not get past it). slack-post takes an Approval, so
// it cannot run without passing this gate first.
//
// v1 rules:
// - Only TRIAGE_APPROVAL_MODE=cli can approve. 'slack' is reserved for v2;
//   blank or any other value refuses.
// - With a TTY and no flags: show the verbatim text, then ask y/N. Only 'y'
//   or 'yes' (surrounding whitespace and case ignored) approves. Anything
//   else, EOF, or a prompt error refuses.
// - Non-interactive use needs both --yes and --approved-by. One without the
//   other refuses, with or without a TTY.
// - approved_by must match APPROVED_BY_PATTERN.
// There is no HTTP constructor: the HTTP post route stays disabled in v1 (D25).

import { userInfo } from 'node:os';

declare const approvalBrand: unique symbol;

export type ApprovalMethod = 'tty' | 'flag';

export type Approval = {
  readonly approved_by: string;
  readonly method: ApprovalMethod;
  readonly at: string;
  readonly [approvalBrand]: true;
};

export type ApprovalResult =
  | { readonly ok: true; readonly approval: Approval }
  | { readonly ok: false; readonly reason: string };

export type ApprovalInput = {
  /** config.approval.mode, typed as string so blank and unknown values can be refused here too. */
  readonly mode: string;
  readonly stdinIsTTY: boolean;
  /** --yes */
  readonly yes: boolean;
  /** --approved-by; undefined when the flag was not given. */
  readonly approvedBy?: string;
  /** The exact text that will be posted. */
  readonly verbatimText: string;
  /** Shows the verbatim text to the operator. Always called before confirm. */
  readonly show: (text: string) => void | Promise<void>;
  /** Asks the y/N question. Resolves to the raw answer, or null on EOF. */
  readonly confirm: (question: string) => Promise<string | null>;
  /** Who is at the terminal, for TTY approvals. Defaults to the OS user name. */
  readonly ttyUser?: string;
  readonly now?: () => Date;
};

export const APPROVED_BY_PATTERN = /^[A-Za-z0-9._@+-]{1,128}$/;
export const CONFIRM_QUESTION = 'Post this to Slack? [y/N] ';

const issued = new WeakSet<object>();

function refuse(reason: string): ApprovalResult {
  return { ok: false, reason };
}

function issue(approvedBy: string, method: ApprovalMethod, now: () => Date): ApprovalResult {
  const approval = Object.freeze({ approved_by: approvedBy, method, at: now().toISOString() }) as Approval;
  issued.add(approval);
  return { ok: true, approval };
}

/** True only for an Approval that requireApproval returned in this process. */
export function isApproval(value: unknown): value is Approval {
  return typeof value === 'object' && value !== null && issued.has(value);
}

export function isValidApprovedBy(value: string): boolean {
  return APPROVED_BY_PATTERN.test(value);
}

/** Only 'y' or 'yes' approves. Surrounding whitespace and case are ignored; EOF is No. */
export function isYes(answer: string | null): boolean {
  if (answer === null) return false;
  const a = answer.trim().toLowerCase();
  return a === 'y' || a === 'yes';
}

function osUser(): string | undefined {
  try {
    return userInfo().username;
  } catch {
    return undefined;
  }
}

export async function requireApproval(input: ApprovalInput): Promise<ApprovalResult> {
  const now = input.now ?? (() => new Date());

  if (input.mode === 'slack') return refuse('TRIAGE_APPROVAL_MODE=slack is reserved for v2; use cli');
  if (input.mode.trim() === '') return refuse('TRIAGE_APPROVAL_MODE is blank; set it to cli');
  if (input.mode !== 'cli') return refuse('TRIAGE_APPROVAL_MODE must be cli');

  if (input.verbatimText.trim() === '') return refuse('nothing to approve: the report text is empty');

  const hasApprovedBy = input.approvedBy !== undefined;
  if (hasApprovedBy && !isValidApprovedBy(input.approvedBy)) {
    return refuse('--approved-by must be 1 to 128 characters of letters, digits and . _ @ + -');
  }

  if (input.yes && hasApprovedBy) return issue(input.approvedBy, 'flag', now);
  if (input.yes) return refuse('--yes needs --approved-by <who>');
  if (hasApprovedBy) return refuse('--approved-by needs --yes');

  if (!input.stdinIsTTY) return refuse('stdin is not a TTY; pass --yes --approved-by <who> after asking the user');

  const who = input.ttyUser ?? osUser();
  if (who === undefined || !isValidApprovedBy(who)) {
    return refuse('cannot tell who is approving at this terminal; pass --yes --approved-by <who>');
  }

  let answer: string | null;
  try {
    await input.show(input.verbatimText);
    answer = await input.confirm(CONFIRM_QUESTION);
  } catch {
    return refuse('the approval prompt failed; nothing was approved');
  }
  if (!isYes(answer)) return refuse('not approved at the prompt');
  return issue(who, 'tty', now);
}
