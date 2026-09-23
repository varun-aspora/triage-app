// Every call below uses a TEST-NET address (192.0.2.1, RFC 5737) or a
// --version style argument, so even a broken guard would not reach a real
// system. The module-level assert stops the file if the guard is missing.

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import childProcess, {
  exec as namedExec,
  execFile as namedExecFile,
  spawn as namedSpawn,
} from 'node:child_process';
import http, { request as namedHttpRequest } from 'node:http';
import https from 'node:https';
import net, { connect as namedNetConnect } from 'node:net';
import tls from 'node:tls';
import { promisify } from 'node:util';
import {
  DENIED_BINARIES,
  NoIoGuardError,
  allowLoopback,
  assertNoIoGuardInstalled,
  deniedBinaryIn,
  installNoIoGuard,
} from './no-io-guard.ts';

assertNoIoGuardInstalled();

const BLOCKED = /no-io guard/;
const REMOTE = '192.0.2.1';

describe('network', () => {
  test('fetch to a remote host throws naming the guard', () => {
    expect(() => fetch('https://example.com')).toThrow(BLOCKED);
    expect(() => fetch(new URL('https://example.com/x'))).toThrow(NoIoGuardError);
    expect(() => fetch(new Request(`http://${REMOTE}/`))).toThrow(BLOCKED);
    expect(() => fetch('s3://bucket/key')).toThrow(BLOCKED);
    expect(() => fetch('http://127.0.0.1:1/', { unix: '/var/run/docker.sock' } as RequestInit)).toThrow(BLOCKED);
  });

  test('fetch of a data: URL still works', async () => {
    const res = await fetch('data:text/plain,hello');
    expect(await res.text()).toBe('hello');
  });

  test('WebSocket to a remote host throws', () => {
    expect(() => new WebSocket(`wss://${REMOTE}/socket`)).toThrow(BLOCKED);
  });

  test('http.request, http.get, https.request and https.get throw', () => {
    expect(() => http.request(`http://${REMOTE}/`)).toThrow(BLOCKED);
    expect(() => http.request({ host: REMOTE, port: 8080, path: '/' })).toThrow(BLOCKED);
    expect(() => http.get(`http://${REMOTE}/`)).toThrow(BLOCKED);
    expect(() => https.request(`https://${REMOTE}/`)).toThrow(BLOCKED);
    expect(() => https.request({ hostname: REMOTE })).toThrow(BLOCKED);
    expect(() => https.get(`https://${REMOTE}/`)).toThrow(BLOCKED);
    expect(() => http.request({ socketPath: '/var/run/docker.sock', path: '/' })).toThrow(BLOCKED);
  });

  test('net.connect, createConnection, Socket#connect and tls.connect throw', () => {
    expect(() => net.connect(5432, REMOTE)).toThrow(BLOCKED);
    expect(() => net.connect({ host: REMOTE, port: 5432 })).toThrow(BLOCKED);
    expect(() => net.createConnection({ host: REMOTE, port: 22 })).toThrow(BLOCKED);
    expect(() => new net.Socket().connect(443, REMOTE)).toThrow(BLOCKED);
    expect(() => tls.connect(443, REMOTE)).toThrow(BLOCKED);
    expect(() => tls.connect({ host: REMOTE, port: 443 })).toThrow(BLOCKED);
  });

  test('unix socket paths are blocked (for example a local postgres socket)', () => {
    expect(() => net.connect('/tmp/.s.PGSQL.5432')).toThrow(BLOCKED);
    expect(() => net.connect({ path: '/tmp/.s.PGSQL.5432' })).toThrow(BLOCKED);
  });

  test('named ESM imports of the builtins are blocked too', () => {
    expect(() => namedNetConnect(5432, REMOTE)).toThrow(BLOCKED);
    expect(() => namedHttpRequest(`http://${REMOTE}/`)).toThrow(BLOCKED);
  });

  test('Bun.connect to a remote host throws', () => {
    expect(() => Bun.connect({ hostname: REMOTE, port: 22, socket: { data() {} } })).toThrow(BLOCKED);
  });

  test('installing twice is a no-op', () => {
    installNoIoGuard();
    expect(() => fetch('https://example.com')).toThrow(BLOCKED);
  });
});

describe('loopback', () => {
  let a: http.Server;
  let b: http.Server;
  let portA = 0;
  let portB = 0;
  const revokes: (() => void)[] = [];

  const listen = (server: http.Server): Promise<number> =>
    new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
    });

  beforeAll(async () => {
    a = http.createServer((_req, res) => res.end('a'));
    b = http.createServer((_req, res) => res.end('b'));
    portA = await listen(a);
    portB = await listen(b);
  });

  afterEach(() => {
    for (const revoke of revokes.splice(0)) revoke();
  });

  afterAll(() => {
    a.closeAllConnections();
    b.closeAllConnections();
    a.close();
    b.close();
  });

  test('loopback is blocked unless the port is opted in', () => {
    expect(() => fetch(`http://127.0.0.1:${portA}/`)).toThrow(/allowLoopback/);
    expect(() => fetch(`http://localhost:${portA}/`)).toThrow(BLOCKED);
    expect(() => net.connect(portA, '127.0.0.1')).toThrow(BLOCKED);
    expect(() => http.request(`http://127.0.0.1:${portA}/`)).toThrow(BLOCKED);
  });

  test('allowLoopback([port]) opens only that port', async () => {
    revokes.push(allowLoopback([portA]));

    const res = await fetch(`http://127.0.0.1:${portA}/`);
    expect(await res.text()).toBe('a');

    const body = await new Promise<string>((resolve, reject) => {
      http
        .get(`http://127.0.0.1:${portA}/`, (r) => {
          let text = '';
          r.on('data', (c) => (text += String(c)));
          r.on('end', () => resolve(text));
        })
        .on('error', reject);
    });
    expect(body).toBe('a');

    await new Promise<void>((resolve, reject) => {
      const socket = net.connect(portA, '127.0.0.1', () => {
        socket.destroy();
        resolve();
      });
      socket.on('error', reject);
    });

    expect(() => fetch(`http://127.0.0.1:${portB}/`)).toThrow(/allowLoopback/);
    expect(() => net.connect(portB, '127.0.0.1')).toThrow(BLOCKED);
    expect(() => fetch(`http://${REMOTE}:${portA}/`)).toThrow(BLOCKED);
  });

  test('the returned function closes the port again', () => {
    const revoke = allowLoopback([portA]);
    revoke();
    expect(() => fetch(`http://127.0.0.1:${portA}/`)).toThrow(/allowLoopback/);
  });

  test('allowLoopback rejects invalid ports', () => {
    expect(() => allowLoopback([0])).toThrow(TypeError);
    expect(() => allowLoopback([70000])).toThrow(TypeError);
    expect(() => allowLoopback([1.5])).toThrow(TypeError);
  });
});

describe('host binaries', () => {
  test('the denylist is exactly the agreed set', () => {
    expect([...DENIED_BINARIES].sort()).toEqual(
      ['aws', 'codegraph', 'curl', 'gh', 'git', 'kubectl', 'psql', 'qw', 'ssh'],
    );
  });

  for (const bin of DENIED_BINARIES) {
    test(`${bin} is blocked via spawn, spawnSync, execFile, execFileSync, exec and execSync`, () => {
      expect(() => childProcess.spawn(bin, ['--version'])).toThrow(BLOCKED);
      expect(() => childProcess.spawnSync(bin, ['--version'])).toThrow(BLOCKED);
      expect(() => childProcess.execFile(bin, ['--version'], () => {})).toThrow(BLOCKED);
      expect(() => childProcess.execFileSync(bin, ['--version'])).toThrow(BLOCKED);
      expect(() => childProcess.exec(`${bin} --version`, () => {})).toThrow(BLOCKED);
      expect(() => childProcess.execSync(`${bin} --version`)).toThrow(BLOCKED);
      expect(() => childProcess.spawn(`/usr/bin/${bin}`, ['--version'])).toThrow(BLOCKED);
    });
  }

  test('the named cases from the ticket throw', () => {
    expect(() => childProcess.execFile('ssh', ['-V'], () => {})).toThrow(BLOCKED);
    expect(() => childProcess.spawn('qw', ['--version'])).toThrow(BLOCKED);
    expect(() => childProcess.execFile('git', ['--version'], () => {})).toThrow(BLOCKED);
    expect(() => childProcess.exec('gh --version', () => {})).toThrow(BLOCKED);
  });

  test('shell:true variants are denied', () => {
    expect(() => childProcess.spawn('git --version', { shell: true })).toThrow(BLOCKED);
    expect(() => childProcess.spawn('echo', ['ok', '&&', 'ssh', '-V'], { shell: true })).toThrow(BLOCKED);
    expect(() => childProcess.spawnSync('true; curl --version', { shell: '/bin/sh' })).toThrow(BLOCKED);
    expect(() => childProcess.execFile('echo', ['$(gh --version)'], { shell: true }, () => {})).toThrow(BLOCKED);
    expect(() => childProcess.execFileSync('echo x | kubectl version --client', { shell: true })).toThrow(BLOCKED);
    expect(() => childProcess.exec('FOO=1 psql --version', () => {})).toThrow(BLOCKED);
  });

  test('shells and wrappers that run a denied binary are denied', () => {
    expect(() => childProcess.spawn('sh', ['-c', 'aws --version'])).toThrow(BLOCKED);
    expect(() => childProcess.spawn('/bin/bash', ['-lc', 'codegraph --version'])).toThrow(BLOCKED);
    expect(() => childProcess.spawnSync('env', ['GIT_DIR=x', 'git', '--version'])).toThrow(BLOCKED);
    expect(() => childProcess.spawnSync('xargs', ['ssh'])).toThrow(BLOCKED);
  });

  test('named imports and promisified forms are blocked', async () => {
    expect(() => namedSpawn('git', ['--version'])).toThrow(BLOCKED);
    expect(() => namedExecFile('ssh', ['-V'], () => {})).toThrow(BLOCKED);
    expect(() => namedExec('gh --version', () => {})).toThrow(BLOCKED);
    await expect(async () => promisify(childProcess.execFile)('git', ['--version'])).toThrow(BLOCKED);
    await expect(async () => promisify(childProcess.exec)('gh --version')).toThrow(BLOCKED);
  });

  test('Bun.spawn, Bun.spawnSync and Bun.$ are blocked', () => {
    expect(() => Bun.spawn(['git', '--version'])).toThrow(BLOCKED);
    expect(() => Bun.spawn({ cmd: ['ssh', '-V'] })).toThrow(BLOCKED);
    expect(() => Bun.spawnSync(['sh', '-c', 'curl --version'])).toThrow(BLOCKED);
    expect(() => Bun.$`gh --version`).toThrow(BLOCKED);
    const tool = 'kubectl';
    expect(() => Bun.$`${tool} version --client`).toThrow(BLOCKED);
  });

  test('bun and node are not blocked', () => {
    expect(childProcess.spawnSync('node', ['-e', 'process.exit(0)']).status).toBe(0);
    expect(childProcess.spawnSync('bun', ['--version']).status).toBe(0);
    expect(childProcess.execFileSync(process.execPath, ['--version']).toString()).toMatch(/\d/);
    expect(Bun.spawnSync(['node', '--version']).exitCode).toBe(0);
    expect(childProcess.execSync('echo ok').toString().trim()).toBe('ok');
  });

  test('deniedBinaryIn matches whole command words only', () => {
    expect(deniedBinaryIn('/usr/local/bin/GIT', [], false)).toBe('git');
    expect(deniedBinaryIn('gitk', [], false)).toBeUndefined();
    expect(deniedBinaryIn('node', ['git'], false)).toBeUndefined();
    expect(deniedBinaryIn('echo digits', [], true)).toBeUndefined();
    expect(deniedBinaryIn('cd /x && ssh host', [], true)).toBe('ssh');
  });
});
