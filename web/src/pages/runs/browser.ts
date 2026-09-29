// Browser-only helpers for the run pages.

/**
 * Saves text as a file. The content is already in the page, so it is built
 * as a Blob here instead of fetched from a URL, which would need the token.
 */
export function downloadText(filename: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
