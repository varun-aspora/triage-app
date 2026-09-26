// Bearer auth for the HTTP API (HLD 02 §5.2, D25).
//
// bearerAuth(token) is Hono middleware for every route, unknown ones
// included. It accepts only `Authorization: Bearer <token>` with the exact
// token. Both sides are hashed to SHA-256 and compared with
// crypto.timingSafeEqual, so the compare takes the same time whatever the
// length of the token sent. A token in the query string is never read.
//
// Every refusal gets the same 401 body, which says nothing about the token.
//
// assertHttpConfig(config) returns the configured token, or throws a
// ConfigError naming TRIAGE_HTTP_AUTH_TOKEN when it is blank. One shared
// token is a known v1 limit.

import crypto from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import type { Config } from '../../config/env.ts';
import { ConfigError } from '../../config/errors.ts';

export const AUTH_TOKEN_KEY = 'TRIAGE_HTTP_AUTH_TOKEN';

/** The one 401 body, for every deny case. */
export const UNAUTHORIZED_BODY = Object.freeze({ error: 'unauthorized' });

const BEARER_RE = /^Bearer ([^\s]+)$/i;

/** Returns the bearer token, or throws a key-only ConfigError when it is blank or whitespace. */
export function assertHttpConfig(config: Pick<Config, 'http'>): string {
  return requireToken(config.http.authToken);
}

function requireToken(token: unknown): string {
  if (typeof token !== 'string' || token.trim() === '') {
    throw ConfigError.of(AUTH_TOKEN_KEY, 'is blank; the HTTP API needs a bearer token');
  }
  return token;
}

function digest(s: string): Buffer {
  return crypto.createHash('sha256').update(s, 'utf8').digest();
}

/**
 * Constant-time token compare. Hashing first gives two buffers of the same
 * length, so timingSafeEqual runs even when the lengths differ; the length
 * check comes after it.
 */
export function tokensMatch(given: string, expected: string): boolean {
  const same = crypto.timingSafeEqual(digest(given), digest(expected));
  return same && given.length === expected.length;
}

/** The token from an Authorization header, or undefined for any other shape. */
export function bearerToken(header: string | undefined): string | undefined {
  return header === undefined ? undefined : BEARER_RE.exec(header)?.[1];
}

export function bearerAuth(token: string): MiddlewareHandler {
  requireToken(token);
  return async (c, next) => {
    const given = bearerToken(c.req.header('authorization'));
    if (given === undefined || !tokensMatch(given, token)) {
      c.header('WWW-Authenticate', 'Bearer');
      return c.json(UNAUTHORIZED_BODY, 401);
    }
    await next();
  };
}
