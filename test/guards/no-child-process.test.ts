// Only two source files under src/ may import child_process: the exec runner
// (src/connectors/exec.ts) and the detached CLI worker spawn
// (src/ingress/detach.ts, T07.9). Everything else shells out through
// ExecRunner. Two existing test files also import it, because they spawn the
// local node binary on purpose to check Node behaviour (src/db.test.ts,
// src/cli/index.test.ts); they are named here one by one rather than
// exempting every test file, so a new test that imports child_process is
// still flagged. The scan covers every code file under src/, with comments
// blanked out.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { REPO_ROOT } from '../support/home.ts';
import { lineAt, stripComments, walk, type Violation } from './rules.ts';

const CHILD_PROCESS_ALLOWED: readonly string[] = ['src/connectors/exec.ts', 'src/ingress/detach.ts'];
// Tests that spawn the local node binary. The no-io guard still stops them
// from running a denied binary.
const CHILD_PROCESS_ALLOWED_TESTS: readonly string[] = ['src/db.test.ts', 'src/cli/index.test.ts'];

// Any string literal naming the module catches static, side-effect, dynamic
// and require imports, and createRequire lookups too.
const CHILD_PROCESS_SPECIFIER = (): RegExp => /(['"`])(?:node:)?child_process\1/g;
const CODE_FILE = /\.(?:[cm]?ts|[cm]?js|tsx|jsx)$/;

function childProcessImports(path: string, text: string): Violation[] {
  if (CHILD_PROCESS_ALLOWED.includes(path) || CHILD_PROCESS_ALLOWED_TESTS.includes(path)) return [];
  const code = stripComments(text);
  return [...code.matchAll(CHILD_PROCESS_SPECIFIER())].map((m) => ({
    rule: 'no-child-process',
    file: path,
    line: lineAt(code, m.index),
    message: 'only src/connectors/exec.ts and src/ingress/detach.ts import child_process; use ExecRunner',
  }));
}

function scan(root: string): Violation[] {
  return walk(root, join(root, 'src'))
    .filter((p) => CODE_FILE.test(p))
    .sort()
    .flatMap((p) => childProcessImports(p, readFileSync(join(root, p), 'utf8')));
}

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempRoot(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'triage-no-cp-'));
  made.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

describe('no-child-process detector', () => {
  const BAD: [string, string, number][] = [
    ['static named', "import { execFile } from 'node:child_process';\n", 1],
    ['static default, bare name', 'import cp from "child_process";\n', 1],
    ['namespace', "const a = 1;\nimport * as cp from 'node:child_process';\n", 2],
    ['side effect', "import 'child_process';\n", 1],
    ['dynamic', "const cp = await import('node:child_process');\n", 1],
    ['template dynamic', 'const cp = await import(`node:child_process`);\n', 1],
    ['require', "const cp = require('child_process');\n", 1],
    ['re-export', "export { spawn } from 'node:child_process';\n", 1],
    ['type import', "import type { ChildProcess } from 'node:child_process';\n", 1],
  ];
  for (const [name, text, line] of BAD) {
    test(`flags ${name}`, () => {
      const vs = childProcessImports('src/tools/x.ts', text);
      expect(vs.map((v) => `${v.file}:${v.line}`)).toEqual([`src/tools/x.ts:${line}`]);
    });
  }

  test('allows only the two named test files', () => {
    const text = "import cp from 'node:child_process';\n";
    expect(childProcessImports('src/db.test.ts', text)).toEqual([]);
    expect(childProcessImports('src/cli/index.test.ts', text)).toEqual([]);
    expect(childProcessImports('src/connectors/exec.test.ts', text)).toHaveLength(1);
    expect(childProcessImports('src/tools/x.test.ts', text)).toHaveLength(1);
    expect(childProcessImports('src/evals/x.eval.ts', text)).toHaveLength(1);
    expect(childProcessImports('src/x.contract.ts', text)).toHaveLength(1);
    expect(childProcessImports('src/cli/db.test.ts', text)).toHaveLength(1);
  });

  test('ignores comments and unrelated names', () => {
    const text = [
      "// import cp from 'node:child_process';",
      "/* require('child_process') */",
      "import { run } from '../connectors/exec.ts';",
      "const name = 'child_process_like';",
      "const other = 'my_child_process';",
    ].join('\n');
    expect(childProcessImports('src/tools/x.ts', text)).toEqual([]);
  });

  test('allows exactly the two listed files', () => {
    const text = "import childProcess from 'node:child_process';\n";
    expect(childProcessImports('src/connectors/exec.ts', text)).toEqual([]);
    expect(childProcessImports('src/ingress/detach.ts', text)).toEqual([]);
    expect(childProcessImports('src/connectors/exec-fake.ts', text)).toHaveLength(1);
    expect(childProcessImports('src/ingress/detach.tsx', text)).toHaveLength(1);
    expect(childProcessImports('src/ops/preflight.ts', text)).toHaveLength(1);
  });

  test('a tree scan reports file and line', () => {
    const root = tempRoot({
      'src/connectors/exec.ts': "import cp from 'node:child_process';\n",
      'src/ops/tunnel.ts': "export const x = 1;\n\nimport { spawn } from 'node:child_process';\n",
      'src/cli/a.mjs': "const cp = require('child_process');\n",
      'src/cli/a.test.ts': "import cp from 'node:child_process';\n",
      'src/db.test.ts': "import cp from 'node:child_process';\n",
      'test/support/ok.ts': "import cp from 'node:child_process';\n",
    });
    expect(scan(root).map((v) => `${v.file}:${v.line}`)).toEqual(['src/cli/a.mjs:1', 'src/cli/a.test.ts:1', 'src/ops/tunnel.ts:3']);
  });
});

describe('the real tree', () => {
  test('no file under src/ except the allowed ones imports child_process', () => {
    const vs = scan(REPO_ROOT);
    expect(vs.map((v) => `${v.file}:${v.line} ${v.message}`)).toEqual([]);
  });

  test('the exec runner is the file that imports it', () => {
    const text = stripComments(readFileSync(join(REPO_ROOT, 'src/connectors/exec.ts'), 'utf8'));
    expect(text).toMatch(CHILD_PROCESS_SPECIFIER());
  });
});
