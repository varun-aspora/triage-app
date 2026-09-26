// Mounts the polling triage API (HLD 02 §5.2) after bearer auth.
//
// The deps are built on the first request, from the Triage runtime the agent
// itself uses, so the routes and the agent share one config, registry and
// run store. Submissions are dispatched with Flue's init() inside the
// server's own runtime; nothing here starts one.

import { triageRuntime } from '../agents/triage-plan.ts';
import { pidAlive } from '../cli/commands/status.command.ts';
import { createTriageRoutes, startAsk, startResume, type TriageRouteDeps } from '../ingress/http/routes.ts';
import { prepareDeps, prepareRequest } from '../ingress/prepare.ts';
import { runSubmission, submissionDeps } from '../ingress/submit.ts';
import type { HttpModule } from './types.ts';

export const httpModule: HttpModule = {
  id: 'triage',
  order: 10,
  mount(app) {
    app.route('/', createTriageRoutes(productionDeps));
  },
};

/** The real route deps. Called once, on the first request that needs them. */
export function productionDeps(): TriageRouteDeps {
  const rt = triageRuntime();
  const submission = submissionDeps({ runtime: rt });
  return {
    store: rt.runStore,
    home: rt.config.home,
    allowSlackPost: rt.config.http.allowSlackPost,
    tracing: rt.config.tracing,
    // Built per request: the normalise options carry the request's clock.
    prepare: (input) => prepareRequest(input, prepareDeps(rt.config, rt.registry)),
    submit: (prepared) => runSubmission(prepared, submission),
    ask: (runId, question, by) => startAsk(runId, question, by, submission),
    resume: (runId, input) => startResume(runId, input, submission),
    abortRun: (runId) => submission.dispatcher.init(submission.agent, { id: runId }).abort(),
    runsDir: rt.config.paths.runsDir,
    // The same check `triage status` uses, so a dead detached worker shows as incomplete, not live.
    isAlive: pidAlive,
    // D71: the run view, the run list and the resume pre-check use the same wait as resumeRun.
    stalledAfterMs: rt.config.budgets.stalledAfterMs,
    ...(submission.stalled !== undefined ? { stalled: submission.stalled } : {}),
  };
}
