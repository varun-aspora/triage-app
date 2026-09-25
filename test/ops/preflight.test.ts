import { describe, expect, test } from 'bun:test';
import { configFromRecord, type Config } from '../../src/config/env.ts';
import { loadRegistry, type Registry } from '../../src/config/registry.ts';
import { createFakeRunner, type FakeRunner, type FakeStep } from '../../src/connectors/exec-fake.ts';
import type { ExecRunner } from '../../src/connectors/exec.ts';
import { hostPort, probeTargets } from '../../src/ops/preflight-steps.ts';
import { parseDeployMode, runPreflight, runResumePreflight, type PreflightInput, type PreflightResult } from '../../src/ops/preflight.ts';
import type { TcpProbe, TunnelDeps, TunnelResult } from '../../src/ops/tunnel.ts';
import { RESOURCES_DIR, testEnvRecord } from '../support/home.ts';

// Seeded fake values. None names a real system: .invalid never resolves and
// 203.0.113.0/24 is a documentation range.
const HOME = '/triage/home';
const SSFB_DB = 'postgresql://reader:hunter2@127.0.0.1:55432/harbor_db';
const ATSPL_DB = 'postgresql://reader:hunter2@atspl-db.fixture.invalid:65432/package_db';
const RTL_DB = 'postgresql://reader:hunter2@203.0.113.9:5432/banking_db';
const SSFB_PROFILE = 'fixture-ssfb-sso';
const SSFB_CONTEXT = 'arn:aws:eks:ap-south-1:000000000000:cluster/fixture-ssfb';
const SSFB_QW = 'ssfb-fixture';
const ATSPL_QW = 'envoy-fixture';

const SEEDED = [SSFB_DB, ATSPL_DB, RTL_DB, 'hunter2', 'reader', 'atspl-db.fixture.invalid', '203.0.113.9', SSFB_PROFILE, SSFB_CONTEXT, 'fixture-ssfb', SSFB_QW, ATSPL_QW];

const BASE: Readonly<Record<string, string>> = {
  TRIAGE_MOCK_MODE: 'false',
  TRIAGE_MOCK_STRICT: 'false',
  TRIAGE_DEPLOY_MODE: 'local',
  SSFB_DB_TUNNEL_REQUIRED: 'true',
  SSFB_HARBOR_DB_URL: SSFB_DB,
  ATSPL_PACKAGE_DB_URL: ATSPL_DB,
  RTL_BANKING_DB_URL: RTL_DB,
  SSFB_QUICKWIT_TRANSPORT: 'qw',
  SSFB_QW_CONTEXT: SSFB_QW,
  ATSPL_QUICKWIT_TRANSPORT: 'qw',
  ATSPL_QW_CONTEXT: ATSPL_QW,
  // RTL stays on qw with a blank index, so its logs are off and qw is never asked.
  RTL_QUICKWIT_TRANSPORT: 'qw',
  SSFB_CBS_VIA_KUBECTL_ENABLED: 'false',
  SSFB_AWS_PROFILE: SSFB_PROFILE,
  SSFB_KUBE_CONTEXT: SSFB_CONTEXT,
};

function setup(overrides: Readonly<Record<string, string>> = {}): { config: Config; registry: Registry } {
  const config = configFromRecord({ ...testEnvRecord(), ...BASE, ...overrides }, HOME);
  return { config, registry: loadRegistry(config, { resourcesDir: RESOURCES_DIR }) };
}

type Probe = TcpProbe & { calls: { host: string; port: number }[] };

/** Answers true unless the host is listed as down. A host listed as 'throw' throws. */
function probeOf(down: Readonly<Record<string, boolean | 'throw'>> = {}): Probe {
  const calls: Probe['calls'] = [];
  return Object.assign(
    async (host: string, port: number) => {
      calls.push({ host, port });
      const d = down[host];
      if (d === 'throw') throw new Error(`probe failed for ${host}`);
      return d !== true;
    },
    { calls },
  );
}

type FakeTunnel = ((deps: TunnelDeps) => Promise<TunnelResult>) & { calls: number };

function tunnelOf(answer: Partial<TunnelResult> | Error = {}): FakeTunnel {
  const fn: FakeTunnel = Object.assign(
    async (_deps: TunnelDeps): Promise<TunnelResult> => {
      fn.calls++;
      if (answer instanceof Error) throw answer;
      return { state: 'up', owned: true, listening: true, started: true, stopped: false, keys: [], message: 'SSFB DB tunnel is up', ...answer };
    },
    { calls: 0 },
  );
  return fn;
}

const qwOk = (context: string, exitCode = 0): FakeStep => ({ bin: 'qw', argv: ['whoami', '--context', context], result: { exitCode } });
const STS = ['sts', 'get-caller-identity', '--profile', SSFB_PROFILE];
const SSO = ['sso', 'login', '--profile', SSFB_PROFILE];
const CONTEXTS = ['config', 'get-contexts', '-o', 'name'];
const kubeList = (...names: string[]): FakeStep => ({ bin: 'kubectl', argv: CONTEXTS, result: { stdout: `${names.join('\n')}\n` } });

type Run = { result: PreflightResult; runner: FakeRunner; probe: Probe; tunnel: FakeTunnel };

async function run(options: {
  overrides?: Record<string, string>;
  script?: FakeStep[];
  probe?: Probe;
  tunnel?: FakeTunnel;
  isTty?: boolean;
  /** Defaults to runPreflight. */
  fn?: (input: PreflightInput) => Promise<PreflightResult>;
} = {}): Promise<Run> {
  const { config, registry } = setup(options.overrides);
  const runner = createFakeRunner(options.script ?? [qwOk(SSFB_QW), qwOk(ATSPL_QW)]);
  const probe = options.probe ?? probeOf();
  const tunnel = options.tunnel ?? tunnelOf();
  const input: PreflightInput = {
    config,
    registry,
    runner,
    tcpProbe: probe,
    tunnel,
    isTty: options.isTty ?? false,
  };
  const result = await (options.fn ?? runPreflight)(input);
  return { result, runner, probe, tunnel };
}

const bins = (r: FakeRunner): string[] => r.calls.map((c) => c.bin);
const stepOf = (res: PreflightResult, id: string, entity?: string) => res.steps.filter((s) => s.id === id && s.entity === entity);
const warningsFor = (res: PreflightResult, step: string) => res.warnings.filter((w) => w.step === step);

function expectNoValues(res: PreflightResult): void {
  const text = JSON.stringify(res);
  for (const v of SEEDED) expect(text).not.toContain(v);
}

describe('mock mode', () => {
  test('skips at once with no runner, tunnel or probe call', async () => {
    const r = await run({
      overrides: { TRIAGE_MOCK_MODE: 'true', TRIAGE_MOCK_STRICT: 'true', SSFB_CBS_VIA_KUBECTL_ENABLED: 'true' },
      script: [],
      isTty: true,
    });
    expect(r.result.skipped).toBe('mock');
    expect(r.result.mode).toBe('local');
    expect(r.result.steps).toEqual([]);
    expect(r.result.warnings).toEqual([]);
    expect(r.runner.calls).toEqual([]);
    expect(r.runner.unscripted).toEqual([]);
    expect(r.tunnel.calls).toBe(0);
    expect(r.probe.calls).toEqual([]);
  });

  test('also skips in server mode', async () => {
    const r = await run({ overrides: { TRIAGE_MOCK_MODE: 'true', TRIAGE_DEPLOY_MODE: 'server' }, script: [] });
    expect(r.result).toEqual({ mode: 'server', skipped: 'mock', steps: [], warnings: [] });
    expect(r.probe.calls).toEqual([]);
  });
});

describe('local mode', () => {
  test('a clean run starts the tunnel, checks qw and probes every configured host', async () => {
    const r = await run();
    expect(r.result.mode).toBe('local');
    expect(r.result.skipped).toBeUndefined();
    expect(r.result.warnings).toEqual([]);
    expect(r.tunnel.calls).toBe(1);
    expect(r.runner.calls.map((c) => [c.bin, ...c.argv])).toEqual([
      ['qw', 'whoami', '--context', SSFB_QW],
      ['qw', 'whoami', '--context', ATSPL_QW],
    ]);
    expect(r.probe.calls).toEqual([
      { host: '127.0.0.1', port: 55432 },
      { host: 'atspl-db.fixture.invalid', port: 65432 },
      { host: '203.0.113.9', port: 5432 },
    ]);
    expect(r.result.steps).toEqual([
      { id: 'tunnel', entity: 'ssfb', status: 'ok' },
      { id: 'qw-login', entity: 'ssfb', status: 'ok' },
      { id: 'qw-login', entity: 'atspl', status: 'ok' },
      { id: 'probe', entity: 'ssfb', status: 'ok' },
      { id: 'probe', entity: 'atspl', status: 'ok' },
      { id: 'probe', entity: 'rtl', status: 'ok' },
    ]);
  });

  test('a failing tunnel gives one warning, the other steps still run and it resolves', async () => {
    const tunnel = tunnelOf({ state: 'down', owned: false, listening: false, started: false, message: 'SSFB DB tunnel did not start', error: 'the bastion is unreachable (exit 255)', keys: ['SSFB_DB_TUNNEL_BASTION'] });
    const r = await run({ tunnel, probe: probeOf({ '127.0.0.1': true }) });
    const t = warningsFor(r.result, 'tunnel');
    expect(t).toHaveLength(1);
    expect(t[0]?.entity).toBe('ssfb');
    expect(t[0]?.message).toContain('the bastion is unreachable');
    expect(t[0]?.fix).toContain('triage tunnel up');
    expect(bins(r.runner)).toEqual(['qw', 'qw']);
    expect(r.probe.calls).toHaveLength(3);
    expect(stepOf(r.result, 'tunnel', 'ssfb')).toEqual([{ id: 'tunnel', entity: 'ssfb', status: 'warn' }]);
  });

  test('a tunnel that throws becomes a warning and the run goes on', async () => {
    const r = await run({ tunnel: tunnelOf(new Error(`ssh to ${SSFB_DB} exploded`)) });
    expect(warningsFor(r.result, 'tunnel')).toHaveLength(1);
    expect(bins(r.runner)).toEqual(['qw', 'qw']);
    expect(r.probe.calls).toHaveLength(3);
    expectNoValues(r.result);
  });

  test('a disabled tunnel warns with the keys to set', async () => {
    const tunnel = tunnelOf({ state: 'disabled', owned: false, listening: false, started: false, message: 'SSFB DB tunnel is off: SSFB_DB_TUNNEL_BASTION is blank', keys: ['SSFB_DB_TUNNEL_BASTION'] });
    const r = await run({ tunnel });
    const [w] = warningsFor(r.result, 'tunnel');
    expect(w?.fix).toBe('set SSFB_DB_TUNNEL_BASTION, or set SSFB_DB_TUNNEL_REQUIRED=false');
  });

  test('SSFB_DB_TUNNEL_REQUIRED=false does not start the tunnel', async () => {
    const r = await run({ overrides: { SSFB_DB_TUNNEL_REQUIRED: 'false' } });
    expect(r.tunnel.calls).toBe(0);
    expect(stepOf(r.result, 'tunnel', 'ssfb')).toEqual([{ id: 'tunnel', entity: 'ssfb', status: 'skipped' }]);
  });

  test('ssfb not enabled means no tunnel', async () => {
    const r = await run({ overrides: { TRIAGE_ENTITIES: 'atspl,rtl' }, script: [qwOk(ATSPL_QW)] });
    expect(r.tunnel.calls).toBe(0);
    expect(r.result.steps.some((s) => s.entity === 'ssfb')).toBe(false);
  });

  test('the ssfb cbs flag false gives no aws or kubectl calls', async () => {
    const r = await run({ isTty: true });
    expect(bins(r.runner).filter((b) => b === 'aws' || b === 'kubectl')).toEqual([]);
    expect(r.result.steps.some((s) => s.id === 'aws-login' || s.id === 'kube-context')).toBe(false);
    expect(r.runner.unscripted).toEqual([]);
  });

  test('cbs flag true: a valid session and a known context make aws sts and kubectl calls only', async () => {
    const r = await run({
      overrides: { SSFB_CBS_VIA_KUBECTL_ENABLED: 'true' },
      script: [{ bin: 'aws', argv: STS }, kubeList('other', SSFB_CONTEXT), qwOk(SSFB_QW), qwOk(ATSPL_QW)],
    });
    expect(r.result.warnings).toEqual([]);
    expect(r.runner.calls.map((c) => [c.bin, ...c.argv]).slice(0, 2)).toEqual([['aws', ...STS], ['kubectl', ...CONTEXTS]]);
    expect(stepOf(r.result, 'aws-login', 'ssfb')).toEqual([{ id: 'aws-login', entity: 'ssfb', status: 'ok' }]);
    expect(stepOf(r.result, 'kube-context', 'ssfb')).toEqual([{ id: 'kube-context', entity: 'ssfb', status: 'ok' }]);
  });

  test('cbs flag true and a blank SSFB_AWS_PROFILE gives a warning naming SSFB_AWS_PROFILE', async () => {
    const r = await run({
      overrides: { SSFB_CBS_VIA_KUBECTL_ENABLED: 'true', SSFB_AWS_PROFILE: '' },
      script: [kubeList(SSFB_CONTEXT), qwOk(SSFB_QW), qwOk(ATSPL_QW)],
      isTty: true,
    });
    const [w, ...rest] = warningsFor(r.result, 'aws-login');
    expect(rest).toEqual([]);
    expect(w?.entity).toBe('ssfb');
    expect(w?.message).toContain('SSFB_AWS_PROFILE');
    expect(w?.fix).toContain('SSFB_AWS_PROFILE');
    expect(bins(r.runner)).not.toContain('aws');
    expect(r.runner.unscripted).toEqual([]);
  });

  test('isTty false with an expired SSO session warns with the command and never runs aws sso login', async () => {
    const r = await run({
      overrides: { SSFB_CBS_VIA_KUBECTL_ENABLED: 'true' },
      script: [{ bin: 'aws', argv: STS, result: { exitCode: 255, stderr: `Error loading SSO Token for ${SSFB_PROFILE}` } }, kubeList(SSFB_CONTEXT), qwOk(SSFB_QW), qwOk(ATSPL_QW)],
      isTty: false,
    });
    expect(r.runner.calls.some((c) => c.bin === 'aws' && c.argv[0] === 'sso')).toBe(false);
    expect(r.runner.unscripted).toEqual([]);
    const [w] = warningsFor(r.result, 'aws-login');
    expect(w?.fix).toBe('aws sso login --profile $SSFB_AWS_PROFILE');
    expect(w?.message).toContain('not a terminal');
    // The kube context check still runs.
    expect(bins(r.runner)).toContain('kubectl');
    expectNoValues(r.result);
  });

  test('isTty true with an expired SSO session runs aws sso login and checks again', async () => {
    let sts = 0;
    const r = await run({
      overrides: { SSFB_CBS_VIA_KUBECTL_ENABLED: 'true' },
      script: [
        { bin: 'aws', argv: STS, result: () => ({ exitCode: sts++ === 0 ? 255 : 0 }) },
        { bin: 'aws', argv: SSO, times: 1 },
        kubeList(SSFB_CONTEXT),
        qwOk(SSFB_QW),
        qwOk(ATSPL_QW),
      ],
      isTty: true,
    });
    expect(r.runner.calls.filter((c) => c.bin === 'aws').map((c) => c.argv.slice(0, 2).join(' '))).toEqual([
      'sts get-caller-identity',
      'sso login',
      'sts get-caller-identity',
    ]);
    expect(warningsFor(r.result, 'aws-login')).toEqual([]);
    expect(stepOf(r.result, 'aws-login', 'ssfb')).toEqual([{ id: 'aws-login', entity: 'ssfb', status: 'ok' }]);
  });

  test('isTty true and a failed aws sso login gives a warning with the command', async () => {
    const r = await run({
      overrides: { SSFB_CBS_VIA_KUBECTL_ENABLED: 'true' },
      script: [{ bin: 'aws', argv: STS, result: { exitCode: 255 } }, { bin: 'aws', argv: SSO, result: { exitCode: 1 } }, kubeList(SSFB_CONTEXT), qwOk(SSFB_QW), qwOk(ATSPL_QW)],
      isTty: true,
    });
    const [w] = warningsFor(r.result, 'aws-login');
    expect(w?.message).toContain('did not complete');
    expect(w?.fix).toBe('aws sso login --profile $SSFB_AWS_PROFILE');
  });

  test('a missing aws binary warns to install it and does not try to log in', async () => {
    const r = await run({
      overrides: { SSFB_CBS_VIA_KUBECTL_ENABLED: 'true' },
      script: [{ bin: 'aws', argv: STS, result: { exitCode: null, spawnError: 'ENOENT' } }, kubeList(SSFB_CONTEXT), qwOk(SSFB_QW), qwOk(ATSPL_QW)],
      isTty: true,
    });
    expect(r.runner.calls.filter((c) => c.bin === 'aws')).toHaveLength(1);
    expect(warningsFor(r.result, 'aws-login')[0]?.fix).toContain('install the AWS CLI');
  });

  test('a kube context missing from the kubeconfig warns with aws eks update-kubeconfig', async () => {
    const r = await run({
      overrides: { SSFB_CBS_VIA_KUBECTL_ENABLED: 'true' },
      script: [{ bin: 'aws', argv: STS }, kubeList('someone-else'), qwOk(SSFB_QW), qwOk(ATSPL_QW)],
    });
    const [w] = warningsFor(r.result, 'kube-context');
    expect(w?.message).toContain('$SSFB_KUBE_CONTEXT');
    expect(w?.fix).toBe('aws eks update-kubeconfig --name <cluster-name> --alias $SSFB_KUBE_CONTEXT --profile $SSFB_AWS_PROFILE');
    expectNoValues(r.result);
  });

  test('a blank kube context warns without calling kubectl', async () => {
    const r = await run({
      overrides: { SSFB_CBS_VIA_KUBECTL_ENABLED: 'true', SSFB_KUBE_CONTEXT: '' },
      script: [{ bin: 'aws', argv: STS }, qwOk(SSFB_QW), qwOk(ATSPL_QW)],
    });
    expect(bins(r.runner)).not.toContain('kubectl');
    expect(warningsFor(r.result, 'kube-context')[0]?.message).toContain('SSFB_KUBE_CONTEXT');
  });

  test('an unsafe AWS profile value is refused before any call and named by key', async () => {
    const r = await run({
      overrides: { SSFB_CBS_VIA_KUBECTL_ENABLED: 'true', SSFB_AWS_PROFILE: 'prof;rm' },
      script: [kubeList(SSFB_CONTEXT), qwOk(SSFB_QW), qwOk(ATSPL_QW)],
    });
    expect(bins(r.runner)).not.toContain('aws');
    const [w] = warningsFor(r.result, 'aws-login');
    expect(w?.message).toContain('SSFB_AWS_PROFILE');
    expect(w?.message).not.toContain('prof;rm');
  });

  test('qw whoami exit non-zero for atspl gives a warning whose fix is qw login --context $ATSPL_QW_CONTEXT', async () => {
    const r = await run({ script: [qwOk(SSFB_QW), qwOk(ATSPL_QW, 1)] });
    const q = warningsFor(r.result, 'qw-login');
    expect(q).toHaveLength(1);
    expect(q[0]?.entity).toBe('atspl');
    expect(q[0]?.fix).toBe('qw login --context $ATSPL_QW_CONTEXT');
    expect(stepOf(r.result, 'qw-login', 'ssfb')).toEqual([{ id: 'qw-login', entity: 'ssfb', status: 'ok' }]);
    expect(r.probe.calls).toHaveLength(3);
    expectNoValues(r.result);
  });

  test('a custom QW_BIN is run and shown as $QW_BIN', async () => {
    const r = await run({
      overrides: { QW_BIN: '/opt/fixture/qw' },
      script: [
        { bin: '/opt/fixture/qw', argv: ['whoami', '--context', SSFB_QW] },
        { bin: '/opt/fixture/qw', argv: ['whoami', '--context', ATSPL_QW], result: { exitCode: 1 } },
      ],
    });
    expect(warningsFor(r.result, 'qw-login')[0]?.fix).toBe('$QW_BIN login --context $ATSPL_QW_CONTEXT');
    expect(JSON.stringify(r.result)).not.toContain('/opt/fixture');
  });

  test('a missing qw binary warns once per entity', async () => {
    const enoent = { exitCode: null, spawnError: 'ENOENT' };
    const r = await run({ script: [{ ...qwOk(SSFB_QW), result: enoent }, { ...qwOk(ATSPL_QW), result: enoent }] });
    const q = warningsFor(r.result, 'qw-login');
    expect(q.map((w) => w.entity)).toEqual(['ssfb', 'atspl']);
    expect(q[0]?.message).toContain('could not be started');
  });

  test('http-transport entities get no qw calls', async () => {
    const r = await run({
      overrides: {
        SSFB_QUICKWIT_TRANSPORT: 'http',
        SSFB_QUICKWIT_URL: 'http://ssfb-logs.fixture.invalid:7080',
        SSFB_QUICKWIT_AUTH: 'none',
        ATSPL_QUICKWIT_TRANSPORT: 'http',
      },
      script: [],
    });
    expect(bins(r.runner)).not.toContain('qw');
    expect(r.runner.unscripted).toEqual([]);
    expect(r.result.steps.some((s) => s.id === 'qw-login')).toBe(false);
    // The ssfb http Quickwit URL is probed.
    expect(r.probe.calls).toContainEqual({ host: 'ssfb-logs.fixture.invalid', port: 7080 });
  });

  test('an unreachable host warns with its keys and never the host', async () => {
    const r = await run({ probe: probeOf({ 'atspl-db.fixture.invalid': true, '203.0.113.9': 'throw' }) });
    const p = warningsFor(r.result, 'probe');
    expect(p.map((w) => [w.entity, w.message])).toEqual([
      ['atspl', 'no TCP answer from the host in $ATSPL_PACKAGE_DB_URL'],
      ['rtl', 'no TCP answer from the host in $RTL_BANKING_DB_URL'],
    ]);
    expect(stepOf(r.result, 'probe', 'ssfb')).toEqual([{ id: 'probe', entity: 'ssfb', status: 'ok' }]);
    expectNoValues(r.result);
  });

  test('a loopback host points at the tunnel', async () => {
    const r = await run({ probe: probeOf({ '127.0.0.1': true }) });
    expect(warningsFor(r.result, 'probe')[0]?.fix).toBe('triage tunnel status');
  });
});

describe('server mode', () => {
  test('makes probes only and warns for qw-transport entities', async () => {
    const r = await run({ overrides: { TRIAGE_DEPLOY_MODE: 'server', SSFB_CBS_VIA_KUBECTL_ENABLED: 'true' }, script: [], isTty: true });
    expect(r.result.mode).toBe('server');
    expect(r.runner.calls).toEqual([]);
    expect(r.runner.unscripted).toEqual([]);
    expect(r.tunnel.calls).toBe(0);
    expect(r.probe.calls).toHaveLength(3);
    const q = warningsFor(r.result, 'qw-transport');
    expect(q.map((w) => w.entity)).toEqual(['ssfb', 'atspl', 'rtl']);
    expect(q[1]?.message).toContain('no headless login');
    expect(q[1]?.fix).toBe('set ATSPL_QUICKWIT_TRANSPORT=http and fill ATSPL_QUICKWIT_URL and ATSPL_QUICKWIT_AUTH');
    expect(r.result.steps.some((s) => ['tunnel', 'aws-login', 'kube-context', 'qw-login'].includes(s.id))).toBe(false);
  });

  test('an entity on http gets no headless-login warning', async () => {
    const r = await run({
      overrides: { TRIAGE_DEPLOY_MODE: 'server', ATSPL_QUICKWIT_TRANSPORT: 'http', SSFB_QUICKWIT_TRANSPORT: 'http', RTL_QUICKWIT_TRANSPORT: 'http' },
      script: [],
    });
    expect(warningsFor(r.result, 'qw-transport')).toEqual([]);
    expect(r.result.warnings).toEqual([]);
  });
});

describe('unknown mode', () => {
  test("'prod' gives a warning and probe-only behaviour", async () => {
    const r = await run({ overrides: { TRIAGE_DEPLOY_MODE: 'prod', SSFB_CBS_VIA_KUBECTL_ENABLED: 'true' }, script: [], isTty: true });
    expect(r.result.mode).toBe('unknown');
    const d = warningsFor(r.result, 'deploy-mode');
    expect(d).toHaveLength(1);
    expect(d[0]?.message).toContain('TRIAGE_DEPLOY_MODE');
    expect(d[0]?.message).not.toContain('prod');
    expect(r.runner.calls).toEqual([]);
    expect(r.tunnel.calls).toBe(0);
    expect(r.probe.calls).toHaveLength(3);
    expect(warningsFor(r.result, 'qw-transport')).toEqual([]);
  });

  test('parseDeployMode', () => {
    expect(parseDeployMode('local')).toBe('local');
    expect(parseDeployMode(' Server ')).toBe('server');
    expect(parseDeployMode('')).toBe('unknown');
    expect(parseDeployMode('prod')).toBe('unknown');
  });
});

describe('never rejects', () => {
  test('a runner, probe and tunnel that all throw give warnings only', async () => {
    const { config, registry } = setup({ SSFB_CBS_VIA_KUBECTL_ENABLED: 'true' });
    const runner: ExecRunner = {
      run: async () => {
        throw new Error(`spawn failed for ${SSFB_PROFILE}`);
      },
    };
    const probe: TcpProbe = async (host) => {
      throw new Error(`refused ${host}`);
    };
    const res = await runPreflight({ config, registry, runner, tcpProbe: probe, tunnel: tunnelOf(new Error('boom')), isTty: true });
    expect(res.mode).toBe('local');
    expect(res.warnings.map((w) => [w.step, w.entity])).toEqual([
      ['tunnel', 'ssfb'],
      ['aws-login', 'ssfb'],
      ['kube-context', 'ssfb'],
      ['qw-login', 'ssfb'],
      ['qw-login', 'atspl'],
      ['probe', 'ssfb'],
      ['probe', 'atspl'],
      ['probe', 'rtl'],
    ]);
    expectNoValues(res);
  });

  test('a registry that throws becomes warnings', async () => {
    const { config, registry } = setup();
    const broken = new Proxy(registry, {
      get(target, prop, receiver) {
        if (prop === 'quickwit' || prop === 'services' || prop === 'cbsEnabled') {
          return () => {
            throw new Error(`registry exploded near ${ATSPL_DB}`);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const res = await runPreflight({ config, registry: broken, runner: createFakeRunner([]), tcpProbe: probeOf(), tunnel: tunnelOf(), isTty: false });
    expect(res.warnings.length).toBeGreaterThan(0);
    expect(res.warnings.every((w) => w.message.includes('failed unexpectedly'))).toBe(true);
    expectNoValues(res);
  });

  test('a broken config resolves with one warning', async () => {
    const { registry } = setup();
    const res = await runPreflight({ config: {} as Config, registry, runner: createFakeRunner([]), tcpProbe: probeOf(), isTty: false });
    expect(res.mode).toBe('unknown');
    expect(res.warnings.map((w) => w.step)).toEqual(['preflight']);
  });
});

describe('probe targets', () => {
  test('hostPort reads DSNs and URLs with default ports', () => {
    expect(hostPort('postgresql://u:p@db.fixture.invalid/x')).toEqual({ host: 'db.fixture.invalid', port: 5432 });
    expect(hostPort('postgresql://<user>:<password>@localhost:55432/x')).toEqual({ host: 'localhost', port: 55432 });
    expect(hostPort('https://api.fixture.invalid/base')).toEqual({ host: 'api.fixture.invalid', port: 443 });
    expect(hostPort('http://[::1]:8080')).toEqual({ host: '::1', port: 8080 });
    expect(hostPort('not a url')).toBeUndefined();
    expect(hostPort('ftp://files.fixture.invalid/x')).toBeUndefined();
  });

  test('keys that share a host are probed once and all named', async () => {
    const shared = 'postgresql://reader:hunter2@127.0.0.1:55432/';
    const { registry } = setup({ SSFB_RHYTHM_DB_URL: `${shared}rhythm_db`, SSFB_GUARDIAN_DB_URL: `${shared}guardian_db` });
    const { targets } = probeTargets(registry, 'ssfb');
    expect(targets).toEqual([{ host: '127.0.0.1', port: 55432, keys: ['SSFB_HARBOR_DB_URL', 'SSFB_RHYTHM_DB_URL', 'SSFB_GUARDIAN_DB_URL'] }]);
  });

  test('a value with no host is reported by key', async () => {
    const r = await run({ overrides: { RTL_BANKING_DB_URL: 'banking_db' } });
    const [w] = warningsFor(r.result, 'probe');
    expect(w).toEqual({ step: 'probe', entity: 'rtl', message: 'could not read a host and port from $RTL_BANKING_DB_URL', fix: 'check the format of RTL_BANKING_DB_URL' });
  });

  test('cbs-transport APIs are not probed', async () => {
    const { registry } = setup({ SSFB_CBS_GATEWAY_URL: 'https://finacle.fixture.invalid' });
    const { targets } = probeTargets(registry, 'ssfb');
    expect(targets.some((t) => t.host === 'finacle.fixture.invalid')).toBe(false);
  });
});

describe('runResumePreflight', () => {
  test('mock mode skips with no runner, tunnel or probe call', async () => {
    const r = await run({ fn: runResumePreflight, overrides: { TRIAGE_MOCK_MODE: 'true' }, script: [] });
    expect(r.result).toEqual({ mode: 'local', skipped: 'mock', steps: [], warnings: [] });
    expect(r.tunnel.calls).toBe(0);
    expect(r.runner.calls).toEqual([]);
    expect(r.probe.calls).toEqual([]);
  });

  test('local mode repeats the tunnel step and nothing else', async () => {
    const r = await run({ fn: runResumePreflight, script: [] });
    expect(r.result.mode).toBe('local');
    expect(r.result.skipped).toBeUndefined();
    expect(r.tunnel.calls).toBe(1);
    expect(r.result.steps).toEqual([{ id: 'tunnel', entity: 'ssfb', status: 'ok' }]);
    expect(r.result.warnings).toEqual([]);
    expect(r.runner.calls).toEqual([]);
    expect(r.probe.calls).toEqual([]);
  });

  test('a tunnel that does not come up is one warning with the fix, and no value leaks', async () => {
    const tunnel = tunnelOf({ state: 'down', owned: false, listening: false, started: false, message: 'SSFB DB tunnel did not start', error: 'the bastion is unreachable' });
    const r = await run({ fn: runResumePreflight, tunnel, script: [] });
    expect(stepOf(r.result, 'tunnel', 'ssfb')).toEqual([{ id: 'tunnel', entity: 'ssfb', status: 'warn' }]);
    const [w] = warningsFor(r.result, 'tunnel');
    expect(w?.message).toContain('the bastion is unreachable');
    expect(w?.fix).toContain('triage tunnel up');
    expectNoValues(r.result);
  });

  test('a tunnel that throws is a warning, not a rejection', async () => {
    const r = await run({ fn: runResumePreflight, tunnel: tunnelOf(new Error(`ssh to ${SSFB_DB} exploded`)), script: [] });
    expect(warningsFor(r.result, 'tunnel')).toHaveLength(1);
    expectNoValues(r.result);
  });

  test('SSFB_DB_TUNNEL_REQUIRED=false records the step as skipped', async () => {
    const r = await run({ fn: runResumePreflight, overrides: { SSFB_DB_TUNNEL_REQUIRED: 'false' }, script: [] });
    expect(r.tunnel.calls).toBe(0);
    expect(r.result.steps).toEqual([{ id: 'tunnel', entity: 'ssfb', status: 'skipped' }]);
    expect(r.result.warnings).toEqual([]);
  });

  test('server mode has no tunnel step and makes no call', async () => {
    const r = await run({ fn: runResumePreflight, overrides: { TRIAGE_DEPLOY_MODE: 'server' }, script: [] });
    expect(r.result).toEqual({ mode: 'server', steps: [], warnings: [] });
    expect(r.tunnel.calls).toBe(0);
    expect(r.runner.calls).toEqual([]);
    expect(r.probe.calls).toEqual([]);
  });
});
