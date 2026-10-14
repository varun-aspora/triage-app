// propose_note: keeps what a run learned that the notes did not say (plan 15
// P5, D99): a join that worked, which service owns a step, a label CX uses.
//
// Mounted on the single agent, the split triage root and the investigators.
// Each proposal is appended to <TRIAGE_PROPOSALS_DIR>/<run_id>.md for the
// owner to review; a good one becomes a PR against knowledge/. Nothing is
// auto-merged, no run ever reads the proposals dir, and the tool is off when
// that dir sits inside the knowledge dir, so runtime never writes the notes.
//
// Order: signal -> shape -> body headings -> every evidence id is a call in
// the run action log -> egress check with refuse semantics -> the per-run cap
// (counted from the file, so it survives a restart) -> append -> run event
// (title and evidence ids only) -> audit line -> envelope.
//
// The egress check refuses instead of masking, like ask_requester: a note
// with ****1234 in it teaches the owner nothing, a note with placeholders
// does. The evidence ids are not checked, since a tool call id can hold a
// digit run the check flags; they go through the persisted profile instead,
// the same way events.jsonl stores them, so they still match there.
//
// The action log is released when the run settles, so after a resume only
// calls made since then can be cited.
//
// The count, the check and the append run synchronously, so two delegates
// proposing at once in the split shape cannot both take the last slot.
//
// Exempt from the tool-call budget (BUDGET_EXEMPT_TOOLS), like note_evidence:
// it records, it does not query.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { defineTool, type ToolDefinition } from '@flue/runtime/tool';
import * as v from 'valibot';
import type { Config } from '../config/env.ts';
import { makeAuditLine } from '../gate/audit.ts';
import { checkEgress, redactModelFacing, redactPersisted } from '../gate/redact.ts';
import { type Action, actionLine, actionsFor, ROOT_AGENT } from '../runlog/actions.ts';
import { logRunEvent } from '../runlog/event-log.ts';
import type { AuditTransport } from '../types/audit.ts';
import { ok, refused, type ToolEnvelope } from '../types/tool-result.ts';
import type { ToolContext, ToolModule } from './types.ts';
import type {} from './_lib/context.ts';

export const PROPOSE_NOTE = 'propose_note';

export const MAX_PROPOSALS_PER_RUN = 5;
export const PROPOSAL_TITLE_MAX = 120;
export const PROPOSAL_BODY_MAX = 4000;
const MAX_EVIDENCE = 20;
const MAX_LISTED = 8;

// A proposal's heading in the file: `## <n>. <title>`. The CLI counts and lists these.
const PROPOSAL_HEADING = /^## (\d+)\. (.*)$/gm;
// # and ## belong to the file's layout, so a body that used them would add or hide proposals.
const LAYOUT_HEADING = /^#{1,2}\s/m;

// The file's headings are found with a multiline regex, for which U+2028 and
// U+2029 also end a line, so a title holding one could add a proposal. Control
// characters would also reach the owner's terminal through `triage proposals`.
const ONE_LINE = /^[^\p{Cc}\u2028\u2029]*$/u;
const TEXT_LINES = /^(?:[^\p{Cc}\u2028\u2029]|[\t\n\r])*$/u;

export const ProposeNoteInputSchema = v.strictObject({
  title: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(PROPOSAL_TITLE_MAX), v.regex(ONE_LINE)),
  body: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(PROPOSAL_BODY_MAX), v.regex(TEXT_LINES)),
  evidence: v.pipe(
    v.array(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(128))),
    v.minLength(1),
    v.maxLength(MAX_EVIDENCE),
  ),
});
export type ProposeNoteInput = v.InferOutput<typeof ProposeNoteInputSchema>;

const DESCRIPTION =
  'Propose a note for the owner to add to the knowledge notes: something this run confirmed that the notes did not ' +
  'say, such as a join that worked, which service owns a step or a label CX uses. Give a one-line title, the note ' +
  `in markdown (at most ${PROPOSAL_BODY_MAX} characters; ### headings or deeper), and the tool call ids of the calls ` +
  'in this run that show it (each run_log line ends with [call <id>]). Write ids as placeholders such as <customer_id>, and leave out names, phones, emails ' +
  'and account numbers. The owner reviews every proposal; later runs never read them, so keep using what you ' +
  `found in this run as usual. At most ${MAX_PROPOSALS_PER_RUN} per run. Returns the proposal number.`;

/** <proposalsDir>/<run_id>.md. Run ids are letters, digits, _ and -, so they are safe as a file name. */
export function proposalsFile(proposalsDir: string, runId: string): string {
  return join(proposalsDir, `${runId}.md`);
}

/** True when the proposals dir is the knowledge dir or inside it. */
export function proposalsInKnowledge(paths: Pick<Config['paths'], 'proposalsDir' | 'knowledgeDir'>): boolean {
  const rel = relative(paths.knowledgeDir, paths.proposalsDir);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** The proposal titles in a proposals file, in file order. */
export function proposalTitles(text: string): string[] {
  return [...text.matchAll(PROPOSAL_HEADING)].map((m) => m[2] ?? '');
}

/** The `- date:` value of a proposals file header, or null. */
export function proposalsDate(text: string): string | null {
  return /^- date: (.+)$/m.exec(text)?.[1] ?? null;
}

function header(runId: string, at: Date, agent: string): string {
  return [`# Proposals for run ${runId}`, '', `- run: ${runId}`, `- date: ${at.toISOString().slice(0, 10)}`, `- agent: ${agent}`, ''].join('\n');
}

function section(n: number, input: ProposeNoteInput, agent: string, at: Date, names: readonly string[]): string {
  const evidence = input.evidence.map((id) => `\`${redactPersisted(id, { names }).value}\``).join(', ');
  return ['', `## ${n}. ${input.title}`, '', `_${agent}, ${at.toISOString()}_`, '', input.body, '', `Evidence: ${evidence}`, ''].join('\n');
}

/** Tool call ids of the calls in a run action log. */
export function loggedCallIds(actions: readonly Pick<Action, 'toolCallId'>[]): Set<string> {
  const ids = new Set<string>();
  for (const a of actions) if (a.toolCallId !== undefined) ids.add(a.toolCallId);
  return ids;
}

function list(items: readonly string[]): string {
  const more = items.length - MAX_LISTED;
  return items.slice(0, MAX_LISTED).join(', ') + (more > 0 ? ` and ${more} more` : '');
}

const RECENT_CALLS = 10;

// Listed in the unknown-evidence refusal, so the model can fix the ids without a run_log call.
function recentCalls(runId: string, agent: string): string {
  const mine = actionsFor(runId).filter((a) => a.agent === agent && a.toolCallId !== undefined && a.tool !== PROPOSE_NOTE);
  if (mine.length === 0) return 'You have no logged calls in this run yet.';
  return `Your last calls: ${mine.slice(-RECENT_CALLS).map((a) => actionLine(a, true)).join('; ')}`;
}

export type ProposeNoteOptions = {
  /** The run's known tool call ids. Defaults to the ids in the run action log; tests pass fakes. */
  readonly callIds?: (runId: string) => ReadonlySet<string>;
};

type ProposeRunContext = { readonly data: unknown; readonly signal?: AbortSignal };

/** Builds the tool. toolModule.create() calls it; tests call it with a fake context. */
export function createProposeNoteTool(ctx: ToolContext, options: ProposeNoteOptions = {}): ToolDefinition {
  const callIds = options.callIds ?? ((runId: string) => loggedCallIds(actionsFor(runId)));
  const agent = ctx.agent ?? ROOT_AGENT;

  const run = async ({ data, signal }: ProposeRunContext): Promise<ToolEnvelope> => {
    signal?.throwIfAborted();
    const deps = ctx.deps;
    const now = deps.now;
    const started = now().getTime();
    const names = [...new Set([...(deps.initialData?.redaction_names ?? []), ...deps.run.redactionNames])];
    const transport: AuditTransport = deps.fixtures.settings.mockMode ? 'mock' : 'real';

    const audit = (decision: 'allow' | 'deny', exit: string, summary: string, reason?: string): void => {
      deps.audit.write(
        makeAuditLine(
          {
            run_id: ctx.runId,
            ts: now().toISOString(),
            interface: deps.run.interface,
            entity: ctx.entity,
            tool: PROPOSE_NOTE,
            decision,
            ...(reason !== undefined ? { reason } : {}),
            service: 'proposals',
            target: 'TRIAGE_PROPOSALS_DIR',
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
      audit('deny', 'refused', 'propose_note: refused', reason);
      return refused(redactModelFacing(message), now);
    };

    const parsed = v.safeParse(ProposeNoteInputSchema, data);
    if (!parsed.success) {
      const paths = list([...new Set(parsed.issues.map((i) => v.getDotPath(i) ?? '(input)'))]);
      return refuse(
        `Refused: the input does not fit at ${paths}. The title is one line of at most ${PROPOSAL_TITLE_MAX} characters, ` +
          `the body at most ${PROPOSAL_BODY_MAX} characters, neither with control characters, and evidence holds 1 to ` +
          `${MAX_EVIDENCE} tool call ids. Fix those fields and call propose_note again.`,
        `shape: ${paths}`,
      );
    }
    const input = { ...parsed.output, evidence: [...new Set(parsed.output.evidence)] };

    if (LAYOUT_HEADING.test(input.body)) {
      return refuse(
        'Refused: the body uses a # or ## heading, which the proposals file keeps for its own layout. Use ### or deeper and call propose_note again.',
        'layout heading in body',
      );
    }

    const known = callIds(ctx.runId);
    const unknown = input.evidence.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      return refuse(
        `Refused: these evidence ids are not tool calls of this run: ${list(unknown)}. Cite the tool call ids of calls ` +
          `made in this run (since the last resume) that show the note, and call propose_note again. ${recentCalls(ctx.runId, agent)}`,
        `unknown evidence: ${unknown.length}`,
      );
    }

    const check = checkEgress({ title: input.title, body: input.body }, { names });
    if (!check.ok) {
      const found = check.unmasked.join(', ');
      const fields = check.paths.join(', ');
      return refuse(
        `Refused: the proposal carries an unmasked ${found} in ${fields}. Write ids as placeholders such as ` +
          '<customer_id>, leave out names, phones and emails, and call propose_note again.',
        `unmasked: ${found}`,
      );
    }
    signal?.throwIfAborted();

    // No await from here to the append, so the count cannot go stale.
    const dir = ctx.config.paths.proposalsDir;
    const file = proposalsFile(dir, ctx.runId);
    const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
    const count = proposalTitles(existing).length;
    if (count >= MAX_PROPOSALS_PER_RUN) {
      return refuse(
        `Refused: this run already has ${MAX_PROPOSALS_PER_RUN} proposals, the most one run keeps. Carry on with the investigation.`,
        `cap: ${MAX_PROPOSALS_PER_RUN}`,
      );
    }
    const at = now();
    const n = count + 1;
    const text = (existing === '' ? header(ctx.runId, at, agent) : '') + section(n, input, agent, at, names);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    appendFileSync(file, text, { encoding: 'utf8', mode: 0o600 });

    logRunEvent(ctx.runId, 'proposal', { n, agent, title: input.title, evidence: input.evidence });
    audit('allow', 'ok', `propose_note ${n} of ${MAX_PROPOSALS_PER_RUN} with ${input.evidence.length} evidence id${input.evidence.length === 1 ? '' : 's'}`);
    return ok({ proposal: n, left: MAX_PROPOSALS_PER_RUN - n }, now);
  };

  return defineTool({
    name: PROPOSE_NOTE,
    description: DESCRIPTION,
    input: ProposeNoteInputSchema,
    run,
  });
}

export const toolModule: ToolModule = {
  name: PROPOSE_NOTE,
  mounts: ['agent', 'triage', 'investigator'],
  entities: 'all',
  enabled: (ctx) =>
    proposalsInKnowledge(ctx.config.paths)
      ? { on: false, reason: 'TRIAGE_PROPOSALS_DIR is inside TRIAGE_KNOWLEDGE_DIR; proposals never go into the notes' }
      : { on: true },
  create: (ctx) => createProposeNoteTool(ctx),
};
