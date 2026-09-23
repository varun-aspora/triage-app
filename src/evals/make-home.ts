// Materialises an eval TRIAGE_HOME from evals/home/.env.example (D42).
//
// Writes <targetDir>/.env with __REPO__ replaced by the repo root, copies the
// repo's resources/ into <targetDir>/resources (the loader reads resources from
// the home and has no key for another location), and drops a marker file so a
// later call may overwrite a home it made itself. It refuses to overwrite a
// .env it did not write, so pointing it at a real TRIAGE_HOME does nothing.
// Everything is written under targetDir; the repo is only read.

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { EvalHomeError } from './home.ts';

/** Template path, relative to the repo root. */
export const EVAL_HOME_TEMPLATE = join('evals', 'home', '.env.example');

export const REPO_PLACEHOLDER = '__REPO__';

/** Written next to the .env so a rerun knows the home is one of ours. */
export const EVAL_HOME_MARKER = '.eval-home';

/** Returns the template text with the placeholder replaced. Pure apart from reading the template. */
export function renderEvalEnv(repoRoot: string): string {
  const root = checkedRoot(repoRoot);
  const template = readFileSync(join(root, EVAL_HOME_TEMPLATE), 'utf8');
  return template.replaceAll(REPO_PLACEHOLDER, root);
}

/** Writes the eval home and returns its absolute path, the value to export as TRIAGE_HOME. */
export function materialiseEvalHome(targetDir: string, repoRoot: string): string {
  if (!isAbsolute(targetDir)) throw new Error('materialiseEvalHome: targetDir must be an absolute path');
  const home = resolve(targetDir);
  const root = checkedRoot(repoRoot);
  if (home === root) throw new Error('materialiseEvalHome: targetDir must not be the repo root');

  const envFile = join(home, '.env');
  const marker = join(home, EVAL_HOME_MARKER);
  if (existsSync(envFile) && !existsSync(marker)) {
    throw new EvalHomeError([
      { key: 'TRIAGE_HOME', reason: 'target already has a .env that materialiseEvalHome did not write; pick an empty dir' },
    ]);
  }

  const text = renderEvalEnv(root);
  mkdirSync(home, { recursive: true });
  writeFileSync(marker, 'Written by src/evals/make-home.ts. This directory is an eval TRIAGE_HOME.\n');
  writeFileSync(envFile, text, { mode: 0o600 });
  const resources = join(home, 'resources');
  rmSync(resources, { recursive: true, force: true });
  cpSync(join(root, 'resources'), resources, { recursive: true });
  return home;
}

// The root goes into single-quoted .env values, so it may not hold a quote or a newline.
function checkedRoot(repoRoot: string): string {
  if (!isAbsolute(repoRoot)) throw new Error('materialiseEvalHome: repoRoot must be an absolute path');
  if (/['\r\n]/.test(repoRoot)) throw new Error('materialiseEvalHome: repoRoot must not contain quotes or newlines');
  return resolve(repoRoot);
}
