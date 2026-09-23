'use agent';
// The Triage root agent (HLD 02 §1.1, LLD 04 §2.4; D3, D10, D23, D42, D45).
//
// The run id is the instance id: ingress starts each run with
// init(Triage, { id: run_id }) and the TriageInit as initialData. Each render:
// - the tier model and its thinking level, once (useModel);
// - the one sandbox, once (useSandbox); delegates inherit it;
// - the method text as an always-on instruction;
// - toolsFor('triage'): resolve_identity, note_evidence and finish_report
//   only, so the root has no entity I/O of its own;
// - per enabled entity, investigate_<e>, investigate_<e>_deep and the
//   <e>-overview skill; then code_walker and the patterns skill.
// The choices themselves live in triage-plan.ts, which is unit tested.
//
// Persistent state: plan, evidence_index and escalation (mirrored from the
// run's escalation store in the callbacks) and finish_retries. useAgentFinish
// appends triage.finish_required once when no report was written, and throws
// on the next miss, so the submission settles failed with the evidence kept.

import '../models.ts';
import {
  type AgentProps,
  useAgentFinish,
  useAgentStart,
  useInitialData,
  useInstruction,
  useModel,
  usePersistentState,
  useSandbox,
  useSkill,
  useSubagent,
  useTool,
} from '@flue/runtime';
import { toolsFor } from '../tools/index.ts';
import { type TriageInit, TriageInitSchema } from '../types/classification.ts';
import { codeWalkerFor } from './delegates/code-walker.ts';
import { type DelegateEnv, investigatorFor } from './delegates/investigator.ts';
import type { Escalation } from './escalation.ts';
import { methodText } from './instruction.ts';
import { overviewSkill, patternsSkill } from './skills.ts';
import {
  calledFinish,
  durabilityAtImport,
  type EvidenceIndexEntry,
  FINISH_REQUIRED_BODY,
  FINISH_REQUIRED_SIGNAL,
  finishDecision,
  FinishRequiredError,
  mirrorFor,
  type PlanState,
  planState,
  reportWrittenFor,
  runDepsFor,
  sameMirror,
  settleRun,
  triagePlan,
  triageRuntime,
  triageToolContext,
  watchFinishReport,
} from './triage-plan.ts';

export function Triage({ id }: AgentProps): string {
  const init = useInitialData<TriageInit>();
  const rt = triageRuntime();
  const plan = triagePlan(init, rt.config, rt.registry);

  useModel(plan.model, { thinkingLevel: plan.thinkingLevel });
  useSandbox(rt.sandbox);

  const services = Object.fromEntries(plan.entities.map((e) => [e, rt.registry.services(e)]));
  useInstruction(methodText(init, { entities: plan.entities, services, knowledge: rt.knowledge }));

  const deps = runDepsFor(id, init, rt);
  for (const tool of toolsFor('triage', triageToolContext(id, deps, rt))) useTool(watchFinishReport(id, tool));

  const env: DelegateEnv = { config: rt.config, registry: rt.registry, deps, knowledge: rt.knowledge };
  for (const entity of plan.entities) {
    useSubagent(investigatorFor(entity, id, { env }));
    useSubagent(investigatorFor(entity, id, { deep: true, env }));
    const overview = overviewSkill(entity, rt.knowledge);
    if (overview !== undefined) useSkill(overview);
  }
  useSubagent(codeWalkerFor(id, { env }));
  const patterns = patternsSkill(rt.knowledge);
  if (patterns !== undefined) useSkill(patterns);

  const [savedPlan, setPlan] = usePersistentState<PlanState | null>('plan', null);
  const [evidenceIndex, setEvidenceIndex] = usePersistentState<EvidenceIndexEntry[]>('evidence_index', []);
  const [escalation, setEscalation] = usePersistentState<Escalation>('escalation', { triggered: false, reasons: [] });
  const [retries, setRetries] = usePersistentState<number>('finish_retries', 0);

  // Writes only on change, so a quiet turn adds no state records.
  const mirror = (): void => {
    const next = mirrorFor(id, init);
    if (!sameMirror(next, { escalation, evidence_index: evidenceIndex })) {
      setEscalation(next.escalation);
      setEvidenceIndex(next.evidence_index);
    }
  };

  // A new delivery gets its own reminder: the count is per submission, not per run.
  useAgentStart(() => {
    if (savedPlan === null) setPlan(planState(plan));
    if (retries !== 0) setRetries(0);
    mirror();
  });

  useAgentFinish((ctx) => {
    mirror();
    const step = finishDecision(retries, calledFinish(ctx.response.toolCalls, reportWrittenFor(id)));
    if (step.kind === 'done') {
      if (retries !== step.retries) setRetries(step.retries);
      settleRun(id);
      return;
    }
    if (step.kind === 'signal') {
      setRetries(step.retries);
      ctx.append({ kind: 'signal', type: FINISH_REQUIRED_SIGNAL, body: FINISH_REQUIRED_BODY });
      return;
    }
    settleRun(id);
    throw new FinishRequiredError();
  });

  return '';
}

Triage.agentName = 'triage';
Triage.initialData = TriageInitSchema;
Triage.durability = durabilityAtImport();

export const rootAgent = Triage;
