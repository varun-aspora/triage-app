// File writes that never leave a partial file where a reader can see it.
//
// writeFileAtomic writes a temp file in the target's directory, syncs it and
// renames it over the target. Rename within one directory is atomic, so a
// reader sees the old content or the new content, never a mix.
//
// createExclusive creates the target only if it does not exist, with the
// same exclusive semantics as open(path, 'wx'). The content goes into a temp
// file first and is then hard-linked to the target; link() fails with EEXIST
// when the target exists, so exactly one caller wins and the winner's file is
// complete from the moment it appears. Where hard links are not supported it
// falls back to the 'wx' flag.

import { randomBytes } from 'node:crypto';
import { link, mkdir, open, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

const TEMP_MARK = '.tmp-';

/** True for the temp files these helpers create, so directory readers can skip them. */
export function isTempFile(name: string): boolean {
  return name.includes(TEMP_MARK);
}

function tempPathFor(target: string): string {
  return join(dirname(target), `.${basename(target)}${TEMP_MARK}${process.pid}-${randomBytes(6).toString('hex')}`);
}

async function writeTemp(target: string, data: string | Uint8Array): Promise<string> {
  await mkdir(dirname(target), { recursive: true });
  const temp = tempPathFor(target);
  const fh = await open(temp, 'wx', 0o600);
  try {
    await fh.writeFile(data);
    await fh.sync();
  } catch (err) {
    await fh.close().catch(() => {});
    await unlink(temp).catch(() => {});
    throw err;
  }
  await fh.close();
  return temp;
}

/** Writes data to target through a temp file and a rename. */
export async function writeFileAtomic(target: string, data: string | Uint8Array): Promise<void> {
  const temp = await writeTemp(target, data);
  try {
    await rename(temp, target);
  } catch (err) {
    await unlink(temp).catch(() => {});
    throw err;
  }
}

const NO_LINK = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV']);

function code(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : undefined;
}

/**
 * Creates target with data only if it does not exist yet. Returns true when
 * this call created it and false when it already existed.
 */
export async function createExclusive(target: string, data: string | Uint8Array): Promise<boolean> {
  const temp = await writeTemp(target, data);
  try {
    await link(temp, target);
    return true;
  } catch (err) {
    if (code(err) === 'EEXIST') return false;
    if (!NO_LINK.has(code(err) ?? '')) throw err;
    return createWithFlag(target, data);
  } finally {
    await unlink(temp).catch(() => {});
  }
}

async function createWithFlag(target: string, data: string | Uint8Array): Promise<boolean> {
  let fh;
  try {
    fh = await open(target, 'wx', 0o600);
  } catch (err) {
    if (code(err) === 'EEXIST') return false;
    throw err;
  }
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
  return true;
}

/** True when err is a node error with this code. */
export function hasCode(err: unknown, expected: string): boolean {
  return code(err) === expected;
}
