// CodeGraph queries for the code tools (D11): explore, node, callers and
// impact against one repo's index.
//
// Rules this file keeps:
// - Every call is CODEGRAPH_BIN with a fixed argv through the ExecRunner:
//   [<command>, '-p', <TRIAGE_REPOS_DIR>/<repo>, '--', <query>]. No shell and
//   no command string.
// - The repo is a name from resources/repos.json, never a path. The
//   directory comes from resolveRepoDir (T11.3), which keeps it under
//   TRIAGE_REPOS_DIR after symlinks are resolved.
// - The query or symbol passes checkQueryText() before any exec. The tools
//   run the same check as their gate, so a bad value is refused and audited
//   before this module is reached.
// - A blank CODEGRAPH_BIN or TRIAGE_REPOS_DIR, a repo that is not checked
//   out and a repo without an index all throw ConnectorError
//   'not_configured', and nothing runs.
// - Absolute repo paths are cut out of the output, so the model sees
//   repo-relative paths only.
//
// Mock mode never reaches this module: the tools answer from fixtures.

import { rawKeyState, type Config } from '../config/env.ts';
import type { RepoPin } from '../config/repos.ts';
import type { CodeQueryCommand } from '../mock/types.ts';
import {
  CODEGRAPH_BIN_KEY,
  createSyncOnce,
  hasIndex,
  REPOS_DIR_KEY,
  resolveRepoDir,
  type SyncOnce,
} from '../ops/codegraph.ts';
import { currentCommit } from '../ops/repos.ts';
import { safeErrorText } from './error-text.ts';
import type { ExecRunner } from './exec.ts';
import { ConnectorError } from './types.ts';

export { CODE_QUERY_COMMANDS, type CodeQueryCommand } from '../mock/types.ts';

export const QUERY_TIMEOUT_MS = 60 * 1000;
export const QUERY_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
export const QUERY_MAX_CHARS = 300;

// ------------------------------------------------------------ query text check

export type QueryCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string };

// Checked in this order, so the reason names the first problem found.
const FORBIDDEN: readonly (readonly [string, string])[] = [
  ['\0', 'a NUL byte'],
  ['\n', 'a newline'],
  ['\r', 'a carriage return'],
  ['`', 'a backtick'],
  ['$(', "'$('"],
  [';', "';'"],
  ['|', "'|'"],
  ['&', "'&'"],
];
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * Whether a query or symbol may be passed to codegraph. Refuses an empty
 * value, a leading '-' (even after spaces), NUL, newline, backtick, '$(',
 * ';', '|', '&', any other control character and anything over
 * QUERY_MAX_CHARS. The reason never echoes the value.
 */
export function checkQueryText(value: unknown): QueryCheck {
  if (typeof value !== 'string') return { ok: false, reason: 'is not a string' };
  if (value.trim() === '') return { ok: false, reason: 'is empty' };
  if (value.length > QUERY_MAX_CHARS) return { ok: false, reason: `is longer than ${QUERY_MAX_CHARS} characters` };
  for (const [needle, name] of FORBIDDEN) {
    if (value.includes(needle)) return { ok: false, reason: `contains ${name}` };
  }
  if (CONTROL.test(value)) return { ok: false, reason: 'contains a control character' };
  if (value.trimStart().startsWith('-')) return { ok: false, reason: "starts with '-' and would be read as a flag" };
  return { ok: true };
}

/** The fixed argv for one query. Throws when the query fails checkQueryText. */
export function codegraphArgv(command: CodeQueryCommand, repoDir: string, query: string): readonly string[] {
  const check = checkQueryText(query);
  if (!check.ok) throw new ConnectorError('refused', `codegraph query ${check.reason}`);
  return Object.freeze([command, '-p', repoDir, '--', query]);
}

// ------------------------------------------------------------ the connector

export type CodeQueryRequest = {
  readonly repo: string;
  readonly command: CodeQueryCommand;
  readonly query: string;
};

/** What a query answers. Fixtures for the 'code_query' kind hold this shape. */
export type CodeQueryResult = {
  /** stdout, with absolute repo paths made repo-relative. */
  readonly output: string;
  /** True when the output hit the exec cap. */
  readonly truncated: boolean;
  /** The commit the checkout is on, or null when git could not say. */
  readonly commit: string | null;
  /** Set when codegraph exited non-zero; the output may explain why. */
  readonly exit_code?: number;
  /** With exit_code: an excerpt of codegraph's stderr, repo paths made relative. */
  readonly error?: string;
};

export type CodegraphConnector = {
  /** A fresh sync-once guard (T11.3). The code tools keep one per run. */
  createSyncOnce(): SyncOnce;
  query(request: CodeQueryRequest, signal: AbortSignal): Promise<CodeQueryResult>;
};

export type CodegraphConnectorDeps = {
  readonly config: Config;
  readonly runner: ExecRunner;
  /** The repos manifest. Loaded from resources/repos.json when left out. */
  readonly repos?: readonly RepoPin[];
};

/** True when CODEGRAPH_BIN is blank. The loader maps blank to 'codegraph', so the raw state is checked too. */
export function codegraphBinBlank(config: Config): boolean {
  return rawKeyState(config, CODEGRAPH_BIN_KEY) === 'empty' || config.code.codegraphBin.trim() === '';
}

/** Characters of stderr kept when codegraph exits non-zero. */
const STDERR_CHARS = 1000;

function notConfigured(message: string): ConnectorError {
  return new ConnectorError('not_configured', message);
}

function relativise(text: string, dir: string): string {
  return text.split(`${dir}/`).join('').split(dir).join('.');
}

export function createCodegraphConnector(deps: CodegraphConnectorDeps): CodegraphConnector {
  const { config, runner } = deps;
  const repoDeps = { config, ...(deps.repos !== undefined ? { repos: deps.repos } : {}) };

  return Object.freeze({
    createSyncOnce(): SyncOnce {
      return createSyncOnce({ config, runner, ...(deps.repos !== undefined ? { repos: deps.repos } : {}) });
    },

    async query(request: CodeQueryRequest, signal: AbortSignal): Promise<CodeQueryResult> {
      signal.throwIfAborted();
      if (codegraphBinBlank(config)) throw notConfigured(`codegraph not configured: ${CODEGRAPH_BIN_KEY} is blank`);
      const r = resolveRepoDir(request.repo, repoDeps);
      if (r.status === 'not_configured') throw notConfigured(r.message);
      if (r.status === 'refused') throw new ConnectorError('refused', r.message);
      if (!r.present) throw notConfigured(`repo is not checked out under ${REPOS_DIR_KEY}`);
      if (!hasIndex(r.dir)) throw notConfigured('repo has no codegraph index; run triage repos sync');

      const argv = codegraphArgv(request.command, r.dir, request.query);
      const res = await runner.run(config.code.codegraphBin.trim(), argv, {
        timeoutMs: QUERY_TIMEOUT_MS,
        maxOutputBytes: QUERY_MAX_OUTPUT_BYTES,
        signal,
      });
      if (res.aborted || signal.aborted) {
        signal.throwIfAborted();
        throw new ConnectorError('unreachable', `codegraph ${request.command} was aborted`);
      }
      if (res.spawnError !== undefined) {
        throw new ConnectorError('unreachable', `codegraph could not start (${res.spawnError}); check ${CODEGRAPH_BIN_KEY}`);
      }
      if (res.timedOut) throw new ConnectorError('timeout', `codegraph ${request.command} timed out`);

      const head = await currentCommit(request.repo, {
        config,
        runner,
        signal,
        ...(deps.repos !== undefined ? { repos: deps.repos } : {}),
      });
      return Object.freeze({
        output: relativise(res.stdout, r.dir),
        truncated: res.truncated,
        commit: head.status === 'ok' ? head.commit : null,
        ...(res.exitCode !== 0 ? { exit_code: res.exitCode ?? -1 } : {}),
        ...(res.exitCode !== 0 && res.stderr.trim() !== ''
          ? { error: safeErrorText(relativise(res.stderr, r.dir), [], STDERR_CHARS) }
          : {}),
      });
    },
  });
}
