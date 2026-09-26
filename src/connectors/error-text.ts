// The real reason a call failed, made safe to pass on.
//
// Every tool error goes back to the model with its real text, so the model
// can fix the call or pick the next step. Connectors keep the real detail
// (the Postgres message, an HTTP body excerpt, the Quickwit error, qw or
// kubectl stderr, the fetch or exec error) and pass it through safeErrorText
// before it goes into a ConnectorError message:
//
// - scrubSecrets takes out the secrets the connector knows (DSN parts, the
//   URL and host, header values) plus anything shaped like one: URL
//   credentials, Authorization, Cookie and API-key header values, bearer and
//   basic tokens, password=... pairs;
// - excerpt folds whitespace and caps the length.
//
// The tool pipeline then applies the model-facing redaction profile
// (src/gate/redact.ts) to the whole text, as it does for results. Values the
// error echoes back (22P02 quotes the bad input) came from the model's own
// call, so returning them is not a new exposure. Pure: no I/O.

import { ConnectorError } from './types.ts';

/** Most characters of error detail that reach the model. */
export const MAX_ERROR_TEXT_CHARS = 1500;

/** The placeholder a scrubbed value becomes. */
export const SCRUBBED = '<redacted>';

// scheme://user:password@ or scheme://token@: the whole userinfo goes.
const URL_USERINFO = /\b([A-Za-z][A-Za-z0-9+.-]{0,31}:\/\/)[^\s\/@'"`]{1,512}@/g;

// Header or field names whose value is a credential, in "Name: value",
// "name=value" or JSON "name": "value" form. The value runs to the end of the
// line or the closing quote, since "Bearer abc" and cookie lists hold spaces.
const SECRET_HEADER =
  /(["']?)\b(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|apikey|x-auth-token|x-access-token)\1(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\r\n"'}]*)/gi;

const AUTH_SCHEME = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/-]{8,}=*/g;

// libpq keyword form: password=secret or password='secret'.
const KEYWORD_PASSWORD = /\b(password|passwd|pwd)\s*=\s*('[^']*'|"[^"]*"|[^\s,;]+)/gi;

// A JSON Web Token: three base64url parts, the first starting eyJ ('{"').
const JWT = /\beyJ[\w-]+\.[\w-]+\.[\w-]+/g;

// An opaque run of 16+ token characters holding a digit, right after a word
// like token, session or refresh ("refresh_token: 1//0gAbC...",
// "session=AbC123..."). Only the run goes; the word stays readable.
const NAMED_TOKEN =
  /\b([\w-]*(?:token|session|refresh)[\w-]*)(["']?\s*[:=]?\s*["']?)(?=[A-Za-z0-9._~+\/=-]*\d)[A-Za-z0-9._~+\/=-]{16,}/gi;

const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/**
 * Takes secrets out of a piece of error text: the given values first
 * (longest first, 3+ characters), then anything shaped like a credential.
 */
export function scrubSecrets(text: string, secrets: readonly string[] = []): string {
  let out = text.replace(CONTROL, ' ');
  const known = [...new Set(secrets)].filter((s) => typeof s === 'string' && s.length >= 3).sort((a, b) => b.length - a.length);
  for (const s of known) out = out.split(s).join(SCRUBBED);
  return out
    .replace(URL_USERINFO, `$1${SCRUBBED}@`)
    .replace(SECRET_HEADER, (_m, q: string, name: string, sep: string, value: string) => {
      const quote = value.startsWith('"') || value.startsWith("'") ? value[0] : '';
      return `${q}${name}${q}${sep}${quote}${SCRUBBED}${quote}`;
    })
    .replace(AUTH_SCHEME, `$1 ${SCRUBBED}`)
    .replace(KEYWORD_PASSWORD, `$1=${SCRUBBED}`)
    .replace(JWT, SCRUBBED)
    .replace(NAMED_TOKEN, `$1$2${SCRUBBED}`);
}

// A scrubbed userinfo (scheme://<redacted>@host) is still part of the URL.
const URL_ANY = /\b[A-Za-z][A-Za-z0-9+.-]{0,31}:\/\/(?:<redacted>|[^\s'"`<>])+/g;
const IPV4_PORT = /\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?\b/g;
const IPV6_PORT = /\[[0-9A-Fa-f:]{2,39}\](?::\d{1,5})?/g;
// A bare host name in a network error. After a DNS failure word any name
// goes ("getaddrinfo ENOTFOUND db-primary", "Could not resolve host: x");
// after "connect to" or "Host:" only a dotted name or one with a port, so
// "could not connect to server: ..." keeps its words.
const LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?';
const HOST_AFTER_DNS = new RegExp(`\\b(ENOTFOUND|EAI_AGAIN|resolve host:?)(\\s+)(?!<host>|<url>)${LABEL}(?:\\.${LABEL})*\\.?(?::\\d{1,5})?`, 'gi');
const HOST_AFTER_WORD = new RegExp(
  `\\b(connect to|Host:)(\\s+)(?!<host>|<url>)(?:${LABEL}(?:\\.${LABEL})+\\.?(?::\\d{1,5})?|${LABEL}(?=:\\d|\\s+port\\s+\\d))(?::\\d{1,5})?`,
  'gi',
);
// Certificate names in a TLS error: "DNS:*.db.example.com, IP Address:10.0.0.1".
const CERT_NAMES = /\b(DNS|IP Address):\s*[^\s,]+/g;

/**
 * Replaces URLs and IP addresses with placeholders. For text that names the
 * endpoint behind a config value (a network error, qw or kubectl stderr),
 * which the connector contract keeps out of messages.
 */
export function stripAddresses(text: string): string {
  return text
    .replace(URL_ANY, (url) => `<url>${/[).,;:\]]+$/.exec(url)?.[0] ?? ''}`)
    .replace(IPV6_PORT, '<host>')
    .replace(IPV4_PORT, '<host>')
    .replace(CERT_NAMES, '$1:<host>')
    .replace(HOST_AFTER_DNS, '$1$2<host>')
    .replace(HOST_AFTER_WORD, '$1$2<host>');
}

/** Folds whitespace and cuts the text at max characters. */
export function excerpt(text: string, max: number = MAX_ERROR_TEXT_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, Math.max(0, max))}...` : flat;
}

/** scrubSecrets then excerpt: what a connector puts in a ConnectorError message. */
export function safeErrorText(text: string, secrets: readonly string[] = [], max: number = MAX_ERROR_TEXT_CHARS): string {
  return excerpt(scrubSecrets(text, secrets), max);
}

/**
 * The text of an error and its causes, for example
 * "fetch failed: connect ECONNREFUSED <host>". A cause whose text is already
 * included is skipped; a cause's code is added when its message lacks it.
 *
 * A ConnectorError gives its message only: the connector built it from the
 * cause with the secrets it knows taken out, and the raw cause it attaches
 * (a fetch error naming the host) must not come back through here. For any
 * other error each cause is scrubbed (scrubSecrets with the given secrets,
 * then stripAddresses) before it is added. The top message is not: pass the
 * result through safeErrorText.
 */
export function errorText(err: unknown, secrets: readonly string[] = []): string {
  if (err instanceof ConnectorError) return err.message.trim();
  const parts: string[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current !== undefined && current !== null; depth++) {
    let text = '';
    if (typeof current === 'string') text = current;
    else if (typeof current === 'object') {
      const message = (current as { message?: unknown }).message;
      const code = (current as { code?: unknown }).code;
      if (typeof message === 'string') text = message;
      // The top error's code is reported by the caller; a cause's code is not.
      if (depth > 0 && typeof code === 'string' && code !== '' && !text.includes(code)) text = text === '' ? code : `${text} (${code})`;
    }
    text = text.trim();
    if (depth > 0) text = stripAddresses(scrubSecrets(text, secrets)).trim();
    if (text !== '' && !parts.some((p) => p.includes(text))) parts.push(text);
    current = typeof current === 'object' ? (current as { cause?: unknown }).cause : undefined;
  }
  return parts.join(': ');
}
