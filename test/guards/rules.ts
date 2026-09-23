// Static source rules checked by test/guards/source-rules.test.ts.
//
// Source rules run over src/**/*.ts (not *.test.ts) with comments blanked
// out, so a comment that names a forbidden thing is not a violation. String
// literals are kept, since some rules are about a string. Tree rules look at
// file names, the git index and directories.
//
// Every violation carries a repo-relative file and a 1-based line. Rules that
// are about a whole file or directory point at line 1.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

export type Violation = { readonly rule: string; readonly file: string; readonly line: number; readonly message: string };
export type SourceFile = { readonly path: string; readonly text: string };

export type SourceRule = {
  readonly id: string;
  /** Which files the rule applies to. The rule still scans only what the caller passes. */
  readonly scope: 'src' | 'repo';
  check(file: SourceFile, code: string): Violation[];
};

export function formatViolation(v: Violation): string {
  return `${v.file}:${v.line} [${v.rule}] ${v.message}`;
}

// ------------------------------------------------------------------ lexing

const REGEX_AFTER_WORDS = new Set([
  'return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'instanceof', 'yield', 'await',
]);
const REGEX_AFTER_CHARS = new Set('(,=:[!&|?{};+-*%<>~^'.split(''));

/**
 * Returns the text with every comment replaced by spaces. Newlines and
 * offsets are kept, so an index into the result is an index into the source.
 * Handles strings, template literals with ${} and regex literals well enough
 * for this repo's own code.
 */
export function stripComments(src: string): string {
  const out = src.split('');
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  const n = src.length;
  const templates: number[] = [];
  let depth = 0;
  let inTemplate = false;
  let prev = '';
  let word = '';
  let i = 0;

  while (i < n) {
    const c = src[i] as string;
    const d = src[i + 1];
    if (inTemplate) {
      if (c === '\\') i += 2;
      else if (c === '`') {
        inTemplate = false;
        prev = '`';
        i++;
      } else if (c === '$' && d === '{') {
        templates.push(depth);
        inTemplate = false;
        prev = '{';
        i += 2;
      } else i++;
      continue;
    }
    if (c === '/' && d === '/') {
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (c === '"' || c === "'") {
      i = skipString(src, i, c);
      prev = c;
      word = '';
      continue;
    }
    if (c === '`') {
      inTemplate = true;
      i++;
      continue;
    }
    if (c === '/' && (prev === '' || REGEX_AFTER_CHARS.has(prev) || REGEX_AFTER_WORDS.has(word))) {
      i = skipRegex(src, i);
      prev = '/';
      word = '';
      continue;
    }
    if (c === '{') depth++;
    if (c === '}') {
      if (templates.length > 0 && templates[templates.length - 1] === depth) {
        templates.pop();
        inTemplate = true;
        i++;
        continue;
      }
      depth--;
    }
    if (/[A-Za-z0-9_$]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_$]/.test(src[j] as string)) j++;
      word = src.slice(i, j);
      prev = 'a';
      i = j;
      continue;
    }
    if (!/\s/.test(c)) {
      prev = c;
      word = '';
    }
    i++;
  }
  return out.join('');
}

function skipString(src: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') i += 2;
    else if (c === quote || c === '\n') return i + 1;
    else i++;
  }
  return i;
}

function skipRegex(src: string, start: number): number {
  let i = start + 1;
  let inClass = false;
  while (i < src.length) {
    const c = src[i];
    if (c === '\n') return start + 1; // not a regex after all; treat as division
    if (c === '\\') i += 2;
    else if (c === '[') {
      inClass = true;
      i++;
    } else if (c === ']') {
      inClass = false;
      i++;
    } else if (c === '/' && !inClass) {
      i++;
      while (i < src.length && /[a-z]/.test(src[i] as string)) i++;
      return i;
    } else i++;
  }
  return i;
}

export function lineAt(text: string, index: number): number {
  let line = 1;
  for (let k = 0; k < index && k < text.length; k++) if (text[k] === '\n') line++;
  return line;
}

// ------------------------------------------------------------ source rules

const isTestFile = (p: string): boolean => p.endsWith('.test.ts');
const ROOT_AGENT = /^src\/agents\/[^/]+\.agent\.ts$/;
const DIRECTIVE = /(['"])use agent\1/g;
const FIRST_DIRECTIVE = /^\s*(['"])use agent\1\s*;?/;

// Reports each match of the patterns in code, unless the file is allowed.
function forbid(id: string, patterns: readonly RegExp[], message: string, allowed: (p: string) => boolean = () => false): SourceRule {
  return {
    id,
    scope: 'src',
    check(file, code) {
      if (allowed(file.path)) return [];
      const out: Violation[] = [];
      for (const re of patterns) {
        const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
        for (const m of code.matchAll(g)) out.push({ rule: id, file: file.path, line: lineAt(code, m.index), message });
      }
      return out.sort((a, b) => a.line - b.line);
    },
  };
}

const useAgentRule: SourceRule = {
  id: 'use-agent-directive',
  scope: 'src',
  check(file, code) {
    const out: Violation[] = [];
    const root = ROOT_AGENT.test(file.path);
    const first = root ? FIRST_DIRECTIVE.exec(code) : null;
    if (root && first === null) {
      out.push({ rule: this.id, file: file.path, line: 1, message: "a root agent file must start with 'use agent' as its first statement" });
    }
    for (const m of code.matchAll(DIRECTIVE)) {
      const isFirst = first !== null && m.index === first.index + first[0].indexOf(m[0]);
      if (isFirst) continue;
      const message = root
        ? "'use agent' may appear only as the first statement"
        : "'use agent' is allowed only in src/agents/*.agent.ts";
      out.push({ rule: this.id, file: file.path, line: lineAt(code, m.index), message });
    }
    return out;
  },
};

const FLUE_NODE = String.raw`['"]@flue/runtime/node['"]`;

const flueLocalRule: SourceRule = {
  id: 'no-flue-local',
  scope: 'src',
  check(file, code) {
    const out: Violation[] = [];
    const hit = (index: number): void => {
      out.push({ rule: this.id, file: file.path, line: lineAt(code, index), message: "local from '@flue/runtime/node' is refused (D45)" });
    };
    const named = new RegExp(String.raw`\b(?:import|export)\s+(?:type\s+)?(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*${FLUE_NODE}`, 'g');
    for (const m of code.matchAll(named)) {
      const names = (m[1] ?? '').split(',').map((s) => s.trim().replace(/^type\s+/, '').split(/\s+/)[0]);
      if (names.includes('local')) hit(m.index);
    }
    const ns = new RegExp(String.raw`\bimport\s+\*\s+as\s+([\w$]+)\s+from\s*${FLUE_NODE}`, 'g');
    for (const m of code.matchAll(ns)) {
      const alias = (m[1] ?? '').replace(/\$/g, '\\$');
      for (const use of code.matchAll(new RegExp(String.raw`\b${alias}\s*(?:\.\s*local\b|\[\s*['"]local['"]\s*\])`, 'g'))) hit(use.index);
    }
    const dynamic = new RegExp(String.raw`\bimport\s*\(\s*${FLUE_NODE}\s*\)`, 'g');
    for (const m of code.matchAll(dynamic)) {
      const lineStart = code.lastIndexOf('\n', m.index) + 1;
      const lineEnd = code.indexOf('\n', m.index);
      if (/\blocal\b/.test(code.slice(lineStart, lineEnd === -1 ? code.length : lineEnd))) hit(m.index);
    }
    return out;
  },
};

export const SOURCE_RULES: readonly SourceRule[] = [
  useAgentRule,
  forbid(
    'process-env-in-config-only',
    [
      /\bprocess\s*\.\s*env\b/,
      /\bprocess\s*\[\s*['"`]env['"`]\s*\]/,
      /\{[^}]*\benv\b[^}]*\}\s*=\s*(?:globalThis\s*\.\s*)?process\b/,
      /\bimport\s*\{[^}]*\benv\b[^}]*\}\s*from\s*['"](?:node:)?process['"]/,
    ],
    'process.env is read only under src/config/',
    (p) => p.startsWith('src/config/'),
  ),
  forbid(
    'deploy-mode-key',
    [/TRIAGE_DEPLOY_MODE/],
    'TRIAGE_DEPLOY_MODE appears only in src/config/keys.ts and src/ops/preflight.ts (D32)',
    (p) => p === 'src/config/keys.ts' || p === 'src/ops/preflight.ts',
  ),
  forbid(
    'deploy-mode-accessor',
    [/\bdeployModeForPreflight\b/],
    'deployModeForPreflight is used only in src/config/env.ts and src/ops/preflight.ts (D32)',
    (p) => p === 'src/config/env.ts' || p === 'src/ops/preflight.ts',
  ),
  forbid(
    'env-label-display-only',
    [/\benvLabel\b/],
    'envLabel is read only in src/config/, src/report/ and src/gate/audit.ts',
    (p) => p.startsWith('src/config/') || p.startsWith('src/report/') || p === 'src/gate/audit.ts',
  ),
  forbid(
    'no-bun-in-src',
    [/\bBun\s*(?:\.|\[)/, /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)['"`]bun(?::[^'"`]*)?['"`]/],
    'src/ never uses Bun.* or imports bun or bun:*',
  ),
  forbid(
    'no-md-imports',
    [/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)['"`][^'"`\n]+\.md(?:\?[^'"`\n]*)?['"`]/],
    'markdown is loaded at runtime (D42), never imported',
  ),
  flueLocalRule,
  forbid('no-agent-router', [/\bcreateAgentRouter\b/], 'there is no createAgentRouter mount (D25)'),
  forbid('no-shell-true', [/\bshell\s*:\s*true\b/, /['"]shell['"]\s*:\s*true\b/], 'child processes never run through a shell'),
  {
    ...forbid(
      'policy-checks-off-in-tests-only',
      [/\bpolicyChecks\s*:\s*false\b/, /['"]policyChecks['"]\s*:\s*false\b/],
      'configFromRecord with policyChecks:false is for *.test.ts, *.contract.ts and test/ only',
      (p) => p.endsWith('.test.ts') || p.endsWith('.contract.ts') || p.startsWith('test/'),
    ),
    scope: 'repo',
  },
];

export function checkSource(file: SourceFile, rules: readonly SourceRule[] = SOURCE_RULES): Violation[] {
  const code = stripComments(file.text);
  return rules.flatMap((r) => r.check(file, code));
}

// -------------------------------------------------------------- tree rules

/** No generated import list is committed. `tracked` is the list of paths in the git index. */
export function committedGenFiles(tracked: readonly string[]): Violation[] {
  return tracked
    .filter((p) => p.endsWith('.gen.ts'))
    .map((file) => ({ rule: 'no-committed-gen', file, line: 1, message: '*.gen.ts files are generated and gitignored' }));
}

/** Flue would read .flue/ instead of src/ if it existed. */
export function flueDirViolations(root: string): Violation[] {
  const dir = join(root, '.flue');
  if (!existsSync(dir)) return [];
  return [{ rule: 'no-flue-dir', file: '.flue', line: 1, message: 'a .flue/ directory makes Flue ignore src/' }];
}

/** Contract tests are test/contract/**\/*.contract.ts, never *.contract.test.ts. */
export function contractTestNames(paths: readonly string[]): Violation[] {
  return paths
    .filter((p) => p.endsWith('.contract.test.ts'))
    .map((file) => ({ rule: 'no-contract-test-name', file, line: 1, message: 'name contract tests *.contract.ts under test/contract/' }));
}

// ------------------------------------------------------------------- files

const SKIP_DIRS = new Set(['node_modules', '.git', '.data', 'dist', 'coverage', 'tmp']);

/** Repo-relative, slash-separated paths of every file under dir, skipping dependency and state dirs. */
export function walk(root: string, dir: string = root): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(root, full));
    else if (entry.isFile()) out.push(relative(root, full).split(sep).join('/'));
  }
  return out;
}

export function srcFiles(root: string): string[] {
  if (!existsSync(join(root, 'src'))) return [];
  return walk(root, join(root, 'src')).filter((p) => p.endsWith('.ts') && !isTestFile(p)).sort();
}

const CODE_FILE = /\.(?:[cm]?ts|[cm]?js)$/;

/** Runs every rule over the tree at root and returns all violations. */
export function scanTree(root: string, tracked: readonly string[] | undefined = readGitIndexPaths(root)): Violation[] {
  const all = walk(root);
  const read = (path: string): SourceFile => ({ path, text: readFileSync(join(root, path), 'utf8') });
  const srcRules = SOURCE_RULES.filter((r) => r.scope === 'src');
  const repoRules = SOURCE_RULES.filter((r) => r.scope === 'repo');
  const out: Violation[] = [];
  for (const path of srcFiles(root)) out.push(...checkSource(read(path), srcRules));
  for (const path of all.filter((p) => CODE_FILE.test(p))) out.push(...checkSource(read(path), repoRules));
  out.push(...committedGenFiles(tracked ?? []));
  out.push(...flueDirViolations(root));
  out.push(...contractTestNames(all));
  return out;
}

// --------------------------------------------------------------- git index

// The no-io guard blocks the git binary in tests, so tracked paths come from
// reading the index file directly (formats 2, 3 and 4).

/** The index file for a checkout or worktree at root, if any. */
export function gitIndexFile(root: string): string | undefined {
  const dotgit = join(root, '.git');
  if (!existsSync(dotgit)) return undefined;
  if (statSync(dotgit).isDirectory()) return join(dotgit, 'index');
  const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotgit, 'utf8'));
  return m?.[1] === undefined ? undefined : join(resolve(root, m[1].trim()), 'index');
}

export function readGitIndexPaths(root: string): string[] | undefined {
  const file = gitIndexFile(root);
  if (file === undefined || !existsSync(file)) return undefined;
  return parseGitIndex(readFileSync(file));
}

export function parseGitIndex(buf: Buffer): string[] {
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'DIRC') throw new Error('not a git index file');
  const version = buf.readUInt32BE(4);
  if (version < 2 || version > 4) throw new Error(`unsupported git index version ${version}`);
  const count = buf.readUInt32BE(8);
  const paths: string[] = [];
  let prev = Buffer.alloc(0);
  let off = 12;
  for (let k = 0; k < count; k++) {
    const start = off;
    const flags = buf.readUInt16BE(off + 60);
    off += 62;
    if (version >= 3 && (flags & 0x4000) !== 0) off += 2;
    if (version === 4) {
      let byte = buf[off++] as number;
      let strip = byte & 0x7f;
      while ((byte & 0x80) !== 0) {
        byte = buf[off++] as number;
        strip = ((strip + 1) << 7) | (byte & 0x7f);
      }
      const end = buf.indexOf(0, off);
      const name = Buffer.concat([prev.subarray(0, prev.length - strip), buf.subarray(off, end)]);
      paths.push(name.toString('utf8'));
      prev = name;
      off = end + 1;
    } else {
      const end = buf.indexOf(0, off);
      paths.push(buf.toString('utf8', off, end));
      off = start + ((end - start + 8) & ~7);
    }
  }
  return paths;
}
