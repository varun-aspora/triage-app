#!/usr/bin/env node
// triage HTTP server shim (T07.10). `bun run serve` runs it. Runs
// src/server/main.ts directly through Node's built-in type stripping, as
// bin/triage.mjs does, so there is nothing to build first.
//
// src/server/main.ts boots everything. This file owns the process: the Node
// version check, the listening line, exit codes, and SIGINT/SIGTERM, which
// stop the server and exit 130/143. A shutdown that hangs exits after 60s.

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 19)) {
  process.stderr.write(`triage-server: needs Node >= 22.19, found ${process.versions.node}\n`);
  process.exit(1);
}

const { runServer, describeBootError } = await import('../src/server/main.ts');

let server;
try {
  server = await runServer();
} catch (err) {
  const { line, exitCode } = describeBootError(err);
  process.stderr.write(`${line}\n`);
  process.exit(exitCode);
}
process.stdout.write(`triage-server: listening on port ${server.port}\n`);

function shutdown(exitCode) {
  setTimeout(() => {
    process.stderr.write('triage-server: shutdown timed out\n');
    process.exit(exitCode);
  }, 60_000).unref();
  server.stop().then(
    () => process.exit(exitCode),
    (err) => {
      // The name only, as for boot errors.
      const name = typeof err?.name === 'string' && err.name !== '' ? err.name : 'unknown error';
      process.stderr.write(`triage-server: shutdown failed (${name})\n`);
      process.exit(exitCode);
    },
  );
}
process.once('SIGINT', () => shutdown(130));
process.once('SIGTERM', () => shutdown(143));
