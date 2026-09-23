// Agent contract: the tripwire end to end (T06.10; HLD 02 §2 'Not mounted
// anywhere', D2, D45).
//
// The tripwire allowlist is built once, when the Triage runtime first loads.
// To show what happens when a tool is mounted that is not on it, this file
// wraps toolsFor() so the triage mount can also carry a test 'curl' tool,
// switched on only after the tripwire is installed. The model then sees
// curl, calls it, and the interceptor must refuse it before its run() does
// anything. Everything else in the run is the real Triage agent.
//
// The home sets TRIAGE_MAX_TASKS_PER_RUN=1, so the second delegation in a
// run is the budget deny case.

import http from 'node:http';
import https from 'node:https';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { createFakeModel, finish, text, toolCall } from '../../../src/mock/fake-model.ts';
import type { AuditLine } from '../../../src/types/audit.ts';
import {
  auditLines,
  bootTriage,
  type Booted,
  contractHome,
  createRun,
  nextRunId,
  reportDraft,
  runTriage,
  type SeenCall,
  scriptAgents,
  triageInit,
} from './harness.ts';

const rogue = vi.hoisted(() => ({ mounted: false, runs: 0 }));

vi.mock('../../../src/tools/index.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/tools/index.ts')>();
  const { defineTool } = await import('@flue/runtime/tool');
  const v = await import('valibot');
  const curl = defineTool({
    name: 'curl',
    description: 'Test-only tool that is never on the tripwire allowlist. It does no I/O.',
    input: v.object({ url: v.string() }),
    async run() {
      rogue.runs += 1;
      return { output: { status: 'ok', data: 'this must never run' } };
    },
  });
  return {
    ...original,
    toolsFor: (...args: Parameters<typeof original.toolsFor>) => {
      const tools = original.toolsFor(...args);
      return rogue.mounted && args[0] === 'triage' ? [...tools, curl] : tools;
    },
  };
});

const fake = createFakeModel();
const home = contractHome(fake, { overrides: { TRIAGE_MAX_TASKS_PER_RUN: '1' } });
const fetchSpy = vi.spyOn(globalThis, 'fetch');
const httpSpy = vi.spyOn(http, 'request');
const httpsSpy = vi.spyOn(https, 'request');
let b: Booted;

const AT = '2026-09-20T10:00:00.000Z';
const FINDINGS = {
  evidence: [{ source: 'db', at: AT, query_or_path: 'deliveries', summary: 'one delivery, status SHIPPED' }],
  timeline: [],
  hypotheses: ['the parcel is with the courier'],
  confidence: 'medium',
  gaps: [],
};
const BRIEF = 'Entity: atspl\nQuestion: where is the parcel\nIds: none\nWindow: last week\nServices in play: package\nReturn: findings';

const linesFor = (runId: string): AuditLine[] => auditLines(home).filter((l) => l.run_id === runId);
const resultOf = (call: SeenCall | undefined, tool: string) => call?.toolResults.filter((r) => r.toolName === tool).at(-1);

beforeAll(async () => {
  b = await bootTriage(fake, home);
  // Loads the runtime, which installs the tripwire with the allowlist of this deployment.
  b.plan.triageRuntime();
});

afterAll(async () => {
  rogue.mounted = false;
  await b?.flue.stop();
  home.dispose();
});

describe('tripwire', () => {
  test('the installed allowlist does not have curl', async () => {
    const { installedTripwire } = await import('../../../src/agents/tripwire.ts');
    const tripwire = installedTripwire();
    expect(tripwire).toBeDefined();
    expect(tripwire?.allows('curl')).toBe(false);
    for (const name of ['resolve_identity', 'note_evidence', 'finish_report', 'bash', 'task']) {
      expect(tripwire?.allows(name), name).toBe(true);
    }
  });

  test('a mounted tool that is not on the allowlist is denied, audited, and the run goes on', async () => {
    rogue.mounted = true;
    try {
      const id = nextRunId('tripwire_curl');
      const init = triageInit(id, { hints: ['atspl'] });
      await createRun(b.store, init);
      const s = scriptAgents(fake, {
        triage: [
          toolCall('curl', { url: 'https://example.test/' }),
          toolCall('bash', { command: 'echo sandbox-ok' }),
          finish(reportDraft(init)),
          text('report written'),
        ],
      });

      const result = await runTriage(b.Triage, id, init);

      expect(result.ok).toBe(true);
      const calls = s.callsFor('triage');
      expect(calls).toHaveLength(4);
      // The model was offered curl, so the call reached the interceptor.
      expect(calls[0]?.tools).toContain('curl');
      expect(rogue.runs).toBe(0);
      const denied = resultOf(calls[1], 'curl');
      expect(denied?.isError).toBe(true);
      expect(denied?.text).toContain('tool curl is not available here');

      const deny = linesFor(id).filter((l) => l.tool === 'curl');
      expect(deny).toHaveLength(1);
      expect(deny[0]).toMatchObject({
        decision: 'deny',
        service: 'tripwire',
        target: 'TRIAGE_ENTITIES',
        transport: 'mock',
        exit: 'refused',
        entity: null,
      });

      // The next calls were allowed and ran.
      const bash = resultOf(calls[2], 'bash');
      expect(bash?.isError).toBe(false);
      expect(bash?.text).toContain('sandbox-ok');
      expect(resultOf(calls[3], 'finish_report')?.text).toContain('"status":"ok"');
      expect(linesFor(id).filter((l) => l.decision === 'deny' && l.tool !== 'curl')).toEqual([]);
      expect(fake.failures()).toEqual([]);
    } finally {
      rogue.mounted = false;
    }
  });

  test('allowed tools pass: the typed tools, the sandbox and one delegation', async () => {
    const id = nextRunId('tripwire_allowed');
    const init = triageInit(id, { hints: ['atspl'] });
    await createRun(b.store, init);
    const s = scriptAgents(fake, {
      triage: [
        toolCall('task', { agent: 'investigate_atspl', prompt: BRIEF }),
        toolCall('note_evidence', FINDINGS),
        toolCall('glob', { pattern: '**/*' }),
        finish(reportDraft(init)),
        text('report written'),
      ],
      investigate_atspl: [toolCall('note_evidence', FINDINGS), text('recorded the delivery')],
    });

    const result = await runTriage(b.Triage, id, init);

    expect(result.ok).toBe(true);
    const calls = s.callsFor('triage');
    expect(resultOf(calls[1], 'task')?.text).toBe('recorded the delivery');
    const delegateNote = resultOf(s.callsFor('investigate_atspl')[1], 'note_evidence');
    expect(delegateNote?.isError).toBe(false);
    expect(delegateNote?.text).toContain('atspl@v1');
    // On the root, note_evidence runs and refuses by itself: it was not the tripwire.
    const rootNote = resultOf(calls[2], 'note_evidence');
    expect(rootNote?.isError).toBe(false);
    expect(rootNote?.text).toContain('the orchestrator has no entity');
    expect(resultOf(calls[3], 'glob')?.isError).toBe(false);

    const lines = linesFor(id);
    expect(lines.filter((l) => l.service === 'tripwire')).toEqual([]);
    expect(lines.filter((l) => l.tool === 'note_evidence').map((l) => l.decision)).toEqual(['allow', 'deny']);
    expect(lines.some((l) => l.tool === 'finish_report' && l.decision === 'allow')).toBe(true);
  });

  test('a delegation past the task budget is denied by the tripwire and audited', async () => {
    const id = nextRunId('tripwire_budget');
    const init = triageInit(id, { hints: ['atspl'] });
    await createRun(b.store, init);
    const s = scriptAgents(fake, {
      triage: [
        toolCall('task', { agent: 'investigate_atspl', prompt: BRIEF }),
        toolCall('task', { agent: 'investigate_atspl', prompt: BRIEF }),
        finish(reportDraft(init)),
        text('report written'),
      ],
      investigate_atspl: [text('first answer')],
      // A spent budget with no high-confidence finding escalates, so finish_report runs the strong synthesis.
      synthesis: [toolCall('finish', reportDraft(init))],
    });

    const result = await runTriage(b.Triage, id, init);

    expect(result.ok).toBe(true);
    // Only the first delegation reached the delegate.
    expect(s.callsFor('investigate_atspl')).toHaveLength(1);
    const second = resultOf(s.callsFor('triage')[2], 'task');
    expect(second?.isError).toBe(true);
    const deny = linesFor(id).filter((l) => l.service === 'tripwire');
    expect(deny).toHaveLength(1);
    expect(deny[0]).toMatchObject({ tool: 'task', decision: 'deny', target: 'TRIAGE_MAX_TASKS_PER_RUN', transport: 'mock' });
    const report = resultOf(s.callsFor('triage')[3], 'finish_report');
    expect(report?.text).toContain('budget_exhausted_no_root_cause');
  });

  test('a call to a tool that is not mounted at all never runs anything and the run goes on', async () => {
    const id = nextRunId('tripwire_unmounted');
    const init = triageInit(id);
    await createRun(b.store, init);
    const s = scriptAgents(fake, {
      triage: [toolCall('curl', { url: 'https://example.test/' }), finish(reportDraft(init)), text('report written')],
    });

    const result = await runTriage(b.Triage, id, init);

    expect(result.ok).toBe(true);
    const calls = s.callsFor('triage');
    expect(calls[0]?.tools).not.toContain('curl');
    const missing = resultOf(calls[1], 'curl');
    expect(missing?.isError).toBe(true);
    expect(missing?.text).toContain('not found');
    expect(rogue.runs).toBe(0);
  });

  test('curl inside the sandbox shell is not a command there and makes no request', async () => {
    const id = nextRunId('tripwire_shell');
    const init = triageInit(id);
    await createRun(b.store, init);
    const s = scriptAgents(fake, {
      triage: [
        toolCall('bash', { command: 'curl -s https://example.test/' }),
        finish(reportDraft(init)),
        text('report written'),
      ],
    });

    const result = await runTriage(b.Triage, id, init);

    expect(result.ok).toBe(true);
    const shell = resultOf(s.callsFor('triage')[1], 'bash');
    expect(shell?.text).toMatch(/curl: command not found|exit code 127/i);
  });

  test('no network request was made', () => {
    expect(fetchSpy).toHaveBeenCalledTimes(0);
    expect(httpSpy).toHaveBeenCalledTimes(0);
    expect(httpsSpy).toHaveBeenCalledTimes(0);
  });

  test('every audit line written in this file has transport mock', () => {
    const lines = auditLines(home);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.filter((l) => l.transport !== 'mock')).toEqual([]);
  });
});
