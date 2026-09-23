// triage runs delete, run through buildProgram and runCli with a test home
// (folder provider under the temp TRIAGE_RUNS_DIR) and fake io.

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { makeTestHome, type TestHome } from '../../../test/support/home.ts';
import { redactPersisted } from '../../gate/redact.ts';
import { RUN_A, RUN_B, RUN_C, sampleRequest } from '../../runstore/contract.ts';
import { createRunStore } from '../../runstore/index.ts';
import { ERASURE_LIMITS } from '../../runstore/retention.ts';
import type { RunStore } from '../../runstore/types.ts';
import { commands as generatedCommands } from '../command-modules.gen.ts';
import { buildProgram, runCli } from '../index.ts';
import { EXIT } from '../output.ts';
import type { CliCommand, CliContext } from '../types.ts';
import { createRunsDeleteCommand, type RunsDeleteOptions } from './runs-delete.command.ts';

const homes: TestHome[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) h.cleanup();
});

function home(): TestHome {
  const h = makeTestHome();
  homes.push(h);
  return h;
}

async function seeded(h: TestHome, ...runIds: string[]): Promise<RunStore> {
  const store = await createRunStore(h.config);
  for (const id of runIds) await store.createRun(id, redactPersisted(sampleRequest(id)));
  return store;
}

async function cli(h: TestHome, argv: string[], options: RunsDeleteOptions = {}) {
  let out = '';
  let err = '';
  const ctx: CliContext = {
    config: () => h.config,
    io: {
      stdout: { write: (s: string) => (out += s) },
      stderr: { write: (s: string) => (err += s) },
      stdin: Readable.from([]),
      isTTY: false,
    },
    deps: {},
  };
  const code = await runCli(buildProgram([createRunsDeleteCommand(options)], ctx), ['runs', 'delete', ...argv]);
  return { code, out, err };
}

function runDirs(h: TestHome): string[] {
  const dir = h.config.paths.runsDir;
  return existsSync(dir) ? readdirSync(dir).filter((n) => !n.startsWith('.')).sort() : [];
}

describe('triage runs delete', () => {
  test('is in the generated command list', () => {
    const paths = (generatedCommands as readonly CliCommand[]).map((c) => c.path.join(' '));
    expect(paths).toContain('runs delete');
  });

  test('removes the run from the configured store and prints the limits', async () => {
    const h = home();
    const store = await seeded(h, RUN_A, RUN_B);
    const r = await cli(h, [RUN_A]);
    expect(r.code).toBe(EXIT.OK);
    expect(r.out).toContain(`deleted run ${RUN_A} from the folder run store`);
    for (const line of ERASURE_LIMITS) expect(r.out).toContain(line);
    expect(await store.getRun(RUN_A)).toBeNull();
    expect(await store.getRun(RUN_B)).not.toBeNull();
    expect(runDirs(h)).toEqual([RUN_B]);
  });

  test('--json prints the run id, provider and the limits', async () => {
    const h = home();
    await seeded(h, RUN_A);
    const r = await cli(h, [RUN_A, '--json']);
    expect(r.code).toBe(EXIT.OK);
    expect(JSON.parse(r.out)).toEqual({ run_id: RUN_A, deleted: true, provider: 'folder', not_reached: [...ERASURE_LIMITS] });
    expect(r.err).toBe('');
  });

  test('--json on an unknown id exits non-zero with run not found and leaves the store untouched', async () => {
    const h = home();
    const store = await seeded(h, RUN_A, RUN_B);
    await store.claimIdempotencyKey('held-by-unknown', RUN_C, 60_000);
    const before = runDirs(h);

    const r = await cli(h, [RUN_C, '--json']);

    expect(r.code).not.toBe(EXIT.OK);
    expect(JSON.parse(r.out)).toEqual({ error: { code: 'ERROR', message: `run not found: ${RUN_C}` } });
    expect(runDirs(h)).toEqual(before);
    expect(await store.getRun(RUN_A)).not.toBeNull();
    expect(await store.getRun(RUN_B)).not.toBeNull();
    expect(await store.claimIdempotencyKey('held-by-unknown', RUN_A, 60_000)).toBe(RUN_C);
  });

  test('an unknown id without --json writes run not found to stderr', async () => {
    const h = home();
    const r = await cli(h, [RUN_C]);
    expect(r.code).toBe(EXIT.ERROR);
    expect(r.err).toContain('run not found');
    expect(r.out).toBe('');
  });

  test('an invalid run id is a usage error and never opens the store', async () => {
    const h = home();
    let opened = 0;
    const r = await cli(h, ['../../etc', '--json'], {
      openStore: async (config) => {
        opened++;
        return createRunStore(config);
      },
    });
    expect(r.code).toBe(EXIT.USAGE);
    expect(JSON.parse(r.out).error.code).toBe('USAGE');
    expect(opened).toBe(0);
  });

  test('a missing run id is a usage error', async () => {
    const h = home();
    const r = await cli(h, []);
    expect(r.code).toBe(EXIT.USAGE);
  });
});
