// Shapes shared by every doctor check (HLD §7 Doctor).
//
// A row names env keys, never their values. Messages are fixed text plus key
// names, counts and file names under resources/. Areas that need more context
// (probes, tool lists) add fields to DoctorContext with
// `declare module '.../ops/doctor/types.ts' { interface DoctorContext { ... } }`
// in their own file.

import type { Config } from '../../config/env.ts';
import type { Registry } from '../../config/registry.ts';
import type { Entity } from '../../types/core.ts';

export const DOCTOR_STATUSES = ['ok', 'warn', 'fail', 'disabled', 'skipped'] as const;
export type DoctorStatus = (typeof DOCTOR_STATUSES)[number];

export type DoctorCheck = {
  /** Stable check id, such as 'env' or 'models'. */
  readonly id: string;
  readonly entity?: Entity;
  readonly status: DoctorStatus;
  /** Env key names this row is about. Never values. */
  readonly key_names: readonly string[];
  /** Fixed text naming keys only. */
  readonly message: string;
};

export type DoctorReport = {
  /**
   * Sorted by entity (the default): rows with no entity first, then ssfb,
   * atspl, rtl. Sorted by check: rows grouped by check id, in check order.
   * Within a group, rows keep check order, then the order each check returned them.
   */
  readonly checks: readonly DoctorCheck[];
  readonly counts: Readonly<Record<DoctorStatus, number>>;
};

export interface DoctorContext {
  readonly config: Config;
  /** The loaded registry. When absent, checks that need it load it from config. */
  readonly registry?: Registry;
  readonly signal?: AbortSignal;
}

export type CheckFn = (ctx: DoctorContext) => Promise<DoctorCheck[]>;

/** A check with an id, so a throw can be reported against it. */
export type NamedCheck = { readonly id: string; readonly run: CheckFn };

/** What runDoctor takes: checks, named checks, or groups of them such as configChecks. */
export type CheckInput = CheckFn | NamedCheck | readonly (CheckFn | NamedCheck)[];
