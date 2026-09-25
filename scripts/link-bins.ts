// Links each entry of package.json "bin" into node_modules/.bin, so `triage`
// runs from a shell whose PATH holds node_modules/.bin. bun and npm link bins
// only for installed dependencies, never for the root package itself, so
// postinstall runs this. Run by hand with `bun scripts/link-bins.ts`.
//
// Links are relative (../../bin/triage.mjs), so they survive moving the repo.
// An existing link is replaced; an existing regular file is left alone.
// Problems are printed and never fail the install.
// Only node:fs and node:path are used, so this also runs under Node.

import { chmodSync, lstatSync, mkdirSync, readFileSync, readlinkSync, statSync, symlinkSync, unlinkSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export type LinkResult = { readonly name: string; readonly status: 'linked' | 'unchanged' | 'skipped'; readonly reason?: string };

/** The "bin" map of <root>/package.json. A string "bin" is named after the package. */
function binsOf(root: string): Record<string, string> {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name?: string; bin?: string | Record<string, string> };
  if (typeof pkg.bin === 'string') return pkg.name === undefined ? {} : { [pkg.name]: pkg.bin };
  return pkg.bin ?? {};
}

const NAME = /^[a-z0-9][a-z0-9._-]*$/;

export function linkBins(root: string = REPO_ROOT): LinkResult[] {
  const binDir = join(root, 'node_modules', '.bin');
  const out: LinkResult[] = [];
  for (const [name, target] of Object.entries(binsOf(root))) {
    if (!NAME.test(name)) {
      out.push({ name, status: 'skipped', reason: 'not a plain command name' });
      continue;
    }
    const abs = resolve(root, target);
    if (relative(root, abs).startsWith('..')) {
      out.push({ name, status: 'skipped', reason: 'target is outside the repo' });
      continue;
    }
    try {
      statSync(abs);
    } catch {
      out.push({ name, status: 'skipped', reason: `${target} does not exist` });
      continue;
    }
    const link = join(binDir, name);
    const wanted = relative(binDir, abs);
    let existing: 'none' | 'link' | 'file' = 'none';
    try {
      existing = lstatSync(link).isSymbolicLink() ? 'link' : 'file';
    } catch {
      existing = 'none';
    }
    if (existing === 'file') {
      out.push({ name, status: 'skipped', reason: `${relative(root, link)} exists and is not a link` });
      continue;
    }
    chmodSync(abs, statSync(abs).mode | 0o111);
    if (existing === 'link' && readlinkSync(link) === wanted) {
      out.push({ name, status: 'unchanged' });
      continue;
    }
    mkdirSync(binDir, { recursive: true });
    if (existing === 'link') unlinkSync(link);
    symlinkSync(wanted, link);
    out.push({ name, status: 'linked' });
  }
  return out;
}

/** CLI entry. Always 0: a missing link must not fail `bun install`. */
export function main(root: string = REPO_ROOT): number {
  try {
    for (const r of linkBins(root)) {
      if (r.status === 'skipped') console.error(`link-bins: ${r.name} not linked: ${r.reason}`);
    }
  } catch (err) {
    console.error(`link-bins: ${err instanceof Error ? err.message : String(err)}`);
  }
  return 0;
}

if (import.meta.main) process.exit(main());
