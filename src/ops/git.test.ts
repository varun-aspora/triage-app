import { describe, expect, test } from 'bun:test';
import { remoteIdentity, remoteWebBase } from './git.ts';

describe('remoteWebBase', () => {
  test('turns each clone form into the https base and keeps case', () => {
    for (const url of ['git@github.com:Org/repo.git', 'ssh://git@github.com:22/Org/repo', 'https://x@github.com/Org/repo.git']) {
      expect(remoteWebBase(url)).toBe('https://github.com/Org/repo');
    }
  });
  test('is undefined for anything else', () => {
    expect(remoteWebBase('/local/path')).toBeUndefined();
    expect(remoteWebBase('file:///x/y')).toBeUndefined();
  });
  test('remoteIdentity still lowercases', () => {
    expect(remoteIdentity('git@GitHub.com:Org/Repo.git')).toBe('github.com/org/repo');
  });
});
