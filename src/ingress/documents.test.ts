import { describe, expect, test } from 'bun:test';
import { minimalPdf } from '../../test/support/pdf.ts';
import { attachmentType, baseMime, DocumentReadError, extractDocumentText } from './documents.ts';

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
  test('each type has a kind and a stored extension; others are not taken', () => {
    expect(attachmentType('image/png')).toEqual({ kind: 'image', ext: 'png' });
    expect(attachmentType('Text/CSV; charset=utf-8')).toEqual({ kind: 'text', ext: 'csv' });
    expect(attachmentType('application/x-yaml')).toEqual({ kind: 'text', ext: 'yaml' });
    expect(attachmentType('application/pdf')).toEqual({ kind: 'pdf', ext: 'pdf' });
    for (const m of ['text/html', 'application/zip', 'application/msword', 'image/heic']) expect(attachmentType(m)).toBeUndefined();
    expect(baseMime(' Text/Plain ; charset=utf-8')).toBe('text/plain');
  });
});

describe('extractDocumentText', () => {
  test('a text file comes back as it is', async () => {
    expect(await extractDocumentText(enc('id,status\n1,failed\n'), 'text/csv')).toEqual({ text: 'id,status\n1,failed\n', cut: false });
  });

  test('text past maxChars is cut', async () => {
    expect(await extractDocumentText(enc('abcdef'), 'text/plain', 4)).toEqual({ text: 'abcd', cut: true });
  });

  test('a text type holding binary or bad UTF-8 is refused', async () => {
    expect(await reason(extractDocumentText(new Uint8Array([0x68, 0x00, 0x69]), 'text/plain'))).toBe('not UTF-8 text');
    expect(await reason(extractDocumentText(new Uint8Array([0xff, 0xfe, 0xfd]), 'text/plain'))).toBe('not UTF-8 text');
    expect(await reason(extractDocumentText(enc('  \n'), 'text/plain'))).toBe('empty');
  });

  test('a PDF gives its text and page count', async () => {
    const got = await extractDocumentText(minimalPdf(['Statement for September', 'UTR 123456789012 failed']), 'application/pdf');
    expect(got.pages).toBe(1);
    expect(got.cut).toBe(false);
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

test('a long PDF is cut at maxChars', async () => {
  const got = await extractDocumentText(minimalPdf(['first line of the statement', 'second line']), 'application/pdf', 10);
  expect(got).toEqual({ text: 'first line', pages: 1, cut: true });
});
