// Proves the Vitest setup installs the same no-io guard as the bun preload.
// Targets are a TEST-NET address and --version arguments, so a missing guard
// would still not reach a real system.

import childProcess, { spawn as namedSpawn } from 'node:child_process';
import http, { request as namedHttpRequest } from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { describe, expect, test } from 'vitest';
import { allowLoopback, assertNoIoGuardInstalled } from '../support/no-io-guard.ts';

assertNoIoGuardInstalled();

const BLOCKED = /no-io guard/;
const REMOTE = '192.0.2.1';

describe('no-io guard under Vitest', () => {
  test('runs on Node, not Bun', () => {
    expect((globalThis as Record<string, unknown>).Bun).toBeUndefined();
  });

  test('fetch throws naming the guard', () => {
    expect(() => fetch('https://example.com')).toThrow(BLOCKED);
  });

  test('net, tls, http and https to a remote host throw', () => {
    expect(() => net.connect(5432, REMOTE)).toThrow(BLOCKED);
    expect(() => tls.connect(443, REMOTE)).toThrow(BLOCKED);
    expect(() => http.request(`http://${REMOTE}/`)).toThrow(BLOCKED);
    expect(() => https.request(`https://${REMOTE}/`)).toThrow(BLOCKED);
    expect(() => namedHttpRequest(`http://${REMOTE}/`)).toThrow(BLOCKED);
  });

  test('loopback needs allowLoopback, and only for that port', async () => {
    const server = http.createServer((_req, res) => res.end('ok'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;
    try {
      expect(() => fetch(`http://127.0.0.1:${port}/`)).toThrow(/allowLoopback/);
      const revoke = allowLoopback([port]);
      try {
        expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe('ok');
        expect(() => fetch(`http://127.0.0.1:${port === 65535 ? 1 : port + 1}/`)).toThrow(BLOCKED);
      } finally {
        revoke();
      }
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  test('denied binaries throw, including shell:true', () => {
    expect(() => childProcess.execFile('ssh', ['-V'], () => {})).toThrow(BLOCKED);
    expect(() => childProcess.spawn('qw', ['--version'])).toThrow(BLOCKED);
    expect(() => childProcess.execFile('git', ['--version'], () => {})).toThrow(BLOCKED);
    expect(() => childProcess.exec('gh --version', () => {})).toThrow(BLOCKED);
    expect(() => childProcess.spawn('kubectl version --client', { shell: true })).toThrow(BLOCKED);
    expect(() => namedSpawn('git', ['--version'])).toThrow(BLOCKED);
  });

  test('node is not blocked', () => {
    expect(childProcess.spawnSync(process.execPath, ['--version']).status).toBe(0);
  });
});
