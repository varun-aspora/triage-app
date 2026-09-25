// Shared set-up for the driver and faux routing contracts (T10.4). Not a
// contract file itself: Vitest only picks up *.contract.ts.
//
// evalHome() writes a real eval home (src/evals/make-home.ts) into a temp dir
// and exports it as TRIAGE_HOME, so bootEvalRuntime sees what `triage evals`
// would see. Every value in it is synthetic and every credential is blank.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as v from 'valibot';
import { CaseSchema, type EvalCase } from '../../src/evals/case-schema.ts';
import { materialiseEvalHome } from '../../src/evals/make-home.ts';
import type { Tier } from '../../src/types/core.ts';
import { REPO_ROOT } from '../support/home.ts';
import { assertNoIoGuardInstalled } from '../support/no-io-guard.ts';

assertNoIoGuardInstalled();

export type EvalHome = { readonly home: string; dispose(): void };

/** A fresh eval home, exported as TRIAGE_HOME until dispose(). */
export function evalHome(): EvalHome {
  const dir = mkdtempSync(join(tmpdir(), 'triage-eval-home-'));
  const previous = process.env.TRIAGE_HOME;
  const home = materialiseEvalHome(dir, REPO_ROOT);
  process.env.TRIAGE_HOME = home;
  return Object.freeze({
    home,
    dispose() {
      if (previous === undefined) delete process.env.TRIAGE_HOME;
      else process.env.TRIAGE_HOME = previous;
      rmSync(dir, { recursive: true, force: true });
    },
  });
}

/** A brief in the shape the method text asks for. */
export function brief(entity: string): string {
  return `Entity: ${entity}\nQuestion: what happened\nIds: none\nWindow: last week\nServices in play: all\nReturn: findings`;
}

/** note_evidence input with no ids in it. */
export function findings(confidence: 'high' | 'medium' | 'low') {
  return {
    evidence: [{ source: 'db', at: '2026-09-20T10:00:00.000Z', query_or_path: 'contract', summary: 'nothing unusual found' }],
    timeline: [],
    hypotheses: ['the contract case has no fault'],
    confidence,
    gaps: [],
  };
}

/** A valid report draft from the sample report fixture, set to the tier the run will have. */
export function reportDraft(tier: Tier, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const full = JSON.parse(readFileSync(join(REPO_ROOT, 'src/report/__fixtures__/sample-report.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  const { run_id: _r, env_label: _e, generated_at: _g, repo_commits: _c, cost: _k, ...draft } = full;
  const classification = draft.classification as Record<string, unknown>;
  return {
    ...draft,
    classification: { ...classification, tier_final: tier },
    escalated: false,
    escalation_reasons: [],
    ...overrides,
  };
}

/** A minimal synthetic case: a text request, no ids, and the classification the faux classifier serves. */
export function minimalCase(id: string, tier: Tier, category = 'onboarding'): EvalCase {
  return v.parse(CaseSchema, {
    id,
    taxonomy_version: 'v1',
    label_source: 'synthetic',
    request: { text: 'The app shows a spinner on the onboarding screen and never moves on.' },
    ids: {},
    id_chain: { ids: {}, hops: [] },
    basic_state: [],
    expected: { category, tier },
    faux_classification: {
      category,
      subcategory: '',
      entities_likely: [],
      money_moved: false,
      misdirected_funds: false,
      tier_proposed: tier,
      confidence: 0.9,
      images_seen: false,
    },
    provenance: { origin: 'synthetic', notes: 'Written inline for the T10.4 contract tests.' },
  });
}
