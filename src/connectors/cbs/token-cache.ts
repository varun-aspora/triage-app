// OAuth token for cbs_call (D14, D30). The mint is tool infrastructure, not a
// model action: the model never reaches /security/oauth.
//
// The token is cached at <TRIAGE_DATA_DIR>/cache/ssfb-cbs-oauth.json (mode
// 0600, written to a temp file and renamed into place) and reused while more
// than 30 seconds remain. Expiry comes from the JWT exp claim, else from
// expires_in. To mint, the Finacle API username and password are read from
// the k8s secret into memory and sent to the gateway from inside the pod as a
// password grant on curl's stdin. Credentials are never written anywhere, and
// .env is never written.
//
// Calls for the same cache file run one at a time, so concurrent callers with
// a stale token share one mint: the first mints and writes, the rest read the
// fresh file.
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ExecRunner } from '../exec.ts';
import { ConnectorError, type ConnectorContext } from '../types.ts';
import { podCurl, readCredentials, type KubeConfig, type SecretRef } from './kubectl.ts';

export const CACHE_DIR = 'cache';
export const CACHE_FILE = 'ssfb-cbs-oauth.json';
export const OAUTH_PATH = '/security/oauth';
/** A cached token is reused only while more than this is left. */
export const REUSE_MARGIN_MS = 30_000;

export type TokenConfig = {
  /** TRIAGE_DATA_DIR. */
  readonly dataDir: string;
  readonly kube: KubeConfig;
  /** A Running pod from resolvePod. */
  readonly pod: string;
  readonly secret: SecretRef;
  /** SSFB_CBS_GATEWAY_URL. */
  readonly gatewayUrl: string;
  /** SSFB_CBS_OAUTH_SCOPE. Sent on stdin only. */
  readonly scope: string;
  /** curl --max-time in seconds. */
  readonly maxTimeSec: number;
  /** File name under <dataDir>/cache. Defaults to CACHE_FILE. */
  readonly cacheFile?: string;
};

export type CachedToken = {
  readonly access_token: string;
  /** Epoch milliseconds. */
  readonly expires_at: number;
};

export type TokenContext = Pick<ConnectorContext, 'signal' | 'now'>;

// Tokens go into an Authorization header, so they must be plain token68-ish text.
const TOKEN = /^[A-Za-z0-9._~+/=-]{1,8192}$/;

export function cachePath(dataDir: string, file: string = CACHE_FILE): string {
  return join(dataDir, CACHE_DIR, file);
}

/** <gateway>/security/oauth, keeping any path prefix on the gateway URL. */
export function oauthUrl(gatewayUrl: string): string {
  const u = new URL(gatewayUrl);
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}${OAUTH_PATH}`;
}

/** The exp claim of a JWT in epoch ms, or undefined when the token is not a JWT with a numeric exp. */
export function jwtExpiryMs(token: string): number | undefined {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[1] === undefined || parts[1] === '') return undefined;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as { exp?: unknown };
    return typeof claims.exp === 'number' && Number.isFinite(claims.exp) ? claims.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

// --------------------------------------------------------------- the lock

const locks = new Map<string, Promise<void>>();

async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = prev.then(() => mine);
  locks.set(key, tail);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(key) === tail) locks.delete(key);
  }
}

// -------------------------------------------------------------- the file

/** The cached token, or null when the file is missing, unreadable, not 0600-only or malformed. */
export async function readCachedToken(path: string): Promise<CachedToken | null> {
  try {
    const st = await lstat(path);
    // A symlink, or a file others can read, is not trusted.
    if (!st.isFile() || (st.mode & 0o077) !== 0) return null;
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<CachedToken>;
    if (typeof parsed.access_token !== 'string' || !TOKEN.test(parsed.access_token)) return null;
    if (typeof parsed.expires_at !== 'number' || !Number.isFinite(parsed.expires_at)) return null;
    return { access_token: parsed.access_token, expires_at: parsed.expires_at };
  } catch {
    return null;
  }
}

async function writeCachedToken(path: string, token: CachedToken): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.${randomUUID()}.tmp`);
  // Only these two fields are written. Credentials never reach this function.
  const text = `${JSON.stringify({ access_token: token.access_token, expires_at: token.expires_at })}\n`;
  try {
    await writeFile(tmp, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

// ---------------------------------------------------------------- minting

type MintResponse = { access_token?: unknown; expires_in?: unknown };

async function mint(ctx: TokenContext, exec: ExecRunner, cfg: TokenConfig): Promise<CachedToken> {
  const { signal } = ctx;
  const creds = await readCredentials(exec, cfg.kube, cfg.secret, signal);
  const data = new URLSearchParams({
    grant_type: 'password',
    username: creds.username,
    password: creds.password,
    scope: cfg.scope,
  }).toString();
  const mintedAt = ctx.now().getTime();
  const res = await podCurl(
    exec,
    cfg.kube,
    cfg.pod,
    {
      url: oauthUrl(cfg.gatewayUrl),
      method: 'POST',
      headers: [
        ['Content-Type', 'application/x-www-form-urlencoded'],
        ['Accept', 'application/json'],
      ],
      data,
    },
    { signal, maxTimeSec: cfg.maxTimeSec },
  );
  if (res.status !== 200) throw new ConnectorError('unreachable', `the CBS OAuth mint answered HTTP ${res.status}`);
  let parsed: MintResponse;
  try {
    parsed = JSON.parse(res.body) as MintResponse;
  } catch {
    throw new ConnectorError('unreachable', 'the CBS OAuth mint did not return JSON');
  }
  const token = parsed.access_token;
  if (typeof token !== 'string' || !TOKEN.test(token)) {
    throw new ConnectorError('unreachable', 'the CBS OAuth mint returned no usable access_token');
  }
  const fromJwt = jwtExpiryMs(token);
  const expiresIn = Number(parsed.expires_in);
  const fromExpiresIn = Number.isFinite(expiresIn) && expiresIn > 0 ? mintedAt + expiresIn * 1000 : undefined;
  // With neither, the token is used for this call and not cached.
  const expires_at = fromJwt ?? fromExpiresIn ?? mintedAt;
  return { access_token: token, expires_at };
}

/**
 * Returns a token with more than 30s left, from the cache or a fresh mint.
 * A fresh token is written to the cache when it will outlive the margin.
 */
export async function getToken(ctx: TokenContext, exec: ExecRunner, cfg: TokenConfig): Promise<string> {
  ctx.signal.throwIfAborted();
  const path = cachePath(cfg.dataDir, cfg.cacheFile);
  return withLock(path, async () => {
    ctx.signal.throwIfAborted();
    const cached = await readCachedToken(path);
    if (cached !== null && cached.expires_at - ctx.now().getTime() > REUSE_MARGIN_MS) return cached.access_token;
    const fresh = await mint(ctx, exec, cfg);
    if (fresh.expires_at - ctx.now().getTime() > REUSE_MARGIN_MS) {
      try {
        await writeCachedToken(path, fresh);
      } catch {
        // A cache that cannot be written costs a mint next time, nothing more.
      }
    }
    return fresh.access_token;
  });
}

/**
 * Removes the cache file. With `token`, only when the file still holds that
 * token, so a 401 on an old token does not throw away a newer one.
 */
export async function clearToken(cfg: Pick<TokenConfig, 'dataDir' | 'cacheFile'>, token?: string): Promise<void> {
  const path = cachePath(cfg.dataDir, cfg.cacheFile);
  await withLock(path, async () => {
    if (token !== undefined) {
      const cached = await readCachedToken(path);
      if (cached !== null && cached.access_token !== token) return;
    }
    await unlink(path).catch(() => {});
  });
}
