#!/usr/bin/env node
// triage CLI shim. Runs src/cli/main.ts directly through Node's built-in
// type stripping, which is on by default from Node 22.18; the repo needs 22.19.

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 19)) {
  process.stderr.write(`triage: needs Node >= 22.19, found ${process.versions.node}\n`);
  process.exit(1);
}

const { main } = await import('../src/cli/main.ts');
process.exitCode = await main(process.argv.slice(2));
