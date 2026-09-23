import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { REPO_ROOT } from '../support/home.ts';
import {
  SOURCE_RULES,
  checkSource,
  committedGenFiles,
  contractTestNames,
  flueDirViolations,
  formatViolation,
  parseGitIndex,
  readGitIndexPaths,
  scanTree,
  srcFiles,
  stripComments,
  type SourceRule,
  type Violation,
} from './rules.ts';

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempRoot(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'triage-guards-'));
  made.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

function rule(id: string): SourceRule {
  const r = SOURCE_RULES.find((x) => x.id === id);
  if (r === undefined) throw new Error(`no rule ${id}`);
  return r;
}

function run(id: string, path: string, text: string): Violation[] {
  return checkSource({ path, text }, [rule(id)]);
}

function lines(vs: readonly Violation[]): string[] {
  return vs.map((v) => `${v.file}:${v.line}`);
}

// id -> fixtures. `bad` lists [path, text, expected line numbers]; `good` must pass.
type Case = { bad: [string, string, number[]][]; good: [string, string][] };

const CASES: Record<string, Case> = {
  'use-agent-directive': {
    bad: [
      ['src/tools/x.ts', "const a = 1;\n'use agent';\n", [2]],
      ['src/agents/delegates/d.ts', '"use agent";\nexport const d = 1;\n', [1]],
      ['src/agents/triage.agent.ts', "import x from './x.ts';\n'use agent';\n", [1, 2]],
      ['src/agents/triage.agent.ts', 'export const rootAgent = 1;\n', [1]],
      ['src/agents/triage.agent.ts', "'use agent';\nconst again = 'use agent';\n", [2]],
    ],
    good: [
      ['src/agents/triage.agent.ts', "// Root agent.\n'use agent';\nexport const rootAgent = 1;\n"],
      ['src/agents/triage.agent.ts', '/* header */\n"use agent"\nexport const rootAgent = 1;\n'],
      ['src/tools/x.ts', "// starts with 'use agent'\nexport const x = 1;\n"],
    ],
  },
  'process-env-in-config-only': {
    bad: [
      ['src/tools/x.ts', 'const a = 1;\nconst t = process.env.SLACK_BOT_TOKEN;\n', [2]],
      ['src/cli/y.ts', "const t = process['env'];\n", [1]],
      ['src/cli/y.ts', 'const { env } = process;\n', [1]],
      ['src/cli/y.ts', "import { env } from 'node:process';\n", [1]],
    ],
    good: [
      ['src/config/env.ts', 'const h = process.env.TRIAGE_HOME;\n'],
      ['src/tools/x.ts', '// never read process.env here\nconst processEnvironment = 1;\n'],
    ],
  },
  'deploy-mode-key': {
    bad: [
      ['src/ops/doctor.ts', "const k = 'TRIAGE_DEPLOY_MODE';\n", [1]],
      ['src/config/env.ts', "\n\nif (rec['TRIAGE_DEPLOY_MODE']) {}\n", [3]],
    ],
    good: [
      ['src/config/keys.ts', "export const DEPLOY_MODE_KEY = 'TRIAGE_DEPLOY_MODE';\n"],
      ['src/ops/preflight.ts', "const k = 'TRIAGE_DEPLOY_MODE';\n"],
      ['src/config/env.ts', '// TRIAGE_DEPLOY_MODE is read through DEPLOY_MODE_KEY\n'],
    ],
  },
  'deploy-mode-accessor': {
    bad: [['src/agents/triage.ts', "import { deployModeForPreflight } from '../config/env.ts';\n", [1]]],
    good: [
      ['src/ops/preflight.ts', 'deployModeForPreflight(config);\n'],
      ['src/config/env.ts', 'export function deployModeForPreflight() {}\n'],
      ['src/config/keys.ts', '/** Read only through deployModeForPreflight. */\n'],
    ],
  },
  'env-label-display-only': {
    bad: [
      ['src/gate/scope.ts', "if (config.display.envLabel === 'prod') {}\n", [1]],
      ['src/tools/x.ts', 'const { envLabel } = config.display;\n', [1]],
    ],
    good: [
      ['src/report/render.ts', 'const label = config.display.envLabel;\n'],
      ['src/gate/audit.ts', 'line.env = config.display.envLabel;\n'],
      ['src/config/env.ts', 'display: { envLabel: undefined },\n'],
    ],
  },
  'no-bun-in-src': {
    bad: [
      ['src/x.ts', 'const f = Bun.file(p);\n', [1]],
      ['src/x.ts', "import { Database } from 'bun:sqlite';\n", [1]],
      ['src/x.ts', "\nconst m = await import('bun:ffi');\n", [2]],
      ['src/x.ts', "import { $ } from 'bun';\n", [1]],
    ],
    good: [['src/x.ts', "// Bun.spawn is blocked by the guard\nconst bunny = 'bun: not an import';\n"]],
  },
  'no-md-imports': {
    bad: [
      ['src/agents/skills.ts', "import skill from '../../knowledge/patterns/SKILL.md';\n", [1]],
      ['src/agents/skills.ts', "const s = await import('./notes.md?raw');\n", [1]],
      ['src/agents/skills.ts', "import './side-effect.md';\n", [1]],
    ],
    good: [['src/agents/skills.ts', "export const SKILL_FILE = 'SKILL.md';\nconst p = join(dir, 'report.md');\n"]],
  },
  'no-flue-local': {
    bad: [
      ['src/agents/sandbox.ts', "import { sqlite, local } from '@flue/runtime/node';\n", [1]],
      ['src/agents/sandbox.ts', "import {\n  local as host,\n} from \"@flue/runtime/node\";\n", [1]],
      ['src/agents/sandbox.ts', "import * as node from '@flue/runtime/node';\nconst s = node.local();\n", [2]],
      ['src/agents/sandbox.ts', "const { local } = await import('@flue/runtime/node');\n", [1]],
      ['src/agents/sandbox.ts', "export { local } from '@flue/runtime/node';\n", [1]],
    ],
    good: [
      ['src/db.ts', "import { sqlite } from '@flue/runtime/node';\nconst local = 1;\n"],
      ['src/agents/sandbox.ts', "import { local } from './sandbox-local.ts';\n"],
    ],
  },
  'no-agent-router': {
    bad: [['src/app.ts', "import { createAgentRouter } from '@flue/runtime';\n", [1]]],
    good: [['src/app.ts', '// There is no createAgentRouter mount (D25).\n']],
  },
  'no-shell-true': {
    bad: [
      ['src/connectors/exec.ts', "execFile('ls', [], { shell: true });\n", [1]],
      ['src/connectors/exec.ts', "spawn('ls', { cwd,\n  shell : true });\n", [2]],
    ],
    good: [['src/connectors/exec.ts', "execFile('ls', [], { shell: false });\n// shell: true is refused\n"]],
  },
  'policy-checks-off-in-tests-only': {
    bad: [
      ['src/cli/commands/x.command.ts', "configFromRecord(rec, home, { policyChecks: false });\n", [1]],
      ['scripts/seed.ts', "\nconst opts = { policyChecks: false };\n", [2]],
    ],
    good: [
      ['src/config/env.test.ts', 'configFromRecord(rec, home, { policyChecks: false });\n'],
      ['test/contract/triage.contract.ts', 'configFromRecord(rec, home, { policyChecks: false });\n'],
      ['test/support/anything.ts', 'configFromRecord(rec, home, { policyChecks: false });\n'],
      ['src/config/env.ts', 'if (options.policyChecks !== false) {}\n'],
    ],
  },
};

describe('source rules: in-memory fixtures', () => {
  test('every rule has fixtures', () => {
    expect(Object.keys(CASES).sort()).toEqual(SOURCE_RULES.map((r) => r.id).sort());
  });

  for (const [id, c] of Object.entries(CASES)) {
    test(`${id} fires on each positive fixture with file:line`, () => {
      for (const [path, text, expected] of c.bad) {
        const vs = run(id, path, text);
        expect(lines(vs)).toEqual(expected.map((n) => `${path}:${n}`));
        for (const v of vs) expect(formatViolation(v)).toStartWith(`${path}:${v.line} [${id}] `);
      }
    });
    test(`${id} passes each negative fixture`, () => {
      for (const [path, text] of c.good) expect(lines(run(id, path, text))).toEqual([]);
    });
  }
});

describe('source rules: fixtures on disk go through the tree scanner', () => {
  test('each source rule reports its violation from a temp file', () => {
    for (const [id, c] of Object.entries(CASES)) {
      const [path, text, expected] = c.bad[0] as [string, string, number[]];
      const root = tempRoot({ [path]: text });
      const vs = scanTree(root, []).filter((v) => v.rule === id);
      expect(lines(vs)).toEqual(expected.map((n) => `${path}:${n}`));
    }
  });

  test('the src scan skips *.test.ts files', () => {
    const root = tempRoot({ 'src/tools/x.test.ts': 'const t = process.env.X;\nBun.file(p);\n' });
    expect(scanTree(root, [])).toEqual([]);
  });
});

describe('tree rules', () => {
  test('a committed *.gen.ts is reported', () => {
    const vs = committedGenFiles(['src/tools/index.ts', 'src/tools/tool-modules.gen.ts']);
    expect(vs.map(formatViolation)).toEqual(['src/tools/tool-modules.gen.ts:1 [no-committed-gen] *.gen.ts files are generated and gitignored']);
    expect(committedGenFiles(['src/tools/index.ts', 'src/gen.ts'])).toEqual([]);
  });

  test('a .flue/ directory is reported', () => {
    const root = tempRoot({ '.flue/agents/x.ts': 'export {};\n' });
    expect(lines(flueDirViolations(root))).toEqual(['.flue:1']);
    expect(lines(scanTree(root, []))).toContain('.flue:1');
    expect(flueDirViolations(tempRoot({ 'src/app.ts': '' }))).toEqual([]);
  });

  test('a *.contract.test.ts file is reported', () => {
    expect(lines(contractTestNames(['test/contract/a.contract.test.ts', 'test/contract/b.contract.ts']))).toEqual([
      'test/contract/a.contract.test.ts:1',
    ]);
    const root = tempRoot({ 'test/contract/a.contract.test.ts': '' });
    expect(scanTree(root, []).map((v) => v.rule)).toEqual(['no-contract-test-name']);
  });

  test('the git index parser reads format 2 and 4 entries', () => {
    const paths = ['a.ts', 'src/app.ts', 'src/app.gen.ts'];
    expect(parseGitIndex(fakeIndex(2, paths))).toEqual(paths);
    expect(parseGitIndex(fakeIndex(4, paths))).toEqual(paths);
    expect(() => parseGitIndex(Buffer.from('nope'))).toThrow(/not a git index/);
  });
});

describe('comment stripping', () => {
  test('keeps offsets, strings and code, blanks comments', () => {
    const src = "const a = '// not a comment'; // gone\n/* gone\n too */ const re = /\\/\\//g; const t = `x ${'y' /* gone */} z`;\n";
    const out = stripComments(src);
    expect(out.length).toBe(src.length);
    expect(out.split('\n').length).toBe(src.split('\n').length);
    expect(out).toContain("'// not a comment'");
    expect(out).toContain('/\\/\\//g');
    expect(out).not.toContain('gone');
  });
});

describe('the real tree', () => {
  test('passes every rule', () => {
    expect(srcFiles(REPO_ROOT).length).toBeGreaterThan(20);
    const vs = scanTree(REPO_ROOT);
    expect(vs.map(formatViolation)).toEqual([]);
  });

  test('the git index is readable and has no *.gen.ts', () => {
    const tracked = readGitIndexPaths(REPO_ROOT);
    if (tracked === undefined) {
      // Not a git checkout (for example an unpacked archive): the ignore rule is what remains.
      expect(readFileSync(join(REPO_ROOT, '.gitignore'), 'utf8')).toMatch(/^\*\.gen\.ts$/m);
      return;
    }
    expect(tracked).toContain('package.json');
    expect(tracked).toContain('src/config/env.ts');
    expect(tracked.filter((p) => p.endsWith('.gen.ts'))).toEqual([]);
  });
});

// Builds a minimal git index with zeroed stat data, enough for the path parser.
function fakeIndex(version: 2 | 4, paths: readonly string[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('DIRC', 0, 'latin1');
  header.writeUInt32BE(version, 4);
  header.writeUInt32BE(paths.length, 8);
  parts.push(header);
  let prev = '';
  for (const path of paths) {
    const fixed = Buffer.alloc(62);
    fixed.writeUInt16BE(Math.min(path.length, 0xfff), 60);
    if (version === 2) {
      const len = (62 + path.length + 8) & ~7;
      const entry = Buffer.alloc(len);
      fixed.copy(entry);
      entry.write(path, 62, 'utf8');
      parts.push(entry);
    } else {
      let common = 0;
      while (common < prev.length && common < path.length && prev[common] === path[common]) common++;
      const strip = prev.length - common;
      if (strip > 0x7f) throw new Error('fixture paths too long');
      parts.push(fixed, Buffer.from([strip]), Buffer.from(`${path.slice(common)}\0`, 'utf8'));
    }
    prev = path;
  }
  return Buffer.concat(parts);
}
