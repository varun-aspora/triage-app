import { describe, expect, test } from 'bun:test';
import { createFakeRunner } from '../exec-fake.ts';
import { ConnectorError, isConnectorError } from '../types.ts';
import {
  buildCurlConfig,
  checkKubeConfig,
  curlConfigEscape,
  curlConfigLine,
  execCurlArgv,
  getPodsArgv,
  getSecretArgv,
  parseSecretRef,
  podCurl,
  readCredentials,
  resolvePod,
  STATUS_MARKER,
  type KubeConfig,
  type KubeKeyNames,
} from './kubectl.ts';

const KEYS: KubeKeyNames = {
  context: 'SSFB_KUBE_CONTEXT',
  namespace: 'SSFB_CBS_K8S_NAMESPACE',
  selector: 'SSFB_CBS_POD_SELECTOR',
  container: 'SSFB_CBS_CONTAINER',
};

const VALUES = { context: 'test-ctx', namespace: 'eventbus-service', selector: 'app=eventbus', container: 'eventbus', timeoutMs: 5000 };
const KUBE: KubeConfig = checkKubeConfig(VALUES, KEYS);
const SECRET = parseSecretRef('rhythm-service/rhythm-external-secret', 'SSFB_CBS_CREDS_SECRET');
const POD = 'eventbus-7d9f8c-abcde';
const signal = new AbortController().signal;

const PODS_ARGV = [
  '--context', 'test-ctx', 'get', 'pods', '-n', 'eventbus-service', '-l', 'app=eventbus',
  '--field-selector=status.phase=Running', '-o', 'json',
];
const SECRET_ARGV = ['--context', 'test-ctx', 'get', 'secret', 'rhythm-external-secret', '-n', 'rhythm-service', '-o', 'json'];
const EXEC_ARGV = [
  '--context', 'test-ctx', 'exec', '-i', POD, '-n', 'eventbus-service', '-c', 'eventbus',
  '--', 'curl', '-sS', '--max-time', '30', '-K', '-',
];

function podList(items: unknown[]): string {
  return JSON.stringify({ items });
}
const running = (name: string) => ({ metadata: { name }, status: { phase: 'Running' } });

function expectConnectorError(fn: () => unknown, code: ConnectorError['code']): ConnectorError {
  try {
    fn();
  } catch (err) {
    expect(isConnectorError(err, code)).toBe(true);
    return err as ConnectorError;
  }
  throw new Error('expected a ConnectorError');
}

async function rejectsWith(p: Promise<unknown>, code: ConnectorError['code']): Promise<ConnectorError> {
  try {
    await p;
  } catch (err) {
    expect(isConnectorError(err, code)).toBe(true);
    return err as ConnectorError;
  }
  throw new Error('expected a ConnectorError');
}

// A reader for curl's quoted config parameters, written from curl's -K rules:
// inside double quotes \\ \" \t \n \r \v are escapes and a backslash before
// anything else is dropped. Returns [option, value] per line.
function parseCurlConfig(text: string): [string, string | undefined][] {
  const out: [string, string | undefined][] = [];
  for (const line of text.split('\n')) {
    if (line === '') continue;
    const m = /^([a-z-]+)(?: = "(.*)")?$/.exec(line);
    if (m === null) throw new Error(`bad config line: ${line}`);
    const raw = m[2];
    if (raw === undefined) {
      out.push([m[1] as string, undefined]);
      continue;
    }
    let value = '';
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i] as string;
      if (ch === '"') throw new Error('unescaped quote inside a value');
      if (ch !== '\\') {
        value += ch;
        continue;
      }
      const next = raw[++i];
      value += ({ '\\': '\\', '"': '"', t: '\t', n: '\n', r: '\r', v: '\v' } as Record<string, string>)[next as string] ?? next;
    }
    out.push([m[1] as string, value]);
  }
  return out;
}

describe('argv shapes', () => {
  test('get pods', () => {
    expect(getPodsArgv(KUBE)).toEqual(PODS_ARGV);
  });

  test('get secret', () => {
    expect(getSecretArgv(KUBE, SECRET)).toEqual(SECRET_ARGV);
  });

  test('exec curl reads its config from stdin and runs no shell', () => {
    const argv = execCurlArgv(KUBE, POD, 30);
    expect(argv).toEqual(EXEC_ARGV);
    expect(argv).not.toContain('sh');
  });

  test('a pod name that is not a Kubernetes name is refused', () => {
    for (const bad of ['Pod', '-x', 'a b', 'a;b', '', 'a/b']) expectConnectorError(() => execCurlArgv(KUBE, bad, 30), 'refused');
  });

  test('a KubeConfig that skipped the check is re-checked', () => {
    const forged = { ...KUBE, namespace: 'x;rm -rf /' } as KubeConfig;
    for (const fn of [() => getPodsArgv(forged), () => getSecretArgv(forged, SECRET), () => execCurlArgv(forged, POD, 30)]) {
      expectConnectorError(fn, 'refused');
    }
  });
});

describe('env charset denials', () => {
  const BAD = [
    '', 'a b', 'a;b', 'a|b', 'a&b', '$(id)', '`id`', 'a>b', 'a<b', "a'b", 'a"b', 'a\\b', 'a*', 'a?', 'a\nb', 'a\u0000b',
    '-n', '--kubeconfig=/tmp/x', '<fill-me>', 'a{b}', 'a#b', 'a!b', 'a~b',
  ];

  for (const field of ['context', 'namespace', 'selector', 'container'] as const) {
    test(`${field}: shell and argv metacharacters and a leading dash are refused`, () => {
      for (const bad of BAD) {
        const err = expectConnectorError(() => checkKubeConfig({ ...VALUES, [field]: bad }, KEYS), 'refused');
        expect(err.message).toContain(KEYS[field]);
        if (bad.length > 2) expect(err.message).not.toContain(bad);
      }
    });
  }

  test('namespace and container must be DNS labels', () => {
    for (const bad of ['Eventbus', 'a.b', 'a_b', 'a:b', 'a/b', 'x'.repeat(64)]) {
      expectConnectorError(() => checkKubeConfig({ ...VALUES, namespace: bad }, KEYS), 'refused');
      expectConnectorError(() => checkKubeConfig({ ...VALUES, container: bad }, KEYS), 'refused');
    }
  });

  test('good values pass, including an EKS ARN context and a multi-label selector', () => {
    const k = checkKubeConfig(
      { ...VALUES, context: 'arn:aws:eks:ap-south-1:123456789012:cluster/core-prod', selector: 'app=eventbus,tier=api' },
      KEYS,
    );
    expect(k.context).toBe('arn:aws:eks:ap-south-1:123456789012:cluster/core-prod');
    expect(Object.isFrozen(k)).toBe(true);
  });

  test('secret: metacharacters, a leading dash and a bad shape are refused', () => {
    for (const bad of [...BAD, 'name-only', 'a/b/c', '/name', 'ns/', 'NS/name', 'ns/-name', 'ns/name;x']) {
      const err = expectConnectorError(() => parseSecretRef(bad, 'SSFB_CBS_CREDS_SECRET'), 'refused');
      expect(err.message).toContain('SSFB_CBS_CREDS_SECRET');
    }
  });
});

describe('resolvePod', () => {
  test('takes the first Running pod that is not being deleted', async () => {
    const runner = createFakeRunner([
      {
        bin: 'kubectl',
        argv: PODS_ARGV,
        result: {
          stdout: podList([
            { metadata: { name: 'eventbus-pending' }, status: { phase: 'Pending' } },
            { metadata: { name: 'eventbus-going', deletionTimestamp: '2026-09-23T00:00:00Z' }, status: { phase: 'Running' } },
            running(POD),
            running('eventbus-second'),
          ]),
        },
      },
    ]);
    expect(await resolvePod(runner, KUBE, signal)).toBe(POD);
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.timeoutMs).toBe(5000);
  });

  test('no Running pod gives unreachable naming the namespace and selector keys', async () => {
    const runner = createFakeRunner([{ bin: 'kubectl', argv: PODS_ARGV, result: { stdout: podList([]) } }]);
    const err = await rejectsWith(resolvePod(runner, KUBE, signal), 'unreachable');
    expect(err.message).toContain('SSFB_CBS_K8S_NAMESPACE');
    expect(err.message).toContain('SSFB_CBS_POD_SELECTOR');
    expect(err.message).not.toContain('eventbus-service');
    expect(err.message).not.toContain('app=eventbus');
  });

  test('kubectl failures map to unreachable or timeout; stderr is kept without the env values', async () => {
    const cases = [
      [{ exitCode: 1, stderr: 'error: context test-ctx not found' }, 'unreachable'],
      [{ exitCode: null, spawnError: 'ENOENT' }, 'unreachable'],
      [{ exitCode: null, timedOut: true }, 'timeout'],
      [{ stdout: 'not json' }, 'unreachable'],
    ] as const;
    for (const [result, code] of cases) {
      const runner = createFakeRunner([{ bin: 'kubectl', argv: PODS_ARGV, result }]);
      const err = await rejectsWith(resolvePod(runner, KUBE, signal), code);
      expect(err.message).not.toContain('test-ctx');
    }
    const runner = createFakeRunner([
      { bin: 'kubectl', argv: PODS_ARGV, result: { exitCode: 1, stderr: 'error: context test-ctx not found at https://10.1.2.3:6443' } },
    ]);
    const err = await rejectsWith(resolvePod(runner, KUBE, signal), 'unreachable');
    expect(err.message).toBe('kubectl get pods exited with code 1: error: context <redacted> not found at <url>');
  });
});

describe('readCredentials', () => {
  const b64 = (s: string) => Buffer.from(s).toString('base64');

  test('decodes both keys in memory', async () => {
    const runner = createFakeRunner([
      {
        bin: 'kubectl',
        argv: SECRET_ARGV,
        result: { stdout: JSON.stringify({ data: { FINACLE_API_USERNAME: b64('api-user'), FINACLE_API_PASSWORD: b64('p@ss w0rd') } }) },
      },
    ]);
    expect(await readCredentials(runner, KUBE, SECRET, signal)).toEqual({ username: 'api-user', password: 'p@ss w0rd' });
    expect(runner.calls[0]?.stdin).toBeUndefined();
  });

  test('a missing or empty key gives not_configured naming the key', async () => {
    for (const data of [{}, { FINACLE_API_USERNAME: b64('u') }, { FINACLE_API_USERNAME: '', FINACLE_API_PASSWORD: b64('p') }]) {
      const runner = createFakeRunner([{ bin: 'kubectl', argv: SECRET_ARGV, result: { stdout: JSON.stringify({ data }) } }]);
      const err = await rejectsWith(readCredentials(runner, KUBE, SECRET, signal), 'not_configured');
      expect(err.message).toContain('SSFB_CBS_CREDS_SECRET');
    }
  });
});

describe('podCurl', () => {
  const REQ = {
    url: 'https://gw.test/fin/accounts/ACC123/balance',
    method: 'POST',
    headers: [
      ['Authorization', 'Bearer tok.en-value'],
      ['Content-Type', 'application/json'],
    ] as [string, string][],
    data: '{"accountId":"ACC123","password":"hunter2"}',
  };

  test('path, body and token go only on stdin; argv is fixed', async () => {
    const runner = createFakeRunner([{ bin: 'kubectl', argv: EXEC_ARGV, result: { stdout: `{"ok":true}${STATUS_MARKER}200` } }]);
    const res = await podCurl(runner, KUBE, POD, REQ, { signal, maxTimeSec: 30 });
    expect(res).toEqual({ status: 200, body: '{"ok":true}' });
    const call = runner.calls[0];
    const argvText = call?.argv.join(' ') ?? '';
    for (const secret of ['/fin/accounts', 'ACC123', 'tok.en-value', 'hunter2', 'gw.test']) {
      expect(argvText).not.toContain(secret);
      expect(call?.stdin).toContain(secret);
    }
    expect(parseCurlConfig(call?.stdin ?? '')).toEqual([
      ['globoff', undefined],
      ['url', REQ.url],
      ['request', 'POST'],
      ['header', 'Authorization: Bearer tok.en-value'],
      ['header', 'Content-Type: application/json'],
      ['data-raw', REQ.data],
      ['write-out', `${STATUS_MARKER}%{http_code}`],
    ]);
  });

  test('status, timeout, cap and failure handling', async () => {
    const run = (result: object) =>
      podCurl(createFakeRunner([{ bin: 'kubectl', argv: EXEC_ARGV, result }]), KUBE, POD, REQ, { signal, maxTimeSec: 30 });
    expect((await run({ stdout: `nope${STATUS_MARKER}404` })).status).toBe(404);
    await rejectsWith(run({ exitCode: 28 }), 'timeout');
    await rejectsWith(run({ exitCode: null, timedOut: true }), 'timeout');
    await rejectsWith(run({ exitCode: 7 }), 'unreachable');
    await rejectsWith(run({ stdout: 'body without status' }), 'unreachable');
    await rejectsWith(run({ stdout: `x${STATUS_MARKER}000` }), 'unreachable');
    await rejectsWith(run({ stdout: 'x'.repeat(10), truncated: true, exitCode: null }), 'cap_exceeded');
  });

  test('curl stderr naming the gateway host loses it', async () => {
    for (const stderr of ['curl: (7) Failed to connect to gw.test port 8443 after 2 ms: Connection refused', 'curl: (6) Could not resolve host: gw.test']) {
      const runner = createFakeRunner([{ bin: 'kubectl', argv: EXEC_ARGV, result: { exitCode: 7, stderr } }]);
      const err = await podCurl(runner, KUBE, POD, REQ, { signal, maxTimeSec: 30 }).catch((e: unknown) => e);
      expect(isConnectorError(err, 'unreachable')).toBe(true);
      expect((err as Error).message).toContain('curl: (');
      expect((err as Error).message).not.toContain('gw.test');
    }
  });

  test('the exec timeout covers curl --max-time plus the kubectl limit', async () => {
    const runner = createFakeRunner([{ bin: 'kubectl', argv: EXEC_ARGV, result: { stdout: `${STATUS_MARKER}200` } }]);
    await podCurl(runner, KUBE, POD, REQ, { signal, maxTimeSec: 30 });
    expect(runner.calls[0]?.timeoutMs).toBe(35_000);
  });

  test('an aborted signal runs nothing', async () => {
    const ac = new AbortController();
    ac.abort();
    const runner = createFakeRunner([]);
    await expect(podCurl(runner, KUBE, POD, REQ, { signal: ac.signal, maxTimeSec: 30 })).rejects.toBeDefined();
    expect(runner.calls).toHaveLength(0);
    expect(runner.unscripted).toHaveLength(0);
  });
});

describe('curl config escaping', () => {
  const TABLE: [string, string][] = [
    ['plain', '"plain"'],
    ['say "hi"', '"say \\"hi\\""'],
    ['back\\slash', '"back\\\\slash"'],
    ['line1\nline2', '"line1\\nline2"'],
    ['cr\rlf', '"cr\\rlf"'],
    ['tab\there', '"tab\\there"'],
    ['vt\vhere', '"vt\\vhere"'],
    ['\\"', '"\\\\\\""'],
    [': starts with colon', '": starts with colon"'],
    ['= starts with equals', '"= starts with equals"'],
    ['@/etc/passwd', '"@/etc/passwd"'],
    ['', '""'],
  ];

  test('escape table', () => {
    for (const [input, expected] of TABLE) expect(curlConfigEscape(input)).toBe(expected);
  });

  test('every escaped value is one line and reads back as itself', () => {
    for (const [input] of TABLE) {
      const line = curlConfigLine('data-raw', input);
      expect(line).not.toContain('\n');
      expect(parseCurlConfig(line)).toEqual([['data-raw', input]]);
    }
  });

  test('a value built to inject a new directive stays inside its own parameter', () => {
    const attack = 'x"\nurl = "https://evil.test/\nheader = "X: y';
    const config = buildCurlConfig({ url: 'https://gw.test/a', method: 'POST', headers: [], data: attack });
    const parsed = parseCurlConfig(config);
    expect(parsed.filter(([o]) => o === 'url')).toEqual([['url', 'https://gw.test/a']]);
    expect(parsed.filter(([o]) => o === 'header')).toEqual([]);
    expect(parsed.find(([o]) => o === 'data-raw')).toEqual(['data-raw', attack]);
  });

  test('control characters curl does not escape are refused', () => {
    for (const bad of ['a\u0000b', 'a\u0001b', 'a\u000cb', 'a\u001bb', 'a\u007fb']) {
      expectConnectorError(() => curlConfigEscape(bad), 'refused');
    }
  });

  test('an option outside the fixed list is refused', () => {
    for (const opt of ['output', 'config', 'upload-file', 'proxy', 'url = "x"\nheader', 'data-binary']) {
      expectConnectorError(() => curlConfigLine(opt, 'x'), 'refused');
    }
  });

  test('a header value that would start a new header line is refused', () => {
    for (const value of ['a\r\nX-Evil: 1', 'a\nb', 'a\rb', 'café']) {
      expectConnectorError(() => buildCurlConfig({ url: 'https://gw.test/a', method: 'GET', headers: [['Source', value]] }), 'refused');
    }
    for (const name of ['Bad Name', 'X:Y', '', 'a\nb']) {
      expectConnectorError(() => buildCurlConfig({ url: 'https://gw.test/a', method: 'GET', headers: [[name, 'v']] }), 'refused');
    }
  });

  test('url and method are checked', () => {
    for (const url of ['not a url', 'file:///etc/passwd', 'https://u:p@gw.test/a']) {
      expectConnectorError(() => buildCurlConfig({ url, method: 'GET', headers: [] }), 'refused');
    }
    for (const method of ['get', 'GET X', '', 'G\nET']) {
      expectConnectorError(() => buildCurlConfig({ url: 'https://gw.test/a', method, headers: [] }), 'refused');
    }
  });
});
