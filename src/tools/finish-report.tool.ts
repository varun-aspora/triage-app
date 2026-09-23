// finish_report: how the Triage root writes the final report (HLD 02 §1.1,
// §2, §4.3, §6; LLD 04 §2.8, §2.9, §3; D23, D24, D35, D37).
//
// Mounted on the triage root only, as a harness tool, so it can run the
// strong-model synthesis pass with harness.prompt(). Input is the report
// draft: the Report minus run_id, env_label, generated_at, repo_commits and
// cost, which this tool and writeReport fill.
//
// run(), in order:
//   1. Re-check the draft shape (Flue parses it first; this keeps the check in
//      our hands). A bad shape is refused with the failing paths.
//   2. Read the run through the RunStore: its evidence (latest version per
//      key), its classification record and its created_at.
//   3. Compute escalation with computeEscalation() over the stored findings
//      plus the run's escalation store snapshot, with the budget state. The
//      tier and money_moved come from initialData when it is wired, else from
//      the stored classification, else from the draft.
//   4. When escalation fired and the tier is not strong, replace the draft
//      with synthesizeOnStrong(). A ResultUnavailableError keeps the draft
//      with a gap (synthesis.ts handles that). The pass runs at most
//      MAX_SYNTHESIS_PASSES times per run, so a synthesized report that keeps
//      failing the egress check cannot loop forever. The count lives in a
//      module-level map keyed by run id, because Flue re-renders the agent
//      before every model turn and so builds a fresh tool each time.
//   5. repo_commits: one { repo, commit } per repo in the code evidence, from
//      the CommitReader (currentCommit, T11.4). A repo without a commit gets
//      a gap.
//   6. cost: token usage per model from the UsageReader (T06.7 runUsage),
//      priced with the pi-ai model metadata cost fields. A model without
//      pricing, or no reader, gives cost null and a gap.
//   7. initialData.preflight_warnings (or the stored ones) become gaps.
//   8. writeReport() with the ingress names (initialData.redaction_names plus
//      deps.run.redactionNames). A refusal is returned as a refused envelope
//      with the retry text; it is never thrown and nothing is written.
//
// Every gap this tool adds goes through the persisted profile first, so a
// value the model cannot change never makes writeReport refuse.
//
// The tool is exempt from the tool-call budget (BUDGET_EXEMPT_TOOLS): it
// never asks the budget, so it still works after the run budget ran out.
//
// synthesis.ts and models.ts are imported lazily inside run(). models.ts
// loads config at import, and the generated tool list is imported by many
// modules and tests that should not do that.

import type { FlueHarness } from '@flue/runtime';
import { defineTool, type ToolDefinition } from '@flue/runtime/tool';
import * as v from 'valibot';
import { computeEscalation, type Escalation, type RecordedFindings } from '../agents/escalation.ts';
import { makeAuditLine } from '../gate/audit.ts';
import { redactModelFacing, redactPersisted } from '../gate/redact.ts';
import { currentCommit, type CommitResult, type ReposDeps } from '../ops/repos.ts';
import { refusalMessage, writeReport, type WriteReportArgs, type WriteReportResult } from '../report/write.ts';
import { RunNotFoundError, type RunRecord } from '../runstore/types.ts';
import type { AuditTransport } from '../types/audit.ts';
import type { PreflightWarning, TriageInit } from '../types/classification.ts';
import { ENTITIES, type Entity, type RunId, type Tier } from '../types/core.ts';
import type { CodeFindings, EntityFindings } from '../types/findings.ts';
import { type RepoCommit, type ReportCost, type ReportDraft, ReportDraftSchema, RepoCommitSchema } from '../types/report.ts';
import { ok, refused, type ToolEnvelope } from '../types/tool-result.ts';
import type { ToolContext, ToolModule } from './types.ts';
import type {} from './_lib/context.ts';

export const FINISH_REPORT = 'finish_report';

/** How often one run runs the strong synthesis before it keeps the draft. */
export const MAX_SYNTHESIS_PASSES = 2;

// Synthesis passes per run. It sits outside the tool so the count survives
// the tool being rebuilt on every agent render. releaseFinishReport() drops
// the entry when the run settles, next to releaseEscalation().
const synthesisPasses = new Map<RunId, number>();

/** How many strong synthesis passes this run has used. */
export function synthesisPassesFor(runId: RunId): number {
  return synthesisPasses.get(runId) ?? 0;
}

/** Drops a run's synthesis count when the run settles. Returns true when one existed. */
export function releaseFinishReport(runId: RunId): boolean {
  return synthesisPasses.delete(runId);
}

/** Most failing paths listed in a shape refusal. The rest are counted. */
const MAX_LISTED_PATHS = 12;

// ------------------------------------------------------------------ deps

/** Token usage for one model in the run. */
export type UsageEntry = {
  readonly input_tokens: number;
  readonly output_tokens: number;
  /** Model calls; 0 when the reader does not count them. */
  readonly calls?: number;
};

/** Usage per model spec ('provider/model') for one run. */
export type RunUsage = Readonly<Record<string, UsageEntry>>;

/** Reads a run's token usage. T06.8 backs it with T06.7's runUsage(runId). */
export type UsageReader = (runId: RunId) => RunUsage | Promise<RunUsage>;

/** The commit a repo checkout is on. Backed by currentCommit (T11.4). */
export type CommitReader = (repo: string, signal?: AbortSignal) => Promise<CommitResult>;

declare module './types.ts' {
  interface ToolDeps {
    /**
     * The Triage root's initialData. T06.8 sets it on the triage mount. When
     * it is missing, finish_report falls back to the stored classification
     * record and deps.run.redactionNames.
     */
    readonly initialData?: TriageInit;
    /** Token usage for the report's cost. Missing means cost null with a gap. */
    readonly usage?: UsageReader;
    /** Commit per repo for repo_commits. Missing means a gap per repo. */
    readonly repoCommit?: CommitReader;
  }
}

/** The CommitReader over currentCommit, for the agents area to put in ToolDeps. */
export function commitReaderFor(deps: Omit<ReposDeps, 'signal'>): CommitReader {
  return (repo, signal) => currentCommit(repo, { ...deps, ...(signal !== undefined ? { signal } : {}) });
}

// ------------------------------------------------------------------ pricing

/** USD per million tokens, as pi-ai model metadata gives it. */
export type ModelPricing = { readonly input: number; readonly output: number };

/** Pricing for a model spec, or undefined when no metadata has it. */
export type PricingLookup = (spec: string) => ModelPricing | undefined | Promise<ModelPricing | undefined>;

function isRate(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x) && x >= 0;
}

/** Reads the cost fields of the pi-ai model metadata that models.ts resolves. */
export const defaultPricing: PricingLookup = async (spec) => {
  const { lookupModel } = await import('../models.ts');
  const cost = (lookupModel(spec) as { cost?: { input?: unknown; output?: unknown } } | undefined)?.cost;
  if (cost === undefined || !isRate(cost.input) || !isRate(cost.output)) return undefined;
  return { input: cost.input, output: cost.output };
};

// ------------------------------------------------------------------ options

export type FinishReportOptions = {
  /** The report writer. Defaults to writeReport (T08.4). */
  readonly writeReport?: (args: WriteReportArgs) => Promise<WriteReportResult>;
  /** Model pricing. Defaults to the pi-ai metadata through models.ts. */
  readonly pricing?: PricingLookup;
};

// ------------------------------------------------------------------ text

const DESCRIPTION =
  'Write the final triage report and end the investigation. Pass the full report draft: request, ' +
  'classification, id_chain, current_state (each with taken_at), timeline, root_cause (null when ' +
  'not confirmed), scope, status, cx_answer, actions, suggested_fix (commands for a human, with ' +
  '$VAR placeholders for hosts and tokens), confidence and its reason, evidence_ladder, ' +
  'entities_consulted, gaps, escalated, escalation_reasons and images_seen. Do not pass run_id, ' +
  'repo_commits or cost; they are filled for you. Mask ids in free text (keep at most the last four ' +
  'digits behind ****) and leave out names, phones and emails. If the report is refused, the reply ' +
  'lists the fields to fix; fix them and call finish_report again. Returns where the report was written.';

const SYNTHESIS_NOTE =
  'The report was rebuilt by the strong-model synthesis pass, so the fields above come from that ' +
  'rebuild. Fix the matching fields in your draft and call finish_report again.';

export const SYNTHESIS_SKIPPED_GAP =
  'strong-model synthesis was not run again after its reports were refused; this report is the orchestrator draft';

export const NO_USAGE_GAP = 'cost not recorded: no token usage was available for this run';

// ------------------------------------------------------------------ helpers

/** Dot paths of the failing fields, never their values. */
function failingPaths(issues: readonly v.BaseIssue<unknown>[]): string[] {
  return [...new Set(issues.map((issue) => v.getDotPath(issue) ?? '(input)'))];
}

function listPaths(paths: readonly string[]): string {
  const shown = paths.slice(0, MAX_LISTED_PATHS).join(', ');
  const more = paths.length - MAX_LISTED_PATHS;
  return more > 0 ? `${shown} and ${more} more` : shown;
}

function unique(list: readonly string[]): string[] {
  return [...new Set(list)];
}

/** The latest findings per evidence key: the store first, the escalation store for keys it lacks. */
export function collectFindings(
  stored: RunRecord['evidence'],
  recorded: readonly RecordedFindings[],
): RecordedFindings[] {
  const byKey = new Map<Entity | 'code', RecordedFindings>();
  for (const r of recorded) byKey.set(r.entity, r);
  for (const key of [...ENTITIES, 'code'] as const) {
    const rec = stored[key];
    if (rec === undefined) continue;
    byKey.set(
      key,
      key === 'code'
        ? { entity: 'code', findings: rec.findings as CodeFindings }
        : { entity: key, findings: rec.findings as EntityFindings },
    );
  }
  const order: readonly (Entity | 'code')[] = [...ENTITIES, 'code'];
  return order.flatMap((k) => {
    const r = byKey.get(k);
    return r === undefined ? [] : [r];
  });
}

/** Repos named in the code evidence, in first-seen order. */
export function codeRepos(findings: readonly RecordedFindings[]): string[] {
  const repos: string[] = [];
  for (const r of findings) {
    if (r.entity !== 'code') continue;
    for (const claim of r.findings.claims) if (!repos.includes(claim.repo)) repos.push(claim.repo);
  }
  return repos;
}

export function preflightGap(w: PreflightWarning): string {
  const where = w.entity === undefined ? w.step : `${w.entity} ${w.step}`;
  const fix = w.fix !== undefined && w.fix.trim() !== '' ? ` (fix: ${w.fix.trim()})` : '';
  return `preflight ${where}: ${w.message}${fix}`;
}

type RunFacts = { readonly tierFinal: Tier; readonly moneyMoved: boolean };

function runFacts(init: TriageInit | undefined, run: RunRecord, draft: ReportDraft): RunFacts {
  const decision = init?.classification ?? run.classification?.decision ?? draft.classification;
  return { tierFinal: decision.tier_final, moneyMoved: decision.proposed.money_moved };
}

type CostResult = { readonly cost: ReportCost | null; readonly gaps: string[] };

/** Prices the run's usage. Any model without pricing makes the cost null with a gap. */
export async function computeCost(
  usage: RunUsage | undefined,
  pricing: PricingLookup,
  wallMs: number,
): Promise<CostResult> {
  if (usage === undefined) return { cost: null, gaps: [NO_USAGE_GAP] };
  const models: ReportCost['models'] = {};
  const unpriced: string[] = [];
  let usd = 0;
  for (const spec of Object.keys(usage).sort()) {
    const u = usage[spec] as UsageEntry;
    const input = Math.max(0, Math.trunc(u.input_tokens));
    const output = Math.max(0, Math.trunc(u.output_tokens));
    models[spec] = { calls: Math.max(0, Math.trunc(u.calls ?? 0)), input_tokens: input, output_tokens: output };
    const price = await pricing(spec);
    if (price === undefined) unpriced.push(spec);
    else usd += (input * price.input + output * price.output) / 1_000_000;
  }
  if (unpriced.length > 0) {
    return { cost: null, gaps: [`cost not computed: no pricing metadata for ${unpriced.join(', ')}`] };
  }
  return {
    cost: { models, wall_ms: Math.max(0, Math.round(wallMs)), usd_total: Math.round(usd * 1_000_000) / 1_000_000 },
    gaps: [],
  };
}

type CommitsResult = { readonly commits: RepoCommit[]; readonly gaps: string[] };

async function readCommits(
  repos: readonly string[],
  reader: CommitReader | undefined,
  signal: AbortSignal | undefined,
): Promise<CommitsResult> {
  const commits: RepoCommit[] = [];
  const gaps: string[] = [];
  for (const repo of repos) {
    if (reader === undefined) {
      gaps.push(`commit not recorded for repo ${repo}: no commit reader for this run`);
      continue;
    }
    signal?.throwIfAborted();
    const res = await reader(repo, signal);
    if (res.status !== 'ok') {
      gaps.push(`commit not recorded for repo ${repo}: ${res.reason}`);
      continue;
    }
    const entry = { repo, commit: res.commit };
    if (!v.is(RepoCommitSchema, entry)) {
      gaps.push(`commit not recorded for repo ${repo}: not a commit id`);
      continue;
    }
    commits.push(entry);
  }
  return { commits, gaps };
}

function wallMsSince(createdAt: string, now: Date): number {
  const start = Date.parse(createdAt);
  return Number.isFinite(start) ? Math.max(0, now.getTime() - start) : 0;
}

// ------------------------------------------------------------------ tool

type FinishRunContext = {
  readonly data: unknown;
  readonly signal?: AbortSignal;
  readonly harness: Pick<FlueHarness, 'prompt'>;
};

/** Builds the tool. toolModule.create() calls it with the defaults; tests pass fakes. */
export function createFinishReportTool(ctx: ToolContext, options: FinishReportOptions = {}): ToolDefinition {
  const write = options.writeReport ?? writeReport;
  const pricing = options.pricing ?? defaultPricing;

  const run = async ({ data, signal, harness }: FinishRunContext): Promise<ToolEnvelope> => {
    signal?.throwIfAborted();
    const deps = ctx.deps;
    const now = deps.now;
    const started = now().getTime();
    const init = deps.initialData;
    const names = unique([...(init?.redaction_names ?? []), ...deps.run.redactionNames]);
    const transport: AuditTransport = deps.fixtures.settings.mockMode ? 'mock' : 'real';
    const target = deps.runStore.provider === 'postgres' ? 'TRIAGE_DB_URL' : 'TRIAGE_RUNS_DIR';
    const safe = (text: string): string => redactPersisted(text, { names }).value;

    const audit = (decision: 'allow' | 'deny', exit: string, summary: string, reason?: string): void => {
      deps.audit.write(
        makeAuditLine(
          {
            run_id: ctx.runId,
            ts: now().toISOString(),
            interface: deps.run.interface,
            entity: null,
            tool: FINISH_REPORT,
            decision,
            ...(reason !== undefined ? { reason } : {}),
            service: 'report',
            target,
            transport,
            summary,
            duration_ms: Math.max(0, now().getTime() - started),
            exit,
          },
          { names },
        ),
      );
    };
    const refuse = (message: string, reason: string): ToolEnvelope => {
      audit('deny', 'refused', 'finish_report: refused', reason);
      return refused(redactModelFacing(message), now);
    };

    // 1. Shape.
    const parsed = v.safeParse(ReportDraftSchema, data);
    if (!parsed.success) {
      const paths = listPaths(failingPaths(parsed.issues));
      return refuse(
        `Refused: the report draft does not match the report shape at ${paths}. Fix those fields and call finish_report again.`,
        `shape: ${paths}`,
      );
    }
    let draft: ReportDraft = parsed.output;

    // 2. The run as stored.
    const record = await deps.runStore.getRun(ctx.runId);
    if (record === null) throw new RunNotFoundError(ctx.runId);
    signal?.throwIfAborted();

    // 3. Escalation.
    const facts = runFacts(init, record, draft);
    const snapshot = deps.escalation.snapshot({
      classification: { money_moved: facts.moneyMoved },
      tierFinal: facts.tierFinal,
    });
    const findings = collectFindings(record.evidence, snapshot.findings);
    const escalation: Escalation = computeEscalation({
      findings,
      classification: { money_moved: facts.moneyMoved },
      tierFinal: facts.tierFinal,
      budgetExhausted: snapshot.budgetExhausted || deps.budget.state().exhausted,
    });

    // 4. Strong synthesis.
    let synthesized = false;
    if (escalation.triggered && facts.tierFinal !== 'strong') {
      const passes = synthesisPassesFor(ctx.runId);
      if (passes < MAX_SYNTHESIS_PASSES) {
        synthesisPasses.set(ctx.runId, passes + 1);
        const { synthesizeOnStrong } = await import('../agents/synthesis.ts');
        draft = await synthesizeOnStrong(
          harness,
          { draft, evidence: findings, reasons: escalation.reasons, ...(signal !== undefined ? { signal } : {}) },
          { config: ctx.config },
        );
        synthesized = true;
      } else {
        draft = {
          ...draft,
          gaps: unique([...draft.gaps, SYNTHESIS_SKIPPED_GAP]),
          escalated: true,
          escalation_reasons: [...escalation.reasons],
        };
      }
    }
    signal?.throwIfAborted();

    // 5. Commits per repo the code walker read.
    const commits = await readCommits(codeRepos(findings), deps.repoCommit, signal);

    // 6. Cost, read after synthesis so its turns are counted.
    const usage = deps.usage === undefined ? undefined : await deps.usage(ctx.runId);
    const cost = await computeCost(usage, pricing, wallMsSince(record.created_at, now()));

    // 7. Pre-flight warnings.
    const warnings = init?.preflight_warnings ?? record.classification?.preflight_warnings ?? [];

    const added = [...warnings.map(preflightGap), ...commits.gaps, ...cost.gaps].map(safe);
    signal?.throwIfAborted();

    // 8. Write.
    const result = await write({
      runId: ctx.runId,
      draft: { ...draft, gaps: unique([...draft.gaps, ...added]), repo_commits: commits.commits, cost: cost.cost },
      ingressNames: names,
      store: deps.runStore,
      config: ctx.config,
      now,
      ...(signal !== undefined ? { signal } : {}),
    });
    if (!result.ok) {
      const message = refusalMessage(result);
      const reason =
        result.reason === 'schema'
          ? `schema: ${listPaths(result.issues.map((i) => i.path))}`
          : `unmasked: ${result.patterns.join(', ')}`;
      return refuse(synthesized ? `${message}\n${SYNTHESIS_NOTE}` : message, reason);
    }

    const report = result.report;
    audit(
      'allow',
      'ok',
      `finish_report submission ${result.paths.submissionId} status ${report.status}${report.escalated ? ' escalated' : ''}`,
    );
    return ok(
      {
        report_json: result.paths.json,
        report_md: result.paths.md,
        submission: result.paths.submissionId,
        status: report.status,
        escalated: report.escalated,
        escalation_reasons: report.escalation_reasons,
      },
      now,
    );
  };

  return defineTool({
    name: FINISH_REPORT,
    description: DESCRIPTION,
    input: ReportDraftSchema,
    harness: true,
    run: (context) => run(context),
  });
}

export const toolModule: ToolModule = {
  name: FINISH_REPORT,
  mounts: ['triage'],
  entities: 'all',
  enabled: () => ({ on: true }),
  create: (ctx) => createFinishReportTool(ctx),
};
