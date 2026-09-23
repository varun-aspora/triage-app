// Safety contract: strict mock misses through runCase (T10.5; HLD 02 §3
// mock.ts, D19, D27, D42).
//
// An ATSPL investigator calls sql_select, http_call and logs_search with no
// fixture for the call. Each miss must come back to the delegate as a tool
// error that names the semantic key, be counted in fixture_misses, touch no
// transport, and leave the run able to finish.
//
// The eval home keeps every credential blank (assertEvalHome refuses
// anything else), and the tool pipeline answers 'not configured' for a blank
// backing env var before it looks for a fixture. So in a plain eval home these
// calls never reach the mock layer. This file wraps loadRegistry so the ATSPL
// DB, API and Quickwit capabilities report 'ok' with a placeholder value. The
// config the eval guard checks is untouched and still blank, mock mode is
// forced, and a mock-mode runtime has no connectors, so nothing can use the
// placeholder.

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { triageRuntime } from '../../../src/agents/triage-plan.ts';
import { bootEvalRuntime, type CaseResult, runCase, stopEvalRuntime } from '../../../src/evals/driver.ts';
import { validateSelect } from '../../../src/gate/sql.ts';
import { createFakeModel, finish, text, toolCall } from '../../../src/mock/fake-model.ts';
import { hashKeyString, keyString, semanticKey } from '../../../src/mock/key.ts';
import { evalHome, findings, reportDraft } from '../eval-support.ts';
import {
  atsplBrief,
  expectFinished,
  expectNoRealIo,
  outputOf,
  safetyCase,
  spyOnIo,
  toolResults,
} from './safety-support.ts';

vi.mock('../../../src/config/registry.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/config/registry.ts')>();
  type Registry = import('../../../src/config/registry.ts').Registry;
  const PLACEHOLDER = 'https://fixture-only.invalid';
  // An 'ok' capability whose value is a non-enumerable placeholder, like the real ones.
  const ok = <T extends object>(visible: T, value: string): T & { readonly status: 'ok'; readonly value: string } => {
    const out = { ...visible, status: 'ok' as const };
    Object.defineProperty(out, 'value', { value, enumerable: false });
    return Object.freeze(out) as T & { readonly status: 'ok'; readonly value: string };
  };
  const fixtureOnly = (registry: Registry): Registry =>
    Object.freeze({
      ...registry,
      serviceDb: (entity, service) => {
        const cap = registry.serviceDb(entity, service);
        return entity === 'atspl' && cap?.status === 'disabled' ? ok({ envName: cap.envName }, PLACEHOLDER) : cap;
      },
      serviceApi: (entity, service) => {
        const cap = registry.serviceApi(entity, service);
        return entity === 'atspl' && cap?.status === 'disabled'
          ? ok({ envName: cap.envName, transport: cap.transport }, PLACEHOLDER)
          : cap;
      },
      quickwit: (entity) => {
        const cap = registry.quickwit(entity);
        if (entity !== 'atspl' || cap.status !== 'disabled') return cap;
        return Object.freeze({
          status: 'ok',
          transport: 'qw',
          index: 'fixture-only',
          context: 'fixture-only',
          maxConcurrency: 1,
          maxHits: 500,
        });
      },
    } satisfies Registry);
  return { ...original, loadRegistry: (...args: Parameters<typeof original.loadRegistry>) => fixtureOnly(original.loadRegistry(...args)) };
});

const CUSTOMER = '5b3e1f0a-7c2d-4e89-9a41-0c6d2f8b1e37';
const SQL = 'SELECT id, status FROM delivery_requests WHERE external_ref_id = $1';
const HTTP_PATH = '/admin/v1/deliveries';

const fake = createFakeModel();
const home = evalHome();
const io = spyOnIo();
const { case: base } = safetyCase('atspl-delivery');

type Probe = { readonly tool: 'sql_select' | 'http_call' | 'logs_search'; readonly input: Record<string, unknown> };

const PROBES: readonly Probe[] = [
  { tool: 'sql_select', input: { service: 'package', sql: SQL, params: [CUSTOMER] } },
  { tool: 'http_call', input: { service: 'package', path: HTTP_PATH } },
  { tool: 'logs_search', input: { service: 'package', message: 'welcome letter dispatch failed', terms: [CUSTOMER] } },
];

const results = new Map<string, CaseResult>();
let connectorKeys: string[] = [];

/** One run: the root delegates to ATSPL, which makes the one call, records a gap and replies. */
function runProbe(probe: Probe): Promise<CaseResult> {
  return runCase(base, {
    turns: {
      root: [
        toolCall('task', { agent: 'investigate_atspl', prompt: atsplBrief(`Ids: customer_id ${CUSTOMER}`) }),
        finish(reportDraft(base.expected.tier)),
        text('report written'),
      ],
      investigate_atspl: [
        toolCall(probe.tool, probe.input),
        toolCall('note_evidence', { ...findings('medium'), gaps: [`${probe.tool} had no fixture`] }),
        text('no data for that call; gap recorded'),
      ],
    },
  });
}

beforeAll(async () => {
  await bootEvalRuntime({ faux: fake });
  connectorKeys = Object.keys(triageRuntime().connectors);
  for (const probe of PROBES) results.set(probe.tool, await runProbe(probe));
});

afterAll(async () => {
  io.restore();
  await stopEvalRuntime();
  home.dispose();
});

function resultFor(tool: string): CaseResult {
  const r = results.get(tool);
  if (r === undefined) throw new Error(`no result for ${tool}`);
  return r;
}

function missSeenBy(tool: string) {
  const seen = toolResults(resultFor(tool), 'investigate_atspl', tool);
  expect(seen).toHaveLength(1);
  return seen[0];
}

describe('strict mock miss', () => {
  test('the mock-mode runtime has no connectors to touch', () => {
    expect(connectorKeys).toEqual([]);
  });

  test('sql_select miss: a visible tool error naming the semantic key and its file', () => {
    const check = validateSelect(SQL);
    if (!check.ok) throw new Error('the probe SQL must pass the gate');
    const key = keyString(
      semanticKey('sql_select', { entity: 'atspl', service: 'package', tables: check.tables, params: [CUSTOMER] }),
    );
    const miss = missSeenBy('sql_select');
    expect(miss?.isError).toBe(true);
    expect(miss?.text).toContain(`no sql_select fixture for key ${key}`);
    expect(miss?.text).toContain(`${hashKeyString(key)}.json`);
  });

  test('http_call miss: a visible tool error naming the semantic key', () => {
    const key = keyString(semanticKey('http_call', { entity: 'atspl', service: 'package', method: 'GET', path: HTTP_PATH }));
    const miss = missSeenBy('http_call');
    expect(miss?.isError).toBe(true);
    expect(miss?.text).toContain(`no http_call fixture for key ${key}`);
  });

  test('logs_search miss: a visible tool error naming the semantic key', () => {
    const miss = missSeenBy('logs_search');
    expect(miss?.isError).toBe(true);
    expect(miss?.text).toContain('no logs_search fixture for key {');
    expect(miss?.text).toContain('"entity":"atspl"');
    expect(miss?.text).toContain('"mode":"search"');
    expect(miss?.text).toContain(CUSTOMER);
  });

  describe.each(PROBES.map((p) => p.tool))('%s', (tool) => {
    test('fixture_misses is incremented by one and the audit line is a mock fixture miss', () => {
      const r = resultFor(tool);
      expect(r.fixture_misses).toBe(1);
      const lines = r.audit.filter((l) => l.tool === tool);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ decision: 'allow', exit: 'fixture_miss', transport: 'mock', entity: 'atspl' });
    });

    test('the run does not crash: the delegate records the gap and the report is written', () => {
      const r = resultFor(tool);
      expectFinished(r);
      const note = toolResults(r, 'investigate_atspl', 'note_evidence')[0];
      expect(note?.isError).toBe(false);
      expect(outputOf(note)?.status).toBe('ok');
      expect(toolResults(r, 'root', 'task')[0]?.text).toBe('no data for that call; gap recorded');
      expect(r.audit.some((l) => l.tool === 'finish_report' && l.decision === 'allow')).toBe(true);
    });

    test('passes checkNoRealIo', () => {
      expectNoRealIo(resultFor(tool));
    });
  });

  test('no transport was touched: no network request and no subprocess', () => {
    expect(io.counts()).toEqual({ fetch: 0, http: 0, https: 0, spawn: 0 });
  });
});
