// src/gate is pure: no filesystem, network, process or database access,
// except the two files allowed to read or write files. This scans every
// non-test .ts file under src/gate, so files added later are covered too.
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lineAt, stripComments } from '../../test/guards/rules.ts';

const GATE_DIR = dirname(fileURLToPath(import.meta.url));

/** Files in src/gate allowed to use node:fs. Nothing is allowed network, process or pg. */
const FS_ALLOWLIST = new Set(['audit-sink.ts', 'rules-file.ts']);

const FS_MODULES = new Set(['fs', 'fs/promises', 'node:fs', 'node:fs/promises']);
const OTHER_FORBIDDEN = [
  /^(?:node:)?net$/,
  /^(?:node:)?child_process$/,
  /^(?:node:)?(?:http|https|http2|tls|dgram)$/,
  /^pg(?:\/.*)?$/,
  /^pg-.*$/,
];

type Hit = { readonly file: string; readonly line: number; readonly what: string };

const SPECIFIER_PATTERNS = [
  /\b(?:import|export)\s[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];
const FETCH_PATTERN = /(?<![.\w$])fetch\s*\(|\b(?:globalThis|window|self)\s*\.\s*fetch\b/g;

function forbiddenModule(spec: string, file: string): boolean {
  if (FS_MODULES.has(spec)) return !FS_ALLOWLIST.has(file);
  return OTHER_FORBIDDEN.some((re) => re.test(spec));
}

/** Returns the forbidden imports and fetch uses in one file. file is relative to src/gate. */
function scanGateSource(file: string, source: string): Hit[] {
  const code = stripComments(source);
  const hits: Hit[] = [];
  for (const re of SPECIFIER_PATTERNS) {
    for (const m of code.matchAll(re)) {
      const spec = m[1] as string;
      if (forbiddenModule(spec, file)) hits.push({ file, line: lineAt(code, m.index ?? 0), what: spec });
    }
  }
  for (const m of code.matchAll(FETCH_PATTERN)) hits.push({ file, line: lineAt(code, m.index ?? 0), what: 'fetch' });
  return hits.sort((a, b) => a.line - b.line);
}

function gateFiles(dir: string = GATE_DIR): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...gateFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(relative(GATE_DIR, full).split(sep).join('/'));
    }
  }
  return out.sort();
}

// Built by concatenation so test/guards/no-child-process.test.ts, which also
// scans test files, does not read these fixtures as real imports.
const CP = 'child' + '_process';

describe('scanGateSource', () => {
  test('flags every forbidden import form', () => {
    const src = [
      "import { readFileSync } from 'node:fs';",
      "import * as fsp from 'fs/promises';",
      "import net from 'node:net';",
      `import { spawn } from '${CP}';`,
      "import { Client } from 'pg';",
      "import 'node:https';",
      `const m = await import('node:${CP}');`,
      "const pg = require('pg');",
      "export { request } from 'node:http';",
    ].join('\n');
    expect(scanGateSource('x.ts', src).map((h) => `${h.line}:${h.what}`)).toEqual([
      '1:node:fs',
      '2:fs/promises',
      '3:node:net',
      '4:child_process',
      '5:pg',
      '6:node:https',
      '7:node:child_process',
      '8:pg',
      '9:node:http',
    ]);
  });

  test('flags fetch calls, bare or through globalThis', () => {
    const src = "const r = await fetch(url);\nconst f = globalThis.fetch;\n";
    expect(scanGateSource('x.ts', src).map((h) => `${h.line}:${h.what}`)).toEqual(['1:fetch', '2:fetch']);
  });

  test('node:fs is allowed only in audit-sink.ts and rules-file.ts', () => {
    const src = "import { appendFileSync } from 'node:fs';";
    expect(scanGateSource('audit-sink.ts', src)).toEqual([]);
    expect(scanGateSource('rules-file.ts', src)).toEqual([]);
    expect(scanGateSource('audit.ts', src)).toHaveLength(1);
    expect(scanGateSource('sub/audit-sink.ts', src)).toHaveLength(1);
  });

  test('the allowlist does not cover network, process or pg imports', () => {
    const src = "import net from 'node:net';\nimport { Client } from 'pg';\nfetch('x');";
    expect(scanGateSource('audit-sink.ts', src)).toHaveLength(3);
    expect(scanGateSource('rules-file.ts', src)).toHaveLength(3);
  });

  test('ignores comments, allowed modules and look-alike names', () => {
    const src = [
      "// import { readFileSync } from 'node:fs';",
      "/* fetch(url) */",
      "import { join } from 'node:path';",
      "import * as v from 'valibot';",
      "import { x } from './pgsql.ts';",
      'const y = prefetch(1) + client.fetch(2);',
    ].join('\n');
    expect(scanGateSource('x.ts', src)).toEqual([]);
  });
});

describe('src/gate purity', () => {
  test('the scan sees the gate files, including the allowlisted ones', () => {
    const files = gateFiles();
    expect(files).toContain('audit.ts');
    expect(files).toContain('audit-sink.ts');
    expect(files).toContain('rules-file.ts');
  });

  test('no file under src/gate imports node:fs, net, child_process, pg or uses fetch outside the allowlist', () => {
    const hits = gateFiles().flatMap((file) => scanGateSource(file, readFileSync(join(GATE_DIR, file), 'utf8')));
    expect(hits.map((h) => `src/gate/${h.file}:${h.line} ${h.what}`)).toEqual([]);
  });
});
