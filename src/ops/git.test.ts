import { describe, expect, test } from 'bun:test';
import { remoteIdentity, remoteWebBase } from './git.ts';

describe('remoteWebBase', () => {
  test('turns each clone form into the https base and keeps case', () => {
    for (const url of ['git@github.com:Org/repo.git', 'ssh://git@github.com:22/Org/repo', 'https://x@github.com/Org/repo.git']) {
      expect(remoteWebBase(url)).toBe('https://github.com/Org/repo');
    }
  });
  test('keeps an https port', () => {
    expect(remoteWebBase('https://git.example.com:8443/Org/repo.git')).toBe('https://git.example.com:8443/Org/repo');
  });
  test('is undefined for an ssh port other than 22 and for hosts with another file layout', () => {
    expect(remoteWebBase('ssh://git@git.example.com:7999/Org/repo.git')).toBeUndefined();
    expect(remoteWebBase('git@gitlab.com:Org/repo.git')).toBeUndefined();
    expect(remoteWebBase('https://bitbucket.org/Org/repo.git')).toBeUndefined();
  });
  test('is undefined for anything else', () => {
    expect(remoteWebBase('/local/path')).toBeUndefined();
    expect(remoteWebBase('file:///x/y')).toBeUndefined();
  });
  test('remoteIdentity still lowercases', () => {
    expect(remoteIdentity('git@GitHub.com:Org/Repo.git')).toBe('github.com/org/repo');
  });
});
