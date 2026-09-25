// runSubmission and askRun with injected fakes: a folder run store in a temp
// dir wrapped in a recorder, fake pre-flight, identity, classifier and
// prior-case providers, the real tier policy behind a spy, and a fake Flue
// dispatcher {init -> {dispatch, read, abort}}. No model, network or Flue
// runtime is involved.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Agent, AgentInstanceExistsError, AgentRunError, type InitOptions } from '@flue/runtime';
import * as v from 'valibot';
import type { TriageRuntime } from '../agents/triage-plan.ts';
import { Triage } from '../agents/triage.agent.ts';
import { unknownClassification } from '../classify/classify.ts';
import { applyTierPolicy, type TierPolicyContext } from '../classify/policy.ts';
import type { Embedder } from '../embed/index.ts';
import { isPersisted, redactPersisted } from '../gate/redact.ts';
import type { EmbedRunResult } from '../runstore/embed-run.ts';
import { createFolderRunStore, folderRunStoreFromConfig } from '../runstore/folder.ts';
import { RunNotFoundError, type RunStore } from '../runstore/types.ts';
import { type Classification, type TriageInit, TriageInitSchema } from '../types/classification.ts';
import type { Tier } from '../types/core.ts';
import type { IdChain } from '../types/id-chain.ts';
import type { Attachment } from '../types/request.ts';
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
    current_ask: 'why is the charge not shown',
    money_moved: false,
    misdirected_funds: false,
    tier_proposed: 'mid',
    confidence: 0.9,
    missing_info: [],
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
  config?: Partial<{ mock: boolean; priorCases: boolean }>;
  classify?: () => Promise<Classification>;
  identity?: () => Promise<IngressIdentity>;
  read?: ReadBehaviour;
  onDispatch?: (store: RunStore) => Promise<void>;
  dispatchError?: Error;
  embedRun?: SubmissionDeps['embedRun'];
  tierAcceptsImages?: (tier: Tier) => boolean;
  preflightWarnings?: { step: string; message: string }[];
  signal?: AbortSignal;
  readTimeoutMs?: number;
};

const EMBEDDER: Embedder = { model: 'test/embed', embed: async () => [] };

function harness(o: HarnessOptions = {}): Harness {
  const events: string[] = [];
  const { store, calls } = recordingStore(events);
  const flue = fakeFlue(events, o.read, o.onDispatch ? () => o.onDispatch!(store) : undefined, o.dispatchError);
  const spies: Harness['spies'] = { preflight: 0, priorCases: 0, embedRun: [], policy: [] };
  const config: SubmissionConfig = {
    mock: { enabled: o.config?.mock ?? true },
    runs: { priorCases: o.config?.priorCases ?? false },
    budgets: { runTimeoutMs: 1_000, runMaxAttempts: 1 },
  };
  const deps: SubmissionDeps = {
    config,
    store,
    dispatcher: flue.dispatcher,
    agent: Triage,
    embedder: EMBEDDER,
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
    priorCases: async () => {
      spies.priorCases += 1;
      return { cases: [{ category: 'card', age_days: 12, similarity: 0.82 }], gaps: [] };
    },
    readAttachment: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    ...(o.signal !== undefined ? { signal: o.signal } : {}),
    ...(o.readTimeoutMs !== undefined ? { readTimeoutMs: o.readTimeoutMs } : {}),
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

  test('the repo sync gets the entities the request names, so it fetches their deploy manifests', async () => {
    const seen: (readonly string[] | undefined)[] = [];
    const h = harness({ config: { mock: false } });
    const deps: SubmissionDeps = {
      ...h.deps,
      repoSync: async ({ entities }) => {
        seen.push(entities);
        return [];
      },
    };
    const p = prepared();
    await runSubmission({ ...p, request: { ...p.request, hints: { ...p.request.hints, entities: ['atspl'] } } }, deps);
    await runSubmission(prepared({ runId: 'run_submit_no_hints_01' }), deps);
    expect(seen).toEqual([['atspl'], p.request.hints.entities]);
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
