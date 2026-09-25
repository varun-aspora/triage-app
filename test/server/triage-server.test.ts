// Runs bin/triage-server.mjs under node against a throwaway TRIAGE_HOME. It
// lives here, not next to src/server/main.ts, because only named files under
// src/ may import child_process. The no-io guard still applies to the spawn,
// and the one request below goes to the child's loopback port only.

import { afterEach, describe, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { makeTestHome, REPO_ROOT, type TestHome } from '../support/home.ts';
import { allowLoopback } from '../support/no-io-guard.ts';

const SHIM = join(REPO_ROOT, 'bin/triage-server.mjs');

function shimEnv(triageHome: string): Record<string, string> {
  return { PATH: process.env.PATH ?? '', TRIAGE_HOME: triageHome };
}

/** A loopback port nothing is listening on right now. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

describe('bin/triage-server.mjs under node', () => {
  let home: TestHome | undefined;
  afterEach(() => {
    home?.cleanup();
    home = undefined;
  });

  test('exits 3 naming TRIAGE_HTTP_AUTH_TOKEN when the token is blank', () => {
    home = makeTestHome();
    const r = spawnSync('node', [SHIM], { cwd: REPO_ROOT, env: shimEnv(home.home), encoding: 'utf8', timeout: 30_000 });
    expect(r.status).toBe(3);
    expect(r.stderr).toContain('TRIAGE_HTTP_AUTH_TOKEN');
    expect(r.stdout).not.toContain('listening');
  });

  test(
    'with a token, serves src/app.ts without a build and exits 143 on SIGTERM',
    async () => {
      const port = await freePort();
      home = makeTestHome({
        overrides: { TRIAGE_HTTP_AUTH_TOKEN: 'test-token', TRIAGE_HTTP_PORT: String(port), TRIAGE_DB_URL: ':memory:' },
      });
      const child = spawn('node', [SHIM], { cwd: REPO_ROOT, env: shimEnv(home.home), stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
      const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));

      try {
        await new Promise<void>((resolve, reject) => {
          child.stdout.on('data', () => {
            if (stdout.includes(`listening on port ${port}`)) resolve();
          });
          void exited.then((code) => reject(new Error(`server exited ${String(code)} before listening: ${stderr}`)));
        });

        const revoke = allowLoopback([port]);
        try {
          const res = await fetch(`http://127.0.0.1:${port}/triage`);
          expect(res.status).toBe(401);
        } finally {
          revoke();
        }
      } finally {
        child.kill('SIGTERM');
      }

      expect(await exited).toBe(143);
      expect(stdout + stderr).not.toContain('test-token');
    },
    30_000,
  );
});
