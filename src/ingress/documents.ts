// Text from the thread's non-image files (D102): text-like files (plain text,
// CSV, TSV, JSON, XML, YAML, Markdown, logs) and PDFs.
//
// The models only take text and image parts, so a file reaches the Triage
// agent as text inside its first message, which goes through the
// model-facing redaction with the rest of the thread (render-thread.ts).
// Text files are read as strict UTF-8. PDFs go through unpdf (pdf.js), with
// font loading off since the file comes from outside; the pdf.js build unpdf
// ships has no eval path to turn off. A PDF with no
// text layer (a scan) is reported as unreadable; there is no OCR (D17).
//
// capDocuments keeps the text within a per-file and a per-run character
// budget, in the order the files came, and marks what it cut.
import { extractText, getDocumentProxy } from 'unpdf';

/** Text-like types and the extension a downloaded file is stored under. */
export const TEXT_MIMES: Readonly<Record<string, string>> = Object.freeze({
  'text/plain': 'txt',
  'text/csv': 'csv',
  'text/tab-separated-values': 'tsv',
  'text/markdown': 'md',
  'text/x-log': 'log',
  'text/xml': 'xml',
  'text/yaml': 'yaml',
  'application/json': 'json',
  'application/xml': 'xml',
  'application/yaml': 'yaml',
  'application/x-yaml': 'yaml',
});

export const PDF_MIME = 'application/pdf';

/** Every non-image type ingress reads, with its stored extension. */
export const DOCUMENT_MIMES: Readonly<Record<string, string>> = Object.freeze({ ...TEXT_MIMES, [PDF_MIME]: 'pdf' });

/** Most characters kept from one file. */
export const MAX_FILE_TEXT_CHARS = 20_000;
/** Most characters kept from all of a run's files together. */
export const MAX_FILES_TEXT_CHARS = 60_000;

/** 'Text/CSV; charset=utf-8' to 'text/csv'. */
export function baseMime(mime: string): string {
  return (mime.split(';')[0] ?? '').trim().toLowerCase();
}

export function isDocumentMime(mime: string): boolean {
  return DOCUMENT_MIMES[baseMime(mime)] !== undefined;
}

/** A file that could not be turned into text. reason is short and names no content. */
export class DocumentReadError extends Error {
  override readonly name = 'DocumentReadError';
  readonly reason: string;

  constructor(reason: string) {
    super(`file could not be read: ${reason}`);
    this.reason = reason;
  }
}

export type ExtractedText = { readonly text: string; readonly pages?: number };

/** The file's text. Throws DocumentReadError for a file that is not what its type says, or has no text. */
export async function extractDocumentText(bytes: Uint8Array, mime: string): Promise<ExtractedText> {
  const type = baseMime(mime);
  if (type === PDF_MIME) return pdfText(bytes);
  if (TEXT_MIMES[type] === undefined) throw new DocumentReadError('type not supported');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new DocumentReadError('not UTF-8 text');
  }
  // A NUL byte means a binary file sent with a text type.
  if (text.includes('\u0000')) throw new DocumentReadError('not UTF-8 text');
  if (text.trim() === '') throw new DocumentReadError('empty');
  return { text };
}

async function pdfText(bytes: Uint8Array): Promise<ExtractedText> {
  let text: string;
  let pages: number;
  try {
    // pdf.js takes ownership of the buffer it is given, so it gets a copy.
    // verbosity 0: pdf.js writes its warnings about a broken file to the console otherwise.
    const pdf = await getDocumentProxy(new Uint8Array(bytes), { disableFontFace: true, useSystemFonts: false, verbosity: 0 });
    try {
      const out = await extractText(pdf, { mergePages: true });
      text = out.text;
      pages = out.totalPages;
    } finally {
      await pdf.loadingTask.destroy().catch(() => undefined);
    }
  } catch (err) {
    throw new DocumentReadError((err as { name?: unknown } | null)?.name === 'PasswordException' ? 'password protected' : 'not a readable PDF');
  }
  if (text.trim() === '') throw new DocumentReadError('no text layer (a scanned PDF?)');
  return { text, pages };
}

export type DocumentText = {
  readonly name: string;
  readonly mime: string;
  readonly text: string;
  readonly pages?: number;
  /** Characters of the file's text that were cut. 0 when it is whole. */
  readonly cut: number;
};

/** Cuts each file to MAX_FILE_TEXT_CHARS, then all of them to MAX_FILES_TEXT_CHARS, first file first. */
export function capDocuments(
  docs: readonly Omit<DocumentText, 'cut'>[],
  perFile = MAX_FILE_TEXT_CHARS,
  total = MAX_FILES_TEXT_CHARS,
): DocumentText[] {
  let left = total;
  return docs.map((d) => {
    const keep = Math.max(0, Math.min(d.text.length, perFile, left));
    left -= keep;
    return { ...d, text: d.text.slice(0, keep), cut: d.text.length - keep };
  });
}
