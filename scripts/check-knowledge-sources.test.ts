// scripts/check-knowledge-sources.ts against a fake Shivalik workspace and a
// fake lock, both in a temp dir. The real workspace is never read.

import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { LOCK_FILE, checkSources, main, readLock, type LockEntry } from './check-knowledge-sources.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function write(root: string, rel: string, text: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Note path -> its text and the skills that port it. */
const NOTES: Record<string, { text: string; skills: string[] }> = {
  'shivalik/AGENTS.md': { text: '# Shivalik\n', skills: ['ssfb-guardian', 'ssfb-overview'] },
  'shivalik/guardian/AGENTS.md': { text: '# guardian\n', skills: ['ssfb-guardian'] },
  'rtl/NRI_ONBOARDING.md': { text: '# onboarding\n', skills: [] },
};

/** A workspace with three notes (plus files that are not notes) and a lock that matches it. */
function setup() {
  const base = mkdtempSync(join(tmpdir(), 'knowledge-sources-'));
  dirs.push(base);
  const shivalikDir = join(base, 'shivalik-ws');
  const knowledgeDir = join(base, 'knowledge');
  for (const [path, { text }] of Object.entries(NOTES)) write(shivalikDir, path, text);
  write(shivalikDir, 'shivalik/guardian/README.md', 'not a note\n');
  write(shivalikDir, 'refs/some-case/AGENTS.md', 'outside the four roots\n');
  const lock: LockEntry[] = Object.entries(NOTES).map(([source, { text, skills }]) => ({ source, sha256: sha(text), skills }));
  write(knowledgeDir, LOCK_FILE, JSON.stringify(lock));
  return { shivalikDir, knowledgeDir };
}

function run(argv: string[], env: Record<string, string | undefined>, knowledgeDir: string) {
  const lines: string[] = [];
  const code = main(argv, env, (line) => lines.push(line), knowledgeDir);
  return { code, out: lines.join('\n') };
}

describe('check', () => {
  test('a workspace that matches the lock exits 0', () => {
    const d = setup();
    expect(run([], { TRIAGE_SHIVALIK_DIR: d.shivalikDir }, d.knowledgeDir)).toEqual({ code: 0, out: 'knowledge sources: 3 notes match the workspace' });
  });

  test('drift lists the changed, missing and new notes with the skills that port them, and exits 1', () => {
    const d = setup();
    write(d.shivalikDir, 'shivalik/AGENTS.md', '# Shivalik\n\nChanged upstream.\n');
    rmSync(join(d.shivalikDir, 'shivalik', 'guardian', 'AGENTS.md'));
    write(d.shivalikDir, 'atspl/AGENTS.md', '# ATSPL\n');
    expect(checkSources(d.knowledgeDir, d.shivalikDir)).toEqual([
      'changed: shivalik/AGENTS.md (ported by ssfb-guardian, ssfb-overview)',
      'missing: shivalik/guardian/AGENTS.md (ported by ssfb-guardian)',
      'new: atspl/AGENTS.md (ported by no skill)',
    ]);
    const r = run([], { TRIAGE_SHIVALIK_DIR: d.shivalikDir }, d.knowledgeDir);
    expect(r.code).toBe(1);
    expect(r.out).toContain('3 note(s) differ');
  });

  test('without TRIAGE_SHIVALIK_DIR it prints one line and exits 0; --update needs it', () => {
    const d = setup();
    expect(run([], {}, d.knowledgeDir)).toEqual({ code: 0, out: 'knowledge sources: skipped, TRIAGE_SHIVALIK_DIR is not set' });
    expect(run([], { TRIAGE_SHIVALIK_DIR: ' ' }, d.knowledgeDir).code).toBe(0);
    expect(run(['--update'], {}, d.knowledgeDir).code).toBe(2);
    expect(run([], { TRIAGE_SHIVALIK_DIR: join(d.shivalikDir, 'nope') }, d.knowledgeDir).code).toBe(2);
  });
});

describe('--update', () => {
  test('rewrites the hashes, keeps the skills, adds new notes with none and drops missing ones', () => {
    const d = setup();
    write(d.shivalikDir, 'shivalik/AGENTS.md', '# Shivalik\n\nChanged upstream.\n');
    rmSync(join(d.shivalikDir, 'rtl', 'NRI_ONBOARDING.md'));
    write(d.shivalikDir, 'frontend/ios/AGENTS.md', '# ios\n');
    expect(run(['--update'], { TRIAGE_SHIVALIK_DIR: d.shivalikDir }, d.knowledgeDir)).toEqual({
      code: 0,
      out: `knowledge sources: wrote 3 hashes to ${LOCK_FILE}`,
    });
    expect(readLock(d.knowledgeDir)).toEqual([
      { source: 'frontend/ios/AGENTS.md', sha256: sha('# ios\n'), skills: [] },
      { source: 'shivalik/AGENTS.md', sha256: sha('# Shivalik\n\nChanged upstream.\n'), skills: ['ssfb-guardian', 'ssfb-overview'] },
      { source: 'shivalik/guardian/AGENTS.md', sha256: sha('# guardian\n'), skills: ['ssfb-guardian'] },
    ]);
    expect(checkSources(d.knowledgeDir, d.shivalikDir)).toEqual([]);
  });

  test('writes nothing without TRIAGE_SHIVALIK_DIR', () => {
    const d = setup();
    rmSync(join(d.knowledgeDir, LOCK_FILE));
    run(['--update'], {}, d.knowledgeDir);
    expect(existsSync(join(d.knowledgeDir, LOCK_FILE))).toBe(false);
  });
});
