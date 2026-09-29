import { describe, expect, test } from 'bun:test';
import { minimalPdf } from '../../test/support/pdf.ts';
import { baseMime, capDocuments, DocumentReadError, extractDocumentText, isDocumentMime } from './documents.ts';

const enc = (s: string) => new TextEncoder().encode(s);

async function reason(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof DocumentReadError) return err.reason;
    throw err;
  }
  throw new Error('expected the read to fail');
}

describe('types', () => {
  test('text-like types and PDFs are read, others are not', () => {
    for (const m of ['text/plain', 'Text/CSV; charset=utf-8', 'application/json', 'application/x-yaml', 'application/pdf']) {
      expect(isDocumentMime(m)).toBe(true);
    }
    for (const m of ['image/png', 'text/html', 'application/zip', 'application/msword']) expect(isDocumentMime(m)).toBe(false);
    expect(baseMime(' Text/Plain ; charset=utf-8')).toBe('text/plain');
  });
});

describe('extractDocumentText', () => {
  test('a text file comes back as it is', async () => {
    expect(await extractDocumentText(enc('id,status\n1,failed\n'), 'text/csv')).toEqual({ text: 'id,status\n1,failed\n' });
  });

  test('a text type holding binary or bad UTF-8 is refused', async () => {
    expect(await reason(extractDocumentText(new Uint8Array([0x68, 0x00, 0x69]), 'text/plain'))).toBe('not UTF-8 text');
    expect(await reason(extractDocumentText(new Uint8Array([0xff, 0xfe, 0xfd]), 'text/plain'))).toBe('not UTF-8 text');
    expect(await reason(extractDocumentText(enc('  \n'), 'text/plain'))).toBe('empty');
  });

  test('a PDF gives its text and page count', async () => {
    const got = await extractDocumentText(minimalPdf(['Statement for September', 'UTR 123456789012 failed']), 'application/pdf');
    expect(got.pages).toBe(1);
    expect(got.text).toContain('Statement for September');
    expect(got.text).toContain('UTR 123456789012 failed');
  });

  test('a PDF that is not one, or has no text, is refused', async () => {
    expect(await reason(extractDocumentText(enc('<html>sign in</html>'), 'application/pdf'))).toBe('not a readable PDF');
    expect(await reason(extractDocumentText(minimalPdf([]), 'application/pdf'))).toBe('no text layer (a scanned PDF?)');
  });

  test('an unsupported type is refused', async () => {
    expect(await reason(extractDocumentText(enc('x'), 'application/zip'))).toBe('type not supported');
  });
});

test('capDocuments cuts each file, then the total, first file first', () => {
  const doc = (name: string, n: number) => ({ name, mime: 'text/plain', text: 'x'.repeat(n) });
  const out = capDocuments([doc('a', 8), doc('b', 3), doc('c', 5)], 5, 9);
  expect(out.map((d) => [d.name, d.text.length, d.cut])).toEqual([
    ['a', 5, 3],
    ['b', 3, 0],
    ['c', 1, 4],
  ]);
});
