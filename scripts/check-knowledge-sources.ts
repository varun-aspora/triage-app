// Tells when a Shivalik note that skills were written from has changed (D85).
//
// The notes are every AGENTS.md and NRI_ONBOARDING.md under atspl/, rtl/,
// shivalik/ and frontend/ of the workspace named by TRIAGE_SHIVALIK_DIR.
// knowledge/sources.lock.json holds, per note, its path, the SHA-256 of the
// file as it is, and the skills written from it. Nothing is copied.
//
// Check (default): exits 0 when every note matches the lock, and 1 with each
// changed, missing and new note and the skills that port it. Without
// TRIAGE_SHIVALIK_DIR it prints one line and exits 0, which is how CI runs it.
// --update: after the owner has updated the skills, rewrites the hashes. A new
// note is added with no skills (name them in the lock); a missing one is dropped.

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SHIVALIK_ROOTS: readonly string[] = ['atspl', 'rtl', 'shivalik', 'frontend'];
const SOURCE_NAMES: readonly string[] = ['AGENTS.md', 'NRI_ONBOARDING.md'];
export const LOCK_FILE = 'sources.lock.json';
const ENV_VAR = 'TRIAGE_SHIVALIK_DIR';

export type LockEntry = { readonly source: string; readonly sha256: string; readonly skills: readonly string[] };

const isDir = (p: string): boolean => existsSync(p) && lstatSync(p).isDirectory();

/** Workspace-relative path -> SHA-256 of every note, sorted by path. */
function upstreamHashes(shivalikDir: string): Map<string, string> {
  const paths: string[] = [];
  const walk = (rel: string): void => {
    for (const entry of readdirSync(join(shivalikDir, rel))) {
      if (entry.startsWith('.') || entry === 'node_modules') continue;
      const path = `${rel}/${entry}`;
      const stat = lstatSync(join(shivalikDir, path));
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile() && SOURCE_NAMES.includes(entry)) paths.push(path);
    }
  };
  for (const root of SHIVALIK_ROOTS) if (isDir(join(shivalikDir, root))) walk(root);
  return new Map(paths.sort().map((p) => [p, createHash('sha256').update(readFileSync(join(shivalikDir, p))).digest('hex')]));
}

export function readLock(knowledgeDir: string): LockEntry[] {
  const path = join(knowledgeDir, LOCK_FILE);
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as LockEntry[]) : [];
}

const by = (skills: readonly string[]): string => (skills.length > 0 ? `ported by ${skills.join(', ')}` : 'ported by no skill');

/** Changed, missing and new notes; empty when the workspace matches the lock. */
export function checkSources(knowledgeDir: string, shivalikDir: string): string[] {
  const upstream = upstreamHashes(shivalikDir);
  const lock = readLock(knowledgeDir);
  const problems: string[] = [];
  for (const entry of lock) {
    const hash = upstream.get(entry.source);
    if (hash === undefined) problems.push(`missing: ${entry.source} (${by(entry.skills)})`);
    else if (hash !== entry.sha256) problems.push(`changed: ${entry.source} (${by(entry.skills)})`);
  }
  const locked = new Set(lock.map((e) => e.source));
  for (const source of upstream.keys()) if (!locked.has(source)) problems.push(`new: ${source} (${by([])})`);
  return problems;
}

/** Rewrites the lock from the workspace, keeping each note's skills. */
export function updateLock(knowledgeDir: string, shivalikDir: string): LockEntry[] {
  const skills = new Map(readLock(knowledgeDir).map((e) => [e.source, e.skills]));
  const lock = [...upstreamHashes(shivalikDir)].map(([source, sha256]) => ({ source, sha256, skills: skills.get(source) ?? [] }));
  writeFileSync(join(knowledgeDir, LOCK_FILE), `${JSON.stringify(lock, null, 2)}\n`);
  return lock;
}

const REPO_KNOWLEDGE = resolve(fileURLToPath(new URL('..', import.meta.url)), 'knowledge');

export function main(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  log: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  knowledgeDir: string = REPO_KNOWLEDGE,
): number {
  const update = argv.includes('--update');
  const shivalikDir = env[ENV_VAR]?.trim();
  if (shivalikDir === undefined || shivalikDir === '') {
    if (update) {
      log(`knowledge sources: --update needs ${ENV_VAR} (the Shivalik workspace)`);
      return 2;
    }
    log(`knowledge sources: skipped, ${ENV_VAR} is not set`);
    return 0;
  }
  if (!isDir(shivalikDir)) {
    log(`knowledge sources: ${ENV_VAR} is not a directory`);
    return 2;
  }
  if (update) {
    log(`knowledge sources: wrote ${updateLock(knowledgeDir, shivalikDir).length} hashes to ${LOCK_FILE}`);
    return 0;
  }
  const problems = checkSources(knowledgeDir, shivalikDir);
  if (problems.length === 0) {
    log(`knowledge sources: ${readLock(knowledgeDir).length} notes match the workspace`);
    return 0;
  }
  for (const line of problems) log(line);
  log(`knowledge sources: ${problems.length} note(s) differ. Read the changes, update the skills that port them, then run with --update.`);
  return 1;
}

if (import.meta.main) process.exit(main(process.argv.slice(2), process.env));
