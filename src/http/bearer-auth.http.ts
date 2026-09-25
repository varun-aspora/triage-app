// Bearer auth on every route, unknown ones included (HLD 02 §5.2, D25). Its
// presence lifts the 503 that src/app.ts answers while no 'bearer-auth'
// module exists.
//
// The token is checked with assertHttpConfig on the first request, not at
// mount: src/app.ts builds the app when it is imported, and importing it must
// not read a .env (tests, the build). Until the config loads and the token is
// set, every route answers 503, so no route is ever served without the token.
// The server boot (T07.10) calls assertHttpConfig before it listens, which is
// where a blank token stops the process.
//
// One exemption: GET/HEAD of the web console's static shell and its public
// config.json under /ui (see ui-public.ts), because the browser must load the
// page before it can ask the operator for the token. The check runs before the
// guard is built, so the prompt loads even while the token config is broken.
// It lives here rather than in an earlier module because orderModules allows
// nothing at or below this module's order.

import type { MiddlewareHandler } from 'hono';
import { ConfigError } from '../config/errors.ts';
import { assertHttpConfig, bearerAuth } from '../ingress/http/auth.ts';
import { isPublicUiRequest } from './ui-public.ts';
import { BEARER_AUTH_ID, type HttpContext, type HttpModule } from './types.ts';

/** Same text src/app.ts answers with when no auth module exists. Not imported from there, to keep the import graph acyclic. */
export const AUTH_NOT_READY = 'http auth not configured';

export const httpModule: HttpModule = {
  id: BEARER_AUTH_ID,
  order: 0,
  mount(app, ctx) {
    app.use('*', authMiddleware(ctx));
  },
};

/** Builds bearerAuth from the config on first use and keeps it once the token is set. */
export function authMiddleware(ctx: HttpContext): MiddlewareHandler {
  let guard: MiddlewareHandler | undefined;
  return async (c, next) => {
    if (isPublicUiRequest(c.req.method, c.req.path)) return next();
    if (guard === undefined) {
      try {
        guard = bearerAuth(assertHttpConfig(ctx.config()));
      } catch (err) {
        if (!(err instanceof ConfigError)) throw err;
        console.error(`triage http: auth not configured (${err.keys.join(', ')})`);
        return c.json({ error: AUTH_NOT_READY }, 503);
      }
    }
    return guard(c, next);
  };
}
