// Decoders that let the redaction scanner look inside encoded text (HLD 02
// §3, D24): URL percent-encoding, JSON unicode and escape sequences, and
// base64 blobs of 24 or more characters that decode to printable text.
// Every decoder is lenient: anything it cannot decode is left as it was.

import { isUuid } from './redact-patterns.ts';

export const MIN_BASE64_LENGTH = 24;
export const MAX_DECODE_DEPTH = 3;

/** Decodes every run of %XX sequences that forms valid UTF-8. `+` is left alone. */
export function urlDecode(s: string): string {
  if (!s.includes('%')) return s;
  return s.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });
}

const SIMPLE_ESCAPES: Record<string, string> = {
  '"': '"',
  "'": "'",
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
};

/** Decodes \uXXXX, \xXX and the single-character JSON escapes. */
export function jsonUnescape(s: string): string {
  if (!s.includes('\\')) return s;
  return s.replace(/\\(?:u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|(["'\\/bfnrt]))/g, (whole, u, x, c) => {
    if (u !== undefined) return String.fromCharCode(parseInt(u, 16));
    if (x !== undefined) return String.fromCharCode(parseInt(x, 16));
    return SIMPLE_ESCAPES[c] ?? whole;
  });
}

const BASE64_BLOB_RE = new RegExp(
  `(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{${MIN_BASE64_LENGTH},}={0,2}(?![A-Za-z0-9+/=_-])`,
  'g',
);

// Control characters other than tab, newline and carriage return, and the
// replacement character, mean the bytes were not text.
const NOT_PRINTABLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F�]/;

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** Decodes one base64 or base64url blob to text, or returns null when it is not printable text. */
export function decodeBase64Text(blob: string): string | null {
  if (isUuid(blob)) return null;
  const std = blob.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  if (std.length % 4 === 1) return null;
  let binary: string;
  try {
    binary = atob(std);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  let text: string;
  try {
    text = utf8.decode(bytes);
  } catch {
    return null;
  }
  if (text.trim().length === 0 || NOT_PRINTABLE.test(text)) return null;
  return text;
}

export type Base64Blob = { readonly start: number; readonly end: number; readonly decoded: string };

/** Base64 blobs in s that decode to printable text. */
export function base64Blobs(s: string): Base64Blob[] {
  const out: Base64Blob[] = [];
  for (const m of s.matchAll(BASE64_BLOB_RE)) {
    const decoded = decodeBase64Text(m[0]);
    if (decoded !== null) out.push({ start: m.index, end: m.index + m[0].length, decoded });
  }
  return out;
}

/** Replaces each printable base64 blob with what replace returns for it. */
export function replaceBase64Blobs(s: string, replace: (blob: string, decoded: string) => string): string {
  const blobs = base64Blobs(s);
  if (blobs.length === 0) return s;
  let out = '';
  let at = 0;
  for (const b of blobs) {
    out += s.slice(at, b.start) + replace(s.slice(b.start, b.end), b.decoded);
    at = b.end;
  }
  return out + s.slice(at);
}

/** The string with every printable base64 blob replaced by its decoded text. */
export function base64Expand(s: string): string {
  return replaceBase64Blobs(s, (_blob, decoded) => decoded);
}

/**
 * Returns s followed by its distinct decoded forms, applying URL decoding,
 * JSON unescaping and base64 expansion up to maxDepth layers deep, so nested
 * encodings (base64 of URL-encoded text, double-escaped JSON) are reached.
 */
export function decodeLayers(s: string, maxDepth: number = MAX_DECODE_DEPTH): string[] {
  const seen = new Set<string>([s]);
  let frontier = [s];
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const form of frontier) {
      for (const decode of [urlDecode, jsonUnescape, base64Expand]) {
        const d = decode(form);
        if (!seen.has(d)) {
          seen.add(d);
          next.push(d);
        }
      }
    }
    frontier = next;
  }
  return [...seen];
}
