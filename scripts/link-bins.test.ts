import { afterEach, describe, expect, test } from 'bun:test';
import { lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { linkBins } from './link-bins.ts';

const roots: string[] = [];

afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function makeRoot(bin: unknown, files: readonly string[] = ['bin/triage.mjs']): string {
  const root = mkdtempSync(join(tmpdir(), 'link-bins-'));
  roots.push(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'triage-app', bin }));
  for (const f of files) {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    writeFileSync(join(root, f), '#!/usr/bin/env node\n', { mode: 0o644 });
  }
  return root;
}

const linkOf = (root: string, name: string): string => readlinkSync(join(root, 'node_modules', '.bin', name));

describe('linkBins', () => {
  test('links each bin as a relative link and makes the target executable', () => {
    const root = makeRoot({ triage: 'bin/triage.mjs' });
    expect(linkBins(root)).toEqual([{ name: 'triage', status: 'linked' }]);
    expect(linkOf(root, 'triage')).toBe('../../bin/triage.mjs');
    expect(statSync(join(root, 'bin/triage.mjs')).mode & 0o111).toBe(0o111);
  });

  test('a second run changes nothing', () => {
    const root = makeRoot({ triage: 'bin/triage.mjs' });
    linkBins(root);
    expect(linkBins(root)).toEqual([{ name: 'triage', status: 'unchanged' }]);
  });

  test('a link pointing elsewhere is replaced', () => {
    const root = makeRoot({ triage: 'bin/triage.mjs' });
    mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
    symlinkSync('../../old.mjs', join(root, 'node_modules', '.bin', 'triage'));
    expect(linkBins(root)).toEqual([{ name: 'triage', status: 'linked' }]);
    expect(linkOf(root, 'triage')).toBe('../../bin/triage.mjs');
  });

  test('a regular file with the same name is left alone', () => {
    const root = makeRoot({ triage: 'bin/triage.mjs' });
    mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(root, 'node_modules', '.bin', 'triage'), 'other');
    expect(linkBins(root)[0]).toMatchObject({ name: 'triage', status: 'skipped' });
    expect(lstatSync(join(root, 'node_modules', '.bin', 'triage')).isSymbolicLink()).toBe(false);
  });

  test('a missing target, a target outside the repo and an odd name are skipped', () => {
    const root = makeRoot({ gone: 'bin/gone.mjs', out: '../x.mjs', 'a/b': 'bin/triage.mjs' });
    expect(linkBins(root).map((r) => `${r.name}:${r.status}`)).toEqual(['gone:skipped', 'out:skipped', 'a/b:skipped']);
  });

  test('a string bin is named after the package', () => {
    const root = makeRoot('bin/triage.mjs');
    expect(linkBins(root)).toEqual([{ name: 'triage-app', status: 'linked' }]);
  });
});
