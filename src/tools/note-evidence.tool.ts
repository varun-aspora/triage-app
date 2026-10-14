// note_evidence: how a delegate hands its findings back (HLD 02 §1.2, §1.4,
// §2; D3, D23, D24, D34, D43).
//
// The mount picks the schema in create(): investigators (normal and deep)
// send EntityFindings, code_walker sends CodeFindings. The evidence key is
// the closure's entity, or 'code' for code_walker, so the input has no entity
// or run_id field and a stray one is refused by the strict schemas.
//
// run() re-validates the input (Flue parses it first; this keeps the check in
// our hands for any other caller), passes every text field through the
// persisted profile, so decrypt_fields plaintext and ids are masked on the
// way to disk, writes evidence/<entity|code>.json through the RunStore,
// records the redacted copy in the run's escalation store (delegates cannot
// use persistent state), writes one audit line and returns the evidence id.
//
// The tool is exempt from the tool-call budget (BUDGET_EXEMPT_TOOLS), so it
// never asks the budget and still works after the run budget ran out.
//
// The triage root has no entity, and the run store keys evidence by entity or
// 'code', so on the triage mount the call is refused and the model is told to
// let the delegate record its own findings.
//
// Single shape (D109, D110): the module is perEntity, so the agent mount
// gets one note_evidence with an entity input, which runs the copy built
// with that entity in the closure. Code findings go through
// codebase_note_evidence (codebase-note-evidence.tool.ts), a shared tool
// built here with the 'code' key.
//
// On the agent mount a call is refused unless the run has queried what it
// records: an ok data call for that entity (or a repo_* / code_* call for
// code) in the run action log, or an earlier stored version of the same key.
// The action log is released when the run settles, so after a resume the
// stored key is what lets the agent add a version without querying again.

import { defineTool, type ToolDefinition } from '@flue/runtime/tool';
import * as v from 'valibot';
import type { RecordedFindings } from '../agents/escalation.ts';
import { makeAuditLine } from '../gate/audit.ts';
import { CODE_TOOLS } from '../gate/budget.ts';
import { type Persisted, redactModelFacing, redactPersisted } from '../gate/redact.ts';
import { type Action, actionsFor } from '../runlog/actions.ts';
import { RunStoreRedactionError, type Findings } from '../runstore/types.ts';
import type { AuditTransport } from '../types/audit.ts';
import type { Entity } from '../types/core.ts';
import { CodeFindingsSchema, EntityFindingsSchema } from '../types/findings.ts';
import { ok, refused, type ToolEnvelope } from '../types/tool-result.ts';
import type { Mount, ToolContext, ToolModule } from './types.ts';
import type {} from './_lib/context.ts';

export const NOTE_EVIDENCE = 'note_evidence';
/** The agent mount's tool for code findings (D109). */
export const CODEBASE_NOTE_EVIDENCE = 'codebase_note_evidence';

/** Most failing paths listed in a refusal. The rest are counted. */
const MAX_LISTED_PATHS = 12;

const ENTITY_DESCRIPTION =
  'Record your findings for this investigation as EntityFindings: evidence items with source, at, ' +
  'query_or_path and summary; a timeline; hypotheses; confidence high|medium|low; gaps; and ' +
  'suggested_next_entity when another entity should be checked. Call it before you reply to the ' +
  'parent; a later call stores a new version. Returns evidence_id and version.';

const CODE_DESCRIPTION =
  'Record your code findings as CodeFindings: claims with repo, file, lines and what_it_shows, an ' +
  'optional matches_known_pattern, and confidence high|medium|low. Call it before you reply to the ' +
  'parent; a later call stores a new version. Returns evidence_id and version.';

const TRIAGE_DESCRIPTION =
  'Findings are recorded by the delegates, not by the orchestrator. Each investigate_<entity> and ' +
  'code_walker calls note_evidence itself; you do not need to call this tool.';

const TRIAGE_REFUSAL =
  'Refused: the orchestrator has no entity to record findings under. Ask the investigate_<entity> ' +
  'or code_walker delegate to record them with note_evidence.';

// One text for every entity: the agent mount shows one tool for all of them (D110).
const AGENT_ENTITY_DESCRIPTION =
  'Save your findings for one entity as EntityFindings: evidence items with source, at, query_or_path and ' +
  'summary; a timeline; hypotheses; confidence high|medium|low; gaps; and suggested_next_entity. ' +
  "Only that entity's findings go in a call, after a data call for it returned a result; another entity's " +
  'findings go in their own call. When the cause sits in another entity, set suggested_next_entity to it: two ' +
  'entity records that each blame their own entity count as conflicting hypotheses. A later call for the ' +
  'same entity stores a new version. Returns evidence_id and version.';

const AGENT_CODE_DESCRIPTION =
  'Save your code findings as CodeFindings: claims with repo, file, lines and what_it_shows, an ' +
  'optional matches_known_pattern, and confidence high|medium|low. Only after a repo_* or code_* call ' +
  'returned a result; data findings go to note_evidence with their entity. A later call stores a new ' +
  'version. Returns evidence_id and version.';

const notQueriedRefusal = (e: Entity): string =>
  `Refused: no ${e} data call has returned a result in this run, so there is nothing to record under ` +
  `${e}. Query ${e} first, or save these findings under the entity you queried.`;

const CODE_NOT_READ_REFUSAL =
  'Refused: no repo_* or code_* call has returned a result in this run, so there are no code findings ' +
  `to record. Read the code first, then call ${CODEBASE_NOTE_EVIDENCE} again.`;

// `checkQueried`: on the agent mount, the run must have queried the key first.
type Plan =
  | { readonly kind: 'entity'; readonly key: Entity; readonly checkQueried: boolean }
  | { readonly kind: 'code'; readonly key: 'code'; readonly checkQueried: boolean }
  | { readonly kind: 'triage'; readonly key: null };

type Recording = Exclude<Plan, { kind: 'triage' }>;

function planFor(ctx: ToolContext, mount: Mount): Plan {
  if (mount === 'code_walker') return { kind: 'code', key: 'code', checkQueried: false };
  if (mount === 'triage') return { kind: 'triage', key: null };
  if (ctx.entity === null) throw new Error(`note_evidence on mount ${mount} needs an entity in the tool context`);
  return { kind: 'entity', key: ctx.entity, checkQueried: mount === 'agent' };
}

// A reused result counts: the data was read earlier in the run.
const OK_OUTCOME = /^ok\b/;

/**
 * The entity a logged call read: the entity of an agent-mount entity tool
 * (D110). Null for shared tools, for note_evidence itself and for every call
 * of the split shape.
 */
export function queriedEntity(action: Pick<Action, 'tool' | 'entity' | 'entityTool'>): Entity | null {
  return action.entityTool === true && action.tool !== NOTE_EVIDENCE ? action.entity : null;
}

/** Entities with at least one ok data call through an agent-mount entity tool in the action log. */
export function entitiesQueried(actions: readonly Action[]): Set<Entity> {
  const found = new Set<Entity>();
  for (const a of actions) {
    const entity = queriedEntity(a);
    if (entity !== null && OK_OUTCOME.test(a.outcome)) found.add(entity);
  }
  return found;
}

function codeRead(actions: readonly Action[]): boolean {
  return actions.some((a) => CODE_TOOLS.includes(a.tool) && OK_OUTCOME.test(a.outcome));
}

/** The input schema the model sees for a mount. */
export function noteEvidenceSchema(mount: Mount): typeof EntityFindingsSchema | typeof CodeFindingsSchema {
  return mount === 'code_walker' ? CodeFindingsSchema : EntityFindingsSchema;
}

/** Dot paths of the failing fields, never their values. */
export function failingPaths(issues: readonly v.BaseIssue<unknown>[]): string[] {
  return [...new Set(issues.map((issue) => v.getDotPath(issue) ?? '(input)'))];
}

function listPaths(paths: readonly string[]): string {
  const shown = paths.slice(0, MAX_LISTED_PATHS).join(', ');
  const more = paths.length - MAX_LISTED_PATHS;
  return more > 0 ? `${shown} and ${more} more` : shown;
}

function describe(plan: Plan): string {
  if (plan.kind === 'triage') return TRIAGE_DESCRIPTION;
  if (plan.kind === 'code') return plan.checkQueried ? AGENT_CODE_DESCRIPTION : CODE_DESCRIPTION;
  return plan.checkQueried ? AGENT_ENTITY_DESCRIPTION : ENTITY_DESCRIPTION;
}

type Checked =
  | { readonly ok: true; readonly record: RecordedFindings }
  | { readonly ok: false; readonly paths: string[] };

// Parses with the mount's schema and pairs the output with its evidence key,
// so the escalation record is typed by the mount rather than by a cast.
function check(plan: Recording, data: unknown): Checked {
  if (plan.kind === 'code') {
    const parsed = v.safeParse(CodeFindingsSchema, data);
    return parsed.success
      ? { ok: true, record: { entity: 'code', findings: parsed.output } }
      : { ok: false, paths: failingPaths(parsed.issues) };
  }
  const parsed = v.safeParse(EntityFindingsSchema, data);
  return parsed.success
    ? { ok: true, record: { entity: plan.key, findings: parsed.output } }
    : { ok: false, paths: failingPaths(parsed.issues) };
}

/** codebase_note_evidence: CodeFindings under the 'code' key, with the agent mount's check. */
export function createCodeEvidenceTool(ctx: ToolContext): ToolDefinition {
  return build(ctx, { kind: 'code', key: 'code', checkQueried: true }, CODEBASE_NOTE_EVIDENCE);
}

function create(ctx: ToolContext, mount: Mount): ToolDefinition {
  return build(ctx, planFor(ctx, mount), NOTE_EVIDENCE);
}

function build(ctx: ToolContext, plan: Plan, name: string): ToolDefinition {
  return defineTool({
    name,
    description: describe(plan),
    input: plan.kind === 'code' ? CodeFindingsSchema : EntityFindingsSchema,
    run: async ({ data, signal }): Promise<ToolEnvelope> => {
      signal?.throwIfAborted();
      const deps = ctx.deps;
      const now = deps.now;
      const started = now().getTime();
      const names = deps.run.redactionNames;
      const transport: AuditTransport = deps.fixtures.settings.mockMode ? 'mock' : 'real';
      // The store's backing setting, by name only.
      const target = deps.runStore.provider === 'postgres' ? 'TRIAGE_DB_URL' : 'TRIAGE_RUNS_DIR';
      const where = plan.key ?? 'triage';

      const audit = (decision: 'allow' | 'deny', exit: string, summary: string, reason?: string): void => {
        deps.audit.write(
          makeAuditLine(
            {
              run_id: ctx.runId,
              ts: now().toISOString(),
              interface: deps.run.interface,
              entity: ctx.entity,
              tool: name,
              decision,
              ...(reason !== undefined ? { reason } : {}),
              service: 'evidence',
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
      // The action log first; the store only when the log has no such call.
      const wasQueried = async (recording: Recording): Promise<boolean> => {
        const actions = actionsFor(ctx.runId);
        const inLog = recording.kind === 'code' ? codeRead(actions) : entitiesQueried(actions).has(recording.key);
        if (inLog) return true;
        const run = await deps.runStore.getRun(ctx.runId);
        return run?.evidence[recording.key] !== undefined;
      };
      const refuse = (message: string, reason: string): ToolEnvelope => {
        audit('deny', 'refused', `${name} ${where}: refused`, reason);
        return refused(redactModelFacing(message), now);
      };

      if (plan.kind === 'triage') return refuse(TRIAGE_REFUSAL, 'no entity on the triage mount');
      if (plan.checkQueried && !(await wasQueried(plan))) {
        return plan.kind === 'code'
          ? refuse(CODE_NOT_READ_REFUSAL, 'no code read in this run')
          : refuse(notQueriedRefusal(plan.key), `${plan.key} not queried in this run`);
      }
      signal?.throwIfAborted();

      const checked = check(plan, data);
      if (!checked.ok) {
        const paths = listPaths(checked.paths);
        const shape = plan.kind === 'code' ? 'CodeFindings' : 'EntityFindings';
        return refuse(
          `Refused: the findings do not match ${shape} at ${paths}. Fix those fields and call ${name} again.`,
          `schema: ${paths}`,
        );
      }

      const confidence = checked.record.findings.confidence;
      const safe: Persisted<Findings> = redactPersisted<Findings>(checked.record.findings, { names });

      let version: number;
      try {
        version = await deps.runStore.putEvidence(ctx.runId, plan.key, safe);
      } catch (err) {
        // The store's own re-scan found something the profile left. Name the
        // patterns only, so the model can reword; nothing was written.
        if (err instanceof RunStoreRedactionError) {
          return refuse(
            `Refused: the findings still contain ${err.patterns.join(', ')} after masking. ` +
              `Remove those values from the text and call ${name} again.`,
            `redaction: ${err.patterns.join(', ')}`,
          );
        }
        throw err;
      }
      // No abort check past this point: the evidence is on disk, so the
      // escalation record and the audit line must follow it.

      // Redaction changes text only, so the masked copy keeps the record's shape.
      deps.escalation.record({ ...checked.record, findings: safe.value } as RecordedFindings);

      const evidenceId = `${plan.key}@v${version}`;
      audit('allow', 'ok', `${name} ${evidenceId} confidence ${confidence}`);
      return ok({ evidence_id: evidenceId, version }, now);
    },
  });
}

export const toolModule: ToolModule = {
  name: NOTE_EVIDENCE,
  mounts: ['triage', 'investigator', 'investigator_deep', 'code_walker', 'agent'],
  entities: 'all',
  perEntity: true,
  enabled: () => ({ on: true }),
  create,
};
