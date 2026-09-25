// triage post <run_id> [--yes --approved-by <who>]
//
// Posts a finished report to its Slack thread after a human approved it
// (HLD 02 §5.1, §7; D13, D28, D39). In order:
//   1. TRIAGE_APPROVAL_MODE=slack is refused (reserved for v2) before any
//      Slack call, lookups included.
//   2. prepareSlackPost loads the report and thread, looks up the reviewer,
//      formats the message and runs the egress check.
//   3. The exact text is printed.
//   4. requireApproval: y/N at a TTY, or --yes with --approved-by.
//   5. postReport posts it and writes the audit line.
// A refused approval posts nothing and writes an audit deny line.
//
// With TRIAGE_MOCK_MODE=true (the default) the reviewer comes from fixtures
// and the post goes to an in-memory sink; nothing reaches Slack. Under --json
// the text is shown on stderr and stdout carries one JSON document.
import type { Config } from '../../config/env.ts';
import { createJsonlAuditSink, type AuditSink } from '../../gate/audit-sink.ts';
import { requireApproval } from '../../report/approval.ts';
import { createSlackClient, SlackClientError, type FetchLike, type SlackClient } from '../../report/slack-client.ts';
import {
  postReport,
  prepareSlackPost,
  recordApprovalRefusal,
  SlackPostRefusal,
  type SlackPostDeps,
} from '../../report/slack-post.ts';
import { createRunStore } from '../../runstore/index.ts';
import type { RunStore } from '../../runstore/types.ts';
import { EXIT, printError, printHuman, printJson } from '../output.ts';
import { linePrompt } from '../lib/prompt.ts';
import type { CliCommand, CliIo } from '../types.ts';

/** Asks the y/N question and resolves to the answer line, or null when input has ended. */
export type Confirm = (question: string) => Promise<string | null>;

export type PostCommandOptions = {
  readonly store?: (config: Config) => Promise<Pick<RunStore, 'getRun'>>;
  readonly client?: (config: Config) => SlackClient;
  readonly audit?: (config: Config) => AuditSink;
  /** Builds the prompt. The default reads one line from ctx.io.stdin. */
  readonly confirm?: (io: CliIo, write: (text: string) => void) => Confirm;
  /** Who is at the terminal for a TTY approval. Defaults to the OS user name. */
  readonly ttyUser?: () => string | undefined;
  /** Used by the default client in real mode only. */
  readonly fetch?: FetchLike;
  readonly now?: () => Date;
};

const V2_REFUSAL =
  'TRIAGE_APPROVAL_MODE=slack is reserved for v2 (Slack button approval); set TRIAGE_APPROVAL_MODE=cli to post from the CLI';

export function createPostCommand(options: PostCommandOptions = {}): CliCommand {
  return {
    path: ['post'],
    summary: 'post a finished report to its Slack thread after approval',
    configure(cmd) {
      cmd
        .argument('<run_id>', 'the run whose report is posted')
        .option('--yes', 'approve without a prompt (needs --approved-by)')
        .option('--approved-by <who>', 'who approved the post, recorded in the audit log');
    },
    async run(ctx, { args, opts }) {
      const { io } = ctx;
      const json = opts.json;
      const runId = String(args[0] ?? '');
      const config = ctx.config();

      // Use-time check: the loader refuses slack too, but a config built with
      // policyChecks:false can still carry it.
      if (config.approval.mode === 'slack') {
        printError(io, json, 'CONFIG', V2_REFUSAL);
        return EXIT.CONFIG;
      }

      const deps: SlackPostDeps = {
        store: await (options.store ?? defaultStore)(config),
        client: (options.client ?? defaultClient(options.fetch))(config),
        audit: (options.audit ?? defaultAudit)(config),
        config,
        interface: 'cli',
        ...(options.now !== undefined ? { now: options.now } : {}),
      };

      let post;
      try {
        post = await prepareSlackPost(runId, deps);
      } catch (err) {
        return refused(io, json, err);
      }

      // Under --json, stdout carries only the final document.
      const write = json ? (text: string) => void io.stderr.write(text) : (text: string) => void io.stdout.write(text);
      const say = (lines: string | readonly string[]) => printHuman({ stdout: { write } }, lines);
      const target = `${post.target.channel_id} thread ${post.target.thread_ts}`;
      const show = (text: string) =>
        say([`This will be posted to Slack ${target}${post.transport === 'mock' ? ' (mock mode: nothing leaves this machine)' : ''}:`, '', text, '']);

      let shown = false;
      let asked = false;
      const ask = (options.confirm ?? linePrompt)(io, write);
      const approval = await requireApproval({
        mode: config.approval.mode,
        stdinIsTTY: io.isTTY,
        yes: opts.yes === true,
        ...(typeof opts.approvedBy === 'string' ? { approvedBy: opts.approvedBy } : {}),
        verbatimText: post.text,
        show: (text) => {
          shown = true;
          show(text);
        },
        confirm: (question) => {
          asked = true;
          return ask(question);
        },
        ...(options.ttyUser !== undefined ? ttyUserOf(options.ttyUser) : {}),
        ...(options.now !== undefined ? { now: options.now } : {}),
      });
      // The prompt path shows the text itself. Every other path shows it here,
      // so the operator always sees what would have been sent.
      if (!shown) show(post.text);

      if (!approval.ok) {
        recordApprovalRefusal(post, approval.reason, deps);
        printError(io, json, asked ? 'ERROR' : 'USAGE', `not posted: ${approval.reason}`);
        return asked ? EXIT.ERROR : EXIT.USAGE;
      }

      let result;
      try {
        result = await postReport(post, approval.approval, deps);
      } catch (err) {
        return refused(io, json, err);
      }

      if (json) {
        printJson(io, { posted: true, ...result, text: post.text });
      } else {
        const where = result.transport === 'mock' ? 'mock sink (not sent to Slack)' : `Slack ${result.channel}`;
        say(`posted to ${where}, ts ${result.ts}, approved by ${result.approved_by}`);
      }
      return EXIT.OK;
    },
  };
}

export const command: CliCommand = createPostCommand();

// ------------------------------------------------------------------ helpers

function refused(io: CliIo, json: boolean, err: unknown): number {
  if (err instanceof SlackPostRefusal) {
    const code = err.code === 'invalid_run_id' ? 'USAGE' : 'ERROR';
    printError(io, json, code, err.message);
    return EXIT[code];
  }
  if (err instanceof SlackClientError) {
    printError(io, json, 'ERROR', `not posted: ${err.message}`);
    return EXIT.ERROR;
  }
  throw err;
}

function ttyUserOf(fn: () => string | undefined): { ttyUser?: string } {
  const who = fn();
  return who !== undefined ? { ttyUser: who } : {};
}

function defaultStore(config: Config): Promise<Pick<RunStore, 'getRun'>> {
  return createRunStore(config);
}

function defaultClient(fetchFn: FetchLike | undefined): (config: Config) => SlackClient {
  return (config) =>
    createSlackClient(config, config.mock.enabled ? {} : { fetch: fetchFn ?? ((url, init) => fetch(url, init)) });
}

function defaultAudit(config: Config): AuditSink {
  return createJsonlAuditSink({ auditLogPath: config.paths.auditLog, runsDir: config.paths.runsDir });
}
