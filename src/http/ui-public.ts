// Which requests under /ui skip bearer auth. Everything under /ui is the
// console's static shell plus config.json, and the browser has to load them
// before it can ask for the token. Any authed route added under /ui must be
// added to UI_AUTHED_PATHS, or it would be served without the token.
//
// Plain module, not *.http.ts, and it imports nothing from the http modules,
// so bearer-auth.http.ts can use it without an import cycle.

export const UI_PREFIX = '/ui';

/** Routes under /ui that stay behind the bearer token. */
export const UI_AUTHED_PATHS: ReadonlySet<string> = new Set(['/ui/session']);

/**
 * True for GET/HEAD of /ui or /ui/<anything> except UI_AUTHED_PATHS. The path is
 * the one the router matches on; URL parsing has already collapsed '..' and
 * '%2e%2e' segments before either sees it, so the two agree.
 */
export function isPublicUiRequest(method: string, path: string): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false;
  if (path !== UI_PREFIX && !path.startsWith(`${UI_PREFIX}/`)) return false;
  return !UI_AUTHED_PATHS.has(path);
}
