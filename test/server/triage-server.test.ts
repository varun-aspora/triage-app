// Runs bin/triage-server.mjs under node against a throwaway TRIAGE_HOME. It
// lives here, not next to src/server/boot.ts, because only named files under
// src/ may import child_process. The no-io guard still applies to the spawn.

import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeTestHome, REPO_ROOT, type TestHome } from '../support/home.ts';

const SHIM = join(REPO_ROOT, 'bin/triage-server.mjs');

describe('bin/triage-server.mjs under node', () => {
  let home: TestHome | undefined;
  afterEach(() => {
    home?.cleanup();
    home = undefined;
  });

  function runShim(triageHome: string) {
    return spawnSync('node', [SHIM], {
      cwd: REPO_ROOT,
      env: { PATH: process.env.PATH ?? '', TRIAGE_HOME: triageHome },
      encoding: 'utf8',
      timeout: 30_000,
    });
  }

  test('exits 3 naming TRIAGE_HTTP_AUTH_TOKEN when the token is blank', () => {
    home = makeTestHome();
    const r = runShim(home.home);
    expect(r.status).toBe(3);
    expect(r.stderr).toContain('TRIAGE_HTTP_AUTH_TOKEN');
    expect(r.stderr).not.toContain('dist/server.mjs');
  });

  // With a build present the shim would start a real listener, so this runs
  // only when dist/server.mjs is absent.
  test.skipIf(existsSync(join(REPO_ROOT, 'dist/server.mjs')))('with a token and no build, says to build first', () => {
    home = makeTestHome({ overrides: { TRIAGE_HTTP_AUTH_TOKEN: 'test-token' } });
    const r = runShim(home.home);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('bun run build');
    expect(r.stderr).not.toContain('test-token');
  });
});
