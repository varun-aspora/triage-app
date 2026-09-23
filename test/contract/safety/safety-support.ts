// Shared set-up for the safety contracts (T10.5). Not a contract file itself:
// Vitest only picks up *.contract.ts.
//
// Every safety file runs Triage through runCase (T10.4) on an eval home with
// the fake model, strict mock mode and no network. The cases are the JSON
// files under fixtures/contract/safety/: { about, case, injected_ids?, env? }.
// env holds budget keys a file boots the eval runtime with.

import http from 'node:http';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';
import { expect, vi } from 'vitest';
import { checkNoRealIo } from '../../../src/evals/audit-gates.ts';
import { CaseSchema, type EvalCase } from '../../../src/evals/case-schema.ts';
import type { FauxCall, FauxCaller, FauxToolResult } from '../../../src/evals/contract/faux-script.ts';
import type { CaseResult } from '../../../src/evals/driver.ts';
import { REPO_ROOT } from '../../support/home.ts';
import { spyOnSpawns } from '../../support/spawn-spy.ts';
import { brief } from '../eval-support.ts';

export const SAFETY_FIXTURES = join(REPO_ROOT, 'fixtures/contract/safety');

const SafetyFileSchema = v.strictObject({
  about: v.string(),
  case: CaseSchema,
  injected_ids: v.optional(v.array(v.string())),
  env: v.optional(v.record(v.pipe(v.string(), v.regex(/^TRIAGE_[A-Z_]+$/)), v.string())),
});

export type SafetyFile = {
  readonly case: EvalCase;
  readonly injectedIds: readonly string[];
  readonly env: Readonly<Record<string, string>>;
};

/** Reads fixtures/contract/safety/<name>.json. */
export function safetyCase(name: string): SafetyFile {
  const raw: unknown = JSON.parse(readFileSync(join(SAFETY_FIXTURES, `${name}.json`), 'utf8'));
  const parsed = v.parse(SafetyFileSchema, raw);
  return Object.freeze({ case: parsed.case, injectedIds: parsed.injected_ids ?? [], env: parsed.env ?? {} });
}

/** A brief for the ATSPL investigator. Extra lines go after the skeleton. */
export function atsplBrief(extra = ''): string {
  return extra === '' ? brief('atspl') : `${brief('atspl')}\n${extra}`;
}

/** Tool results a caller saw for one tool, in order, across all its calls (deduplicated by call id). */
export function toolResults(result: CaseResult, caller: FauxCaller, tool: string): FauxToolResult[] {
  const seen = new Map<string, FauxToolResult>();
  for (const call of result.model_calls.filter((c: FauxCall) => c.caller === caller)) {
    for (const r of call.toolResults) if (r.toolName === tool && !seen.has(r.toolCallId)) seen.set(r.toolCallId, r);
  }
  return [...seen.values()];
}

/** The tool output a result text holds, parsed from JSON. Undefined when the text is not JSON. */
export function outputOf(r: FauxToolResult | undefined): Record<string, unknown> | undefined {
  if (r === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(r.text);
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** The run finished with a report, and every scripted turn was used with no faux failure. */
export function expectFinished(result: CaseResult): void {
  expect(result.error, 'run error').toBeUndefined();
  expect(result.status).toBe('completed');
  expect(result.report).not.toBeNull();
  expect(result.faux_failures).toEqual([]);
  for (const [caller, left] of Object.entries(result.turns_left)) expect(left, `turns left for ${caller}`).toBe(0);
}

/** checkNoRealIo over the case's audit lines, with at least one line to check. */
export function expectNoRealIo(result: CaseResult): void {
  expect(result.audit.length).toBeGreaterThan(0);
  expect(checkNoRealIo(result.audit)).toEqual({ ok: true, offending: [] });
}

export type IoSpies = {
  /** Network requests and subprocess starts seen so far. */
  counts(): { fetch: number; http: number; https: number; spawn: number };
  restore(): void;
};

/** Counts fetch, http and https requests and subprocess starts. The no-io guard still blocks them. */
export function spyOnIo(): IoSpies {
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  const httpSpy = vi.spyOn(http, 'request');
  const httpsSpy = vi.spyOn(https, 'request');
  const spawns = spyOnSpawns();
  return {
    counts: () => ({
      fetch: fetchSpy.mock.calls.length,
      http: httpSpy.mock.calls.length,
      https: httpsSpy.mock.calls.length,
      spawn: spawns.calls().length,
    }),
    restore() {
      fetchSpy.mockRestore();
      httpSpy.mockRestore();
      httpsSpy.mockRestore();
      spawns.restore();
    },
  };
}
