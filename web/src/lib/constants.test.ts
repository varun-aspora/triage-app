import { describe, expect, test } from 'bun:test';
import { CATEGORIES as SRC_CATEGORIES } from '../../../src/types/classification.ts';
import {
  ENTITIES as SRC_ENTITIES,
  KNOWN_ID_KEYS as SRC_KNOWN_ID_KEYS,
  REPORT_STATUSES as SRC_REPORT_STATUSES,
  TIERS as SRC_TIERS,
} from '../../../src/types/core.ts';
import { EVIDENCE_LADDER_STEPS as SRC_LADDER } from '../../../src/types/findings.ts';
import {
  EVIDENCE_KEYS as SRC_EVIDENCE_KEYS,
  FEEDBACK_VERDICTS as SRC_VERDICTS,
  RUN_PHASES as SRC_PHASES,
  TERMINAL_PHASES,
} from '../../../src/runstore/types.ts';
import { DOCTOR_STATUSES as SRC_DOCTOR } from '../../../src/ops/doctor/types.ts';
import { SKILL_STATUSES } from '../../../test/knowledge/_util.ts';
import * as c from './constants.ts';

describe('constants match src/', () => {
  test('lists', () => {
    expect([...c.RUN_PHASES]).toEqual([...SRC_PHASES]);
    expect([...c.CATEGORIES]).toEqual([...SRC_CATEGORIES]);
    expect([...c.TIERS]).toEqual([...SRC_TIERS]);
    expect([...c.ENTITIES]).toEqual([...SRC_ENTITIES]);
    expect([...c.KNOWN_ID_KEYS]).toEqual([...SRC_KNOWN_ID_KEYS]);
    expect([...c.REPORT_STATUSES]).toEqual([...SRC_REPORT_STATUSES]);
    expect([...c.FEEDBACK_VERDICTS]).toEqual([...SRC_VERDICTS]);
    expect([...c.EVIDENCE_LADDER_STEPS]).toEqual([...SRC_LADDER]);
    expect([...c.EVIDENCE_KEYS]).toEqual([...SRC_EVIDENCE_KEYS]);
    expect([...c.DOCTOR_STATUSES]).toEqual([...SRC_DOCTOR]);
    expect([...c.GUIDE_STATUSES]).toEqual([...SKILL_STATUSES]);
  });

  test('run statuses: every non-terminal phase counts as running', () => {
    expect([...c.RUN_STATUSES]).toEqual(['running', ...TERMINAL_PHASES]);
  });
});
