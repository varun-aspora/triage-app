// triage proposals, run through buildProgram and runCli with a test home in
// the OS temp dir (mock mode forced on) and fake io. Proposal files are
// written by propose_note itself, so the CLI reads the real format. All
// values are synthetic.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import type { ToolDefinition } from '@flue/runtime/tool';
import { makeTestHome, REPO_ROOT, type TestHome } from '../../../test/support/home.ts';
import { makeToolContext } from '../../../test/support/fake-tool-context.ts';
import { createMemoryAuditSink } from '../../gate/audit-sink.ts';
import type { MockLayer } from '../../mock/index.ts';
import { createProposeNoteTool } from '../../tools/propose-note.tool.ts';
import type { ToolDeps } from '../../tools/types.ts';
import { buildProgram, runCli } from '../index.ts';
import { EXIT } from '../output.ts';
import type { CliContext } from '../types.ts';
import { command } from './proposals.command.ts';

const OLD_RUN = '01J8ZQ7XK3PSEUDRUNAAAAAAAA';
const NEW_RUN = '01J8ZQ7XK3PSEUDRUNBBBBBBBB';

const homes: TestHome[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) h.cleanup();
});

function home(): TestHome {
  const h = makeTestHome();
  homes.push(h);
  return h;
}

type Run = { code: number; out: string; err: string };

async function cli(argv: readonly string[], h: TestHome): Promise<Run> {
  let out = '';
  let err = '';
  const ctx: CliContext = {
    config: () => h.config,
    io: {
      stdout: { write: (s: string) => (out += s) },
      stderr: { write: (s: string) => (err += s) },
      stdin: Readable.from([]),
      isTTY: false,
    },
    deps: {},
  };
  const code = await runCli(buildProgram([command], ctx), ['proposals', ...argv]);
  return { code, out, err };
}

function proposer(h: TestHome, runId: string, at: string): ToolDefinition {
  const deps = {
    audit: createMemoryAuditSink(),
    fixtures: { settings: { mockMode: true } } as unknown as MockLayer,
    run: { interface: 'cli', redactionNames: [] },
    now: () => new Date(at),
  } as unknown as ToolDeps;
  return createProposeNoteTool(makeToolContext({ runId, deps, config: h.config }), { callIds: () => new Set(['call_1']) });
}

async function propose(tool: ToolDefinition, title: string): Promise<void> {
  const res = (await tool.run({ data: { title, body: 'A join that worked.', evidence: ['call_1'] } } as never)) as {
    output: { status: string };
  };
  expect(res.output.status).toBe('ok');
}

describe('triage proposals', () => {
  test('the proposals dir is inside the test home, never under the repo', () => {
    const h = home();
    expect(h.config.paths.proposalsDir.startsWith(h.home)).toBe(true);
    expect(h.config.paths.proposalsDir.startsWith(REPO_ROOT)).toBe(false);
  });

  test('says there are none when the dir does not exist', async () => {
    const h = home();
    const r = await cli([], h);
    expect(r.code).toBe(EXIT.OK);
    expect(r.out).toBe('no proposals yet\n');
    expect((await cli(['--json'], h)).out).toBe('{"proposals":[]}\n');
  });

  test('lists each run with its date, count and titles, newest first', async () => {
    const h = home();
    const old = proposer(h, OLD_RUN, '2026-09-20T10:00:00.000Z');
    await propose(old, 'rtl workflow owns the payout step');
    const recent = proposer(h, NEW_RUN, '2026-09-28T10:00:00.000Z');
    await propose(recent, 'CX calls a stuck payout pending');
    await propose(recent, 'request_ref joins the two tables');
    // Not a run file: ignored.
    mkdirSync(h.config.paths.proposalsDir, { recursive: true });
    writeFileSync(`${h.config.paths.proposalsDir}/notes.txt`, 'x');

    const r = await cli([], h);
    expect(r.code).toBe(EXIT.OK);
    expect(r.out).toBe(
      [
        `${NEW_RUN}  2026-09-28  2 proposals`,
        '  - CX calls a stuck payout pending',
        '  - request_ref joins the two tables',
        `${OLD_RUN}  2026-09-20  1 proposal`,
        '  - rtl workflow owns the payout step',
        '',
      ].join('\n'),
    );

    const j = JSON.parse((await cli(['--json'], h)).out);
    expect(j.proposals.map((p: { run_id: string; count: number }) => [p.run_id, p.count])).toEqual([
      [NEW_RUN, 2],
      [OLD_RUN, 1],
    ]);
    expect(j.proposals[0].titles).toEqual(['CX calls a stuck payout pending', 'request_ref joins the two tables']);
  });

  test('show prints one run file; --json wraps it', async () => {
    const h = home();
    await propose(proposer(h, NEW_RUN, '2026-09-28T10:00:00.000Z'), 'request_ref joins the two tables');
    const r = await cli(['show', NEW_RUN], h);
    expect(r.code).toBe(EXIT.OK);
    expect(r.out).toContain(`# Proposals for run ${NEW_RUN}`);
    expect(r.out).toContain('## 1. request_ref joins the two tables');
    expect(r.out).toContain('Evidence: `call_1`');

    const j = JSON.parse((await cli(['show', NEW_RUN, '--json'], h)).out);
    expect(j.run_id).toBe(NEW_RUN);
    expect(j.text).toContain('A join that worked.');
  });

  test('show errors on a run without proposals and on a bad or missing run id; an unknown action is a usage error', async () => {
    const h = home();
    const missing = await cli(['show', NEW_RUN], h);
    expect(missing.code).toBe(EXIT.ERROR);
    expect(missing.err).toContain(`no proposals for run ${NEW_RUN}`);
    expect((await cli(['show'], h)).code).toBe(EXIT.USAGE);
    expect((await cli(['show', '../etc'], h)).code).toBe(EXIT.USAGE);
    const bad = await cli(['list'], h);
    expect(bad.code).toBe(EXIT.USAGE);
    expect(bad.err).toContain("unknown action 'list'");
  });
});
