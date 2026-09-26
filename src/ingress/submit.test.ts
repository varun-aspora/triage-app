// runSubmission and askRun with injected fakes: a folder run store in a temp
// dir wrapped in a recorder, fake pre-flight, identity, classifier and
// prior-case providers, the real tier policy behind a spy, and a fake Flue
// dispatcher {init -> {dispatch, read, abort}}. No model, network or Flue
// runtime is involved.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Agent, AgentInstanceExistsError, AgentRunError, type InitOptions } from '@flue/runtime';
import * as v from 'valibot';
import type { TriageRuntime } from '../agents/triage-plan.ts';
import { Triage } from '../agents/triage.agent.ts';
import { unknownClassification } from '../classify/classify.ts';
import { applyTierPolicy, type TierPolicyContext } from '../classify/policy.ts';
import { HASH_MODEL, type Embedder } from '../embed/index.ts';
import { isPersisted, redactPersisted } from '../gate/redact.ts';
import type { EmbedRunResult } from '../runstore/embed-run.ts';
import { createFolderRunStore, folderRunStoreFromConfig } from '../runstore/folder.ts';
import { RunNotFoundError, RunStoppedError, type RunStore } from '../runstore/types.ts';
import { type Classification, type TriageInit, TriageInitSchema } from '../types/classification.ts';
import type { Tier } from '../types/core.ts';
import type { IdChain } from '../types/id-chain.ts';
import { INPUT_ANSWER_CHAIN_ATTR, INPUT_ANSWER_SIGNAL } from '../types/input-request.ts';
import { BLOCK_RESUME_SIGNAL, MAX_RESUME_NOTE_CHARS } from '../types/block.ts';
import { flushRunEventLog, installRunEventLog, uninstallRunEventLog } from '../runlog/event-log.ts';
import { readRunEvents } from '../runlog/read.ts';
import { sampleBlock, sampleInputRequest } from '../runstore/contract.ts';
import type { Attachment } from '../types/request.ts';
import type { UsageRow } from '../types/usage.ts';
import { priceUsage } from '../usage/price.ts';
import {
  installUsageMeter,
  recordUsage,
  resetUsageMeterForTests,
  snapshotIntake,
  snapshotSubmission,
  type UsageEvent,
} from '../usage/meter.ts';
import type { IngressIdentity } from './identity.ts';
import { buildTriageRequest, IngressInputError, type TriageInput } from './normalise.ts';
import { prepareDeps, prepareRequest, type PreparedSubmission } from './prepare.ts';
import {
  askRun,
  type AgentHandle,
  type Dispatcher,
  runSubmission,
  type SubmissionConfig,
  type SubmissionDeps,
  SubmissionReadTimeoutError,
  submissionDeps,
  answerRun,
  RunNotWaitingError,
  SubmissionInputError,
  RESUME_HINTS,
  ResumeNotReadyError,
  resumeRun,
  RunNotResumableError,
  type SettleDeps,
  DEFAULT_USAGE_FLUSH_MS,
  HASH_USAGE_MODEL,
  type UsageFlushTimer,
} from './submit.ts';
import { makeTestHome } from '../../test/support/home.ts';

// ------------------------------------------------------------------ synthetic data

const RUN_ID = '01JSUBMITAAAAAAAAAAAAAAAAA';
const PHONE = '+91 98765 43210';
const NAME = 'Asha Verma';
const PAN = '4111111111111111';
// Fails the Luhn check, so the model-facing profile keeps it.
const ACCOUNT = '918020012345678';
const NOW = new Date('2026-09-24T10:00:00.000Z');

function prepared(opts: { attachments?: Attachment[]; tier?: Tier; runId?: string } = {}): PreparedSubmission {
  const runId = opts.runId ?? RUN_ID;
  const input: TriageInput = {
    kind: 'json',
    interface: 'cli',
    requested_by: 'ops.reviewer@example.com',
    body: {
      messages: [
        {
          ts: '1695460000.123456',
          author: NAME,
          text: `Customer Name: ${NAME}\nPhone ${PHONE}. Card ${PAN} was charged but account ${ACCOUNT} shows nothing.`,
          is_parent: true,
        },
        { ts: '1695460100.000001', author: 'support', text: 'Any update on this one?' },
      ],
      ...(opts.tier !== undefined ? { tier: opts.tier } : {}),
    },
    ...(opts.attachments !== undefined ? { attachments: opts.attachments } : {}),
  };
  const request = buildTriageRequest(input, {
    now: NOW,
    newId: () => runId,
    lookbackDays: 7,
    enabledEntities: ['ssfb', 'atspl'],
    resolveEntity: (n) => (n === 'ssfb' || n === 'atspl' ? n : undefined),
  });
  return { run_id: runId, request, redaction_names: [NAME] };
}

const CHAIN: IdChain = { ids: { account_number: ACCOUNT }, hops: [], basic_state: [] };

function goodClassification(): Classification {
  return {
    category: 'card',
    subcategory: 'charge not reflected',
    entities_likely: ['ssfb'],
    money_moved: false,
    misdirected_funds: false,
    tier_proposed: 'mid',
    confidence: 0.9,
    images_seen: false,
  };
}

// ------------------------------------------------------------------ fakes

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Call = { readonly method: string; readonly args: unknown[] };

/** The folder store with every call recorded, in order, into calls and events. */
function recordingStore(events: string[]): { store: RunStore; calls: Call[]; inner: RunStore } {
  const dir = mkdtempSync(join(tmpdir(), 'triage-submit-'));
  dirs.push(dir);
  const inner = createFolderRunStore({ runsDir: join(dir, 'runs'), dataDir: join(dir, 'data') });
  const calls: Call[] = [];
  const store = new Proxy(inner, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        calls.push({ method: String(prop), args });
        events.push(prop === 'setPhase' ? `phase:${String(args[1])}` : String(prop));
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { store, calls, inner };
}

/** Every store call argument as text, with Persisted boxes opened. */
function storeText(calls: readonly Call[]): string {
  return JSON.stringify(calls.map((c) => c.args.map((a) => (isPersisted(a) ? a.value : a))));
}

type ReadBehaviour = (signal: AbortSignal | undefined) => Promise<{ text: string; submissionId: string; data: Record<string, unknown[]> }>;

type FakeFlue = {
  readonly dispatcher: Dispatcher;
  readonly inits: { agent: Agent; options: InitOptions }[];
  readonly dispatches: { message: unknown; initialData?: unknown; keys: string[] }[];
  readonly reads: number[];
  aborts: number;
};

function fakeFlue(
  events: string[],
  read: ReadBehaviour = async () => ({ text: 'done', submissionId: 'sub-1', data: {} }),
  onDispatch?: () => Promise<void>,
  dispatchError?: Error,
): FakeFlue {
  const flue: FakeFlue = {
    inits: [],
    dispatches: [],
    reads: [],
    aborts: 0,
    dispatcher: {
      init(agent, options) {
        flue.inits.push({ agent, options });
        const handle: AgentHandle = {
          async dispatch(request) {
            events.push('dispatch');
            if (dispatchError !== undefined) throw dispatchError;
            const r = request as { message: unknown; initialData?: unknown };
            flue.dispatches.push({ message: r.message, initialData: r.initialData, keys: Object.keys(r) });
            await onDispatch?.();
            return { submissionId: `sub-${flue.dispatches.length}`, acceptedAt: NOW.toISOString(), uid: 'uid-1' };
          },
          async read(_target, opts) {
            events.push('read');
            flue.reads.push(1);
            return read(opts?.signal);
          },
          async abort() {
            flue.aborts += 1;
          },
        };
        return handle;
      },
    },
  };
  return flue;
}

type Harness = {
  deps: SubmissionDeps;
  events: string[];
  calls: Call[];
  store: RunStore;
  flue: FakeFlue;
  spies: { preflight: number; priorCases: number; embedRun: unknown[][]; policy: TierPolicyContext[] };
};

type HarnessOptions = {
  config?: Partial<{ mock: boolean; priorCases: boolean; usageFlushMs: number }>;
  classify?: SubmissionDeps['classify'];
  identity?: () => Promise<IngressIdentity>;
  read?: ReadBehaviour;
  onDispatch?: (store: RunStore) => Promise<void>;
  dispatchError?: Error;
  embedRun?: SubmissionDeps['embedRun'];
  tierAcceptsImages?: (tier: Tier) => boolean;
  preflightWarnings?: { step: string; message: string }[];
  signal?: AbortSignal;
  readTimeoutMs?: number;
  stopPollMs?: number;
  embedder?: Embedder | null;
  priorCases?: SubmissionDeps['priorCases'];
  usageFlushTimer?: UsageFlushTimer;
};

const EMBEDDER: Embedder = { model: 'test/embed', embed: async () => [] };

function harness(o: HarnessOptions = {}): Harness {
  const events: string[] = [];
  const { store, calls } = recordingStore(events);
  const flue = fakeFlue(events, o.read, o.onDispatch ? () => o.onDispatch!(store) : undefined, o.dispatchError);
  const spies: Harness['spies'] = { preflight: 0, priorCases: 0, embedRun: [], policy: [] };
  const config: SubmissionConfig = {
    mock: { enabled: o.config?.mock ?? true },
    runs: {
      priorCases: o.config?.priorCases ?? false,
      ...(o.config?.usageFlushMs !== undefined ? { usageFlushMs: o.config.usageFlushMs } : {}),
    },
    budgets: { runTimeoutMs: 1_000, runMaxAttempts: 1 },
  };
  const deps: SubmissionDeps = {
    config,
    store,
    dispatcher: flue.dispatcher,
    agent: Triage,
    embedder: o.embedder === undefined ? EMBEDDER : o.embedder,
    embedRun:
      o.embedRun ??
      (async (...args) => {
        events.push('embedRun');
        spies.embedRun.push(args);
        return { written: [], unchanged: [], empty: [], gaps: [] } satisfies EmbedRunResult;
      }),
    preflight: async () => {
      events.push('preflight');
      spies.preflight += 1;
      return { warnings: o.preflightWarnings ?? [] };
    },
    identity:
      o.identity ??
      (async () => {
        events.push('identity');
        return { id_chain: CHAIN, basic_state: [], gaps: [] };
      }),
    classify:
      o.classify ??
      (async () => {
        events.push('classify');
        return goodClassification();
      }),
    policy: (raw, ctx) => {
      events.push('policy');
      spies.policy.push(ctx);
      return applyTierPolicy(raw, ctx);
    },
    tierAcceptsImages: o.tierAcceptsImages ?? (() => true),
    priorCases:
      o.priorCases ??
      (async () => {
        spies.priorCases += 1;
        return { cases: [{ category: 'card', age_days: 12, similarity: 0.82 }], gaps: [] };
      }),
    readAttachment: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    ...(o.signal !== undefined ? { signal: o.signal } : {}),
    ...(o.readTimeoutMs !== undefined ? { readTimeoutMs: o.readTimeoutMs } : {}),
    ...(o.stopPollMs !== undefined ? { stopPollMs: o.stopPollMs } : {}),
    ...(o.usageFlushTimer !== undefined ? { usageFlushTimer: o.usageFlushTimer } : {}),
  };
  return { deps, events, calls, store, flue, spies };
}

function initialDataOf(h: Harness): TriageInit {
  const d = h.flue.dispatches[0];
  if (d === undefined) throw new Error('nothing was dispatched');
  return d.initialData as TriageInit;
}

function bodyOf(h: Harness, i = 0): string {
  return (h.flue.dispatches[i]?.message as { body: string }).body;
}

// ------------------------------------------------------------------ order

describe('runSubmission order', () => {
  test('happy path runs the steps in order and records a phase for each', async () => {
    const h = harness({ config: { mock: false } });
    const result = await runSubmission(prepared(), h.deps);

    const steps = h.events.filter((e) =>
      ['createRun', 'preflight', 'identity', 'classify', 'policy', 'putClassification', 'dispatch', 'read', 'phase:completed'].includes(e),
    );
    expect(steps).toEqual(['createRun', 'preflight', 'identity', 'classify', 'policy', 'putClassification', 'dispatch', 'read', 'phase:completed']);
    expect(h.events.filter((e) => e.startsWith('phase:'))).toEqual([
      'phase:preflight',
      'phase:identity',
      'phase:classifying',
      'phase:dispatched',
      'phase:investigating',
      'phase:completed',
    ]);
    expect(h.events.indexOf('addSubmission')).toBeLessThan(h.events.indexOf('dispatch'));

    expect(result).toMatchObject({ run_id: RUN_ID, status: 'completed', submission_seq: 1, submission_id: 'sub-1', reply_text: 'done' });
    const run = await h.store.getRun(RUN_ID);
    expect(run?.phase).toBe('completed');
    expect(run?.submissions.map((s) => s.kind)).toEqual(['initial']);
  });

  test('createRun gets a persisted-profile value', async () => {
    const h = harness();
    await runSubmission(prepared(), h.deps);
    const create = h.calls.find((c) => c.method === 'createRun');
    expect(create?.args[0]).toBe(RUN_ID);
    expect(isPersisted(create?.args[1])).toBe(true);
  });

  test('dispatch uses uid: null and id = run_id, and initialData passes the Triage schema', async () => {
    const h = harness();
    await runSubmission(prepared(), h.deps);
    expect(h.flue.inits).toHaveLength(1);
    expect(h.flue.inits[0]?.agent).toBe(Triage);
    expect(h.flue.inits[0]?.options).toEqual({ id: RUN_ID, uid: null });
    const init = initialDataOf(h);
    expect(v.safeParse(Triage.initialData as typeof TriageInitSchema, init).success).toBe(true);
    expect(v.safeParse(TriageInitSchema, init).success).toBe(true);
    expect(init.request.request_id).toBe(RUN_ID);
    expect(init.id_chain).toEqual(CHAIN);
  });

  test('a mismatched run id is refused before anything is stored', async () => {
    const h = harness();
    const p = prepared();
    await expect(runSubmission({ ...p, run_id: '01JOTHERAAAAAAAAAAAAAAAAAA' }, h.deps)).rejects.toThrow('run_id must equal');
    expect(h.calls).toHaveLength(0);
  });
});

// ------------------------------------------------------------------ redaction

describe('redaction', () => {
  test('the raw thread never reaches the run store', async () => {
    const h = harness({ config: { mock: false, priorCases: true } });
    await runSubmission(prepared(), h.deps);
    const text = storeText(h.calls);
    expect(h.calls.length).toBeGreaterThan(5);
    for (const secret of [PHONE, '9876543210', NAME, 'Asha', 'Verma', PAN, ACCOUNT, 'ops.reviewer@example.com']) {
      expect(text).not.toContain(secret);
    }
  });

  test('redaction_names are in initialData and in no store call', async () => {
    const h = harness();
    await runSubmission(prepared(), h.deps);
    expect(initialDataOf(h).redaction_names).toEqual([NAME]);
    expect(storeText(h.calls)).not.toContain(NAME);
  });

  test('the message is model-facing and initialData.request is the persisted-profile copy', async () => {
    const h = harness();
    const p = prepared();
    await runSubmission(p, h.deps);
    const body = bodyOf(h);
    expect(body).not.toContain(PAN);
    expect(body).toContain('****1111');
    expect(body).toContain(ACCOUNT);
    expect(body).toContain(PHONE);
    expect(body).toContain(NAME);

    const expected = { ...redactPersisted(p.request, { names: [NAME] }).value, request_id: RUN_ID };
    expect(initialDataOf(h).request).toEqual(expected);
    expect(JSON.stringify(initialDataOf(h).request)).not.toContain(PAN);
  });

  test('the classifier gets the model-facing thread', async () => {
    let seen = '';
    const h = harness();
    h.deps = {
      ...h.deps,
      classify: async (input) => {
        seen = JSON.stringify(input.thread);
        return goodClassification();
      },
    };
    await runSubmission(prepared(), h.deps);
    expect(seen).not.toContain(PAN);
    expect(seen).toContain(ACCOUNT);
  });
});

// ------------------------------------------------------------------ pre-flight

describe('pre-flight', () => {
  test('mock mode does not call pre-flight', async () => {
    const h = harness({ config: { mock: true } });
    await runSubmission(prepared(), h.deps);
    expect(h.spies.preflight).toBe(0);
    expect(initialDataOf(h).preflight_warnings).toEqual([]);
  });

  test('outside mock mode the warnings reach initialData and the run record', async () => {
    const w = { step: 'tunnel', message: 'the ssfb tunnel is down' };
    const h = harness({ config: { mock: false }, preflightWarnings: [w] });
    await runSubmission(prepared(), h.deps);
    expect(h.spies.preflight).toBe(1);
    expect(initialDataOf(h).preflight_warnings).toContainEqual(w);
    const run = await h.store.getRun(RUN_ID);
    expect(run?.classification?.preflight_warnings).toContainEqual(w);
  });

  test('outside mock mode the repo sync runs with the request interface and its warnings follow pre-flight', async () => {
    const seen: string[] = [];
    const repoWarning = { step: 'repos', message: 'repo sync failed for rhythm; those checkouts are as they were' };
    const h = harness({ config: { mock: false }, preflightWarnings: [{ step: 'tunnel', message: 'down' }] });
    const deps: SubmissionDeps = {
      ...h.deps,
      repoSync: async ({ interface: iface }) => {
        seen.push(iface);
        return [repoWarning];
      },
    };
    await runSubmission(prepared(), deps);
    expect(seen).toEqual([prepared().request.interface]);
    const warnings = initialDataOf(h).preflight_warnings ?? [];
    expect(warnings.map((x) => x.step).slice(0, 2)).toEqual(['tunnel', 'repos']);
    expect(warnings).toContainEqual(repoWarning);
  });

  test('pre-flight and the repo sync cover every enabled entity, even when the request names one', async () => {
    const seen: string[][] = [];
    const h = harness({ config: { mock: false } });
    const deps: SubmissionDeps = {
      ...h.deps,
      preflight: async (input) => {
        seen.push(Object.keys(input));
        return { warnings: [] };
      },
      repoSync: async (input) => {
        seen.push(Object.keys(input));
        return [];
      },
    };
    const p = prepared();
    await runSubmission({ ...p, request: { ...p.request, hints: { ...p.request.hints, entities: ['atspl'] } } }, deps);
    expect(seen).toEqual([['signal'], ['interface', 'signal']]);
  });

  test('mock mode does not sync repos', async () => {
    let calls = 0;
    const h = harness({ config: { mock: true } });
    await runSubmission(prepared(), {
      ...h.deps,
      repoSync: async () => {
        calls++;
        return [];
      },
    });
    expect(calls).toBe(0);
  });
});

// ------------------------------------------------------------------ failures before dispatch

describe('classifier and identity failures', () => {
  test('a classifier error still dispatches, with tier_final strong', async () => {
    const h = harness({ classify: async () => unknownClassification('provider error: boom') });
    const result = await runSubmission(prepared(), h.deps);
    expect(result.status).toBe('completed');
    expect(h.flue.dispatches).toHaveLength(1);
    const decision = initialDataOf(h).classification;
    expect(decision.tier_final).toBe('strong');
    expect(decision.proposed.category).toBe('unknown');
    expect(decision.proposed.classifier_error).toContain('provider error');
  });

  test('a classifier that throws still dispatches, with tier_final strong', async () => {
    const h = harness({
      classify: async () => {
        throw new TypeError('bad');
      },
    });
    await runSubmission(prepared(), h.deps);
    expect(initialDataOf(h).classification.tier_final).toBe('strong');
    expect(initialDataOf(h).classification.proposed.classifier_error).toContain('TypeError');
  });

  test('an unreachable identity step still dispatches and records a gap', async () => {
    const h = harness({
      identity: async () => {
        throw Object.assign(new Error('connect ECONNREFUSED'), { name: 'ConnectorError' });
      },
    });
    const result = await runSubmission(prepared(), h.deps);
    expect(result.status).toBe('completed');
    const init = initialDataOf(h);
    expect(init.id_chain).toEqual({ ids: {}, hops: [], basic_state: [] });
    expect(init.preflight_warnings?.some((w) => w.step === 'identity' && w.message.includes('did not run'))).toBe(true);
    expect(JSON.stringify(init.preflight_warnings)).not.toContain('ECONNREFUSED');
  });

  test('identity hops marked unreachable are passed through and dispatched', async () => {
    const chain: IdChain = {
      ids: { account_number: ACCOUNT },
      hops: [{ from: 'account_number', source: 'ssfb:rhythm.customer_account_mappings', status: 'unreachable', taken_at: NOW.toISOString() }],
      basic_state: [],
    };
    const h = harness({ identity: async () => ({ id_chain: chain, basic_state: [], gaps: ['ssfb:rhythm unreachable'] }) });
    await runSubmission(prepared(), h.deps);
    expect(initialDataOf(h).id_chain.hops[0]?.status).toBe('unreachable');
  });

  test('a strict fixture miss in identity is loud: phase failed, nothing dispatched', async () => {
    class FixtureMissError extends Error {
      override name = 'FixtureMissError';
    }
    const h = harness({
      identity: async () => {
        throw new FixtureMissError('no fixture');
      },
    });
    await expect(runSubmission(prepared(), h.deps)).rejects.toThrow('no fixture');
    expect(h.flue.dispatches).toHaveLength(0);
    expect((await h.store.getRun(RUN_ID))?.phase).toBe('failed');
    expect((await h.store.getRun(RUN_ID))?.phase_reason).toBe('FixtureMissError');
  });

  test('a dispatch rejection records failed and is passed on', async () => {
    const h = harness({ dispatchError: new AgentInstanceExistsError({ id: RUN_ID, uid: 'u' }) });
    await expect(runSubmission(prepared(), h.deps)).rejects.toBeInstanceOf(AgentInstanceExistsError);
    const run = await h.store.getRun(RUN_ID);
    expect(run?.phase).toBe('failed');
    expect(run?.phase_reason).toBe('AgentInstanceExistsError');
    expect(h.spies.embedRun).toHaveLength(0);
  });
});

// ------------------------------------------------------------------ read and settle

describe('read and settle', () => {
  test('a read rejection records phase failed with the class name and keeps the evidence', async () => {
    const findings = {
      evidence: [{ source: 'db' as const, at: NOW.toISOString(), query_or_path: 'harbor.account_forms', summary: 'form verified' }],
      timeline: [],
      hypotheses: ['vendor rejected the address'],
      confidence: 'medium' as const,
      gaps: [],
    };
    const h = harness({
      onDispatch: async (store) => {
        await store.putEvidence(RUN_ID, 'ssfb', redactPersisted(findings));
      },
      read: async () => {
        throw new AgentRunError({ outcome: 'failed', submissionId: 'sub-1' });
      },
    });
    const result = await runSubmission(prepared(), h.deps);
    expect(result.status).toBe('failed');
    expect(result.error).toBe('AgentRunError');
    const run = await h.store.getRun(RUN_ID);
    expect(run?.phase).toBe('failed');
    expect(run?.phase_reason).toBe('AgentRunError');
    expect(run?.evidence.ssfb?.findings).toEqual(findings);
    expect(h.calls.filter((c) => c.method === 'putEvidence')).toHaveLength(1);
    expect(h.calls.some((c) => c.method === 'deleteRun')).toBe(false);
  });

  test('an aborted settlement names the outcome', async () => {
    const h = harness({
      read: async () => {
        throw new AgentRunError({ outcome: 'aborted', submissionId: 'sub-1' });
      },
    });
    const result = await runSubmission(prepared(), h.deps);
    expect(result.error).toBe('AgentRunError (aborted)');
  });

  test('a read that outlives the read timeout fails the run and asks Flue to abort', async () => {
    const h = harness({
      readTimeoutMs: 20,
      read: (signal) =>
        new Promise((_, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason));
        }),
    });
    const result = await runSubmission(prepared(), h.deps);
    expect(result.status).toBe('failed');
    expect(result.error).toBe(new SubmissionReadTimeoutError(20).name);
    expect(h.flue.aborts).toBe(1);
  });

  test('a caller abort stops the wait without marking the run failed', async () => {
    const ctrl = new AbortController();
    const h = harness({
      signal: ctrl.signal,
      read: (signal) =>
        new Promise((_, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason));
          ctrl.abort(new Error('caller went away'));
        }),
    });
    await expect(runSubmission(prepared(), h.deps)).rejects.toThrow('caller went away');
    expect((await h.store.getRun(RUN_ID))?.phase).toBe('investigating');
    expect(h.flue.aborts).toBe(0);
  });

  test('embedRun is called once after a completed settle', async () => {
    const h = harness();
    await runSubmission(prepared(), h.deps);
    expect(h.spies.embedRun).toHaveLength(1);
    expect(h.spies.embedRun[0]?.[1]).toBe(EMBEDDER);
    expect(h.spies.embedRun[0]?.[2]).toBe(RUN_ID);
    expect(h.events.indexOf('embedRun')).toBeGreaterThan(h.events.indexOf('phase:completed'));
  });

  test('embedRun is called once after a failed settle', async () => {
    const h = harness({
      read: async () => {
        throw new AgentRunError({ outcome: 'failed', submissionId: 'sub-1' });
      },
    });
    await runSubmission(prepared(), h.deps);
    expect(h.spies.embedRun).toHaveLength(1);
    expect(h.events.indexOf('embedRun')).toBeGreaterThan(h.events.indexOf('phase:failed'));
  });

  test('embedRun throwing leaves the phase completed and returns a gap', async () => {
    const h = harness({
      embedRun: async () => {
        throw new RangeError('broken');
      },
    });
    const result = await runSubmission(prepared(), h.deps);
    expect(result.status).toBe('completed');
    expect(result.gaps).toEqual(['embeddings skipped (RangeError)']);
    expect((await h.store.getRun(RUN_ID))?.phase).toBe('completed');
  });

  test('embedRun gaps are returned and the status stays completed', async () => {
    const h = harness({
      embedRun: async () => ({ written: [], unchanged: [], empty: [], gaps: ['embeddings disabled'] }),
    });
    const result = await runSubmission(prepared(), h.deps);
    expect(result.status).toBe('completed');
    expect(result.gaps).toEqual(['embeddings disabled']);
  });
});

// ------------------------------------------------------------------ prior cases

describe('prior cases', () => {
  test('off (the default): absent from initialData and the provider is not called', async () => {
    const h = harness();
    await runSubmission(prepared(), h.deps);
    expect(h.spies.priorCases).toBe(0);
    expect('prior_cases' in initialDataOf(h)).toBe(false);
  });

  test('on: the projection reaches initialData', async () => {
    const h = harness({ config: { priorCases: true } });
    await runSubmission(prepared(), h.deps);
    expect(h.spies.priorCases).toBe(1);
    expect(initialDataOf(h).prior_cases).toEqual([{ category: 'card', age_days: 12, similarity: 0.82 }]);
  });

  test('on, with a retrieval gap: the gap becomes a warning', async () => {
    const h = harness({ config: { priorCases: true } });
    h.deps = { ...h.deps, priorCases: async () => ({ cases: [], gaps: ['prior cases unavailable'] }) };
    await runSubmission(prepared(), h.deps);
    expect(initialDataOf(h).prior_cases).toEqual([]);
    expect(initialDataOf(h).preflight_warnings).toContainEqual({ step: 'prior_cases', message: 'prior cases unavailable' });
  });
});

// ------------------------------------------------------------------ images

describe('screenshots', () => {
  const shot: Attachment = { name: 'screen.png', mime: 'image/png', bytes_ref: '/synthetic/attachments/1.png' };

  test('an image-capable tier gets the images as image parts', async () => {
    const h = harness({ tierAcceptsImages: () => true });
    await runSubmission(prepared({ attachments: [shot] }), h.deps);
    const message = h.flue.dispatches[0]?.message as { kind: string; attachments?: { type: string; data: string; mimeType: string }[] };
    expect(message.kind).toBe('user');
    expect(message.attachments).toHaveLength(1);
    expect(message.attachments?.[0]).toMatchObject({ type: 'image', mimeType: 'image/png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64') });
    expect(bodyOf(h)).toContain('1 screenshot from the thread is attached');
    expect(initialDataOf(h).classification.images_dropped).toBeUndefined();
    expect(h.spies.policy[0]?.hasImages).toBe(true);
  });

  test('a text-only tier drops the images and records the drop', async () => {
    const h = harness({ tierAcceptsImages: () => false });
    await runSubmission(prepared({ attachments: [shot] }), h.deps);
    const message = h.flue.dispatches[0]?.message as { attachments?: unknown[] };
    expect(message.attachments).toBeUndefined();
    expect(bodyOf(h)).toContain('1 screenshot was left out');
    const init = initialDataOf(h);
    expect(init.classification.images_dropped).toBe(true);
    expect(init.preflight_warnings?.some((w) => w.step === 'attachments')).toBe(true);
    const run = await h.store.getRun(RUN_ID);
    expect(run?.classification?.decision.images_dropped).toBe(true);
  });

  test('an image that cannot be read is left out with a warning', async () => {
    const h = harness();
    h.deps = {
      ...h.deps,
      readAttachment: async () => {
        throw new Error('ENOENT');
      },
    };
    await runSubmission(prepared({ attachments: [shot] }), h.deps);
    expect((h.flue.dispatches[0]?.message as { attachments?: unknown[] }).attachments).toBeUndefined();
    expect(initialDataOf(h).preflight_warnings?.some((w) => w.message.includes('could not be read'))).toBe(true);
  });

  test('no screenshots: a plain user message with no attachments', async () => {
    const h = harness();
    await runSubmission(prepared(), h.deps);
    const message = h.flue.dispatches[0]?.message as { kind: string; attachments?: unknown };
    expect(message.kind).toBe('user');
    expect(message.attachments).toBeUndefined();
  });
});

// ------------------------------------------------------------------ tier override

test('a caller tier hint reaches the policy as an override with who asked', async () => {
  const h = harness();
  await runSubmission(prepared({ tier: 'cheap' }), h.deps);
  expect(h.spies.policy[0]?.override).toEqual({ tier: 'cheap', by: 'ops.reviewer@example.com' });
  expect(initialDataOf(h).classification.tier_final).toBe('cheap');
});

// ------------------------------------------------------------------ ask

describe('askRun', () => {
  test('an unknown run id throws RunNotFound and dispatches nothing', async () => {
    const h = harness();
    await expect(askRun(RUN_ID, 'did the retry go out?', 'ops@example.com', h.deps)).rejects.toBeInstanceOf(RunNotFoundError);
    expect(h.flue.inits).toHaveLength(0);
  });

  test('an invalid run id is a usage error', async () => {
    const h = harness();
    await expect(askRun('../etc', 'q', 'ops', h.deps)).rejects.toBeInstanceOf(IngressInputError);
  });

  test('a blank question is refused', async () => {
    const h = harness();
    await runSubmission(prepared(), h.deps);
    await expect(askRun(RUN_ID, '   ', 'ops', h.deps)).rejects.toBeInstanceOf(IngressInputError);
  });

  test('a known run gets a new submission without initialData and with the redacted question', async () => {
    const h = harness();
    await runSubmission(prepared(), h.deps);
    const question = `Did the retry to ${PHONE} go out for card ${PAN}?`;
    const result = await askRun(RUN_ID, question, 'ops.reviewer@example.com', h.deps);

    expect(result).toMatchObject({ status: 'completed', submission_seq: 2, submission_id: 'sub-2' });
    expect(h.flue.inits[1]?.options).toEqual({ id: RUN_ID });
    expect(h.flue.dispatches[1]?.keys).toEqual(['message']);
    expect(h.flue.dispatches[1]?.initialData).toBeUndefined();
    const body = bodyOf(h, 1);
    expect(body).not.toContain(PAN);
    expect(body).toContain(PHONE);

    const run = await h.store.getRun(RUN_ID);
    expect(run?.submissions.map((s) => s.kind)).toEqual(['initial', 'ask']);
    const stored = run?.submissions[1]?.question ?? '';
    expect(stored).not.toContain(PAN);
    expect(stored).not.toContain(PHONE);
    expect(stored).toContain('Did the retry');
    expect(h.spies.embedRun).toHaveLength(2);
  });
});

// ------------------------------------------------------------------ production deps

describe('submissionDeps in mock mode', () => {
  test('wires the real steps over a test home; only the dispatcher is faked', async () => {
    const home = makeTestHome({ entities: ['ssfb'] });
    try {
      const events: string[] = [];
      const flue = fakeFlue(events);
      const audit: unknown[] = [];
      const runtime = {
        config: home.config,
        registry: home.registry,
        runStore: folderRunStoreFromConfig(home.config),
        connectors: {},
        audit: { write: (line: unknown) => audit.push(line) },
      } as unknown as TriageRuntime;
      const deps = submissionDeps({ runtime, dispatcher: flue.dispatcher });
      expect(deps.agent).toBe(Triage);
      expect(deps.embedder).toBeNull();
      expect(deps.tierAcceptsImages('strong')).toBe(false);

      const p = await prepareRequest(
        { kind: 'text', text: 'Welcome letter never arrived', interface: 'cli', requested_by: 'ops@example.com' },
        prepareDeps(home.config, home.registry, { newId: () => RUN_ID }),
      );
      const result = await runSubmission(p, deps);

      expect(result.status).toBe('completed');
      expect(result.gaps).toEqual(['embeddings disabled']);
      const init = initialDataOf({ flue } as Harness);
      // MODEL_CLASSIFIER is blank in a test home, so the classifier fails upward.
      expect(init.classification.tier_final).toBe('strong');
      expect(init.preflight_warnings).toContainEqual({ step: 'identity', message: 'no ids in request' });
      const run = await runtime.runStore.getRun(RUN_ID);
      expect(run?.phase).toBe('completed');
    } finally {
      home.cleanup();
    }
  });
});

// ------------------------------------------------------------------ questions for the requester

describe('needs_input and answerRun', () => {
  const question = () => sampleInputRequest('q1');

  /** A stored run parked on q1, the way ask_requester leaves it. */
  async function parked(h: Harness): Promise<void> {
    await h.store.createRun(RUN_ID, redactPersisted(prepared().request, { names: [NAME] }));
    await h.store.addSubmission(RUN_ID, redactPersisted({ kind: 'initial' as const }));
    await h.store.putInputRequest(RUN_ID, redactPersisted(question()));
  }

  test('a response that ended on ask_requester settles as needs_input: phase kept, nothing embedded', async () => {
    // The tool runs during the read, after the phase went to investigating.
    let h!: Harness;
    h = harness({
      read: async () => {
        await h.store.putInputRequest(RUN_ID, redactPersisted(question()));
        return { text: 'waiting', submissionId: 'sub-1', data: {} };
      },
    });
    const result = await runSubmission(prepared(), h.deps);
    expect(result.status).toBe('needs_input');
    expect(result.input_request?.question_id).toBe('q1');
    expect(result.gaps).toEqual([]);
    expect(h.events).not.toContain('embedRun');
    expect(h.events).not.toContain('phase:completed');
    expect(h.events).not.toContain('phase:failed');
    const run = await h.store.getRun(RUN_ID);
    expect(run?.phase).toBe('needs_input');
    expect(run?.report).toBeNull();
  });

  test('answerRun closes the question, records an answer submission and resumes the run with a signal', async () => {
    const h = harness();
    await parked(h);
    const result = await answerRun(RUN_ID, { answer: 'the one on 3 Sep for 12,000', by: 'ops-reviewer' }, h.deps);
    expect(result.status).toBe('completed');
    expect(result.submission_seq).toBe(2);
    const run = await h.store.getRun(RUN_ID);
    expect(run?.phase).toBe('completed');
    expect(run?.input_request).toBeNull();
    expect(run?.input_history.map((r) => [r.question_id, r.status, r.resolved_by])).toEqual([['q1', 'answered', 'ops-reviewer']]);
    expect(run?.submissions[1]).toMatchObject({ kind: 'answer', question_id: 'q1', answer: 'the one on 3 Sep for 12,000' });
    expect(h.flue.inits[0]?.options).toEqual({ id: RUN_ID });
    const d = h.flue.dispatches[0]!;
    expect(d.keys).not.toContain('initialData');
    const msg = d.message as { kind: string; type: string; body: string; attributes: Record<string, string> };
    expect(msg.kind).toBe('signal');
    expect(msg.type).toBe(INPUT_ANSWER_SIGNAL);
    expect(msg.attributes).toEqual({ question_id: 'q1' });
    expect(msg.body).toContain('Answer from ops-reviewer to your question q1');
    expect(msg.body).toContain('the one on 3 Sep for 12,000');
    expect(h.events.filter((e) => e === 'embedRun')).toHaveLength(1);
  });

  test('a skip resumes the run without an answer and says so', async () => {
    const h = harness();
    await parked(h);
    const result = await answerRun(RUN_ID, { skip: true, by: 'ops-reviewer' }, h.deps);
    expect(result.status).toBe('completed');
    const run = await h.store.getRun(RUN_ID);
    expect(run?.input_history[0]?.status).toBe('skipped');
    expect(run?.submissions[1]).toMatchObject({ kind: 'answer', question_id: 'q1' });
    expect(run?.submissions[1]?.answer).toBeUndefined();
    const body = bodyOf(h);
    expect(body).toContain('skipped your question q1');
    expect(body).toContain('list the open question under gaps');
  });

  test('refuses a run that is not waiting, another question, an unknown run and bad input, dispatching nothing', async () => {
    const h = harness();
    await expect(answerRun(RUN_ID, { answer: 'x', by: 'ops' }, h.deps)).rejects.toBeInstanceOf(RunNotFoundError);
    await parked(h);
    await expect(answerRun(RUN_ID, { question_id: 'q2', answer: 'x', by: 'ops' }, h.deps)).rejects.toBeInstanceOf(RunNotWaitingError);
    await expect(answerRun(RUN_ID, { answer: '  ', by: 'ops' }, h.deps)).rejects.toBeInstanceOf(IngressInputError);
    await expect(answerRun(RUN_ID, { answer: 'x', skip: true, by: 'ops' }, h.deps)).rejects.toBeInstanceOf(IngressInputError);
    await expect(answerRun(RUN_ID, { answer: 'x', by: ' ' }, h.deps)).rejects.toBeInstanceOf(IngressInputError);
    await expect(answerRun(RUN_ID, { question_id: 'first', answer: 'x', by: 'ops' }, h.deps)).rejects.toBeInstanceOf(IngressInputError);
    await expect(answerRun('not a run id!', { answer: 'x', by: 'ops' }, h.deps)).rejects.toBeInstanceOf(IngressInputError);
    expect(h.flue.dispatches).toHaveLength(0);
    expect((await h.store.getRun(RUN_ID))?.input_request?.question_id).toBe('q1');
    // Once answered, a second answer finds nothing to answer.
    await answerRun(RUN_ID, { answer: 'x', by: 'ops' }, h.deps);
    await expect(answerRun(RUN_ID, { answer: 'again', by: 'ops' }, h.deps)).rejects.toBeInstanceOf(RunNotWaitingError);
    expect(h.flue.dispatches).toHaveLength(1);
  });

  test('ids go through the identity step and ride in the signal, verified; the stored copy is masked', async () => {
    const seen: unknown[] = [];
    const chain: IdChain = {
      ids: { customer_id: 'cust-answer-1', account_number: ACCOUNT },
      hops: [{ from: 'customer_id', to: 'account_number', source: 'ssfb:rhythm.customer_account_mappings', status: 'resolved', taken_at: NOW.toISOString() }],
      basic_state: [],
    };
    const h = harness({
      identity: async (...args: unknown[]) => {
        seen.push(args[0]);
        return { id_chain: chain, basic_state: [], gaps: ['identity lookup unreachable: ssfb:harbor'] };
      },
    });
    await parked(h);
    const result = await answerRun(
      RUN_ID,
      { answer: `it is the account ${ACCOUNT}`, ids: { customer_id: 'cust-answer-1' }, by: 'ops' },
      h.deps,
    );
    expect(result.status).toBe('completed');
    expect(seen).toEqual([{ request_id: RUN_ID, interface: 'cli', messages: [], hints: { ids: { customer_id: 'cust-answer-1' } } }]);
    const msg = h.flue.dispatches[0]!.message as { body: string; attributes: Record<string, string> };
    expect(JSON.parse(msg.attributes[INPUT_ANSWER_CHAIN_ATTR]!)).toEqual(chain);
    expect(msg.attributes.question_id).toBe('q1');
    expect(msg.body).toContain('customer_id = cust-answer-1');
    expect(msg.body).toContain(`account_number = ${ACCOUNT}`);
    expect(msg.body).toContain('Identity lookups: identity lookup unreachable: ssfb:harbor');
    // The model sees the account number; the run store never does.
    expect(msg.body).toContain(ACCOUNT);
    expect(JSON.stringify(await h.store.getRun(RUN_ID))).not.toContain(ACCOUNT);

    // An identity step that cannot run leaves an empty chain and a gap; a loud one is passed on.
    const g = harness({
      identity: async () => {
        throw new Error('boom');
      },
    });
    await parked(g);
    await answerRun(RUN_ID, { answer: 'x', ids: { customer_id: 'c-2' }, by: 'ops' }, g.deps);
    const gm = g.flue.dispatches[0]!.message as { body: string; attributes: Record<string, string> };
    expect(JSON.parse(gm.attributes[INPUT_ANSWER_CHAIN_ATTR]!)).toEqual({ ids: {}, hops: [], basic_state: [] });
    expect(gm.body).toContain('identity step did not run (Error)');

    // Without an identity step in the deps, ids cannot be verified.
    const n = harness();
    await parked(n);
    const { identity: _identity, ...noIdentity } = n.deps;
    await expect(answerRun(RUN_ID, { answer: 'x', ids: { customer_id: 'c' }, by: 'ops' }, noIdentity)).rejects.toBeInstanceOf(SubmissionInputError);
    expect(n.flue.dispatches).toHaveLength(0);
  });
});

// ------------------------------------------------------------------ stop

describe('a stop from another process', () => {
  const cancel = () => redactPersisted({ status: 'cancelled' as const, resolved_at: NOW.toISOString(), resolved_by: 'ops' });
  const stop = (store: RunStore) => store.markStopped(RUN_ID, 'cancelled', cancel());
  /** A read that waits until its signal aborts. */
  const readUntilAborted: ReadBehaviour = (signal) =>
    new Promise((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted'))));

  test('a stop that lands during a step ends the run before dispatch at the next phase write', async () => {
    let store: RunStore | undefined;
    const h = harness({
      stopPollMs: 0,
      identity: async () => {
        await stop(store!);
        return { id_chain: CHAIN, basic_state: [], gaps: [] };
      },
    });
    store = h.store;
    await expect(runSubmission(prepared(), h.deps)).rejects.toBeInstanceOf(RunStoppedError);
    expect(h.flue.dispatches).toHaveLength(0);
    expect(h.events).not.toContain('classify');
    const run = await h.store.getRun(RUN_ID);
    expect(run?.phase).toBe('stopped');
    expect(run?.phase_reason).toBe('cancelled');
  });

  test('the watcher aborts a step that is still running', async () => {
    let store: RunStore | undefined;
    const h = harness({
      stopPollMs: 5,
      identity: (_request: unknown, { signal }: { signal: AbortSignal }) => {
        setTimeout(() => void stop(store!), 1);
        return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
      },
    } as HarnessOptions);
    store = h.store;
    await expect(runSubmission(prepared(), h.deps)).rejects.toBeInstanceOf(RunStoppedError);
    expect(h.flue.dispatches).toHaveLength(0);
    expect((await h.store.getRun(RUN_ID))?.phase).toBe('stopped');
  });

  test('after dispatch the watcher aborts the read and the Flue instance; nothing is embedded', async () => {
    const h = harness({
      stopPollMs: 5,
      read: readUntilAborted,
      onDispatch: async (store) => {
        setTimeout(() => void stop(store), 20);
      },
    });
    const result = await runSubmission(prepared(), h.deps);
    expect(result.status).toBe('stopped');
    expect(result.error).toBeUndefined();
    expect(h.flue.aborts).toBe(1);
    expect(h.spies.embedRun).toHaveLength(0);
    expect((await h.store.getRun(RUN_ID))?.phase).toBe('stopped');
  });

  test('a stop between the dispatch and the investigating write aborts at once', async () => {
    const h = harness({ stopPollMs: 0, read: readUntilAborted, onDispatch: async (store) => void (await stop(store)) });
    const result = await runSubmission(prepared(), h.deps);
    expect(result.status).toBe('stopped');
    expect(h.flue.aborts).toBe(1);
    expect((await h.store.getRun(RUN_ID))?.phase).toBe('stopped');
  });

  test('a read that fails because the agent was aborted elsewhere settles as stopped', async () => {
    let store: RunStore | undefined;
    const h = harness({
      stopPollMs: 0,
      read: async () => {
        await stop(store!);
        throw new AgentRunError({ outcome: 'aborted', submissionId: 'sub-1' });
      },
    });
    store = h.store;
    const result = await runSubmission(prepared(), h.deps);
    expect(result.status).toBe('stopped');
    expect(result.error).toBeUndefined();
    const run = await h.store.getRun(RUN_ID);
    expect(run?.phase).toBe('stopped');
    expect(run?.phase_reason).toBe('cancelled');
  });

  test('a follow-up resumes a stopped run', async () => {
    const h = harness({ stopPollMs: 0 });
    await h.store.createRun(RUN_ID, redactPersisted(prepared().request));
    await stop(h.store);
    const result = await askRun(RUN_ID, 'did the reversal land?', 'ops', h.deps);
    expect(result.status).toBe('completed');
    expect((await h.store.getRun(RUN_ID))?.phase).toBe('completed');
  });
});

// ------------------------------------------------------------------ blocked runs and resumeRun

describe('blocked and resumeRun', () => {
  const RUN_B = '01JSUBMITBBBBBBBBBBBBBBBBB';
  const cancel = () => redactPersisted({ status: 'cancelled' as const, resolved_at: NOW.toISOString(), resolved_by: 'ops' });

  /** A stored run with one submission, the way a dispatched run looks. */
  async function dispatched(h: Harness, runId = RUN_ID): Promise<void> {
    await h.store.createRun(runId, redactPersisted(prepared({ runId }).request, { names: [NAME] }));
    await h.store.addSubmission(runId, redactPersisted({ kind: 'initial' as const }));
  }

  /** A stored run parked on b1, the way stop_blocked leaves it. */
  async function blocked(h: Harness): Promise<void> {
    await dispatched(h);
    await h.store.putBlock(RUN_ID, redactPersisted(sampleBlock('b1')));
  }

  function signalOf(h: Harness, i = 0): { kind: string; type: string; body: string } {
    return h.flue.dispatches[i]!.message as { kind: string; type: string; body: string };
  }

  test('a response that ended on stop_blocked settles as blocked: phase kept, no report, nothing embedded', async () => {
    // The tool runs during the read, after the phase went to investigating.
    let h!: Harness;
    h = harness({
      read: async () => {
        await h.store.putBlock(RUN_ID, redactPersisted(sampleBlock('b1')));
        return { text: 'blocked', submissionId: 'sub-1', data: {} };
      },
    });
    const result = await runSubmission(prepared(), h.deps);
    expect(result.status).toBe('blocked');
    expect(result.block).toEqual(sampleBlock('b1'));
    expect(result.input_request).toBeUndefined();
    expect(result.gaps).toEqual([]);
    expect(h.events).not.toContain('embedRun');
    expect(h.events).not.toContain('phase:completed');
    expect(h.events).not.toContain('phase:failed');
    const run = await h.store.getRun(RUN_ID);
    expect(run?.phase).toBe('blocked');
    expect(run?.block?.block_id).toBe('b1');
    expect(run?.report).toBeNull();
  });

  test('resumeRun repeats the tunnel check first and refuses, with the run as it was, when the tunnel does not come up', async () => {
    const h = harness({ config: { mock: false } });
    await blocked(h);
    const signals: AbortSignal[] = [];
    const warning = {
      step: 'tunnel',
      entity: 'ssfb' as const,
      message: 'SSFB DB tunnel did not start: the bastion is unreachable; the SSFB databases may be unreachable',
      fix: 'triage tunnel status, then triage tunnel up',
    };
    const deps: SettleDeps = {
      ...h.deps,
      resumePreflight: async ({ signal }) => {
        signals.push(signal);
        return { steps: [{ id: 'tunnel', entity: 'ssfb', status: 'warn' }], warnings: [warning] };
      },
    };
    const err = await resumeRun(RUN_ID, { by: 'ops' }, deps).catch((x: unknown) => x);
    expect(err).toBeInstanceOf(ResumeNotReadyError);
    expect(err).toBeInstanceOf(RunNotResumableError);
    expect((err as ResumeNotReadyError).phase).toBe('blocked');
    expect((err as ResumeNotReadyError).hint).toBe(`${warning.message}; ${warning.fix}`);
    expect((err as ResumeNotReadyError).warnings).toEqual([warning]);
    expect(signals).toHaveLength(1);
    expect(h.flue.dispatches).toHaveLength(0);
    const run = await h.store.getRun(RUN_ID);
    expect(run?.phase).toBe('blocked');
    expect(run?.block?.block_id).toBe('b1');
    expect(run?.block_history).toEqual([]);
    expect(run?.submissions).toHaveLength(1);
  });

  test('a clean tunnel check, or a warning from another step, lets the resume go on', async () => {
    const h = harness({ config: { mock: false } });
    await blocked(h);
    const deps: SettleDeps = {
      ...h.deps,
      now: () => NOW,
      resumePreflight: async () => ({
        steps: [{ id: 'tunnel', entity: 'ssfb', status: 'ok' }],
        warnings: [{ step: 'preflight', message: 'the resume check could not finish; the run continues without it' }],
      }),
    };
    const result = await resumeRun(RUN_ID, { by: 'ops' }, deps);
    expect(result.status).toBe('completed');
    expect(h.flue.dispatches).toHaveLength(1);
    expect((await h.store.getRun(RUN_ID))?.block).toBeNull();
  });

  test('mock mode never runs the resume check', async () => {
    const h = harness();
    await blocked(h);
    let calls = 0;
    const deps: SettleDeps = {
      ...h.deps,
      resumePreflight: async () => {
        calls += 1;
        return { steps: [], warnings: [{ step: 'tunnel', message: 'down' }] };
      },
    };
    const result = await resumeRun(RUN_ID, { by: 'ops' }, deps);
    expect(calls).toBe(0);
    expect(result.status).toBe('completed');
  });

  test('resumeRun closes the block as resumed, records a resume submission and sends the run on with a signal', async () => {
    const h = harness();
    await blocked(h);
    const result = await resumeRun(RUN_ID, { by: 'ops-reviewer', note: 'harbor is back' }, { ...h.deps, now: () => NOW });
    expect(result).toMatchObject({ run_id: RUN_ID, status: 'completed', submission_seq: 2, submission_id: 'sub-1', reply_text: 'done' });
    expect(result.block).toBeUndefined();

    const run = await h.store.getRun(RUN_ID);
    expect(run?.phase).toBe('completed');
    expect(run?.block).toBeNull();
    expect(run?.block_history).toEqual([
      { ...sampleBlock('b1'), status: 'resumed', resolved_at: NOW.toISOString(), resolved_by: 'ops-reviewer', note: 'harbor is back' },
    ]);
    expect(run?.submissions.map((s) => s.kind)).toEqual(['initial', 'resume']);
    expect(run?.submissions[1]).toMatchObject({ kind: 'resume', block_id: 'b1', note: 'harbor is back' });

    // The same instance, no initialData, and the resume signal.
    expect(h.flue.inits[0]?.options).toEqual({ id: RUN_ID });
    expect(h.flue.dispatches[0]?.keys).toEqual(['message']);
    const msg = signalOf(h);
    expect(msg.kind).toBe('signal');
    expect(msg.type).toBe(BLOCK_RESUME_SIGNAL);
    expect(msg.body).toContain('This run was blocked (b1) because ssfb:harbor did not answer');
    expect(msg.body).toContain(`ops-reviewer resumed it at ${NOW.toISOString()}.`);
    expect(msg.body).toContain('Message from ops-reviewer:\nharbor is back');
    expect(msg.body).toContain('finish_report');
    expect(msg.body).toContain('stop_blocked');
    expect(h.events.filter((e) => e.startsWith('phase:'))).toEqual(['phase:dispatched', 'phase:investigating', 'phase:completed']);
    expect(h.events.filter((e) => e === 'embedRun')).toHaveLength(1);
  });

  test('the note is model-facing in the signal and persisted-profile in the store; a blank note is left out', async () => {
    const h = harness();
    await blocked(h);
    await resumeRun(RUN_ID, { by: 'ops', note: `  harbor is back for ${PHONE}; card ${PAN} was the test card  ` }, h.deps);
    const body = signalOf(h).body;
    expect(body).toContain(`harbor is back for ${PHONE}`);
    expect(body).not.toContain(PAN);
    const run = await h.store.getRun(RUN_ID);
    const stored = JSON.stringify([run?.submissions[1]?.note, run?.block_history[0]?.note]);
    expect(stored).toContain('harbor is back for');
    expect(stored).not.toContain(PHONE);
    expect(stored).not.toContain(PAN);

    const g = harness();
    await blocked(g);
    await resumeRun(RUN_ID, { by: 'ops', note: '   ' }, g.deps);
    const again = await g.store.getRun(RUN_ID);
    expect(again?.submissions[1]?.note).toBeUndefined();
    expect(again?.block_history[0]?.note).toBeUndefined();
    expect(signalOf(g).body).not.toContain('Message from');
  });

  test('a resume that blocks again settles as blocked on the new block, with the first one in the history', async () => {
    let h!: Harness;
    h = harness({
      read: async () => {
        await h.store.putBlock(RUN_ID, redactPersisted({ ...sampleBlock('b2', ['atspl:core']), submission_seq: 2 }));
        return { text: 'blocked again', submissionId: 'sub-1', data: {} };
      },
    });
    await blocked(h);
    const result = await resumeRun(RUN_ID, { by: 'ops' }, h.deps);
    expect(result.status).toBe('blocked');
    expect(result.block?.block_id).toBe('b2');
    expect(result.block?.systems).toEqual(['atspl:core']);
    const run = await h.store.getRun(RUN_ID);
    expect(run?.phase).toBe('blocked');
    expect(run?.block_history.map((b) => [b.block_id, b.status])).toEqual([['b1', 'resumed']]);
    expect(h.events).not.toContain('embedRun');
  });

  test('a run that failed after dispatch is resumed and told so', async () => {
    const h = harness();
    await dispatched(h);
    await h.store.setPhase(RUN_ID, 'failed', { reason: 'AgentRunError' });
    const result = await resumeRun(RUN_ID, { by: 'ops' }, h.deps);
    expect(result.status).toBe('completed');
    expect(signalOf(h).body).toContain('This run failed (AgentRunError) before it finished.');
    const run = await h.store.getRun(RUN_ID);
    expect(run?.phase).toBe('completed');
    expect(run?.submissions[1]).toMatchObject({ kind: 'resume', seq: 2 });
    expect(run?.submissions[1]?.block_id).toBeUndefined();
    expect(run?.block_history).toEqual([]);
  });

  test('a stopped run is resumed, its cancelled block left in the history', async () => {
    const h = harness({ stopPollMs: 0 });
    await blocked(h);
    await h.store.markStopped(RUN_ID, 'cancelled', cancel());
    const result = await resumeRun(RUN_ID, { by: 'ops' }, h.deps);
    expect(result.status).toBe('completed');
    const body = signalOf(h).body;
    expect(body).toContain('This run was stopped before it finished.');
    expect(body).not.toContain('was blocked');
    const run = await h.store.getRun(RUN_ID);
    expect(run?.phase).toBe('completed');
    expect(run?.block_history.map((b) => [b.block_id, b.status])).toEqual([['b1', 'cancelled']]);
    expect(run?.submissions[1]?.block_id).toBeUndefined();
  });

  test('refuses an unknown run, a working run, a question, a finished run and a run that never started, dispatching nothing', async () => {
    const h = harness();
    await expect(resumeRun(RUN_ID, { by: 'ops' }, h.deps)).rejects.toBeInstanceOf(RunNotFoundError);

    const refusal = async (runId = RUN_ID): Promise<RunNotResumableError> => {
      const err = await resumeRun(runId, { by: 'ops' }, h.deps).catch((x: unknown) => x);
      expect(err).toBeInstanceOf(RunNotResumableError);
      return err as RunNotResumableError;
    };

    await h.store.createRun(RUN_ID, redactPersisted(prepared().request));
    expect(await refusal()).toMatchObject({ runId: RUN_ID, phase: 'created', hint: RESUME_HINTS.running });
    // Failed before dispatch: no conversation to continue.
    await h.store.setPhase(RUN_ID, 'failed', { reason: 'FixtureMissError' });
    expect(await refusal()).toMatchObject({ phase: 'failed', hint: RESUME_HINTS.never_started });
    await h.store.addSubmission(RUN_ID, redactPersisted({ kind: 'initial' as const }));
    await h.store.setPhase(RUN_ID, 'investigating');
    expect(await refusal()).toMatchObject({ phase: 'investigating', hint: RESUME_HINTS.running });
    await h.store.putInputRequest(RUN_ID, redactPersisted(sampleInputRequest('q1')));
    expect(await refusal()).toMatchObject({ phase: 'needs_input', hint: RESUME_HINTS.needs_input });
    await h.store.resolveInputRequest(RUN_ID, 'q1', redactPersisted({ status: 'skipped' as const, resolved_at: NOW.toISOString(), resolved_by: 'ops' }));
    await h.store.setPhase(RUN_ID, 'completed');
    expect(await refusal()).toMatchObject({ phase: 'completed', hint: RESUME_HINTS.completed });
    expect((await refusal()).message).toContain(RESUME_HINTS.completed);

    // Stopped before dispatch: no conversation either.
    await h.store.createRun(RUN_B, redactPersisted(prepared({ runId: RUN_B }).request));
    await h.store.markStopped(RUN_B, 'cancelled', cancel());
    expect(await refusal(RUN_B)).toMatchObject({ phase: 'stopped', hint: RESUME_HINTS.never_started });

    expect(h.flue.dispatches).toHaveLength(0);
    expect((await h.store.getRun(RUN_ID))?.phase).toBe('completed');
  });

  test('bad input is refused before the store is read', async () => {
    const h = harness();
    await blocked(h);
    await expect(resumeRun('not a run id!', { by: 'ops' }, h.deps)).rejects.toBeInstanceOf(IngressInputError);
    await expect(resumeRun(RUN_ID, { by: '  ' }, h.deps)).rejects.toBeInstanceOf(IngressInputError);
    await expect(resumeRun(RUN_ID, { by: 'ops', note: 'x'.repeat(MAX_RESUME_NOTE_CHARS + 1) }, h.deps)).rejects.toBeInstanceOf(IngressInputError);
    expect(h.flue.dispatches).toHaveLength(0);
    expect((await h.store.getRun(RUN_ID))?.block?.block_id).toBe('b1');
  });

  test('the step log gets a blocked line at the settle and a resume line on the resume', async () => {
    const runsDir = mkdtempSync(join(tmpdir(), 'triage-submit-log-'));
    dirs.push(runsDir);
    // No Flue events here: the subscriber is a no-op.
    installRunEventLog({ runsDir, observe: () => () => undefined });
    try {
      let h!: Harness;
      h = harness({
        read: async () => {
          if (h.flue.reads.length === 1) await h.store.putBlock(RUN_ID, redactPersisted(sampleBlock('b1')));
          return { text: 'done', submissionId: 'sub-1', data: {} };
        },
      });
      expect((await runSubmission(prepared(), h.deps)).status).toBe('blocked');
      expect((await resumeRun(RUN_ID, { by: 'ops', note: 'harbor is back' }, h.deps)).status).toBe('completed');
      await flushRunEventLog();
      const { events } = await readRunEvents(runsDir, RUN_ID);
      const pipeline = events.filter((e) => e.source === 'pipeline').map((e) => [e.type, e.data]);
      expect(pipeline).toContainEqual(['blocked', { submission_seq: 1, block_id: 'b1', systems: ['ssfb:harbor'] }]);
      expect(pipeline).toContainEqual(['resume', { kind: 'resume', from: 'blocked', block_id: 'b1', by: 'ops', note: 'harbor is back' }]);
      const settled = events.filter((e) => e.type === 'settled').map((e) => (e.data as { status: string }).status);
      expect(settled).toEqual(['blocked', 'completed']);
    } finally {
      await flushRunEventLog();
      uninstallRunEventLog();
    }
  });
});

// ------------------------------------------------------------------ usage (D59)

describe('usage', () => {
  const HAIKU = 'anthropic/claude-haiku-4-5-20251001';
  const RUN_2 = '01JSUBMITCCCCCCCCCCCCCCCCC';
  const cancel = () => redactPersisted({ status: 'cancelled' as const, resolved_at: NOW.toISOString(), resolved_by: 'ops' });
  const stop = (store: RunStore) => store.markStopped(RUN_ID, 'cancelled', cancel());

  let runsDir = '';
  beforeEach(() => {
    resetUsageMeterForTests();
    runsDir = mkdtempSync(join(tmpdir(), 'triage-submit-usage-'));
    dirs.push(runsDir);
    installRunEventLog({ runsDir, observe: () => () => undefined });
  });
  afterEach(async () => {
    await flushRunEventLog();
    uninstallRunEventLog();
    resetUsageMeterForTests();
  });

  async function pipeline(runId = RUN_ID): Promise<[string, unknown][]> {
    await flushRunEventLog();
    const { events } = await readRunEvents(runsDir, runId);
    return events.filter((e) => e.source === 'pipeline').map((e) => [e.type, e.data]);
  }

  function turn(over: Partial<UsageEvent> = {}): UsageEvent {
    return { model: 'faux/cheap', agent: 'triage', purpose: 'agent', isError: false, input: 10, output: 5, cacheRead: 0, cacheWrite: 0, ...over };
  }
  /** One model turn of a Flue submission, the way the meter counts it. */
  const countTurn = (over: Partial<UsageEvent> = {}, submissionId = 'sub-1', runId = RUN_ID) =>
    recordUsage(runId, { submissionId }, turn(over));

  const triageRow = (calls: number, over: Partial<UsageRow> = {}): UsageRow => ({
    model: 'faux/cheap',
    agent: 'triage',
    purpose: 'agent',
    calls,
    failed_calls: 0,
    input_tokens: 10 * calls,
    output_tokens: 5 * calls,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    usd: 0,
    ...over,
  });

  /** A classifier stub that reports one completion call. */
  const classifyWithUsage: SubmissionDeps['classify'] = async (_input, _signal, onUsage) => {
    onUsage?.({ path: 'completion', model: HAIKU, failed: false, input: 1000, output: 200, cacheRead: 50, cacheWrite: 0 });
    return goodClassification();
  };

  type UsageWrite = { readonly seq: number; readonly final: boolean; readonly rows: readonly UsageRow[] };

  /** The deps with putUsage recorded, and optionally held or failed per call. */
  function spyUsage(
    h: Harness,
    opts: { fail?: (n: number) => Error | undefined; hold?: (n: number) => Promise<void> | undefined } = {},
  ): { deps: SubmissionDeps; writes: UsageWrite[]; settled: () => Promise<void> } {
    const writes: UsageWrite[] = [];
    const pending: Promise<unknown>[] = [];
    const inner = h.deps.store;
    const putUsage: RunStore['putUsage'] = (runId, seq, rows, final) => {
      const n = writes.length;
      writes.push({ seq, final, rows });
      const p = (async () => {
        await opts.hold?.(n);
        const err = opts.fail?.(n);
        if (err !== undefined) throw err;
        await inner.putUsage(runId, seq, rows, final);
      })();
      pending.push(p.catch(() => undefined));
      return p;
    };
    const store = new Proxy(inner, { get: (t, prop) => (prop === 'putUsage' ? putUsage : Reflect.get(t, prop, t)) });
    const settled = async (): Promise<void> => {
      let seen = -1;
      while (seen !== pending.length) {
        seen = pending.length;
        await Promise.all(pending);
        await new Promise((resolve) => setImmediate(resolve));
      }
    };
    return { deps: { ...h.deps, store }, writes, settled };
  }

  /** A timer the test ticks by hand. Cancelled ticks stay callable, to show a late tick does nothing. */
  function manualTimer(): { timer: UsageFlushTimer; tick: () => void; ms: number[]; cancelled: () => number } {
    const ticks: (() => void)[] = [];
    const ms: number[] = [];
    let cancelled = 0;
    return {
      timer: (tick, every) => {
        ticks.push(tick);
        ms.push(every);
        return () => {
          cancelled += 1;
        };
      },
      tick: () => {
        for (const t of ticks) t();
      },
      ms,
      cancelled: () => cancelled,
    };
  }

  class StoreDown extends Error {}

  // ---------------------------------------------------------------- intake

  test('the classifier call is written as seq 0, final, before the dispatch, and then forgotten', async () => {
    const h = harness({ classify: classifyWithUsage });
    await runSubmission(prepared(), h.deps);
    const run = await h.store.getRun(RUN_ID);
    const tokens = { input: 1000, output: 200, cacheRead: 50, cacheWrite: 0 };
    expect(run?.usage).toEqual([
      {
        seq: 0,
        final: true,
        updated_at: expect.any(String),
        rows: [
          {
            model: HAIKU,
            agent: 'classifier',
            purpose: 'classify',
            calls: 1,
            failed_calls: 0,
            input_tokens: 1000,
            output_tokens: 200,
            cache_read_tokens: 50,
            cache_write_tokens: 0,
            usd: priceUsage(HAIKU, tokens, 'classify'),
          },
        ],
      },
    ]);
    expect(h.events.indexOf('putUsage')).toBeGreaterThan(-1);
    expect(h.events.indexOf('putUsage')).toBeLessThan(h.events.indexOf('dispatch'));
    expect(snapshotIntake(RUN_ID)).toEqual([]);
  });

  test('a decision-model classifier is charged the cost the provider reported, or left unpriced', async () => {
    const spec = 'openrouter/typesafe/jev-1.13';
    const decision =
      (reportedUsd?: number): SubmissionDeps['classify'] =>
      async (_input, _signal, onUsage) => {
        onUsage?.({ path: 'decision', model: spec, failed: false, input: 300, output: 40, cacheRead: 0, cacheWrite: 0, ...(reportedUsd !== undefined ? { reportedUsd } : {}) });
        return goodClassification();
      };
    const priced = harness({ classify: decision(0.0042) });
    await runSubmission(prepared(), priced.deps);
    expect((await priced.store.getRun(RUN_ID))?.usage[0]?.rows[0]).toMatchObject({ model: spec, agent: 'classifier', usd: 0.0042 });

    const unpriced = harness({ classify: decision() });
    await runSubmission(prepared({ runId: RUN_2 }), unpriced.deps);
    expect((await unpriced.store.getRun(RUN_2))?.usage[0]?.rows[0]).toMatchObject({ model: spec, input_tokens: 300, usd: null });
  });

  test('a failure between the classifier and the dispatch still writes seq 0', async () => {
    const h = harness({ classify: classifyWithUsage });
    const deps: SubmissionDeps = {
      ...h.deps,
      policy: () => {
        throw new Error('policy broke');
      },
    };
    await expect(runSubmission(prepared(), deps)).rejects.toThrow('policy broke');
    const run = await h.store.getRun(RUN_ID);
    expect(run?.phase).toBe('failed');
    expect(run?.usage.map((u) => [u.seq, u.final, u.rows.map((r) => r.agent)])).toEqual([[0, true, ['classifier']]]);
    expect(h.flue.dispatches).toHaveLength(0);
  });

  test('a stop during the prior-cases lookup still writes seq 0, with the mock embedding marked fake', async () => {
    let store!: RunStore;
    const h = harness({
      stopPollMs: 5,
      config: { priorCases: true },
      classify: classifyWithUsage,
      embedder: { model: HASH_MODEL, embed: async () => [] },
      priorCases: (_runId, signal, onUsage) => {
        onUsage?.({ model: 'ollama/nomic-embed-text', inputTokens: 0, failed: false });
        setTimeout(() => void stop(store), 1);
        return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
      },
    });
    store = h.store;
    await expect(runSubmission(prepared(), h.deps)).rejects.toBeInstanceOf(RunStoppedError);
    const run = await h.store.getRun(RUN_ID);
    expect(run?.phase).toBe('stopped');
    expect(run?.usage).toHaveLength(1);
    const rows = run?.usage[0]?.rows ?? [];
    expect(run?.usage[0]).toMatchObject({ seq: 0, final: true });
    expect(rows.map((r) => [r.model, r.agent, r.purpose, r.calls, r.usd])).toEqual([
      [HAIKU, 'classifier', 'classify', 1, expect.any(Number)],
      [HASH_USAGE_MODEL, 'embedder', 'embed', 1, 0],
    ]);
  });

  test('a real embedder keeps its MODEL_EMBEDDING spec, and a missing token count is logged as usage_missing', async () => {
    const spec = 'openai/text-embedding-3-small';
    const h = harness({
      config: { priorCases: true },
      embedder: { model: spec, embed: async () => [] },
      priorCases: async (_runId, _signal, onUsage) => {
        onUsage?.({ model: spec, inputTokens: 12, failed: false });
        onUsage?.({ model: spec, inputTokens: 0, failed: false, usageMissing: true });
        return { cases: [], gaps: [] };
      },
    });
    await runSubmission(prepared(), h.deps);
    const rows = (await h.store.getRun(RUN_ID))?.usage[0]?.rows ?? [];
    expect(rows).toEqual([
      {
        model: spec,
        agent: 'embedder',
        purpose: 'embed',
        calls: 2,
        failed_calls: 0,
        input_tokens: 12,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        usd: priceUsage(spec, { input: 12, output: 0, cacheRead: 0, cacheWrite: 0 }, 'embed'),
      },
    ]);
    expect(await pipeline()).toContainEqual(['usage_missing', { submission_seq: 0, agent: 'embedder', calls: 1 }]);
  });

  // ---------------------------------------------------------------- settle

  const statuses: [string, (h: Harness) => ReadBehaviour][] = [
    ['completed', () => async () => {
      countTurn();
      return { text: 'done', submissionId: 'sub-1', data: {} };
    }],
    ['failed', () => async () => {
      countTurn();
      throw new AgentRunError({ outcome: 'failed', submissionId: 'sub-1' });
    }],
    ['stopped', (h) => async () => {
      countTurn();
      await stop(h.store);
      throw new AgentRunError({ outcome: 'aborted', submissionId: 'sub-1' });
    }],
    ['needs_input', (h) => async () => {
      countTurn();
      await h.store.putInputRequest(RUN_ID, redactPersisted(sampleInputRequest('q1')));
      return { text: 'waiting', submissionId: 'sub-1', data: {} };
    }],
    ['blocked', (h) => async () => {
      countTurn();
      await h.store.putBlock(RUN_ID, redactPersisted(sampleBlock('b1')));
      return { text: 'parked', submissionId: 'sub-1', data: {} };
    }],
  ];
  for (const [status, read] of statuses) {
    test(`a ${status} settle writes the submission's rows final on its seq and forgets them`, async () => {
      let h!: Harness;
      h = harness({ stopPollMs: 0, read: (signal) => read(h)(signal) });
      const result = await runSubmission(prepared(), h.deps);
      expect(result.status).toBe(status as typeof result.status);
      const run = await h.store.getRun(RUN_ID);
      expect(run?.usage).toEqual([{ seq: 1, final: true, updated_at: expect.any(String), rows: [triageRow(1)] }]);
      expect(snapshotSubmission(RUN_ID, 'sub-1')).toEqual([]);
    });
  }

  test('the embedding after the settle is counted on the same seq and the rows are written final again, once each', async () => {
    const h = harness({
      read: async () => {
        countTurn();
        return { text: 'done', submissionId: 'sub-1', data: {} };
      },
      embedRun: async (_store, _embedder, _runId, options) => {
        h.events.push('embedRun');
        options?.onUsage?.({ model: 'test/embed', inputTokens: 30, failed: false });
        return { written: ['case'], unchanged: [], empty: [], gaps: [] };
      },
    });
    const spy = spyUsage(h);
    await runSubmission(prepared(), spy.deps);
    const embedder = { ...triageRow(1), model: 'test/embed', agent: 'embedder', purpose: 'embed' as const, input_tokens: 30, output_tokens: 0, usd: null };
    expect(spy.writes).toEqual([
      { seq: 1, final: true, rows: [triageRow(1)] },
      { seq: 1, final: true, rows: [triageRow(1), embedder] },
    ]);
    const settle = h.events.filter((e) => e === 'putUsage' || e === 'embedRun');
    expect(settle).toEqual(['putUsage', 'embedRun', 'putUsage']);
    // Final replaces final: one set, not two.
    expect((await h.store.getRun(RUN_ID))?.usage).toEqual([{ seq: 1, final: true, updated_at: expect.any(String), rows: [triageRow(1), embedder] }]);
  });

  test('the mock hash embedder after the settle is recorded as a faux model', async () => {
    const h = harness({
      embedder: { model: HASH_MODEL, embed: async () => [] },
      read: async () => {
        countTurn();
        return { text: 'done', submissionId: 'sub-1', data: {} };
      },
      embedRun: async (_store, _embedder, _runId, options) => {
        options?.onUsage?.({ model: 'ollama/nomic-embed-text', inputTokens: 0, failed: false });
        return { written: ['case'], unchanged: [], empty: [], gaps: [] };
      },
    });
    await runSubmission(prepared(), h.deps);
    const rows = (await h.store.getRun(RUN_ID))?.usage[0]?.rows ?? [];
    expect(rows.map((r) => [r.model, r.agent, r.usd])).toEqual([
      ['faux/cheap', 'triage', 0],
      [HASH_USAGE_MODEL, 'embedder', 0],
    ]);
  });

  test('a usage write that fails is logged by class name only and never changes the status', async () => {
    const h = harness({
      classify: classifyWithUsage,
      read: async () => {
        countTurn();
        return { text: 'done', submissionId: 'sub-1', data: {} };
      },
    });
    const spy = spyUsage(h, { fail: () => new StoreDown('connection to the secret host dropped') });
    const result = await runSubmission(prepared(), spy.deps);
    expect(result.status).toBe('completed');
    const run = await h.store.getRun(RUN_ID);
    expect(run?.phase).toBe('completed');
    expect(run?.usage).toEqual([]);
    const events = await pipeline();
    expect(events).toContainEqual(['usage_write_failed', { submission_seq: 0, final: true, error: 'StoreDown' }]);
    expect(events).toContainEqual(['usage_write_failed', { submission_seq: 1, final: true, error: 'StoreDown' }]);
    expect(JSON.stringify(events)).not.toContain('secret host');
  });

  test('a caller abort writes what is counted so far, not final, and keeps it in memory', async () => {
    const ctrl = new AbortController();
    const h = harness({
      signal: ctrl.signal,
      read: (signal) =>
        new Promise((_, reject) => {
          countTurn();
          signal?.addEventListener('abort', () => reject(signal.reason));
          ctrl.abort(new Error('caller went away'));
        }),
    });
    const spy = spyUsage(h);
    await expect(runSubmission(prepared(), spy.deps)).rejects.toThrow('caller went away');
    expect(spy.writes).toEqual([{ seq: 1, final: false, rows: [triageRow(1)] }]);
    expect((await h.store.getRun(RUN_ID))?.usage).toEqual([{ seq: 1, final: false, updated_at: expect.any(String), rows: [triageRow(1)] }]);
    // The run goes on in this process; report.cost still reads these.
    expect(snapshotSubmission(RUN_ID, 'sub-1')).toEqual([triageRow(1)]);
  });

  test('turns without a submission id are logged as usage_unassigned, counts only, and not stored', async () => {
    let emit!: (o: unknown, ctx: unknown) => void;
    installUsageMeter({
      observe: (subscriber) => {
        emit = subscriber as typeof emit;
        return () => undefined;
      },
    });
    const h = harness({
      read: async () => {
        emit(
          {
            type: 'turn',
            instanceId: RUN_ID,
            request: { providerId: 'faux', requestedModel: 'cheap' },
            response: { usage: { input: 3, output: 2, cacheRead: 1, cacheWrite: 0 } },
          },
          { id: RUN_ID },
        );
        return { text: 'done', submissionId: 'sub-1', data: {} };
      },
    });
    await runSubmission(prepared(), h.deps);
    expect(await pipeline()).toContainEqual(['usage_unassigned', { rows: 1, calls: 1, tokens: 6 }]);
    expect((await h.store.getRun(RUN_ID))?.usage).toEqual([]);
  });

  test('a follow-up gets its own seq and leaves the first one as it was', async () => {
    const h = harness({
      read: async () => {
        countTurn({}, `sub-${h.flue.dispatches.length}`);
        return { text: 'done', submissionId: `sub-${h.flue.dispatches.length}`, data: {} };
      },
    });
    await runSubmission(prepared(), h.deps);
    await askRun(RUN_ID, 'did the reversal land?', 'ops', h.deps);
    const usage = (await h.store.getRun(RUN_ID))?.usage ?? [];
    expect(usage.map((u) => [u.seq, u.final, u.rows])).toEqual([
      [1, true, [triageRow(1)]],
      [2, true, [triageRow(1)]],
    ]);
  });

  // ---------------------------------------------------------------- live flush

  test('the live flush writes non-final rows when they changed, skips an unchanged tick, and stops at the settle', async () => {
    const m = manualTimer();
    const seen: { writes: number; stored?: unknown }[] = [];
    let spy!: ReturnType<typeof spyUsage>;
    let h!: Harness;
    h = harness({
      config: { usageFlushMs: 5000 },
      usageFlushTimer: m.timer,
      read: async () => {
        m.tick(); // nothing counted yet
        await spy.settled();
        seen.push({ writes: spy.writes.length });
        countTurn();
        m.tick();
        await spy.settled();
        seen.push({ writes: spy.writes.length, stored: (await h.store.getRun(RUN_ID))?.usage });
        m.tick(); // unchanged
        await spy.settled();
        seen.push({ writes: spy.writes.length });
        countTurn();
        m.tick();
        await spy.settled();
        seen.push({ writes: spy.writes.length });
        return { text: 'done', submissionId: 'sub-1', data: {} };
      },
    });
    spy = spyUsage(h);
    const result = await runSubmission(prepared(), spy.deps);
    expect(result.status).toBe('completed');
    expect(seen).toEqual([
      { writes: 0 },
      { writes: 1, stored: [{ seq: 1, final: false, updated_at: expect.any(String), rows: [triageRow(1)] }] },
      { writes: 1 },
      { writes: 2 },
    ]);
    expect(spy.writes.map((w) => [w.seq, w.final, w.rows[0]?.calls])).toEqual([
      [1, false, 1],
      [1, false, 2],
      [1, true, 2],
      [1, true, 2],
    ]);
    expect(m.ms).toEqual([5000]);
    expect(m.cancelled()).toBe(1);

    // A tick after the settle writes nothing, and the final rows stay.
    m.tick();
    await spy.settled();
    expect(spy.writes).toHaveLength(4);
    expect((await h.store.getRun(RUN_ID))?.usage[0]).toMatchObject({ final: true, rows: [triageRow(2)] });
  });

  test('ticks never overlap, and the settle waits for a write in flight before its final write', async () => {
    const m = manualTimer();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let whileHeld = -1;
    let spy!: ReturnType<typeof spyUsage>;
    const h = harness({
      usageFlushTimer: m.timer,
      read: async () => {
        countTurn();
        m.tick();
        countTurn();
        m.tick(); // the first write is still running
        await new Promise((resolve) => setImmediate(resolve));
        whileHeld = spy.writes.length;
        setTimeout(release, 20);
        return { text: 'done', submissionId: 'sub-1', data: {} };
      },
    });
    spy = spyUsage(h, { hold: (n) => (n === 0 ? held : undefined) });
    await runSubmission(prepared(), spy.deps);
    expect(whileHeld).toBe(1);
    expect(spy.writes.map((w) => [w.final, w.rows[0]?.calls])).toEqual([
      [false, 1],
      [true, 2],
      [true, 2],
    ]);
    expect((await h.store.getRun(RUN_ID))?.usage[0]).toMatchObject({ final: true, rows: [triageRow(2)] });
  });

  test('a failed flush is logged, tried again on the next tick, and never changes the status', async () => {
    const m = manualTimer();
    let spy!: ReturnType<typeof spyUsage>;
    const h = harness({
      usageFlushTimer: m.timer,
      read: async () => {
        countTurn();
        m.tick();
        await spy.settled();
        m.tick(); // same version, but the last write failed
        await spy.settled();
        return { text: 'done', submissionId: 'sub-1', data: {} };
      },
    });
    spy = spyUsage(h, { fail: (n) => (n === 0 ? new StoreDown('host unreachable') : undefined) });
    const result = await runSubmission(prepared(), spy.deps);
    expect(result.status).toBe('completed');
    expect(spy.writes.map((w) => w.final)).toEqual([false, false, true, true]);
    const events = await pipeline();
    expect(events).toContainEqual(['usage_flush_failed', { submission_seq: 1, error: 'StoreDown' }]);
    expect(events.filter(([type]) => type === 'usage_write_failed')).toEqual([]);
  });

  test('TRIAGE_USAGE_FLUSH_MS=0 turns the live flush off; left out, it uses the default interval', async () => {
    const off = manualTimer();
    const h = harness({ config: { usageFlushMs: 0 }, usageFlushTimer: off.timer });
    await runSubmission(prepared(), h.deps);
    expect(off.ms).toEqual([]);

    const dflt = manualTimer();
    const d = harness({ usageFlushTimer: dflt.timer });
    await runSubmission(prepared({ runId: RUN_2 }), d.deps);
    expect(dflt.ms).toEqual([DEFAULT_USAGE_FLUSH_MS]);
    expect(dflt.cancelled()).toBe(1);
  });
});
