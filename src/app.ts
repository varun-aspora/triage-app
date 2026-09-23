// Flue HTTP entry (HLD §5.2). The default export is the Hono app Flue serves.
// It mounts the generated HTTP modules in ascending order. Without a
// 'bearer-auth' module every route answers 503, so no route is ever served
// unauthenticated. No agent conversation router is mounted (D25).

import { Hono } from 'hono';
import { loadConfig, type Config } from './config/env.ts';
import { httpModules } from './http/http-modules.gen.ts';
import { BEARER_AUTH_ID, type HttpContext, type HttpDeps, type HttpModule } from './http/types.ts';

export const AUTH_NOT_CONFIGURED = 'http auth not configured';

const ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export class HttpModuleError extends Error {
  override readonly name = 'HttpModuleError';
}

/** Checks ids and orders and returns the modules in mount order (order, then id). */
export function orderModules(modules: readonly HttpModule[]): HttpModule[] {
  const ids = new Set<string>();
  for (const m of modules) {
    if (typeof m?.id !== 'string' || !ID_PATTERN.test(m.id)) {
      throw new HttpModuleError(`http module id '${String(m?.id)}' is not lowercase kebab-case`);
    }
    if (ids.has(m.id)) throw new HttpModuleError(`duplicate http module id '${m.id}'`);
    ids.add(m.id);
    if (!Number.isFinite(m.order)) throw new HttpModuleError(`http module '${m.id}' has no finite order`);
    if (typeof m.mount !== 'function') throw new HttpModuleError(`http module '${m.id}' has no mount()`);
  }
  const sorted = [...modules].sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const auth = sorted.find((m) => m.id === BEARER_AUTH_ID);
  if (auth !== undefined && sorted.some((m) => m !== auth && m.order <= auth.order)) {
    throw new HttpModuleError(`http module '${BEARER_AUTH_ID}' must have the lowest order so it runs before every route`);
  }
  return sorted;
}

export function buildApp(modules: readonly HttpModule[], ctx: HttpContext): Hono {
  const sorted = orderModules(modules);
  const app = new Hono();
  if (!sorted.some((m) => m.id === BEARER_AUTH_ID)) {
    // Nothing else is mounted: a route without auth is never reachable.
    app.all('*', (c) => c.json({ error: AUTH_NOT_CONFIGURED }, 503));
    return app;
  }
  for (const m of sorted) m.mount(app, ctx);
  return app;
}

/** Context for the served app: config loads on first use, so importing this file needs no TRIAGE_HOME. */
export function processHttpContext(): HttpContext {
  let config: Config | undefined;
  return {
    config: () => (config ??= loadConfig()),
    // No HttpDeps fields exist yet.
    deps: {} as HttpDeps,
  };
}

export default buildApp(httpModules as readonly HttpModule[], processHttpContext());
