// The web console (web/, built by `bun run build:web`) and its two small API
// routes, served same-origin under /ui.
//
//   GET /ui/config.json   public. {"env": "production" | "non-production"}, so
//                         even the token prompt shows the right colours.
//   GET /ui/session       behind the bearer token. Cheap check the console runs
//                         to verify a token: no probes, config and registry only.
//   GET /ui, /ui/*        public. The built single-page app; paths that are not
//                         files fall back to index.html so /ui/runs/<id> loads.
//
// Which of these skip auth is decided by ui-public.ts, not here. Nothing is
// read at mount: src/app.ts builds the app on import, so the dist dir and the
// registry are resolved on the first request that needs them.

import { lstat, readFile, realpath } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Context, Hono } from 'hono';
import type { Config } from '../config/env.ts';
import { loadRegistry } from '../config/registry.ts';
import type { Entity } from '../types/core.ts';
import { UI_PREFIX } from './ui-public.ts';

export type UiRouteDeps = {
  readonly config: () => Config;
  /** Enabled entities for /ui/session. Defaults to the registry, loaded once. */
  readonly entities?: () => readonly Entity[];
  /** Built console directory. Defaults to web/dist next to the source or the bundle. */
  readonly distDir?: string;
};

export const NOT_BUILT_HTML =
  '<!doctype html><meta charset="utf-8"><title>triage console</title><p>The console is not built. Run bun run build:web.</p>';

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  // React and the fonts set inline style attributes; no inline script is allowed.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

// Running from source, this file is src/http/ui-routes.ts; bundled, it is dist/server.mjs.
const DIST_CANDIDATES = [new URL('../../web/dist/', import.meta.url), new URL('../web/dist/', import.meta.url)];

export function createUiRoutes(deps: UiRouteDeps): Hono {
  const app = new Hono();
  let entities: readonly Entity[] | undefined;
  let dist: string | undefined;

  const enabledEntities = (): readonly Entity[] =>
    deps.entities?.() ?? (entities ??= loadRegistry(deps.config()).enabledEntities());
  // Only a found dir is kept, so building the console needs no server restart.
  const distDir = async (): Promise<string | undefined> => (dist ??= await findDistDir(deps.distDir));

  app.onError((err, c) => {
    console.error(`triage http: ${c.req.method} ${c.req.routePath} failed (${err instanceof Error ? err.name : 'error'})`);
    return c.json({ error: 'internal error' }, 500);
  });

  app.get(`${UI_PREFIX}/config.json`, (c) => {
    c.header('Cache-Control', 'no-store');
    return c.json({ env: deps.config().ui.env });
  });

  app.get(`${UI_PREFIX}/session`, (c) => {
    const config = deps.config();
    c.header('Cache-Control', 'no-store');
    return c.json({
      ok: true,
      mock_mode: config.mock.enabled,
      entities: enabledEntities(),
      allow_slack_post: config.http.allowSlackPost,
    });
  });

  app.get(UI_PREFIX, (c) => c.redirect(`${UI_PREFIX}/`, 301));

  app.get(`${UI_PREFIX}/*`, async (c) => {
    c.header('X-Content-Type-Options', 'nosniff');
    const root = await distDir();
    if (root === undefined) return c.html(NOT_BUILT_HTML, 503);

    // The raw pathname, decoded once here: c.req.path is already decoded, and
    // decoding it again would turn %252e into '.'.
    const raw = new URL(c.req.url).pathname.slice(UI_PREFIX.length + 1);
    let rel: string;
    try {
      rel = decodeURIComponent(raw);
    } catch {
      return c.text('bad path', 400);
    }
    if (!isSafeRelative(rel)) return c.text('bad path', 400);

    if (rel !== '') {
      const file = resolve(root, rel);
      if (!file.startsWith(root + sep)) return c.text('bad path', 400);
      if (await isRegularFile(file)) return serveFile(c, file, rel.startsWith('assets/'));
      const last = rel.split('/').at(-1) ?? '';
      if (extname(last) !== '') return c.text('not found', 404);
    }
    return serveFile(c, resolve(root, 'index.html'), false);
  });

  return app;
}

function isSafeRelative(rel: string): boolean {
  if (rel.includes('\0') || rel.includes('\\') || rel.startsWith('/')) return false;
  return !rel.split('/').some((segment) => segment === '..' || segment === '.');
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    // lstat so a symlink inside the dist dir is never followed out of it.
    return (await lstat(path)).isFile();
  } catch {
    return false;
  }
}

async function findDistDir(explicit: string | undefined): Promise<string | undefined> {
  const candidates = explicit !== undefined ? [explicit] : DIST_CANDIDATES.map((u) => fileURLToPath(u));
  for (const candidate of candidates) {
    try {
      const dir = await realpath(candidate);
      if (await isRegularFile(resolve(dir, 'index.html'))) return dir;
    } catch {
      // Not there; try the next one.
    }
  }
  return undefined;
}

async function serveFile(c: Context, file: string, immutable: boolean): Promise<Response> {
  let body: Buffer;
  try {
    body = await readFile(file);
  } catch {
    return c.text('not found', 404);
  }
  const type = CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
  c.header('Content-Type', type);
  // Vite puts a content hash in every assets/ file name, so those never change.
  c.header('Cache-Control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
  if (type.startsWith('text/html')) {
    c.header('Content-Security-Policy', CSP);
    c.header('Referrer-Policy', 'no-referrer');
  }
  return c.body(new Uint8Array(body));
}
