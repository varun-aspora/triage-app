// Doctor checks that probe systems outside the process (HLD §7 Doctor; D33,
// D37, D44, D19, D27).
//
// - db: SELECT 1 and the read-only role check per service whose DB key is set.
// - quickwit: a dry check per entity. http: liveness, the auth mode and that
//   the token is set when auth is bearer. qw: QW_BIN --version and
//   `qw whoami --context`. No search, count or histogram call is ever made.
// - tunnel: the SSFB DB tunnel status (T11.2).
// - codegraph: the binary's version and which checkouts have an index (T11.3).
// - repos: branch drift per pin in resources/repos.json (T11.4).
//
// Network access goes only through the Probes interface (probes.ts). In mock
// mode the probes answer from fixtures or report skipped, and qw whoami and
// ssh are not run. Rows name env keys, never their values.

import { lookupEnv } from '../../config/env.ts';
import { RegistryError, loadRegistry, type Registry } from '../../config/registry.ts';
import { UnsafeArgError, assertSafeArg, createExecRunner, type ExecResult, type ExecRunner } from '../../connectors/exec.ts';
import { mockPortFromFixtures, type MockPort } from '../../connectors/mock.ts';
import type { FetchLike } from '../../connectors/quickwit/http-transport.ts';
import { createMockLayer } from '../../mock/index.ts';
import type { Entity } from '../../types/core.ts';
import { CODEGRAPH_BIN_KEY, codegraphVersion } from '../codegraph.ts';
import { repoStatus, type ReposDeps, type ReposStatusReport } from '../repos.ts';
import { TUNNEL_KEYS, readTunnelConfig, tunnelStatus, type TunnelDeps, type TunnelResult } from '../tunnel.ts';
import {
  createMockProbes,
  createRealProbes,
  type ProbeResult,
  type Probes,
  type RealProbesOptions,
  type TcpConnect,
} from './probes.ts';
import type { DoctorCheck, DoctorContext, DoctorStatus, NamedCheck } from './types.ts';

/** Ops functions the probe checks call. Tests replace them; the defaults are the T11 modules. */
export type DoctorOps = {
  readonly repoStatus?: (deps: ReposDeps) => Promise<ReposStatusReport>;
  readonly codegraphVersion?: typeof codegraphVersion;
  readonly tunnelStatus?: (deps: TunnelDeps) => Promise<TunnelResult>;
};

declare module './types.ts' {
  interface DoctorContext {
    /** Network probes. Built from config (mock or real) when left out. */
    readonly probes?: Probes;
    /** Runs qw, codegraph, git and ssh. Defaults to the real ExecRunner. */
    readonly runner?: ExecRunner;
    /** Used by the default real probes for the Quickwit liveness GET. Defaults to global fetch. */
    readonly fetch?: FetchLike;
    /** The SQL connector for the default real probes. Built from config when left out. */
    readonly sql?: RealProbesOptions['sql'];
    /** The TCP connect for the default real probes. Defaults to node:net. */
    readonly tcpConnect?: TcpConnect;
    /** Fixture lookup for the default mock probes. Built from config when left out. */
    readonly mockPort?: MockPort;
    readonly ops?: DoctorOps;
  }
}

export const REQUIRE_READONLY_KEY = 'TRIAGE_REQUIRE_READONLY_DB_ROLE';
export const QW_BIN_KEY = 'QW_BIN';
const QW_DEFAULT_BIN = 'qw';
const QW_TIMEOUT_MS = 20_000;
const QW_MAX_OUTPUT = 64 * 1024;
const LOOPBACK = '127.0.0.1';

type Row = Omit<DoctorCheck, 'id'>;

function row(status: DoctorStatus, key_names: readonly string[], message: string, entity?: Entity): Row {
  return entity === undefined ? { status, key_names, message } : { status, key_names, message, entity };
}

const withId = (id: string, rows: readonly Row[]): DoctorCheck[] => rows.map((r) => ({ id, ...r }));

const fromFixture = (r: { readonly transport?: string }): string => (r.transport === 'mock' ? ' (fixture)' : '');

// ------------------------------------------------------------------ shared state

type RegistryResult = { readonly ok: true; readonly registry: Registry } | { readonly ok: false };

const registries = new WeakMap<DoctorContext, RegistryResult>();
const probeSets = new WeakMap<DoctorContext, Probes>();
const repoReports = new WeakMap<DoctorContext, Promise<ReposStatusReport>>();
const runners = new WeakMap<DoctorContext, ExecRunner>();

// A registry that does not load is reported by the env check (T11.6); these
// checks then skip.
function registryOf(ctx: DoctorContext): RegistryResult {
  if (ctx.registry !== undefined) return { ok: true, registry: ctx.registry };
  const known = registries.get(ctx);
  if (known !== undefined) return known;
  let result: RegistryResult;
  try {
    result = { ok: true, registry: loadRegistry(ctx.config) };
  } catch (err) {
    if (!(err instanceof RegistryError)) throw err;
    result = { ok: false };
  }
  registries.set(ctx, result);
  return result;
}

const registrySkipped = (id: string): DoctorCheck[] =>
  withId(id, [row('skipped', [], `${id} not checked: the entity registry did not load`)]);

/** The probes for this doctor run: ctx.probes, or mock or real ones built from config once per run. */
export function probesFor(ctx: DoctorContext, registry: Registry): Probes {
  if (ctx.probes !== undefined) return ctx.probes;
  const known = probeSets.get(ctx);
  if (known !== undefined) return known;
  let probes: Probes;
  if (ctx.config.mock.enabled) {
    const mock = ctx.mockPort ?? mockPortFromFixtures(createMockLayer(ctx.config));
    probes = createMockProbes({ registry, mock });
  } else {
    probes = createRealProbes({
      config: ctx.config,
      registry,
      fetch: ctx.fetch ?? ((url, init) => fetch(url, init)),
      ...(ctx.sql !== undefined ? { sql: ctx.sql } : {}),
      ...(ctx.tcpConnect !== undefined ? { tcpConnect: ctx.tcpConnect } : {}),
      ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
    });
  }
  probeSets.set(ctx, probes);
  return probes;
}

function runnerOf(ctx: DoctorContext): ExecRunner {
  if (ctx.runner !== undefined) return ctx.runner;
  const known = runners.get(ctx);
  if (known !== undefined) return known;
  const runner = createExecRunner();
  runners.set(ctx, runner);
  return runner;
}

// The repos and codegraph checks share one status read per doctor run.
function repoReportOf(ctx: DoctorContext): Promise<ReposStatusReport> {
  const known = repoReports.get(ctx);
  if (known !== undefined) return known;
  const run = ctx.ops?.repoStatus ?? ((deps: ReposDeps) => repoStatus(deps));
  const pending = run({ config: ctx.config, runner: runnerOf(ctx), ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}) });
  repoReports.set(ctx, pending);
  return pending;
}

// ------------------------------------------------------------------ db

function tunnelHint(entity: Entity): string {
  return entity === 'ssfb' ? 'is the SSFB DB tunnel up? run triage tunnel status' : 'check the VPN or tunnel to this database';
}

async function dbRow(probes: Probes, requireReadonly: boolean, entity: Entity, service: string, key: string): Promise<Row> {
  const reach = await probes.dbSelectOne(entity, service);
  if (reach.status === 'skipped') return row('skipped', [key], `${service}: ${reach.reason}`, entity);
  if (reach.status === 'failed') {
    if (reach.code === 'unreachable' || reach.code === 'timeout') {
      return row('warn', [key], `${service}: could not reach the database behind ${key} (${reach.code})${fromFixture(reach)}; ${tunnelHint(entity)}`, entity);
    }
    return row('fail', [key], `${service}: SELECT 1 through ${key} failed (${reach.code}): ${reach.message}`, entity);
  }

  const role = await probes.dbWritable(entity, service);
  if (role.status === 'skipped') return row('skipped', [key], `${service}: SELECT 1 ok through ${key}${fromFixture(reach)}; role check skipped: ${role.reason}`, entity);
  if (role.status === 'failed') {
    return row('warn', [key], `${service}: SELECT 1 ok through ${key}; the read-only role check failed (${role.code}): ${role.message}`, entity);
  }
  if (!role.value.writable) return row('ok', [key], `${service}: SELECT 1 ok through ${key}; the role is read-only${fromFixture(role)}`, entity);
  if (role.value.reader) {
    return row(
      'ok',
      [key],
      `${service}: SELECT 1 ok through ${key}; the server is a read replica (pg_is_in_recovery), so the role's write grants cannot be used${fromFixture(role)}`,
      entity,
    );
  }
  if (requireReadonly) {
    return row(
      'fail',
      [key, REQUIRE_READONLY_KEY],
      `real mode blocked for ${entity}: the role behind ${key} can write and ${REQUIRE_READONLY_KEY}=true${fromFixture(role)}`,
      entity,
    );
  }
  return row(
    'warn',
    [key, REQUIRE_READONLY_KEY],
    `${service}: the role behind ${key} can INSERT, UPDATE or DELETE${fromFixture(role)}. Calls still run read-only; set ${REQUIRE_READONLY_KEY}=true to block real mode for ${entity} until a read-only role exists`,
    entity,
  );
}

async function dbCheck(ctx: DoctorContext): Promise<DoctorCheck[]> {
  const reg = registryOf(ctx);
  if (!reg.ok) return registrySkipped('db');
  const { registry } = reg;
  const probes = probesFor(ctx, registry);
  const requireReadonly = ctx.config.sql.requireReadonlyRole;
  const pending: Promise<Row>[] = [];
  for (const entity of registry.enabledEntities()) {
    for (const service of registry.services(entity)) {
      const cap = registry.serviceDb(entity, service);
      if (cap === undefined || cap.status !== 'ok') continue;
      pending.push(dbRow(probes, requireReadonly, entity, service, cap.envName));
    }
  }
  const rows = await Promise.all(pending);
  if (rows.length === 0) rows.push(row('skipped', [], 'no enabled service has a database key set'));
  return withId('db', rows);
}

// ------------------------------------------------------------------ quickwit

const clean = (r: ExecResult): boolean => r.exitCode === 0 && !r.timedOut && !r.aborted && r.spawnError === undefined;

function why(r: ExecResult): string {
  if (r.spawnError !== undefined) return `could not start (${r.spawnError})`;
  if (r.timedOut) return 'timed out';
  if (r.aborted) return 'was aborted';
  return `exit ${r.exitCode === null ? 'none' : r.exitCode}`;
}

const VERSION_TEXT = /^[A-Za-z0-9 ._()+\-/]{1,80}$/;

/** The first line of a --version answer, when it looks like a version and nothing else. */
function versionText(stdout: string): string | undefined {
  const first = stdout.trim().split(/\r?\n/)[0]?.trim() ?? '';
  return VERSION_TEXT.test(first) ? first : undefined;
}

async function quickwitHttpRow(ctx: DoctorContext, registry: Registry, probes: Probes, entity: Entity): Promise<Row> {
  const spec = registry.spec(entity).quickwit;
  const h = spec.http;
  if (h === undefined) return row('fail', [spec.transport], `${spec.transport} is http but the registry has no quickwit.http block`, entity);
  const authRaw = lookupEnv(ctx.config, h.auth);
  const auth = authRaw.state === 'set' ? authRaw.value.trim() : 'none';
  if (auth === 'bearer') {
    const token = h.token === undefined ? undefined : lookupEnv(ctx.config, h.token);
    if (h.token === undefined) return row('fail', [h.auth], `${h.auth} is bearer but the registry names no token key`, entity);
    if (token?.state !== 'set') return row('fail', [h.token, h.auth], `${h.auth} is bearer and ${h.token} is blank`, entity);
  }
  const cap = registry.quickwit(entity);
  if (cap.status !== 'ok') return row('disabled', cap.envNames, `logs off: ${cap.reason}`, entity);
  const authText = auth === 'bearer' ? `auth bearer, ${h.token} set` : 'auth none';
  const keys = auth === 'bearer' ? [h.url, h.auth, h.token as string] : [h.url, h.auth];
  const live = await probes.quickwitHttpLive(entity);
  if (live.status === 'skipped') return row('skipped', keys, `http, ${authText}; liveness skipped: ${live.reason}`, entity);
  if (live.status === 'failed') return row('warn', keys, `http, ${authText}; ${live.message}${fromFixture(live)}`, entity);
  return row('ok', keys, `http: live, ${authText}${fromFixture(live)}`, entity);
}

async function quickwitQwRow(ctx: DoctorContext, registry: Registry, entity: Entity): Promise<Row> {
  const spec = registry.spec(entity).quickwit;
  const contextKey = spec.qw?.context ?? `${entity.toUpperCase()}_QW_CONTEXT`;
  const cap = registry.quickwit(entity);
  if (cap.status !== 'ok') return row('disabled', cap.envNames, `logs off: ${cap.reason}`, entity);
  if (cap.transport !== 'qw') return row('fail', [spec.transport], `${spec.transport} and the registry disagree on the transport`, entity);

  const bin = ctx.config.code.qwBin;
  const shown = bin === QW_DEFAULT_BIN ? QW_DEFAULT_BIN : `$${QW_BIN_KEY}`;
  const loginFix = `${shown} login --context $${contextKey}`;
  const runner = runnerOf(ctx);
  const opts = { timeoutMs: QW_TIMEOUT_MS, maxOutputBytes: QW_MAX_OUTPUT, ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}) };

  const version = await runner.run(bin, ['--version'], opts);
  if (version.spawnError !== undefined) {
    return row('warn', [QW_BIN_KEY], `qw: ${QW_BIN_KEY} could not be started (${version.spawnError}); install qw or set ${QW_BIN_KEY}`, entity);
  }
  if (!clean(version)) return row('warn', [QW_BIN_KEY], `qw: ${shown} --version failed (${why(version)})`, entity);
  const v = versionText(version.stdout);
  const versionPart = v === undefined ? 'qw' : v;

  if (ctx.config.mock.enabled) {
    return row('skipped', [QW_BIN_KEY, contextKey], `qw: ${versionPart}; mock mode, qw whoami for $${contextKey} not run`, entity);
  }
  const context = cap.context.trim();
  try {
    assertSafeArg(context, contextKey);
  } catch (err) {
    if (!(err instanceof UnsafeArgError)) throw err;
    return row('fail', [contextKey], `qw: ${contextKey} holds characters that cannot go into an argv`, entity);
  }
  const whoami = await runner.run(bin, ['whoami', '--context', context], opts);
  if (clean(whoami)) return row('ok', [QW_BIN_KEY, contextKey], `qw: ${versionPart}; logged in for $${contextKey}`, entity);
  return row(
    'warn',
    [QW_BIN_KEY, contextKey],
    `qw: whoami for $${contextKey} failed (${why(whoami)}); run: ${loginFix}`,
    entity,
  );
}

async function quickwitCheck(ctx: DoctorContext): Promise<DoctorCheck[]> {
  const reg = registryOf(ctx);
  if (!reg.ok) return registrySkipped('quickwit');
  const { registry } = reg;
  const rows: Row[] = [];
  for (const entity of registry.enabledEntities()) {
    const spec = registry.spec(entity).quickwit;
    const t = lookupEnv(ctx.config, spec.transport);
    const transport = t.state === 'set' ? t.value.trim() : '';
    if (transport === '') {
      rows.push(row('disabled', [spec.transport], `logs off: ${spec.transport} is blank`, entity));
    } else if (transport === 'http') {
      rows.push(await quickwitHttpRow(ctx, registry, probesFor(ctx, registry), entity));
    } else if (transport === 'qw') {
      rows.push(await quickwitQwRow(ctx, registry, entity));
    } else {
      rows.push(row('fail', [spec.transport], `${spec.transport} must be qw or http`, entity));
    }
  }
  return withId('quickwit', rows);
}

// ------------------------------------------------------------------ tunnel

function tunnelRow(res: TunnelResult): Row {
  if (res.state === 'disabled') return row(res.error === undefined ? 'disabled' : 'fail', res.keys, res.error ?? res.message, 'ssfb');
  if (res.state === 'up' && res.owned) return row('ok', res.keys, res.message, 'ssfb');
  if (res.state === 'up') return row('warn', res.keys, res.message, 'ssfb');
  const detail = res.error ?? 'run triage tunnel up';
  return row('warn', res.keys.length > 0 ? res.keys : [TUNNEL_KEYS.localPort], `${res.message}; ${detail}`, 'ssfb');
}

async function tunnelCheck(ctx: DoctorContext): Promise<DoctorCheck[]> {
  const reg = registryOf(ctx);
  if (!reg.ok) return registrySkipped('tunnel');
  if (!reg.registry.isEnabled('ssfb')) return [];
  const cfg = readTunnelConfig(ctx.config);
  if (!cfg.enabled) return withId('tunnel', [row('disabled', cfg.keys, cfg.reason, 'ssfb')]);
  const probes = probesFor(ctx, reg.registry);

  if (ctx.config.mock.enabled) {
    // ssh is not run in mock mode; the port probe answers from a fixture.
    const r = await probes.tcp(LOOPBACK, cfg.localPort);
    const keys = [TUNNEL_KEYS.localPort];
    if (r.status === 'skipped') return withId('tunnel', [row('skipped', keys, `SSFB DB tunnel not probed: ${r.reason}`, 'ssfb')]);
    if (r.status === 'failed') return withId('tunnel', [row('warn', keys, `SSFB DB tunnel probe failed: ${r.message}`, 'ssfb')]);
    return withId('tunnel', [
      r.value
        ? row('ok', keys, `port ${cfg.localPort} listens on ${LOOPBACK} (fixture)`, 'ssfb')
        : row('warn', keys, `SSFB DB tunnel is down on ${LOOPBACK}:${cfg.localPort} (fixture); run triage tunnel up`, 'ssfb'),
    ]);
  }

  const status = ctx.ops?.tunnelStatus ?? tunnelStatus;
  const tcpProbe = async (host: string, port: number): Promise<boolean> => {
    const r: ProbeResult<boolean> = await probes.tcp(host, port);
    return r.status === 'ok' && r.value;
  };
  const res = await status({
    config: ctx.config,
    runner: runnerOf(ctx),
    tcpProbe,
    ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
  });
  return withId('tunnel', [tunnelRow(res)]);
}

// ------------------------------------------------------------------ codegraph

async function codegraphCheck(ctx: DoctorContext): Promise<DoctorCheck[]> {
  const version = ctx.ops?.codegraphVersion ?? codegraphVersion;
  const v = await version({ config: ctx.config, runner: runnerOf(ctx), ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}) });
  if (v.status === 'not_configured') return withId('codegraph', [row('disabled', [v.key], `code tools off: ${v.message}`)]);
  const rows: Row[] = [];
  if (v.status === 'ok') {
    const text = versionText(v.output);
    rows.push(row('ok', [CODEGRAPH_BIN_KEY], text === undefined ? 'codegraph answers --version' : `codegraph ${text}`));
  } else if (v.status === 'error') {
    rows.push(row('warn', [CODEGRAPH_BIN_KEY], v.message));
  } else {
    rows.push(row('warn', [CODEGRAPH_BIN_KEY], `codegraph --version: ${v.status}`));
  }

  const report = await repoReportOf(ctx);
  if (report.status !== 'ok') return withId('codegraph', rows);
  let indexed = 0;
  for (const r of report.repos) {
    if (!r.present) continue;
    if (r.indexed) indexed += 1;
    else rows.push(row('warn', [], `${r.repo}: no codegraph index; run triage repos sync`));
  }
  if (indexed > 0) rows.push(row('ok', [], `codegraph index present for ${indexed} repo${indexed === 1 ? '' : 's'}`));
  return withId('codegraph', rows);
}

// ------------------------------------------------------------------ repos

async function reposCheck(ctx: DoctorContext): Promise<DoctorCheck[]> {
  const report = await repoReportOf(ctx);
  if (report.status !== 'ok') return withId('repos', [row('disabled', [report.key], report.message)]);
  const rows: Row[] = report.repos.map((r) => {
    if (!r.present) return row('warn', [], `${r.repo}: not checked out; run triage repos sync`);
    if (r.problem !== undefined) return row('warn', [], `${r.repo}: ${r.problem}`);
    if (r.drift === true) {
      const actual = r.actualBranch ?? 'a detached HEAD';
      return row('warn', [], `${r.repo}: on ${actual}, expected ${r.expectedBranch ?? 'the default branch'}; run triage repos sync`);
    }
    if (r.dirty === true) return row('warn', [], `${r.repo}: has local changes on ${r.actualBranch ?? 'a detached HEAD'}`);
    const at = r.commit === null ? '' : ` at ${r.commit.slice(0, 12)}`;
    const unknown = r.drift === null ? '; the default branch is not recorded locally' : '';
    return row('ok', [], `${r.repo}: on ${r.actualBranch ?? 'a detached HEAD'}${at}${unknown}`);
  });
  if (rows.length === 0) rows.push(row('skipped', [], 'resources/repos.json pins no repos'));
  return withId('repos', rows);
}

/** The probe checks, in the order the doctor table shows them. */
export const probeChecks: readonly NamedCheck[] = Object.freeze([
  { id: 'db', run: dbCheck },
  { id: 'quickwit', run: quickwitCheck },
  { id: 'tunnel', run: tunnelCheck },
  { id: 'codegraph', run: codegraphCheck },
  { id: 'repos', run: reposCheck },
]);
