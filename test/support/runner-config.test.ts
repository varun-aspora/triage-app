// Checks the test runner wiring: bunfig.toml keeps Bun from loading .env,
// `bun run test` skips contract and eval files, and vitest.config.ts
// includes only those. Child runs use temp dirs and spawn only bun.

import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vitestConfig from '../../vitest.config.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PRELOAD = join(REPO, 'test/support/bun-preload.ts');
const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { scripts: Record<string, string> };

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempProject(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'runner-config-'));
  dirs.push(root);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

function runBun(cwd: string, args: string[]): { status: number | null; output: string } {
  const env = { ...process.env };
  delete env.TRIAGE_ENV_SENTINEL;
  const r = spawnSync('bun', args, { cwd, env, encoding: 'utf8', timeout: 60_000 });
  return { status: r.status, output: `${r.stdout}\n${r.stderr}` };
}

/** The repo bunfig.toml with its preload pointed at this repo, so it works from a temp dir. */
function repoBunfig(): string {
  const text = readFileSync(join(REPO, 'bunfig.toml'), 'utf8');
  expect(text).toContain('"./test/support/bun-preload.ts"');
  return text.replace('"./test/support/bun-preload.ts"', JSON.stringify(PRELOAD));
}

const SENTINEL_PROBE = `import { expect, test } from 'bun:test';
test('probe', () => {
  console.log('SENTINEL=' + String(process.env.TRIAGE_ENV_SENTINEL));
});
`;

describe('.env loading', () => {
  test('bunfig.toml turns off automatic .env loading', () => {
    expect(readFileSync(join(REPO, 'bunfig.toml'), 'utf8')).toMatch(/^env\s*=\s*false\s*$/m);
  });

  test('a .env in the cwd is not loaded under bun run test', () => {
    const files = {
      '.env': 'TRIAGE_ENV_SENTINEL=leaked\n',
      'package.json': JSON.stringify({ scripts: { test: 'bun test ./probe' } }),
      'probe/sentinel.test.ts': SENTINEL_PROBE,
    };

    // Control: without the repo bunfig, Bun loads the .env, so the probe can see it.
    const control = runBun(tempProject(files), ['run', 'test']);
    expect(control.output).toContain('SENTINEL=leaked');

    const guarded = runBun(tempProject({ ...files, 'bunfig.toml': repoBunfig() }), ['run', 'test']);
    expect(guarded.status).toBe(0);
    expect(guarded.output).toContain('SENTINEL=undefined');
    expect(guarded.output).not.toContain('leaked');
  });

  test('this test process has no sentinel from a .env', () => {
    expect(process.env.TRIAGE_ENV_SENTINEL).toBeUndefined();
  });
});

describe('bun run test file selection', () => {
  test('the test script is bun test over src, test and scripts', () => {
    expect(pkg.scripts.test).toBe('bun test ./src ./test ./scripts');
  });

  test('contract and eval files are not picked up', () => {
    const picked = "throw new Error('PICKED_UP');\n";
    const root = tempProject({
      'bunfig.toml': 'env = false\n',
      'src/a.eval.ts': picked,
      'test/contract/b.contract.ts': picked,
      'scripts/c.eval.ts': picked,
      'test/ok.test.ts': "import { test } from 'bun:test';\ntest('ok', () => {});\n",
    });
    const args = (pkg.scripts.test ?? '').split(' ').slice(1);
    const r = runBun(root, args);
    expect(r.status).toBe(0);
    expect(r.output).toContain('1 pass');
    expect(r.output).not.toContain('PICKED_UP');
  });
});

describe('vitest.config.ts', () => {
  const t = vitestConfig.test ?? {};

  test('include is exactly contract and eval files', () => {
    expect(t.include).toEqual(['test/contract/**/*.contract.ts', '**/*.eval.ts']);
  });

  test('runs on Node with the shared guard and a raised timeout', () => {
    expect(t.environment).toBe('node');
    expect(t.setupFiles).toEqual(['test/support/vitest-setup.ts']);
    expect(t.testTimeout ?? 0).toBeGreaterThanOrEqual(30_000);
  });
});

describe('package.json scripts', () => {
  test('gen runs before typecheck, build and contract tests, and on install', () => {
    expect(pkg.scripts.gen).toBe('bun scripts/gen-indexes.ts');
    expect(pkg.scripts.postinstall).toBe('bun run gen');
    for (const name of ['typecheck', 'build', 'test:contract']) {
      expect(pkg.scripts[name]).toStartWith('bun run gen && ');
    }
    expect(pkg.scripts['test:contract']).toEndWith('vitest run');
  });

  test('scripts filled by later tickets are pre-declared', () => {
    expect(pkg.scripts['evals:classifier']).toBe('node bin/triage.mjs evals classifier');
    expect(pkg.scripts.ci).toBe('bun scripts/ci.ts');
    expect(pkg.scripts.serve).toBe('node bin/triage-server.mjs');
  });
});
