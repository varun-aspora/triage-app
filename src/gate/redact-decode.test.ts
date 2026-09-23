// Synthetic values only.
import { describe, expect, test } from 'bun:test';

import { base64Blobs, decodeBase64Text, decodeLayers, jsonUnescape, urlDecode } from './redact-decode.ts';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

describe('decoders', () => {
  test('urlDecode decodes valid runs and leaves broken ones and + alone', () => {
    expect(urlDecode('a%40b.example%2Ecom+x')).toBe('a@b.example.com+x');
    expect(urlDecode('bad %E0%A4 ok %41')).toBe('bad %E0%A4 ok A');
    expect(urlDecode('plain')).toBe('plain');
  });

  test('jsonUnescape decodes unicode, hex and simple escapes', () => {
    expect(jsonUnescape('\\u0039\\u0038 \\x41 \\" \\n \\\\')).toBe('98 A " \n \\');
    expect(jsonUnescape('\\q stays')).toBe('\\q stays');
  });

  test('base64 blobs of 24+ chars that decode to printable text are found', () => {
    const blob = b64('synthetic printable text here');
    expect(blob.length).toBeGreaterThanOrEqual(24);
    expect(base64Blobs(`x ${blob} y`)).toEqual([{ start: 2, end: 2 + blob.length, decoded: 'synthetic printable text here' }]);
    // base64url form
    expect(decodeBase64Text(blob.replace(/\+/g, '-').replace(/\//g, '_'))).toBe('synthetic printable text here');
  });

  test('short blobs, binary, SHAs and UUIDs are not treated as base64 text', () => {
    expect(base64Blobs(b64('short one'))).toEqual([]);
    expect(base64Blobs(Buffer.from([0, 1, 2, 250, 251, 252, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]).toString('base64'))).toEqual([]);
    expect(base64Blobs('3f2a1b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f30')).toEqual([]);
    expect(base64Blobs('123e4567-e89b-12d3-a456-426614174000')).toEqual([]);
  });
});

describe('decodeLayers', () => {
  test('returns the string first, then its decoded forms', () => {
    const layers = decodeLayers('q=a%40b.example.com');
    expect(layers[0]).toBe('q=a%40b.example.com');
    expect(layers).toContain('q=a@b.example.com');
  });

  test('reaches nested encodings', () => {
    const inner = encodeURIComponent('mail a@b.example.com please');
    const layers = decodeLayers(`blob ${b64(inner)}`);
    expect(layers).toContain(`blob ${inner}`);
    expect(layers).toContain('blob mail a@b.example.com please');
  });

  test('plain text has one layer', () => {
    expect(decodeLayers('nothing encoded here')).toEqual(['nothing encoded here']);
  });
});
