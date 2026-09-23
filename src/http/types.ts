// The HTTP extension point. An area adds src/http/**/<name>.http.ts exporting
// `httpModule: HttpModule`; bun run gen lists it and src/app.ts mounts it in
// ascending order. Nothing else needs editing.

import type { Hono } from 'hono';
import type { Config } from '../config/env.ts';

/** The module that installs bearer auth. Until it exists, every route answers 503. */
export const BEARER_AUTH_ID = 'bearer-auth';

/**
 * Dependencies handed to every HTTP module. Empty here; areas add fields with
 * `declare module '<path>/src/http/types.ts' { interface HttpDeps { ... } }`.
 */
export interface HttpDeps {}

export type HttpContext = {
  /** Loads config from TRIAGE_HOME on first call. Throws ConfigError. */
  config(): Config;
  readonly deps: HttpDeps;
};

export interface HttpModule {
  /** Lowercase kebab-case, unique across modules. */
  readonly id: string;
  /** Mount order, ascending. The bearer-auth module must be strictly first (order 0 by convention). */
  readonly order: number;
  /** Adds middleware or routes to the app. Runs once, when the app is built. */
  mount(app: Hono, ctx: HttpContext): void;
}
