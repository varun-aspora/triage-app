// buildProgram and runCli with fake commands and fake io, plus one smoke run
// of bin/triage.mjs on Node. No config is loaded from a real home.

import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { Command } from 'commander';
import { configFromRecord, loadConfig } from '../config/env.ts';
import { commands as generatedCommands } from './command-modules.gen.ts';
import { buildProgram, CliBuildError, runCli } from './index.ts';
import { EXIT, printHuman, printJson } from './output.ts';
import type { CliCommand, CliContext, CliInvocation } from './types.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

type Harness = { ctx: CliContext; out: () => string; err: () => string; configCalls: () => number };

function harness(config: () => ReturnType<CliContext['config']> = () => loadConfig()): Harness {
  let out = '';
  let err = '';
  let calls = 0;
  const ctx: CliContext = {
    config: () => {
      calls++;
      return config();
    },
    io: {
      stdout: { write: (s: string) => (out += s) },
      stderr: { write: (s: string) => (err += s) },
      stdin: Readable.from([]),
      isTTY: false,
    },
    deps: {},
  };
  return { ctx, out: () => out, err: () => err, configCalls: () => calls };
}

function fake(path: string[], run: CliCommand['run'] = async () => EXIT.OK, configure: CliCommand['configure'] = () => {}): CliCommand {
  return { path, summary: `does ${path.join(' ')}`, configure, run };
}

async function run(cmds: readonly CliCommand[], argv: string[], h: Harness = harness()): Promise<number> {
  return runCli(buildProgram(cmds, h.ctx), argv);
}

function withoutHome<T>(fn: () => Promise<T>): Promise<T> {
  const saved = process.env.TRIAGE_HOME;
  delete process.env.TRIAGE_HOME;
  return fn().finally(() => {
    if (saved !== undefined) process.env.TRIAGE_HOME = saved;
  });
}

function allCommands(root: Command): Command[] {
  return [root, ...root.commands.flatMap(allCommands)];
}

describe('help', () => {
  test('--help lists every command and never loads config', async () => {
    const h = harness();
    const cmds = [fake(['tunnel', 'up']), fake(['status']), fake(['repos', 'sync'])];
    expect(await withoutHome(() => run(cmds, ['--help'], h))).toBe(EXIT.OK);
    for (const name of ['tunnel', 'status', 'repos', '--json']) expect(h.out()).toContain(name);
    expect(h.configCalls()).toBe(0);
  });

  test('--help works with zero commands', async () => {
    const h = harness();
    expect(await run([], ['--help'], h)).toBe(EXIT.OK);
    expect(h.out()).toContain('Usage: triage');
  });

  test('a group run on its own prints its help and exits 0', async () => {
    const h = harness();
    const cmds = [fake(['tunnel', 'up']), fake(['tunnel', 'down'])];
    expect(await run(cmds, ['tunnel'], h)).toBe(EXIT.OK);
    expect(h.out()).toContain('Usage: triage tunnel');
    expect(h.out()).toContain('up');
    expect(h.out()).toContain('down');
  });

  test('an unknown word under a group is a usage error', async () => {
    const h = harness();
    expect(await run([fake(['tunnel', 'up'])], ['tunnel', 'sideways'], h)).toBe(EXIT.USAGE);
    expect(h.err()).toContain("unknown command 'tunnel sideways'");
  });

  test('an unknown top-level command is a usage error', async () => {
    const h = harness();
    expect(await run([fake(['status'])], ['nope'], h)).toBe(EXIT.USAGE);
  });
});

describe('paths', () => {
  test("['tunnel','up'] is reachable as 'triage tunnel up' with args and opts", async () => {
    const seen: CliInvocation[] = [];
    const cmd = fake(
      ['tunnel', 'up'],
      async (_ctx, input) => {
        seen.push(input);
        return 7;
      },
      (c) => {
        c.argument('<target>').option('--port <n>');
      },
    );
    expect(await run([cmd], ['tunnel', 'up', 'ssfb', '--port', '9'])).toBe(7);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.args).toEqual(['ssfb']);
    expect(seen[0]?.opts.port).toBe('9');
    expect(seen[0]?.opts.json).toBe(false);
  });

  test('three-part paths create nested groups', async () => {
    let ran = false;
    const cmd = fake(['runs', 'store', 'delete'], async () => {
      ran = true;
      return EXIT.OK;
    });
    expect(await run([cmd], ['runs', 'store', 'delete'])).toBe(EXIT.OK);
    expect(ran).toBe(true);
  });

  test('duplicate paths fail at build and name both files', () => {
    const h = harness();
    const build = () =>
      buildProgram([fake(['tunnel', 'up']), fake(['status']), fake(['tunnel', 'up'])], h.ctx, {
        sources: ['src/cli/commands/a.command.ts', 'src/cli/commands/b.command.ts', 'src/cli/commands/c.command.ts'],
      });
    expect(build).toThrow(CliBuildError);
    expect(build).toThrow("duplicate command path 'tunnel up': src/cli/commands/a.command.ts and src/cli/commands/c.command.ts");
  });

  test('sources can be given lazily', () => {
    const h = harness();
    expect(() =>
      buildProgram([fake(['x']), fake(['x'])], h.ctx, { sources: () => ['one.command.ts', 'two.command.ts'] }),
    ).toThrow('one.command.ts and two.command.ts');
  });

  test('a path that is both a command and a group fails at build', () => {
    const h = harness();
    expect(() =>
      buildProgram([fake(['runs']), fake(['runs', 'delete'])], h.ctx, { sources: ['runs.command.ts', 'runs-delete.command.ts'] }),
    ).toThrow(/'runs' \(runs\.command\.ts\) is also a group for 'runs delete' \(runs-delete\.command\.ts\)/);
  });

  test('empty or non-kebab paths fail at build', () => {
    const h = harness();
    expect(() => buildProgram([fake([])], h.ctx)).toThrow(CliBuildError);
    expect(() => buildProgram([fake(['Tunnel'])], h.ctx)).toThrow(CliBuildError);
    expect(() => buildProgram([fake(['tunnel up'])], h.ctx)).toThrow(CliBuildError);
  });
});

describe('exit codes', () => {
  test('ctx.config() without TRIAGE_HOME exits 3 and stderr names TRIAGE_HOME', async () => {
    const h = harness();
    const cmd = fake(['doctor'], async (ctx) => {
      ctx.config();
      return EXIT.OK;
    });
    expect(await withoutHome(() => run([cmd], ['doctor'], h))).toBe(EXIT.CONFIG);
    expect(h.err()).toContain('TRIAGE_HOME');
    expect(h.out()).toBe('');
  });

  test('a ConfigError prints key names and no values', async () => {
    const secret = 'sk-live-do-not-print-4242';
    const h = harness(() => configFromRecord({ TRIAGE_HTTP_PORT: secret, SLACK_BOT_TOKEN: secret }, '/nonexistent-home'));
    const cmd = fake(['doctor'], async (ctx) => {
      ctx.config();
      return EXIT.OK;
    });
    expect(await run([cmd], ['doctor'], h)).toBe(EXIT.CONFIG);
    expect(h.err()).toContain('TRIAGE_HTTP_PORT');
    expect(h.err()).not.toContain(secret);
  });

  test('a RegistryError maps to exit 3 with its key names', async () => {
    class RegistryError extends Error {
      override readonly name = 'RegistryError';
      readonly keys = ['SSFB_HARBOR_DB_URL', 'SSFB_RHYTHM_API_URL'];
    }
    const h = harness();
    const cmd = fake(['doctor'], async () => {
      throw new RegistryError('the message is not used when keys are present');
    });
    expect(await run([cmd], ['doctor'], h)).toBe(EXIT.CONFIG);
    expect(h.err()).toContain('SSFB_HARBOR_DB_URL, SSFB_RHYTHM_API_URL');
    expect(h.err()).not.toContain('the message is not used');
  });

  test('any other thrown error exits 1', async () => {
    const h = harness();
    const cmd = fake(['boom'], async () => {
      throw new Error('it broke');
    });
    expect(await run([cmd], ['boom'], h)).toBe(EXIT.ERROR);
    expect(h.err()).toContain('it broke');
  });

  test('a non-integer exit code from run becomes 1', async () => {
    const cmd = fake(['odd'], async () => Number.NaN);
    expect(await run([cmd], ['odd'])).toBe(EXIT.ERROR);
  });

  test('an unknown option is a usage error', async () => {
    expect(await run([fake(['status'])], ['status', '--bogus'])).toBe(EXIT.USAGE);
  });
});

describe('--json', () => {
  const configCmd = fake(['doctor'], async (ctx) => {
    ctx.config();
    return EXIT.OK;
  });

  for (const argv of [
    ['--json', 'doctor'],
    ['doctor', '--json'],
  ]) {
    test(`config error with ${argv.join(' ')} prints the JSON error shape on stdout`, async () => {
      const h = harness();
      expect(await withoutHome(() => run([configCmd], argv, h))).toBe(EXIT.CONFIG);
      const parsed = JSON.parse(h.out()) as { error: { code: string; message: string } };
      expect(Object.keys(parsed)).toEqual(['error']);
      expect(Object.keys(parsed.error).sort()).toEqual(['code', 'message']);
      expect(parsed.error.code).toBe('CONFIG');
      expect(parsed.error.message).toContain('TRIAGE_HOME');
      expect(h.err()).toBe('');
    });
  }

  test('usage errors under --json are JSON too', async () => {
    const h = harness();
    expect(await run([fake(['status'])], ['--json', 'nope'], h)).toBe(EXIT.USAGE);
    const parsed = JSON.parse(h.out()) as { error: { code: string; message: string } };
    expect(parsed.error.code).toBe('USAGE');
    expect(parsed.error.message).not.toMatch(/^error:/);
    expect(h.err()).toBe('');
  });

  test('generic errors under --json use code ERROR', async () => {
    const h = harness();
    const cmd = fake(['boom'], async () => {
      throw new Error('it broke');
    });
    expect(await run([cmd], ['boom', '--json'], h)).toBe(EXIT.ERROR);
    expect(JSON.parse(h.out())).toEqual({ error: { code: 'ERROR', message: 'Error: it broke' } });
  });

  test('the global flag reaches the command, also when the command declares its own --json', async () => {
    const seen: boolean[] = [];
    const plain = fake(['a'], async (_ctx, { opts }) => {
      seen.push(opts.json);
      return EXIT.OK;
    });
    const own = fake(
      ['b'],
      async (_ctx, { opts }) => {
        seen.push(opts.json);
        return EXIT.OK;
      },
      (c) => {
        c.option('--json', 'print JSON');
      },
    );
    for (const argv of [['--json', 'a'], ['a', '--json'], ['--json', 'b'], ['b', '--json'], ['a'], ['b']]) {
      expect(await run([plain, own], argv)).toBe(EXIT.OK);
    }
    expect(seen).toEqual([true, true, true, true, false, false]);
  });
});

describe('no --env', () => {
  test('no command or group in the built program has --env', () => {
    const h = harness();
    const program = buildProgram([fake(['tunnel', 'up']), fake(['status'])], h.ctx);
    const longs = allCommands(program).flatMap((c) => c.options.map((o) => o.long));
    expect(longs).toContain('--json');
    expect(longs).not.toContain('--env');
  });

  test('--env on the command line is rejected', async () => {
    expect(await run([fake(['status'])], ['--env', 'prod', 'status'])).toBe(EXIT.USAGE);
  });

  test('a command that adds --env fails at build', () => {
    const h = harness();
    const cmd = fake(['status'], undefined, (c) => {
      c.option('--env <name>');
    });
    expect(() => buildProgram([cmd], h.ctx, { sources: ['status.command.ts'] })).toThrow(/status\.command\.ts.*--env/);
  });
});

describe('output helpers', () => {
  test('printJson writes one parseable line and printHuman adds newlines', () => {
    const h = harness();
    printJson(h.ctx.io, { a: 1 });
    printHuman(h.ctx.io, ['x', 'y\n']);
    printHuman(h.ctx.io, 'z');
    expect(h.out()).toBe('{"a":1}\nx\ny\nz\n');
  });
});

describe('bin/triage.mjs smoke', () => {
  test('node bin/triage.mjs --help exits 0 without TRIAGE_HOME and lists every generated command', () => {
    const env: Record<string, string | undefined> = { ...process.env };
    delete env.TRIAGE_HOME;
    const r = spawnSync('node', [join(REPO, 'bin/triage.mjs'), '--help'], {
      cwd: REPO,
      env,
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Usage: triage');
    // The internal __worker command (T07.5, path ['worker']) is hidden from help.
    for (const cmd of generatedCommands as readonly CliCommand[]) {
      if (cmd.path[0] === 'worker') continue;
      expect(r.stdout).toContain(cmd.path[0] as string);
    }
    expect(r.stdout).not.toContain('__worker');
  });

  test('node bin/triage.mjs --json with an unknown command prints the JSON error and exits 2', () => {
    const env: Record<string, string | undefined> = { ...process.env };
    delete env.TRIAGE_HOME;
    const r = spawnSync('node', [join(REPO, 'bin/triage.mjs'), '--json', 'no-such-command'], {
      cwd: REPO,
      env,
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(r.status).toBe(EXIT.USAGE);
    expect((JSON.parse(r.stdout) as { error: { code: string } }).error.code).toBe('USAGE');
  });
});
