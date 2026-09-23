// The qw transport for logs_search (D44). It runs the SSO-authenticated qw
// CLI on the host through the injected ExecRunner, with a fixed argv and no
// shell. It never runs in the sandbox and never logs in: `qw login` is an
// interactive browser flow, so preflight checks it and this file only says
// when it is missing.
//
// Every value that goes into argv passes assertQwSafe. The flags themselves
// are fixed literals from QW_FLAGS.
//
// qw has no terms aggregation (its `histogram` is a date histogram), so a
// group_by runs `qw search` projected to the group field and the groups are
// counted here. When Quickwit matched more hits than qw returned, the groups
// are partial and truncated is set.
import { assertQwSafe, QwArgError, type LogsQueryMode } from '../../gate/quickwit.ts';
import type { ExecResult, ExecRunner } from '../exec.ts';
import { ConnectorError, MAX_EXEC_OUTPUT_BYTES } from '../types.ts';
import type { LogGroup, LogHit, TransportResult } from './client.ts';

export type QwSearchRequest = {
  /** QW_BIN. */
  readonly bin: string;
  /** <ENTITY>_QW_CONTEXT value. */
  readonly context: string;
  readonly index: string;
  readonly query: string;
  readonly mode: LogsQueryMode;
  /** Output projection for search mode. */
  readonly fields: readonly string[];
  readonly maxHits: number;
  readonly groupBy?: string;
  /** From toSince() in src/gate/quickwit-window.ts. */
  readonly since: string;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
};

/** Every flag the qw transport may put into argv. Anything else in argv is a value. */
export const QW_FLAGS: ReadonlySet<string> = new Set(['--since', '--max-hits', '-o', '--fields', '--context']);

/** Where stderr says the context has no usable login. */
const NOT_LOGGED_IN =
  /not logged in|no (?:cached |valid )?token|token (?:has )?expired|login required|run [`'"]?qw login|unauthenticated|401 unauthorized/i;

function val(value: string): string {
  assertQwSafe(value);
  return value;
}

/**
 * The fixed argv for one call. Throws QwArgError when a value fails
 * assertQwSafe, so nothing unsafe reaches the runner.
 */
export function qwArgv(req: QwSearchRequest): string[] {
  if (req.mode === 'count') {
    return ['count', val(req.index), val(req.query), '--since', val(req.since), '-o', 'json', '--context', val(req.context)];
  }
  if (!Number.isInteger(req.maxHits) || req.maxHits < 1) throw new QwArgError('qw argument refused: max hits must be a whole number of at least 1');
  let fields: readonly string[] = req.fields;
  if (req.mode === 'histogram') {
    if (req.groupBy === undefined) throw new QwArgError('qw argument refused: group_by is missing');
    fields = [req.groupBy];
  }
  return [
    'search',
    val(req.index),
    val(req.query),
    '--since',
    val(req.since),
    '--max-hits',
    val(String(req.maxHits)),
    '-o',
    'json',
    '--fields',
    val(fields.join(',')),
    '--context',
    val(req.context),
  ];
}

/** Runs one qw call and parses its output. Throws ConnectorError on every failure. */
export async function qwSearch(exec: ExecRunner, req: QwSearchRequest): Promise<TransportResult> {
  let bin: string;
  let argv: string[];
  try {
    bin = val(req.bin);
    argv = qwArgv(req);
  } catch (err) {
    if (err instanceof QwArgError) throw new ConnectorError('refused', err.message, { cause: err });
    throw err;
  }
  req.signal.throwIfAborted();
  const result = await exec.run(bin, argv, {
    timeoutMs: req.timeoutMs,
    signal: req.signal,
    maxOutputBytes: MAX_EXEC_OUTPUT_BYTES,
  });
  checkResult(result, req, argv[0] as string);
  return parseOutput(result.stdout, req);
}

function checkResult(result: ExecResult, req: QwSearchRequest, sub: string): void {
  if (result.aborted) {
    req.signal.throwIfAborted();
    throw new ConnectorError('unreachable', `qw ${sub} was stopped before it finished`);
  }
  if (result.timedOut) throw new ConnectorError('timeout', `qw ${sub} did not finish within ${req.timeoutMs} ms`);
  if (result.spawnError !== undefined) {
    throw new ConnectorError('unreachable', `QW_BIN could not be started (${result.spawnError}); check that qw is installed`);
  }
  if (result.truncated) {
    throw new ConnectorError('cap_exceeded', `qw ${sub} printed more than ${MAX_EXEC_OUTPUT_BYTES} bytes; narrow the query or lower max_hits`);
  }
  const loginMissing = NOT_LOGGED_IN.test(result.stderr);
  if (result.exitCode !== 0 || (loginMissing && result.stdout.trim() === '')) {
    if (loginMissing) {
      throw new ConnectorError(
        'unreachable',
        `qw is not logged in for context ${req.context}; run qw login --context ${req.context} on the host`,
      );
    }
    // stderr is left out: it can name the endpoint behind the context.
    throw new ConnectorError('unreachable', `qw ${sub} failed with exit code ${String(result.exitCode)}`);
  }
}

function invalid(): ConnectorError {
  return new ConnectorError('unreachable', 'qw printed output that is not the expected JSON');
}

/** JSON first, then one JSON value per line, since some qw builds print NDJSON. */
function parseJson(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === '') throw invalid();
  try {
    return JSON.parse(trimmed);
  } catch {
    const lines = trimmed.split('\n').filter((l) => l.trim() !== '');
    try {
      return lines.map((l) => JSON.parse(l) as unknown);
    } catch {
      throw invalid();
    }
  }
}

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isCount = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x) && x >= 0;

function parseHits(parsed: unknown): { hits: LogHit[]; num_hits: number } {
  let raw: unknown;
  let total: unknown;
  if (Array.isArray(parsed)) raw = parsed;
  else if (isObject(parsed) && Array.isArray(parsed.hits)) {
    raw = parsed.hits;
    total = parsed.num_hits;
  } else throw invalid();
  const hits = raw as unknown[];
  if (!hits.every(isObject)) throw invalid();
  const num_hits = isCount(total) ? Math.max(total, hits.length) : hits.length;
  return { hits: hits as LogHit[], num_hits };
}

function parseCount(parsed: unknown): number {
  if (isCount(parsed)) return parsed;
  if (isObject(parsed)) {
    if (isCount(parsed.count)) return parsed.count;
    if (isCount(parsed.num_hits)) return parsed.num_hits;
  }
  throw invalid();
}

function parseOutput(stdout: string, req: QwSearchRequest): TransportResult {
  if (req.mode === 'count') {
    const text = stdout.trim();
    const parsed = /^\d+$/.test(text) ? Number(text) : parseJson(text);
    return { kind: 'count', num_hits: parseCount(parsed) };
  }
  const { hits, num_hits } = parseHits(parseJson(stdout));
  if (req.mode === 'search') return { kind: 'hits', hits, num_hits };
  return {
    kind: 'groups',
    groups: groupHits(hits, req.groupBy as string),
    num_hits,
    truncated: num_hits > hits.length,
  };
}

/** Counts hits per value of one field, largest group first. Hits without the field are skipped, as a terms aggregation does. */
export function groupHits(hits: readonly LogHit[], field: string): LogGroup[] {
  const counts = new Map<string, number>();
  for (const hit of hits) {
    const value = hit[field];
    if (value === undefined || value === null) continue;
    const key = typeof value === 'string' ? value : JSON.stringify(value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
