// The 500 handler route groups install with app.onError. It logs the method,
// the route and the error class, never the message.

import type { ErrorHandler } from 'hono';

export const internalError: ErrorHandler = (err, c) => {
  console.error(`triage http: ${c.req.method} ${c.req.routePath} failed (${err instanceof Error ? err.name : 'error'})`);
  return c.json({ error: 'internal error' }, 500);
};
