// triage runs prune, run through buildProgram and runCli with a test home,
// a fake clock and fake io. The store is the folder provider in the temp home.

import { afterEach, describe, expect, test } from 'bun:test';
import { Readable } from 'node:stream';
import { makeTestHome, type TestHome } from '../../../test/support/home.ts';
import { redactPersisted } from '../../gate/redact.ts';
import { CONTRACT_EPOCH, RUN_A, RUN_B, makeClock, sampleRequest, type ContractClock } from '../../runstore/contract.ts';
import { folderRunStoreFromConfig } from '../../runstore/folder.ts';
import { DAY_MS } from '../../runstore/retention.ts';
import type { RunStore } from '../../runstore/types.ts';
import { commands as generatedCommands } from '../command-modules.gen.ts';
import { buildProgram, runCli } from '../index.ts';
import { EXIT } from '../output.ts';
import type { CliCommand, CliContext } from '../types.ts';
import { createRunsPruneCommand } from './runs-prune.command.ts';

const homes: TestHome[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) h.cleanup();
});

function home(retention: string): TestHome {
  const h = makeTestHome({ overrides: { TRIAGE_RUNS_RETENTION_DAYS: retention } });
  homes.push(h);
  return h;
}

async function setup(retention: string): Promise<{ h: TestHome; store: RunStore; clock: ContractClock }> {
  const h = home(retention);
  const clock = makeClock();
  const store = folderRunStoreFromConfig(h.config, { now: clock.now });
  clock.set(CONTRACT_EPOCH - 40 * DAY_MS);
  await store.createRun(RUN_A, redactPersisted(sampleRequest(RUN_A)));
  await store.claimIdempotencyKey('old-key', RUN_A, 60_000);
  clock.set(CONTRACT_EPOCH - 10 * DAY_MS);
  await store.createRun(RUN_B, redactPersisted(sampleRequest(RUN_B)));
  clock.set(CONTRACT_EPOCH);
  await store.claimIdempotencyKey('live-key', RUN_B, 60_000);
  return { h, store, clock };
}

async function cli(h: TestHome, store: RunStore, clock: ContractClock, argv: string[]) {
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
  const command = createRunsPruneCommand({ openStore: async () => store, now: clock.now });
  const code = await runCli(buildProgram([command], ctx), ['runs', 'prune', ...argv]);
  return { code, out, err };
}

describe('triage runs prune', () => {
  test('is in the generated command list', () => {
    const paths = (generatedCommands as readonly CliCommand[]).map((c) => c.path.join(' '));
    expect(paths).toContain('runs prune');
  });

  test('--json prints {deleted, idempotency_cleared}', async () => {
    const { h, store, clock } = await setup('30');
    // The claim on RUN_A went with the run; add one more that simply expired.
    await store.claimIdempotencyKey('short-key', RUN_B, 1_000);
    clock.advance(2_000);

    const r = await cli(h, store, clock, ['--json']);

    expect(r.code).toBe(EXIT.OK);
    expect(JSON.parse(r.out)).toEqual({ deleted: 1, idempotency_cleared: 1 });
    expect(await store.getRun(RUN_A)).toBeNull();
    expect(await store.getRun(RUN_B)).not.toBeNull();
    expect(await store.claimIdempotencyKey('live-key', RUN_A, 60_000)).toBe(RUN_B);
  });

  test('human output names the window and the counts', async () => {
    const { h, store, clock } = await setup('30');
    const r = await cli(h, store, clock, []);
    expect(r.code).toBe(EXIT.OK);
    expect(r.out).toContain('deleted 1 run(s) created before');
    expect(r.out).toContain('30 day window');
    expect(r.out).toContain('expired idempotency key(s)');
  });

  test('blank TRIAGE_RUNS_RETENTION_DAYS deletes no run', async () => {
    const { h, store, clock } = await setup('');
    expect(h.config.runs.retentionDays).toBeUndefined();
    const r = await cli(h, store, clock, ['--json']);
    expect(r.code).toBe(EXIT.OK);
    expect(JSON.parse(r.out).deleted).toBe(0);
    expect(await store.getRun(RUN_A)).not.toBeNull();
    expect(await store.getRun(RUN_B)).not.toBeNull();

    const human = await cli(h, store, clock, []);
    expect(human.out).toContain('retention is off');
  });

  test('a failed delete exits non-zero', async () => {
    const { h, store, clock } = await setup('30');
    const broken: RunStore = Object.assign(Object.create(null), {
      provider: store.provider,
      listExpired: (before: Date) => store.listExpired(before),
      deleteRun: async () => {
        throw new Error('disk gone');
      },
      clearExpiredIdempotencyKeys: () => store.clearExpiredIdempotencyKeys(),
    });
    const r = await cli(h, broken, clock, ['--json']);
    expect(r.code).toBe(EXIT.ERROR);
    expect(JSON.parse(r.out).error.message).toContain('RetentionPruneError');
    expect(await store.getRun(RUN_A)).not.toBeNull();
  });
});
