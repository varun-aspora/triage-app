// The attachment types ingress takes, and the text of the non-image ones
// (D36, D102): screenshots, text-like files (plain text, CSV, TSV, JSON, XML,
// YAML, Markdown, logs) and PDFs.
//
// The models only take text and image parts, so a text file or a PDF reaches
// the Triage agent as text inside its first message, which goes through the
// model-facing redaction with the rest of the thread (render-thread.ts).
// Text files are read as strict UTF-8. PDFs go through unpdf (pdf.js), with
// font loading off since the file comes from outside; the pdf.js build unpdf
// ships has no eval path to turn off. A PDF with no text layer (a scan) is
// reported as unreadable; there is no OCR (D17).
//
// extractDocumentText keeps the first maxChars of the text.
import { extractText, getDocumentProxy } from 'unpdf';

export type AttachmentKind = 'image' | 'text' | 'pdf';

type AttachmentType = { readonly kind: AttachmentKind; readonly ext: string };

/** Every type ingress takes, with its kind and the extension a downloaded file is stored under. */
const TYPES: Readonly<Record<string, AttachmentType>> = Object.freeze({
  'image/png': { kind: 'image', ext: 'png' },
  'image/jpeg': { kind: 'image', ext: 'jpg' },
  'image/gif': { kind: 'image', ext: 'gif' },
  'image/webp': { kind: 'image', ext: 'webp' },
  'text/plain': { kind: 'text', ext: 'txt' },
  'text/csv': { kind: 'text', ext: 'csv' },
  'text/tab-separated-values': { kind: 'text', ext: 'tsv' },
  'text/markdown': { kind: 'text', ext: 'md' },
  'text/x-log': { kind: 'text', ext: 'log' },
  'text/xml': { kind: 'text', ext: 'xml' },
  'text/yaml': { kind: 'text', ext: 'yaml' },
  'application/json': { kind: 'text', ext: 'json' },
  'application/xml': { kind: 'text', ext: 'xml' },
  'application/yaml': { kind: 'text', ext: 'yaml' },
  'application/x-yaml': { kind: 'text', ext: 'yaml' },
  'application/pdf': { kind: 'pdf', ext: 'pdf' },
});

/** The reason given for a file of any other type. */
export const UNSUPPORTED_TYPE = 'type not supported';

/** Most characters kept from one file. */
export const MAX_FILE_TEXT_CHARS = 20_000;
/** Most characters kept from all of a run's files together. */
export const MAX_FILES_TEXT_CHARS = 60_000;

/** 'Text/CSV; charset=utf-8' to 'text/csv'. */
export function baseMime(mime: string): string {
  return (mime.split(';')[0] ?? '').trim().toLowerCase();
}

/** The kind and stored extension of a type ingress takes, or undefined. */
export function attachmentType(mime: string): AttachmentType | undefined {
  return TYPES[baseMime(mime)];
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

type ExtractedText = {
  /** At most maxChars long. */
  readonly text: string;
  readonly pages?: number;
  /** Whether text past maxChars was left out. */
  readonly cut: boolean;
};

/** The file's text, up to maxChars. Throws DocumentReadError for a file that is not what its type says, or has no text. */
export async function extractDocumentText(bytes: Uint8Array, mime: string, maxChars = MAX_FILE_TEXT_CHARS): Promise<ExtractedText> {
  const kind = attachmentType(mime)?.kind;
  if (kind === 'pdf') return pdfText(bytes, maxChars);
  if (kind !== 'text') throw new DocumentReadError(UNSUPPORTED_TYPE);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new DocumentReadError('not UTF-8 text');
  }
  // A NUL byte means a binary file sent with a text type.
  if (text.includes('\u0000')) throw new DocumentReadError('not UTF-8 text');
  if (text.trim() === '') throw new DocumentReadError('empty');
  return { text: text.slice(0, maxChars), cut: text.length > maxChars };
}

async function pdfText(bytes: Uint8Array, maxChars: number): Promise<ExtractedText> {
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
  return { text: text.slice(0, maxChars), pages, cut: text.length > maxChars };
}
