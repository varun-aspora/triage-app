#!/usr/bin/env node
// triage CLI shim. Runs src/cli/main.ts directly through Node's built-in
// type stripping, which is on by default from Node 22.18; the repo needs 22.19.

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 19)) {
  process.stderr.write(`triage: needs Node >= 22.19, found ${process.versions.node}\n`);
  process.exit(1);
}

const { main, tracesStillSending } = await import('../src/cli/main.ts');
const code = await main(process.argv.slice(2));
process.exitCode = code;

// A Braintrust flush that timed out (D82) leaves the SDK's requests and retry
// timers running, which would keep the process up for a long time after the
// output. Exit once what is written to stdout and stderr has gone out.
if (tracesStillSending()) {
  const drained = (stream) => new Promise((resolve) => stream.write('', () => resolve()));
  await Promise.all([drained(process.stdout), drained(process.stderr)]);
  process.exit(code);
}
