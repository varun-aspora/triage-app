import { describe, expect, test } from 'bun:test';
import childProcess from 'node:child_process';
import { NoIoGuardError } from './no-io-guard.ts';
import { spyOnSpawns } from './spawn-spy.ts';

describe('spyOnSpawns', () => {
  test('counts a spawn and still lets the no-io guard refuse it', () => {
    const spy = spyOnSpawns();
    try {
      expect(() => childProcess.spawnSync('git', ['status'])).toThrow(NoIoGuardError);
      expect(spy.calls()).toEqual(['child_process.spawnSync']);
    } finally {
      spy.restore();
    }
  });

  test('restore puts the original functions back', () => {
    const before = childProcess.execFile;
    const spy = spyOnSpawns();
    expect(childProcess.execFile).not.toBe(before);
    spy.restore();
    spy.restore();
    expect(childProcess.execFile).toBe(before);
  });
});
