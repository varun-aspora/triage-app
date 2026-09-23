// makeToolContext() builds a ToolContext for tests without a real .env:
// config comes from .env.example plus overrides, the registry from the repo's
// resources/ files. By default ctx.deps is a Proxy that throws on any access,
// which proves a tool's create() and enabled() never touch run dependencies.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';
import { configFromRecord, type Config } from '../../src/config/env.ts';
import { loadRegistry, type Registry } from '../../src/config/registry.ts';
import type { ToolContext, ToolDeps } from '../../src/tools/types.ts';
import type { Entity } from '../../src/types/core.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const FAKE_HOME = '/triage-test/home';

export class FakeDepsAccessError extends Error {
  override readonly name = 'FakeDepsAccessError';
}

/** A ToolDeps stand-in that throws on every property read, write, lookup or enumeration. */
export function throwingDeps(): ToolDeps {
  const fail = (what: string): never => {
    throw new FakeDepsAccessError(`ctx.deps ${what} in a fake tool context; tools read deps only inside run()`);
  };
  return new Proxy(Object.create(null) as object, {
    get: (_t, key) => fail(`read of ${String(key)}`),
    set: (_t, key) => fail(`write of ${String(key)}`),
    has: (_t, key) => fail(`lookup of ${String(key)}`),
    deleteProperty: (_t, key) => fail(`delete of ${String(key)}`),
    defineProperty: (_t, key) => fail(`define of ${String(key)}`),
    ownKeys: () => fail('enumeration'),
    getOwnPropertyDescriptor: (_t, key) => fail(`descriptor of ${String(key)}`),
  }) as ToolDeps;
}

let example: Readonly<Record<string, string>> | undefined;

function exampleRecord(): Readonly<Record<string, string>> {
  example ??= Object.freeze(parse(readFileSync(join(ROOT, '.env.example'), 'utf8')));
  return example;
}

export type FakeToolContextOptions = {
  readonly entity?: Entity | null;
  readonly runId?: string;
  /** Applied over .env.example; undefined removes a key. Ignored when config is given. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly config?: Config;
  readonly registry?: Registry;
  /** Real deps for a test that runs a tool. Defaults to throwingDeps(). */
  readonly deps?: ToolDeps;
};

export function makeTestConfig(env: FakeToolContextOptions['env'] = {}): Config {
  const record: Record<string, string> = { ...exampleRecord() };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete record[key];
    else record[key] = value;
  }
  return configFromRecord(record, FAKE_HOME);
}

export function makeToolContext(options: FakeToolContextOptions = {}): ToolContext {
  const config = options.config ?? makeTestConfig(options.env);
  const registry = options.registry ?? loadRegistry(config, { resourcesDir: join(ROOT, 'resources') });
  return Object.freeze({
    runId: options.runId ?? 'run_test_0001',
    entity: options.entity ?? null,
    config,
    registry,
    deps: options.deps ?? throwingDeps(),
  });
}
