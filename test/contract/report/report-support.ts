// Shared set-up for the report-path contracts (T10.6). Not a contract file
// itself: Vitest only picks up *.contract.ts.
//
// Loads the synthetic fixtures under fixtures/contract/report/ and reads the
// run folder the way a reviewer would: which report.json files exist and
// which evidence files were kept. Every value in the fixtures is synthetic.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';
import { CaseSchema, type EvalCase } from '../../../src/evals/case-schema.ts';
import { FINISH_REQUIRED_SIGNAL } from '../../../src/agents/triage-plan.ts';
import type { FauxCall } from '../../../src/evals/contract/faux-script.ts';
import { REPO_ROOT } from '../../support/home.ts';

export const REPORT_FIXTURES = join(REPO_ROOT, 'fixtures', 'contract', 'report');

function readFixture(file: string): unknown {
  return JSON.parse(readFileSync(join(REPORT_FIXTURES, file), 'utf8'));
}

export type ReportCaseName = 'cheap' | 'strong-money-moved';

/** A case from fixtures/contract/report/case-<name>.json, checked against CaseSchema. */
export function reportCase(name: ReportCaseName): EvalCase {
  return v.parse(CaseSchema, readFixture(`case-${name}.json`));
}

export type FindingsName = 'low' | 'medium' | 'ssfb_blames_itself' | 'rtl_blames_itself';

/** note_evidence input from findings.json. */
export function findingsFixture(name: FindingsName): Record<string, unknown> {
  const all = readFixture('findings.json') as Record<FindingsName, Record<string, unknown>>;
  return structuredClone(all[name]);
}

export type Leaks = {
  readonly phone: { readonly value: string; readonly reply_text: string; readonly pattern: string };
  readonly base64_email: { readonly value: string; readonly decoded: string; readonly command: string; readonly pattern: string };
};

/** The unmasked values the redaction contract puts in a draft. */
export function leaks(): Leaks {
  return readFixture('leaks.json') as Leaks;
}

/** Every report.json in the run folder: the latest copy and one per submission. */
export function reportFiles(runsDir: string, runId: string): string[] {
  const dir = join(runsDir, runId);
  const found: string[] = [];
  if (existsSync(join(dir, 'report.json'))) found.push('report.json');
  const subs = join(dir, 'submissions');
  if (existsSync(subs)) {
    for (const seq of readdirSync(subs)) {
      if (existsSync(join(subs, seq, 'report.json'))) found.push(`submissions/${seq}/report.json`);
    }
  }
  return found.sort();
}

/** The .json files in the run's evidence folder. */
export function evidenceFiles(runsDir: string, runId: string): string[] {
  const dir = join(runsDir, runId, 'evidence');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort();
}

const SIGNAL_OPEN = `<signal type="${FINISH_REQUIRED_SIGNAL}">`;

/** How many finish_required signals a model call's context holds. */
export function signalsIn(call: FauxCall | undefined): number {
  return (call?.userTexts ?? []).filter((t) => t.includes(SIGNAL_OPEN)).length;
}

/** The last result of a tool in a model call's context. */
export function toolResultIn(call: FauxCall | undefined, tool: string) {
  return call?.toolResults.filter((r) => r.toolName === tool).at(-1);
}
