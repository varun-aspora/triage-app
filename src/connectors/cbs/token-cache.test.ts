import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createFakeRunner, type FakeCall, type FakeStep } from '../exec-fake.ts';
import { isConnectorError } from '../types.ts';
import { checkKubeConfig, parseSecretRef, STATUS_MARKER } from './kubectl.ts';
import {
  cachePath,
  clearToken,
  getToken,
  jwtExpiryMs,
  oauthUrl,
  readCachedToken,
  REUSE_MARGIN_MS,
  type TokenConfig,
} from './token-cache.ts';

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDataDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'triage-cbs-token-test-')));
  made.push(dir);
  return join(dir, '.data');
}

const KUBE = checkKubeConfig(
  { context: 'test-ctx', namespace: 'eventbus-service', selector: 'app=eventbus', container: 'eventbus', timeoutMs: 5000 },
  { context: 'SSFB_KUBE_CONTEXT', namespace: 'SSFB_CBS_K8S_NAMESPACE', selector: 'SSFB_CBS_POD_SELECTOR', container: 'SSFB_CBS_CONTAINER' },
);
const SECRET = parseSecretRef('rhythm-service/rhythm-external-secret', 'SSFB_CBS_CREDS_SECRET');
const POD = 'eventbus-abc';
const USER = 'finacle-api-user';
const PASS = 'S3cret!pass word';
const NOW = new Date('2026-09-23T10:00:00.000Z');

const SECRET_ARGV = ['--context', 'test-ctx', 'get', 'secret', 'rhythm-external-secret', '-n', 'rhythm-service', '-o', 'json'];
const EXEC_ARGV = [
  '--context', 'test-ctx', 'exec', '-i', POD, '-n', 'eventbus-service', '-c', 'eventbus',
  '--', 'curl', '-sS', '--max-time', '30', '-K', '-',
];

const b64 = (s: string) => Buffer.from(s).toString('base64');
const b64url = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (claims: object) => `${b64url({ alg: 'RS256' })}.${b64url(claims)}.c2ln`;

function config(dataDir: string): TokenConfig {
  return {
    dataDir,
    kube: KUBE,
    pod: POD,
    secret: SECRET,
    gatewayUrl: 'https://gw.test',
    scope: 'urn:test:scope::all',
    maxTimeSec: 30,
  };
}

function ctxAt(now: Date = NOW, signal: AbortSignal = new AbortController().signal) {
  return { signal, now: () => now };
}

function mintSteps(response: object | ((call: FakeCall) => object), status = 200): FakeStep[] {
  return [
    {
      bin: 'kubectl',
      argv: SECRET_ARGV,
      result: { stdout: JSON.stringify({ data: { FINACLE_API_USERNAME: b64(USER), FINACLE_API_PASSWORD: b64(PASS) } }) },
    },
    {
      bin: 'kubectl',
      argv: EXEC_ARGV,
      result: (call) => {
        const body = typeof response === 'function' ? response(call) : response;
        return { stdout: `${JSON.stringify(body)}${STATUS_MARKER}${status}` };
      },
    },
  ];
}

const mints = (calls: readonly FakeCall[]) => calls.filter((c) => c.argv.includes('secret')).length;

function seed(dataDir: string, token: string, expiresAt: number, mode = 0o600): string {
  const path = cachePath(dataDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ access_token: token, expires_at: expiresAt }), { mode });
  chmodSync(path, mode);
  return path;
}

describe('reuse', () => {
  test('a token with more than 30s left is reused without a mint', async () => {
    const dataDir = tempDataDir();
    seed(dataDir, 'cached-token', NOW.getTime() + REUSE_MARGIN_MS + 1);
    const runner = createFakeRunner([]);
    expect(await getToken(ctxAt(), runner, config(dataDir))).toBe('cached-token');
    expect(runner.calls).toHaveLength(0);
    expect(runner.unscripted).toHaveLength(0);
  });

  test('a token with 30s or less left triggers a mint', async () => {
    for (const left of [REUSE_MARGIN_MS, REUSE_MARGIN_MS - 1, 0, -60_000]) {
      const dataDir = tempDataDir();
      seed(dataDir, 'old-token', NOW.getTime() + left);
      const runner = createFakeRunner(mintSteps({ access_token: 'new-token', expires_in: 3600 }));
      expect(await getToken(ctxAt(), runner, config(dataDir))).toBe('new-token');
      expect(mints(runner.calls)).toBe(1);
    }
  });

  test('a cache file others can read, a symlink or junk is not trusted', async () => {
    const future = NOW.getTime() + 3_600_000;
    const setups: ((dataDir: string) => void)[] = [
      (d) => void seed(d, 'loose-token', future, 0o644),
      (d) => {
        const real = join(dirname(d), 'elsewhere.json');
        writeFileSync(real, JSON.stringify({ access_token: 'linked', expires_at: future }), { mode: 0o600 });
        mkdirSync(dirname(cachePath(d)), { recursive: true });
        symlinkSync(real, cachePath(d));
      },
      (d) => {
        mkdirSync(dirname(cachePath(d)), { recursive: true });
        writeFileSync(cachePath(d), 'not json', { mode: 0o600 });
      },
      (d) => {
        mkdirSync(dirname(cachePath(d)), { recursive: true });
        writeFileSync(cachePath(d), JSON.stringify({ access_token: 'bad token\nX: y', expires_at: future }), { mode: 0o600 });
      },
    ];
    for (const setup of setups) {
      const dataDir = tempDataDir();
      setup(dataDir);
      const runner = createFakeRunner(mintSteps({ access_token: 'fresh', expires_in: 3600 }));
      expect(await getToken(ctxAt(), runner, config(dataDir))).toBe('fresh');
      expect(mints(runner.calls)).toBe(1);
    }
  });
});

describe('expiry', () => {
  test('from the JWT exp claim', async () => {
    const dataDir = tempDataDir();
    const exp = Math.floor(NOW.getTime() / 1000) + 900;
    const token = jwt({ sub: 'x', exp });
    // expires_in disagrees on purpose: exp wins.
    const runner = createFakeRunner(mintSteps({ access_token: token, expires_in: 60 }));
    expect(await getToken(ctxAt(), runner, config(dataDir))).toBe(token);
    expect(await readCachedToken(cachePath(dataDir))).toEqual({ access_token: token, expires_at: exp * 1000 });
  });

  test('from expires_in when the token is not a JWT', async () => {
    const dataDir = tempDataDir();
    const runner = createFakeRunner(mintSteps({ access_token: 'opaque-token', expires_in: 3600 }));
    await getToken(ctxAt(), runner, config(dataDir));
    expect(await readCachedToken(cachePath(dataDir))).toEqual({ access_token: 'opaque-token', expires_at: NOW.getTime() + 3_600_000 });
  });

  test('expires_in as a numeric string works too', async () => {
    const dataDir = tempDataDir();
    const runner = createFakeRunner(mintSteps({ access_token: 'opaque-token', expires_in: '120' }));
    await getToken(ctxAt(), runner, config(dataDir));
    expect((await readCachedToken(cachePath(dataDir)))?.expires_at).toBe(NOW.getTime() + 120_000);
  });

  test('a token with no expiry, or one that expires within the margin, is used once and not cached', async () => {
    for (const body of [{ access_token: 'no-expiry' }, { access_token: 'short', expires_in: 20 }]) {
      const dataDir = tempDataDir();
      const runner = createFakeRunner(mintSteps(body));
      expect(await getToken(ctxAt(), runner, config(dataDir))).toBe(body.access_token);
      expect(existsSync(cachePath(dataDir))).toBe(false);
    }
  });

  test('jwtExpiryMs ignores tokens that are not JWTs', () => {
    expect(jwtExpiryMs('abc')).toBeUndefined();
    expect(jwtExpiryMs('a.b.c')).toBeUndefined();
    expect(jwtExpiryMs(jwt({ exp: 'soon' }))).toBeUndefined();
    expect(jwtExpiryMs(jwt({ exp: 100 }))).toBe(100_000);
  });
});

describe('the cache file', () => {
  test('is mode 0600, holds only the token and expiry, and never the credentials', async () => {
    const dataDir = tempDataDir();
    const runner = createFakeRunner(mintSteps({ access_token: 'minted-token', expires_in: 3600, refresh_token: 'rt-value' }));
    await getToken(ctxAt(), runner, config(dataDir));
    const path = cachePath(dataDir);
    expect(path).toBe(join(dataDir, 'cache', 'ssfb-cbs-oauth.json'));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const text = readFileSync(path, 'utf8');
    expect(Object.keys(JSON.parse(text)).sort()).toEqual(['access_token', 'expires_at']);
    for (const secret of [USER, PASS, b64(USER), b64(PASS), encodeURIComponent(PASS), 'rt-value']) {
      expect(text).not.toContain(secret);
    }
    // No temp files are left beside it.
    expect(readdirSync(dirname(path))).toEqual(['ssfb-cbs-oauth.json']);
  });

  test('the credentials travel only on the mint stdin, never in argv', async () => {
    const dataDir = tempDataDir();
    const runner = createFakeRunner(mintSteps({ access_token: 'minted-token', expires_in: 3600 }));
    await getToken(ctxAt(), runner, config(dataDir));
    for (const call of runner.calls) {
      const argv = call.argv.join(' ');
      for (const secret of [USER, PASS, 'urn:test:scope', 'security/oauth', 'gw.test']) expect(argv).not.toContain(secret);
    }
    const stdin = runner.calls.find((c) => c.argv.includes('exec'))?.stdin ?? '';
    const data = /^data-raw = "(.*)"$/m.exec(stdin)?.[1] ?? '';
    const form = new URLSearchParams(data);
    expect(form.get('grant_type')).toBe('password');
    expect(form.get('username')).toBe(USER);
    expect(form.get('password')).toBe(PASS);
    expect(form.get('scope')).toBe('urn:test:scope::all');
    expect(stdin).toContain('url = "https://gw.test/security/oauth"');
    expect(stdin).toContain('request = "POST"');
    expect(stdin).toContain('header = "Content-Type: application/x-www-form-urlencoded"');
  });

  test('the mint writes nothing outside the cache directory', async () => {
    const dataDir = tempDataDir();
    const runner = createFakeRunner(mintSteps({ access_token: 'minted-token', expires_in: 3600 }));
    await getToken(ctxAt(), runner, config(dataDir));
    expect(readdirSync(dataDir)).toEqual(['cache']);
    expect(readdirSync(dirname(dataDir))).toEqual(['.data']);
  });
});

describe('single-flight', () => {
  test('two concurrent calls run one mint', async () => {
    const dataDir = tempDataDir();
    const runner = createFakeRunner(mintSteps({ access_token: 'shared-token', expires_in: 3600 }));
    const [a, b, c] = await Promise.all([
      getToken(ctxAt(), runner, config(dataDir)),
      getToken(ctxAt(), runner, config(dataDir)),
      getToken(ctxAt(), runner, config(dataDir)),
    ]);
    expect([a, b, c]).toEqual(['shared-token', 'shared-token', 'shared-token']);
    expect(mints(runner.calls)).toBe(1);
    expect(runner.calls).toHaveLength(2);
  });

  test('a failed mint does not block the next caller', async () => {
    const dataDir = tempDataDir();
    const failing = createFakeRunner(mintSteps({ error: 'invalid_grant' }, 400));
    await expect(getToken(ctxAt(), failing, config(dataDir))).rejects.toBeDefined();
    const ok = createFakeRunner(mintSteps({ access_token: 'second-try', expires_in: 3600 }));
    expect(await getToken(ctxAt(), ok, config(dataDir))).toBe('second-try');
  });
});

describe('mint failures', () => {
  test('non-200, non-JSON and unusable tokens give unreachable without echoing the body', async () => {
    const cases: [object, number][] = [
      [{ error: 'invalid_grant', user: USER }, 401],
      [{ access_token: 42 }, 200],
      [{ access_token: 'has space' }, 200],
      [{ access_token: '' }, 200],
    ];
    for (const [body, status] of cases) {
      const dataDir = tempDataDir();
      const runner = createFakeRunner(mintSteps(body, status));
      try {
        await getToken(ctxAt(), runner, config(dataDir));
        throw new Error('expected a failure');
      } catch (err) {
        expect(isConnectorError(err, 'unreachable')).toBe(true);
        expect((err as Error).message).not.toContain(USER);
      }
      expect(existsSync(cachePath(dataDir))).toBe(false);
    }
  });

  test('an aborted signal runs nothing', async () => {
    const dataDir = tempDataDir();
    const ac = new AbortController();
    ac.abort();
    const runner = createFakeRunner([]);
    await expect(getToken(ctxAt(NOW, ac.signal), runner, config(dataDir))).rejects.toBeDefined();
    expect(runner.calls).toHaveLength(0);
    expect(runner.unscripted).toHaveLength(0);
  });
});

describe('clearToken', () => {
  test('removes the file, or only when it still holds the given token', async () => {
    const dataDir = tempDataDir();
    const path = seed(dataDir, 'newer-token', NOW.getTime() + 3_600_000);
    await clearToken(config(dataDir), 'older-token');
    expect(existsSync(path)).toBe(true);
    await clearToken(config(dataDir), 'newer-token');
    expect(existsSync(path)).toBe(false);
    seed(dataDir, 'any', NOW.getTime() + 3_600_000);
    await clearToken(config(dataDir));
    expect(existsSync(path)).toBe(false);
    // Missing file is fine.
    await clearToken(config(dataDir));
  });
});

test('oauthUrl keeps a gateway path prefix', () => {
  expect(oauthUrl('https://gw.test')).toBe('https://gw.test/security/oauth');
  expect(oauthUrl('https://gw.test/')).toBe('https://gw.test/security/oauth');
  expect(oauthUrl('https://gw.test/fin/')).toBe('https://gw.test/fin/security/oauth');
});
