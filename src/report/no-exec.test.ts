// src/report renders suggested_fix commands; it must have no way to run them
// (D35). No file under src/report may import a process runner or a database
// client, and the modules src/report loads at runtime may not either.
import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const REPORT_DIR = import.meta.dir;
const SRC_DIR = resolve(REPORT_DIR, '..');
const SELF = join(REPORT_DIR, 'no-exec.test.ts');

// Package specifiers that run processes or talk to a database.
const FORBIDDEN_SPECIFIERS: readonly RegExp[] = [
  /^(?:node:)?child_process$/,
  /^execa(?:\/|$)/,
  /^cross-spawn$/,
  /^zx(?:\/|$)/,
  /^shelljs$/,
  // bun:test is the test runner; bun and the other bun: modules can spawn.
  /^bun$/,
  /^bun:(?!test$)/,
  /^pg(?:-[\w-]+)?(?:\/|$)/,
  /^postgres(?:\/|$)/,
  /^@flue\/postgres(?:\/|$)/,
  /^(?:node:)?sqlite$/,
  /^(?:better-)?sqlite3?(?:\/|$)/,
  /^@libsql\//,
  /^libsql(?:\/|$)/,
  /^mysql2?(?:\/|$)/,
  /^mongodb(?:\/|$)/,
  /^(?:io)?redis(?:\/|$)/,
  /^knex(?:\/|$)/,
  /^kysely(?:\/|$)/,
  /^drizzle-orm(?:\/|$)/,
  /^libpg-query(?:\/|$)/,
];

// In-repo modules that hold the real I/O: connectors, the one exec runner,
// the pg runner and the Flue persistence entry.
const FORBIDDEN_LOCAL: readonly RegExp[] = [/^connectors\//, /^db\//, /^db\.ts$/, /^runstore\/(?:postgres|fake-pg|migrate|index)\.ts$/];

// Process spawning written out in code rather than imported.
const FORBIDDEN_CODE: readonly RegExp[] = [
  /\bBun\s*\.\s*(?:spawn|spawnSync|\$)/,
  /\bBun\s*\[\s*['"`](?:spawn|spawnSync|\$)['"`]\s*\]/,
  /\bprocess\s*\.\s*binding\s*\(/,
  /(?<![.\w$])(?:exec|execSync|execFile|execFileSync|spawn|spawnSync|fork)\s*\(/,
];

function listTs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...listTs(path));
    else if (name.endsWith('.ts')) out.push(path);
  }
  return out.sort();
}

function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

type Import = { specifier: string; typeOnly: boolean };

function importsOf(code: string): Import[] {
  const out: Import[] = [];
  const statics = /\b(import|export)\s+(type\s+)?(?:[\w*{}\s,$]+?\s+from\s+)?['"]([^'"]+)['"]/g;
  for (const m of code.matchAll(statics)) out.push({ specifier: m[3]!, typeOnly: m[2] !== undefined });
  for (const m of code.matchAll(/\b(?:import|require)\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g)) {
    out.push({ specifier: m[1]!, typeOnly: false });
  }
  return out;
}

function problemsIn(file: string, code: string, imports: Import[]): string[] {
  const where = relative(SRC_DIR, file);
  const problems: string[] = [];
  for (const { specifier } of imports) {
    if (FORBIDDEN_SPECIFIERS.some((re) => re.test(specifier))) problems.push(`${where} imports ${specifier}`);
    if (specifier.startsWith('.')) {
      const target = relative(SRC_DIR, resolve(dirname(file), specifier));
      if (FORBIDDEN_LOCAL.some((re) => re.test(target))) problems.push(`${where} imports ${target}`);
    }
  }
  for (const re of FORBIDDEN_CODE) {
    if (re.test(code)) problems.push(`${where} matches ${re}`);
  }
  return problems;
}

const reportFiles = listTs(REPORT_DIR).filter((f) => f !== SELF);

describe('src/report cannot execute a suggested_fix', () => {
  test('finds the report modules', () => {
    const names = reportFiles.map((f) => relative(REPORT_DIR, f));
    expect(names).toContain('write.ts');
    expect(names).toContain('markdown.ts');
  });

  test('no file under src/report imports a process runner or SQL client', () => {
    const problems = reportFiles.flatMap((file) => {
      const code = stripComments(readFileSync(file, 'utf8'));
      return problemsIn(file, code, importsOf(code));
    });
    expect(problems).toEqual([]);
  });

  test('nothing src/report loads at runtime does either', () => {
    const seen = new Set<string>();
    const queue = reportFiles.filter((f) => !f.endsWith('.test.ts'));
    const problems: string[] = [];
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      const code = stripComments(readFileSync(file, 'utf8'));
      const runtime = importsOf(code).filter((i) => !i.typeOnly);
      problems.push(...problemsIn(file, code, runtime));
      for (const { specifier } of runtime) {
        if (!specifier.startsWith('.')) continue;
        const target = resolve(dirname(file), specifier);
        if (target.endsWith('.ts') && existsSync(target)) queue.push(target);
      }
    }
    expect(seen.size).toBeGreaterThan(reportFiles.filter((f) => !f.endsWith('.test.ts')).length);
    expect(problems).toEqual([]);
  });

  test('the checks catch the forms they look for', () => {
    const file = join(REPORT_DIR, 'example.ts');
    // Built at runtime so the repo-wide child process guard does not see a
    // module name in this file.
    const cp = ['child', 'process'].join('_');
    const samples = [
      `import { execFile } from 'node:${cp}';`,
      `import { spawn } from '${cp}';`,
      "const { execa } = await import('execa');",
      "import pg from 'pg';",
      "import { Client } from 'pg';",
      "import { postgres } from '@flue/postgres';",
      "import { DatabaseSync } from 'node:sqlite';",
      "import { runSql } from '../connectors/pg.ts';",
      "import { createPgRunner } from '../db/pg.ts';",
      "const out = Bun.spawn(['sh', '-c', command]);",
      'await Bun.$`${command}`;',
      'spawn(command, []);',
      `const cp = require('${cp}');`,
      "import { $ } from 'bun';",
    ];
    for (const code of samples) {
      expect(problemsIn(file, code, importsOf(code)).length).toBeGreaterThan(0);
    }
    // Method calls named exec (RegExp.prototype.exec) are fine.
    const regexUse = 'const m = /x/.exec(value);';
    expect(problemsIn(file, regexUse, importsOf(regexUse))).toEqual([]);
  });
});
