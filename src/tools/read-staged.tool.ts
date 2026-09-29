// read_staged: reads part of a file an earlier call staged under /data (D45,
// D104): a jq filter, a line range of the pretty-printed JSON, or both (the
// range then applies to the jq output), cut to a byte limit. It is how the
// model reads the rest of a result that came back cut or over the cap.
//
// jq runs in-process on a private just-bash that has only jq and an
// in-memory copy of the file. The run's sandbox only has the file read from
// it, never runs anything for this tool, and every sandbox provider behaves
// the same.
//
// Order: signal -> budget (one tool call, not a data tool, so no time rule,
// D87) -> input checks -> read the file -> jq -> line range -> byte cut ->
// model-facing redaction -> the result cap -> envelope. Nothing is staged
// again. There is no audit line: the tool reads only what the run already
// fetched. Every refusal says why and what to try instead.

import type { Sandbox } from '@flue/runtime';
import { defineTool, type ToolDefinition } from '@flue/runtime/tool';
import { Bash, InMemoryFs } from 'just-bash';
import * as v from 'valibot';
import { excerpt } from '../connectors/error-text.ts';
import { isExhausted } from '../gate/budget.ts';
import { redactModelFacing } from '../gate/redact.ts';
import { ok, refused, type ToolEnvelope } from '../types/tool-result.ts';
import { capModelResult, stageProfileFor } from './_lib/pipeline.ts';
import type { ToolContext, ToolModule } from './types.ts';
import type {} from './_lib/context.ts';

export const READ_STAGED = 'read_staged';

/** The shape stagePath() writes: /data/<id>.json with the id in safe characters. */
export const STAGED_FILE_PATTERN = /^\/data\/[A-Za-z0-9_-]{1,128}\.json$/;
export const MAX_JQ_CHARS = 500;
/**
 * jq limits for the private just-bash, over the hardened profile's. Sized for
 * the largest staged file (a few MB, 20,000+ groups); one run at these limits
 * takes well under a second.
 */
export const JQ_LIMITS = { maxJqIterations: 1_000_000, maxQueryElements: 1_000_000 } as const;
// just-bash's messages when a jq work limit stops the run.
const JQ_LIMIT_ERROR = /too many iterations|element limit exceeded|depth limit exceeded/;
// Room in the cap for everything around result (file, byte counts, note).
const ENVELOPE_ROOM = 512;
// How much of a jq error the model sees.
const JQ_ERROR_CHARS = 300;

export const ReadStagedInputSchema = v.strictObject({
  file: v.pipe(v.string(), v.maxLength(200), v.description('The staged_file path of an earlier result, for example /data/toolu_01ABC.json.')),
  jq: v.optional(
    v.pipe(
      v.string(),
      v.minLength(1),
      v.maxLength(MAX_JQ_CHARS),
      v.description('A jq filter run on the file. Output is compact JSON, one value per line.'),
    ),
  ),
  lines: v.optional(
    v.pipe(
      v.strictObject({
        from: v.pipe(v.number(), v.integer(), v.minValue(1)),
        to: v.pipe(v.number(), v.integer(), v.minValue(1)),
      }),
      v.description('Lines from..to, 1-based and inclusive, of the pretty-printed file, or of the jq output when jq is given.'),
    ),
  ),
  max_bytes: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1), v.description('The most bytes of result to return. Default and upper limit: the per-call cap.')),
  ),
});
export type ReadStagedInput = v.InferOutput<typeof ReadStagedInputSchema>;

function description(cap: number): string {
  return (
    'Read part of a file an earlier tool call staged under /data (the staged_file of its result), when that result ' +
    'came back cut or over the cap (over_cap). Give a jq filter, for example ' +
    `'[.groups[] | {key, count}] | .[0:50]' or '.hits[] | select(.level == "ERROR") | .message', a line range of the ` +
    'pretty-printed JSON (lines: {from, to}), or both, in which case the range applies to the jq output. Count or ' +
    `filter with jq before reading raw lines. The result is text, cut to max_bytes (at most ${maxResultBytes(cap)}); ` +
    'truncated says whether it was cut, and bytes_total how big the whole selection was. Uses one tool call.'
  );
}

/** The sandbox surface the tool needs: a harness tool's harness. */
export type ReadHarness = { readonly sandbox: Pick<Sandbox, 'readFile'> };

export type ReadStagedOptions = {
  /**
   * just-bash's defense-in-depth patches. On by default. Unit tests under
   * bun turn it off, as for the virtual sandbox (src/agents/sandbox.ts).
   */
  readonly defenseInDepth?: boolean;
};

type ReadStagedResult = {
  readonly file: string;
  readonly bytes_total: number;
  readonly bytes_returned: number;
  readonly truncated: boolean;
  readonly lines_total?: number;
  readonly result: string;
  readonly note?: string;
};

type Selected = { readonly ok: true; readonly text: string; readonly linesTotal?: number } | { readonly ok: false; readonly message: string };

function maxResultBytes(cap: number): number {
  return Math.max(1, cap - ENVELOPE_ROOM);
}

/** The longest prefix of text whose JSON string form, without the quotes, is at most max bytes. */
export function cutToBytes(text: string, max: number): string {
  const size = (t: string): number => Buffer.byteLength(JSON.stringify(t)) - 2;
  if (size(text) <= max) return text;
  let lo = 0;
  let hi = Math.min(text.length, max);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (size(text.slice(0, mid)) <= max) lo = mid;
    else hi = mid - 1;
  }
  const cut = text.slice(0, lo);
  // Never end on half of a surrogate pair.
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

// Pretty-printed with one space, so a line range means something on a staged
// file that is one line of JSON. Text that is not JSON is used as it is.
function pretty(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text) as unknown, null, 1);
  } catch {
    return text;
  }
}

function sliceLines(text: string, from: number, to: number): { text: string; total: number } {
  const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
  return { text: lines.slice(from - 1, to).join('\n'), total: lines.length };
}

// jq on a private just-bash holding only the file. args bypass shell parsing,
// so the filter needs no quoting. jq runs synchronously, so a timer cannot
// stop it; the work limits are the bound. The hardened profile's jq limits
// (10,000 iterations, 100,000 elements) refuse plain filters over a few
// thousand groups or hits, the files this tool exists for, so they are
// raised to JQ_LIMITS. A filter that still hits one is told to slice first.
async function runJq(text: string, filter: string, opts: ReadStagedOptions, signal: AbortSignal | undefined): Promise<Selected> {
  const bash = new Bash({
    fs: new InMemoryFs({ '/f.json': text }),
    commands: ['jq'],
    executionLimitProfile: 'hardened',
    executionLimits: JQ_LIMITS,
    defenseInDepth: opts.defenseInDepth ?? true,
  });
  const result = await bash.exec('jq -c', { args: [filter, '/f.json'], ...(signal !== undefined ? { signal } : {}) });
  signal?.throwIfAborted();
  if (result.exitCode !== 0) {
    const reason = excerpt(result.stderr.trim().replace(/^jq: /, ''), JQ_ERROR_CHARS) || `exit ${result.exitCode}`;
    if (JQ_LIMIT_ERROR.test(reason)) {
      return {
        ok: false,
        message:
          `Refused: the jq filter hit the work limit on this file (${reason}). The filter may be fine; the file is too big for it. ` +
          'Slice first, for example .groups[:500] or .hits[:200], or count with length before listing.',
      };
    }
    return { ok: false, message: `Refused: the jq filter failed: ${reason}. Fix the filter and call read_staged again.` };
  }
  return { ok: true, text: result.stdout };
}

// Why the file could not be read, by code or error name only: a message
// could quote more than the path.
function readFailure(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^[A-Z_]{1,20}$/.test(code)) return code;
  return err instanceof Error ? err.name : 'error';
}

/** Builds read_staged. create() uses the defaults; tests pass options. */
export function readStagedTool(ctx: ToolContext, opts: ReadStagedOptions = {}): ToolDefinition {
  const cap = ctx.config.budgets.maxModelBytesPerCall;
  return defineTool({
    name: READ_STAGED,
    description: description(cap),
    input: ReadStagedInputSchema,
    harness: true,
    run: async ({ data, signal, harness }): Promise<ToolEnvelope> => {
      signal?.throwIfAborted();
      const deps = ctx.deps;
      const now = deps.now;
      const refuse = (message: string): ToolEnvelope => refused(redactModelFacing(message), now);

      const budget = deps.budget.consumeToolCall(READ_STAGED, ctx.entity ?? undefined);
      if (!budget.ok) {
        if (isExhausted(budget.reason)) deps.escalation.markBudgetExhausted();
        return refuse(budget.message);
      }

      const input = data as ReadStagedInput;
      if (!STAGED_FILE_PATTERN.test(input.file)) {
        return refuse('Refused: file must be a staged file path, /data/<call id>.json, exactly as an earlier result gave it in staged_file.');
      }
      if (input.jq === undefined && input.lines === undefined) {
        return refuse('Refused: give a jq filter, a line range (lines: {from, to}), or both.');
      }
      if (input.lines !== undefined && input.lines.to < input.lines.from) {
        return refuse('Refused: lines.to must not be less than lines.from.');
      }
      // Flue's sandbox getter throws when the agent declared none.
      let sandbox: ReadHarness['sandbox'] | undefined;
      try {
        sandbox = (harness as ReadHarness | undefined)?.sandbox;
      } catch {
        sandbox = undefined;
      }
      if (sandbox === undefined) return refuse('Refused: this agent has no sandbox, so there are no staged files to read.');

      let text: string;
      try {
        text = await sandbox.readFile(input.file);
      } catch (err) {
        return refuse(
          `No staged file at ${input.file} (${readFailure(err)}). Use the exact staged_file path of an earlier result in this run, ` +
            'or run the call again.',
        );
      }

      let selected: Selected = { ok: true, text: input.jq === undefined ? pretty(text) : text };
      if (input.jq !== undefined) selected = await runJq(text, input.jq, opts, signal);
      if (!selected.ok) return refuse(selected.message);
      let chosen = selected.text;
      let linesTotal: number | undefined;
      if (input.lines !== undefined) {
        const sliced = sliceLines(chosen, input.lines.from, input.lines.to);
        chosen = sliced.text;
        linesTotal = sliced.total;
      }

      const limit = Math.min(input.max_bytes ?? Number.MAX_SAFE_INTEGER, maxResultBytes(cap));
      const result = cutToBytes(chosen, limit);
      const truncated = result.length < chosen.length;
      const out: ReadStagedResult = {
        file: input.file,
        bytes_total: Buffer.byteLength(chosen),
        bytes_returned: Buffer.byteLength(result),
        truncated,
        ...(linesTotal !== undefined ? { lines_total: linesTotal } : {}),
        result,
        ...(truncated ? { note: 'Cut to max_bytes. Narrow the jq filter, or read a smaller line range.' } : {}),
      };
      // Never staged again: an over-cap summary points back at the same file.
      return ok(capModelResult(redactModelFacing(out), { cap, stagedFile: input.file }), now);
    },
  });
}

export const toolModule: ToolModule = {
  name: READ_STAGED,
  // investigator_deep inherits it; shared on the agent mount (D109).
  mounts: ['investigator', 'agent'],
  entities: 'all',
  enabled(ctx) {
    if (stageProfileFor(ctx.config) === null) return { on: false, reason: `sandbox provider ${ctx.config.sandbox.provider} is not staged into` };
    return { on: true };
  },
  create: (ctx) => readStagedTool(ctx),
};
