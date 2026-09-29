// triage proposals [--json]
// triage proposals show <run_id> [--json]
//
// Lists the note proposals runs wrote with propose_note (D99): one line per
// run with its date and proposal count, then its titles. `show` prints one
// run's file as it is. Both read TRIAGE_PROPOSALS_DIR only; a missing dir
// means no proposals yet.
//
// One command with an optional action rather than a 'proposals' group, since
// the CLI builder refuses a path that is both a command and a group.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import * as v from 'valibot';
import { RunIdSchema } from '../../types/core.ts';
import { proposalsDate, proposalsFile, proposalTitles } from '../../tools/propose-note.tool.ts';
import { emitJson } from '../lib/output-schemas.ts';
import { EXIT, printError, printHuman } from '../output.ts';
import type { CliCommand } from '../types.ts';
import { checkRunIdArg } from './status.command.ts';

const ProposalsListSchema = v.object({
  proposals: v.array(
    v.object({ run_id: v.string(), date: v.nullable(v.string()), count: v.number(), titles: v.array(v.string()) }),
  ),
});
type ProposalsList = v.InferOutput<typeof ProposalsListSchema>;

const ProposalsShowSchema = v.object({ run_id: v.string(), text: v.string() });

/** Every <run_id>.md in the dir, newest date first. */
export function listProposals(dir: string): ProposalsList['proposals'] {
  if (!existsSync(dir)) return [];
  const rows = readdirSync(dir)
    .filter((name) => name.endsWith('.md') && v.is(RunIdSchema, name.slice(0, -3)))
    .map((name) => {
      const runId = name.slice(0, -3);
      const text = readFileSync(proposalsFile(dir, runId), 'utf8');
      const titles = proposalTitles(text);
      return { run_id: runId, date: proposalsDate(text), count: titles.length, titles };
    });
  return rows.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '') || b.run_id.localeCompare(a.run_id));
}

export const command: CliCommand = {
  path: ['proposals'],
  summary: 'list the note proposals runs wrote for review, or show one run',
  configure(cmd) {
    cmd
      .argument('[action]', "'show' to print one run's proposals")
      .argument('[run_id]', 'the run to show')
      .option('--json', 'print machine-readable JSON');
  },
  async run(ctx, { args, opts }) {
    const { io } = ctx;
    const json = opts.json;
    const [action, runId] = args;
    if (action !== undefined && action !== 'show') {
      printError(io, json, 'USAGE', `unknown action '${String(action)}'; use 'triage proposals' or 'triage proposals show <run_id>'`);
      return EXIT.USAGE;
    }
    const dir = ctx.config().paths.proposalsDir;

    if (action === 'show') {
      if (!checkRunIdArg(io, json, runId)) return EXIT.USAGE;
      const file = proposalsFile(dir, runId);
      if (!existsSync(file)) {
        printError(io, json, 'ERROR', `no proposals for run ${runId}`);
        return EXIT.ERROR;
      }
      const text = readFileSync(file, 'utf8');
      if (json) emitJson(io, ProposalsShowSchema, { run_id: runId, text });
      else printHuman(io, text.trimEnd());
      return EXIT.OK;
    }

    const proposals = listProposals(dir);
    if (json) {
      emitJson(io, ProposalsListSchema, { proposals });
      return EXIT.OK;
    }
    if (proposals.length === 0) {
      printHuman(io, 'no proposals yet');
      return EXIT.OK;
    }
    printHuman(
      io,
      proposals.flatMap((p) => [
        `${p.run_id}  ${p.date ?? '-'}  ${p.count} proposal${p.count === 1 ? '' : 's'}`,
        ...p.titles.map((t) => `  - ${t}`),
      ]),
    );
    return EXIT.OK;
  },
};
