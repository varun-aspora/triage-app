// The pre-flight step functions (D32, D14, D44). src/ops/preflight.ts picks
// which of them run for the deploy mode; this file never looks at the mode.
//
// Rules every step keeps:
// - It never throws. runGuarded turns any thrown error into a warning with a
//   fixed message, because an error's text can quote a config value.
// - Warnings and fixes name config keys as $KEY placeholders. No value from
//   the config (host, profile, context, token) is ever put in a message.
// - Commands run only through the ExecRunner with fixed argv. Values that go
//   into argv pass assertSafeArg first.

import type { Config } from '../config/env.ts';
import { lookupEnv } from '../config/env.ts';
import type { Registry } from '../config/registry.ts';
import { UnsafeArgError, assertSafeArg, type ExecResult, type ExecRunner } from '../connectors/exec.ts';
import type { PreflightWarning } from '../types/classification.ts';
import type { Entity } from '../types/core.ts';
import type { TcpProbe, TunnelDeps, TunnelResult } from './tunnel.ts';

export type StepId =
  | 'preflight'
  | 'deploy-mode'
  | 'tunnel'
  | 'aws-login'
  | 'kube-context'
  | 'qw-login'
  | 'qw-transport'
  | 'probe';

export type StepStatus = 'ok' | 'warn' | 'skipped';

export type PreflightStep = {
  readonly id: StepId;
  readonly entity?: Entity;
  readonly status: StepStatus;
};

/** Starts the SSFB tunnel. tunnelUp from src/ops/tunnel.ts, or a fake in tests. */
export type TunnelUpFn = (deps: TunnelDeps) => Promise<TunnelResult>;

export type StepContext = {
  readonly config: Config;
  readonly registry: Registry;
  /** Enabled entities this pre-flight covers. */
  readonly entities: readonly Entity[];
  readonly runner: ExecRunner;
  readonly tcpProbe: TcpProbe;
  readonly tunnel: TunnelUpFn;
  /** True when stdin is a terminal, so an interactive login can run. */
  readonly isTty: boolean;
  readonly signal?: AbortSignal;
};

export const TUNNEL_REQUIRED_KEY = 'SSFB_DB_TUNNEL_REQUIRED';
export const AWS_BIN = 'aws';
export const KUBECTL_BIN = 'kubectl';
const QW_DEFAULT_BIN = 'qw';

export const PREFLIGHT_TIMEOUTS = Object.freeze({
  awsIdentityMs: 20_000,
  // aws sso login waits for the operator to approve in the browser.
  awsSsoLoginMs: 300_000,
  kubeContextsMs: 10_000,
  qwWhoamiMs: 20_000,
  probeMs: 1_500,
});

/** Collects steps and warnings in the order they happen. */
export class Outcome {
  readonly steps: PreflightStep[] = [];
  readonly warnings: PreflightWarning[] = [];

  step(id: StepId, entity: Entity | undefined, status: StepStatus): void {
    this.steps.push(Object.freeze(entity === undefined ? { id, status } : { id, entity, status }));
  }

  /** Records a warning without a step. Use warn() unless the step is recorded separately. */
  warning(id: StepId, entity: Entity | undefined, message: string, fix?: string): void {
    const w: PreflightWarning = { step: id, message };
    if (entity !== undefined) w.entity = entity;
    if (fix !== undefined) w.fix = fix;
    this.warnings.push(Object.freeze(w));
  }

  /** A step that ended in a warning. */
  warn(id: StepId, entity: Entity | undefined, message: string, fix?: string): void {
    this.step(id, entity, 'warn');
    this.warning(id, entity, message, fix);
  }
}

/** $KEY placeholder for messages. */
export const ph = (key: string): string => `$${key}`;

/**
 * Runs one step and turns anything it throws into a warning. The error text
 * is dropped on purpose: it may quote a value.
 */
export async function runGuarded(out: Outcome, id: StepId, entity: Entity | undefined, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    const detail = e instanceof UnsafeArgError ? `: ${e.keyName} ${e.reason}` : '';
    out.warn(id, entity, `the ${id} check failed unexpectedly${detail}`);
  }
}

function runOpts(ctx: StepContext, timeoutMs: number): { timeoutMs: number; signal?: AbortSignal } {
  return ctx.signal === undefined ? { timeoutMs } : { timeoutMs, signal: ctx.signal };
}

const clean = (r: ExecResult): boolean =>
  r.exitCode === 0 && !r.timedOut && !r.aborted && r.spawnError === undefined;

/** A fixed description of why a command did not succeed. Never includes its output. */
function failure(bin: string, r: ExecResult): string {
  if (r.spawnError !== undefined) return `the ${bin} CLI could not be started`;
  if (r.aborted) return `${bin} was aborted`;
  if (r.timedOut) return `${bin} did not answer in time`;
  return `${bin} exited with ${r.exitCode === null ? 'no exit code' : `code ${r.exitCode}`}`;
}

function readFlag(config: Config, key: string): boolean {
  const l = lookupEnv(config, key);
  return l.state === 'set' && l.value.trim().toLowerCase() === 'true';
}

// ------------------------------------------------------------------ tunnel

/** Local mode: brings the SSFB DB tunnel up when ssfb is enabled and the tunnel is required. */
export async function tunnelStep(ctx: StepContext, out: Outcome): Promise<void> {
  if (!ctx.entities.includes('ssfb')) return;
  if (!readFlag(ctx.config, TUNNEL_REQUIRED_KEY)) {
    out.step('tunnel', 'ssfb', 'skipped');
    return;
  }
  await runGuarded(out, 'tunnel', 'ssfb', async () => {
    const r = await ctx.tunnel({
      config: ctx.config,
      runner: ctx.runner,
      tcpProbe: ctx.tcpProbe,
      ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
    });
    // TunnelResult messages and errors name keys and the local port only.
    if (r.state === 'up') {
      out.step('tunnel', 'ssfb', 'ok');
    } else if (r.state === 'disabled') {
      const keys = r.keys.length > 0 ? r.keys.join(', ') : 'SSFB_DB_TUNNEL_BASTION';
      out.warn('tunnel', 'ssfb', `${r.message}, so the SSFB databases may be unreachable`, `set ${keys}, or set ${TUNNEL_REQUIRED_KEY}=false`);
    } else {
      const message = r.error === undefined ? r.message : `${r.message}: ${r.error}`;
      out.warn('tunnel', 'ssfb', `${message}; the SSFB databases may be unreachable`, 'triage tunnel status, then triage tunnel up');
    }
  });
}

// -------------------------------------------------------------- kube login

/** Entities whose transport needs a kube login. In v1 that is an entity whose CBS-via-kubectl flag is on (ssfb). */
export function needsKubeLogin(registry: Registry, entity: Entity): boolean {
  return registry.cbsEnabled(entity);
}

/**
 * Local mode: for each entity that needs it, checks the AWS session
 * (`aws sts get-caller-identity --profile`), runs `aws sso login --profile`
 * only when stdin is a TTY, then checks that the kube context is in the
 * kubeconfig (kubectl on the laptop, Q26 default).
 */
export async function kubeLoginSteps(ctx: StepContext, out: Outcome): Promise<void> {
  for (const entity of ctx.entities) {
    await runGuarded(out, 'aws-login', entity, async () => {
      if (!needsKubeLogin(ctx.registry, entity)) return;
      const spec = ctx.registry.spec(entity).kube;
      await runGuarded(out, 'aws-login', entity, () => awsLogin(ctx, out, entity, spec.aws_profile_env));
      await runGuarded(out, 'kube-context', entity, () => kubeContext(ctx, out, entity, spec.context_env, spec.aws_profile_env));
    });
  }
}

async function awsLogin(ctx: StepContext, out: Outcome, entity: Entity, profileKey: string): Promise<void> {
  const cap = ctx.registry.kube(entity).awsProfile;
  if (cap.status !== 'ok') {
    out.warn('aws-login', entity, `${profileKey} is blank, so the AWS login for kubectl cannot run`, `set ${profileKey} to the AWS SSO profile for ${entity}`);
    return;
  }
  const profile = cap.value.trim();
  assertSafeArg(profile, profileKey);
  const identityArgv = ['sts', 'get-caller-identity', '--profile', profile];
  const loginFix = `aws sso login --profile ${ph(profileKey)}`;

  const first = await ctx.runner.run(AWS_BIN, identityArgv, runOpts(ctx, PREFLIGHT_TIMEOUTS.awsIdentityMs));
  if (clean(first)) {
    out.step('aws-login', entity, 'ok');
    return;
  }
  if (first.spawnError !== undefined) {
    out.warn('aws-login', entity, failure(AWS_BIN, first), 'install the AWS CLI v2 and put it on PATH');
    return;
  }
  if (!ctx.isTty) {
    out.warn('aws-login', entity, `the AWS session for ${ph(profileKey)} is missing or expired (${failure(AWS_BIN, first)}) and stdin is not a terminal, so no login was attempted`, loginFix);
    return;
  }

  const login = await ctx.runner.run(AWS_BIN, ['sso', 'login', '--profile', profile], runOpts(ctx, PREFLIGHT_TIMEOUTS.awsSsoLoginMs));
  if (!clean(login)) {
    out.warn('aws-login', entity, `aws sso login for ${ph(profileKey)} did not complete (${failure(AWS_BIN, login)})`, loginFix);
    return;
  }
  const second = await ctx.runner.run(AWS_BIN, identityArgv, runOpts(ctx, PREFLIGHT_TIMEOUTS.awsIdentityMs));
  if (clean(second)) {
    out.step('aws-login', entity, 'ok');
    return;
  }
  out.warn('aws-login', entity, `the AWS session for ${ph(profileKey)} is still not valid after aws sso login (${failure(AWS_BIN, second)})`, loginFix);
}

async function kubeContext(ctx: StepContext, out: Outcome, entity: Entity, contextKey: string, profileKey: string): Promise<void> {
  const cap = ctx.registry.kube(entity).context;
  const updateFix = `aws eks update-kubeconfig --name <cluster-name> --alias ${ph(contextKey)} --profile ${ph(profileKey)}`;
  if (cap.status !== 'ok') {
    out.warn('kube-context', entity, `${contextKey} is blank, so kubectl has no context for ${entity}`, `set ${contextKey}, then ${updateFix}`);
    return;
  }
  // The context name is compared to kubectl's list rather than passed in
  // argv, since EKS context names are ARNs.
  const r = await ctx.runner.run(KUBECTL_BIN, ['config', 'get-contexts', '-o', 'name'], runOpts(ctx, PREFLIGHT_TIMEOUTS.kubeContextsMs));
  if (!clean(r)) {
    const fix = r.spawnError !== undefined ? 'install kubectl and put it on PATH' : updateFix;
    out.warn('kube-context', entity, `could not list kubeconfig contexts (${failure(KUBECTL_BIN, r)})`, fix);
    return;
  }
  const wanted = cap.value.trim();
  const found = r.stdout.split(/\r?\n/).some((line) => line.trim() === wanted);
  if (found) {
    out.step('kube-context', entity, 'ok');
    return;
  }
  out.warn('kube-context', entity, `the context in ${ph(contextKey)} is not in the kubeconfig`, updateFix);
}

// ---------------------------------------------------------------------- qw

/** The qw command as shown to the operator: `qw`, or $QW_BIN when it points elsewhere. */
function qwShown(config: Config): string {
  return config.code.qwBin === QW_DEFAULT_BIN ? QW_DEFAULT_BIN : ph('QW_BIN');
}

/** Local mode: `qw whoami --context <ctx>` for each enabled entity on the qw log transport. */
export async function qwLoginSteps(ctx: StepContext, out: Outcome): Promise<void> {
  for (const entity of ctx.entities) {
    await runGuarded(out, 'qw-login', entity, async () => {
      const q = ctx.registry.quickwit(entity);
      if (q.status !== 'ok' || q.transport !== 'qw') return;
      const contextKey = ctx.registry.spec(entity).quickwit.qw?.context ?? `${entity.toUpperCase()}_QW_CONTEXT`;
      const context = q.context.trim();
      assertSafeArg(context, contextKey);
      const shown = qwShown(ctx.config);
      const r = await ctx.runner.run(ctx.config.code.qwBin, ['whoami', '--context', context], runOpts(ctx, PREFLIGHT_TIMEOUTS.qwWhoamiMs));
      if (clean(r)) {
        out.step('qw-login', entity, 'ok');
        return;
      }
      if (r.spawnError !== undefined) {
        out.warn('qw-login', entity, `the qw CLI could not be started, so logs for ${entity} may be unreachable`, `install qw or set QW_BIN`);
        return;
      }
      out.warn('qw-login', entity, `qw whoami for ${ph(contextKey)} failed (${failure('qw', r)}); logs for ${entity} may be unreachable until you log in`, `${shown} login --context ${ph(contextKey)}`);
    });
  }
}

/**
 * Server mode: qw has no headless login yet (Q27 default: http on servers),
 * so an entity on the qw transport gets a warning. Runs nothing.
 */
export async function qwHeadlessSteps(ctx: StepContext, out: Outcome): Promise<void> {
  for (const entity of ctx.entities) {
    await runGuarded(out, 'qw-transport', entity, async () => {
      const q = ctx.registry.spec(entity).quickwit;
      const transportKey = q.transport;
      const l = lookupEnv(ctx.config, transportKey);
      if (l.state !== 'set' || l.value.trim() !== 'qw') return;
      out.warn(
        'qw-transport',
        entity,
        `${transportKey} is qw, but qw has no headless login, so logs for ${entity} may be unreachable on a server`,
        q.http === undefined ? `set ${transportKey}=http` : `set ${transportKey}=http and fill ${q.http.url} and ${q.http.auth}`,
      );
    });
  }
}

// ------------------------------------------------------------------ probes

export type ProbeTarget = { readonly host: string; readonly port: number; readonly keys: readonly string[] };

const DEFAULT_PORTS: Readonly<Record<string, number>> = { 'postgres:': 5432, 'postgresql:': 5432, 'http:': 80, 'https:': 443 };
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1']);

/** host and port from a DSN or URL, or undefined when it has neither. */
export function hostPort(value: string): { host: string; port: number } | undefined {
  let u: URL;
  try {
    u = new URL(value.trim());
  } catch {
    return undefined;
  }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === '') return undefined;
  const port = u.port === '' ? DEFAULT_PORTS[u.protocol] : Number(u.port);
  if (port === undefined || !Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  return { host, port };
}

/**
 * The hosts an entity is configured to reach directly: each service DB, each
 * service API on the http transport (cbs APIs are reached from inside a pod)
 * and the Quickwit URL on the http transport. One target per host and port,
 * with every key that points there. Keys whose value has no host come back
 * in `unreadable`.
 */
export function probeTargets(registry: Registry, entity: Entity): { targets: ProbeTarget[]; unreadable: string[] } {
  const byAddr = new Map<string, { host: string; port: number; keys: string[] }>();
  const unreadable: string[] = [];
  const add = (key: string, value: string): void => {
    const hp = hostPort(value);
    if (hp === undefined) {
      unreadable.push(key);
      return;
    }
    const addr = `${hp.host}\u0000${hp.port}`;
    const t = byAddr.get(addr) ?? { ...hp, keys: [] };
    if (!t.keys.includes(key)) t.keys.push(key);
    byAddr.set(addr, t);
  };

  for (const service of registry.services(entity)) {
    const db = registry.serviceDb(entity, service);
    if (db?.status === 'ok') add(db.envName, db.value);
    const api = registry.serviceApi(entity, service);
    if (api?.status === 'ok' && api.transport === 'http') add(api.envName, api.value);
  }
  const q = registry.quickwit(entity);
  const urlKey = registry.spec(entity).quickwit.http?.url;
  if (q.status === 'ok' && q.transport === 'http' && urlKey !== undefined) add(urlKey, q.url);
  return { targets: [...byAddr.values()], unreadable };
}

function keyList(keys: readonly string[]): string {
  const shown = keys.slice(0, 3).map(ph).join(', ');
  return keys.length > 3 ? `${shown} and ${keys.length - 3} more` : shown;
}

async function reachable(ctx: StepContext, t: ProbeTarget): Promise<boolean> {
  try {
    return (await ctx.tcpProbe(t.host, t.port, PREFLIGHT_TIMEOUTS.probeMs)) === true;
  } catch {
    return false;
  }
}

/** Every mode: TCP-probes the configured hosts of each enabled entity. One step per entity. */
export async function probeSteps(ctx: StepContext, out: Outcome): Promise<void> {
  for (const entity of ctx.entities) {
    await runGuarded(out, 'probe', entity, async () => {
      const { targets, unreadable } = probeTargets(ctx.registry, entity);
      if (targets.length === 0 && unreadable.length === 0) {
        out.step('probe', entity, 'skipped');
        return;
      }
      const answers = await Promise.all(targets.map((t) => reachable(ctx, t)));
      const down = targets.filter((_, i) => answers[i] !== true);
      if (down.length === 0 && unreadable.length === 0) {
        out.step('probe', entity, 'ok');
        return;
      }
      out.step('probe', entity, 'warn');
      for (const key of unreadable) {
        out.warning('probe', entity, `could not read a host and port from ${ph(key)}`, `check the format of ${key}`);
      }
      for (const t of down) {
        const fix = LOOPBACK.has(t.host) ? 'triage tunnel status' : 'check the VPN or network path to this host';
        out.warning('probe', entity, `no TCP answer from the host in ${keyList(t.keys)}`, fix);
      }
    });
  }
}
