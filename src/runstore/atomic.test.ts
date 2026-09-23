import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExclusive, isTempFile, writeFileAtomic } from './atomic.ts';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'runstore-atomic-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('writeFileAtomic', () => {
  test('writes the file and creates missing parent directories', async () => {
    const dir = tempDir();
    const target = join(dir, 'a', 'b', 'file.json');
    await writeFileAtomic(target, '{"x":1}\n');
    expect(readFileSync(target, 'utf8')).toBe('{"x":1}\n');
    expect(readdirSync(join(dir, 'a', 'b'))).toEqual(['file.json']);
  });

  test('replaces existing content and leaves no temp file', async () => {
    const dir = tempDir();
    const target = join(dir, 'file.txt');
    writeFileSync(target, 'old');
    await writeFileAtomic(target, 'new');
    expect(readFileSync(target, 'utf8')).toBe('new');
    expect(readdirSync(dir)).toEqual(['file.txt']);
  });

  test('a reader never sees a partial file while writes are in flight', async () => {
    const dir = tempDir();
    const target = join(dir, 'big.txt');
    const a = 'a'.repeat(512 * 1024);
    const b = 'b'.repeat(512 * 1024);
    await writeFileAtomic(target, a);
    let writing = true;
    const writer = (async () => {
      for (let i = 0; i < 20; i++) await writeFileAtomic(target, i % 2 ? a : b);
      writing = false;
    })();
    let reads = 0;
    while (writing) {
      const seen = await readFile(target, 'utf8');
      expect(seen === a || seen === b).toBe(true);
      reads++;
    }
    await writer;
    expect(reads).toBeGreaterThan(0);
  });

  test('a failed write leaves the old content and no temp file', async () => {
    const dir = tempDir();
    const target = join(dir, 'file.txt');
    writeFileSync(target, 'old');
    // A directory where the target should be makes the rename fail.
    const blocked = join(dir, 'blocked');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(blocked, 'child'), { recursive: true });
    await expect(writeFileAtomic(blocked, 'new')).rejects.toThrow();
    expect(readFileSync(target, 'utf8')).toBe('old');
    expect(readdirSync(dir).filter(isTempFile)).toEqual([]);
  });
});

describe('createExclusive', () => {
  test('creates once, then reports the file exists without changing it', async () => {
    const dir = tempDir();
    const target = join(dir, 'claim.json');
    expect(await createExclusive(target, 'first')).toBe(true);
    expect(await createExclusive(target, 'second')).toBe(false);
    expect(readFileSync(target, 'utf8')).toBe('first');
    expect(readdirSync(dir)).toEqual(['claim.json']);
  });

  test('many concurrent creates have exactly one winner and a complete file', async () => {
    const dir = tempDir();
    const target = join(dir, 'claim.json');
    const bodies = Array.from({ length: 25 }, (_, i) => `body-${i}-${'x'.repeat(10_000)}`);
    const results = await Promise.all(bodies.map((b) => createExclusive(target, b)));
    expect(results.filter(Boolean)).toHaveLength(1);
    const winner = bodies[results.indexOf(true)];
    expect(readFileSync(target, 'utf8')).toBe(winner!);
    expect(readdirSync(dir)).toEqual(['claim.json']);
  });

  test('creates missing parent directories', async () => {
    const dir = tempDir();
    const target = join(dir, 'x', 'y.json');
    expect(await createExclusive(target, '1')).toBe(true);
    expect(existsSync(target)).toBe(true);
  });
});

describe('isTempFile', () => {
  test('matches only helper temp names', () => {
    expect(isTempFile('.meta.json.tmp-123-abcdef')).toBe(true);
    expect(isTempFile('meta.json')).toBe(false);
    expect(isTempFile('ssfb.v2.json')).toBe(false);
  });
});
