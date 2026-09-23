import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import {
  type AtomicFs,
  appendJsonl,
  assertRunId,
  evalDraftDir,
  isRunId,
  RunFolderError,
  runPaths,
  writeFileAtomic,
} from './run-folder.ts';

const RUN_ID = '01J8Z3K4M5N6P7Q8R9S0T1V2W3';
const REPO_ROOT = resolve(import.meta.dir, '..', '..');

let tmp: string;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'triage-run-folder-')));
  // Guard for the "nothing written under the repo" rule.
  expect(relative(REPO_ROOT, tmp).startsWith('..')).toBe(true);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('runPaths', () => {
  test('path table for a fixed run_id', () => {
    const p = runPaths('/srv/triage/runs', RUN_ID);
    const dir = `/srv/triage/runs/${RUN_ID}`;
    expect({
      runId: p.runId,
      dir: p.dir,
      input: p.input,
      classification: p.classification,
      evidenceDir: p.evidenceDir,
      'evidence(ssfb)': p.evidence('ssfb'),
      'evidence(atspl)': p.evidence('atspl'),
      'evidence(rtl)': p.evidence('rtl'),
      'evidence(code)': p.evidence('code'),
      report: p.report,
      reportMd: p.reportMd,
      feedbackJsonl: p.feedbackJsonl,
      feedbackMd: p.feedbackMd,
      audit: p.audit,
      meta: p.meta,
      embeddings: p.embeddings,
    }).toEqual({
      runId: RUN_ID,
      dir,
      input: `${dir}/input.json`,
      classification: `${dir}/classification.json`,
      evidenceDir: `${dir}/evidence`,
      'evidence(ssfb)': `${dir}/evidence/ssfb.json`,
      'evidence(atspl)': `${dir}/evidence/atspl.json`,
      'evidence(rtl)': `${dir}/evidence/rtl.json`,
      'evidence(code)': `${dir}/evidence/code.json`,
      report: `${dir}/report.json`,
      reportMd: `${dir}/report.md`,
      feedbackJsonl: `${dir}/feedback.jsonl`,
      feedbackMd: `${dir}/feedback.md`,
      audit: `${dir}/audit.jsonl`,
      meta: `${dir}/meta.json`,
      embeddings: `${dir}/embeddings.json`,
    });
  });

  test('normalises a trailing slash on runsDir', () => {
    expect(runPaths('/srv/triage/runs/', RUN_ID).dir).toBe(`/srv/triage/runs/${RUN_ID}`);
  });

  test('the result is frozen', () => {
    expect(Object.isFrozen(runPaths('/srv/runs', RUN_ID))).toBe(true);
  });

  test('refuses a relative or empty runsDir', () => {
    expect(() => runPaths('runs', RUN_ID)).toThrow(RunFolderError);
    expect(() => runPaths('./.data/runs', RUN_ID)).toThrow(RunFolderError);
    expect(() => runPaths('', RUN_ID)).toThrow(RunFolderError);
  });

  test('refuses evidence keys that are not an entity or code', () => {
    const p = runPaths('/srv/runs', RUN_ID);
    for (const key of ['shivalik', 'SSFB', '../x', 'a/b', '', 'report']) {
      expect(() => p.evidence(key as never)).toThrow(RunFolderError);
    }
  });

  test('refuses a bad run_id before building any path', () => {
    expect(() => runPaths('/srv/runs', '../x')).toThrow(RunFolderError);
    expect(() => runPaths('relative', '..')).toThrow(/run_id/);
  });
});

describe('assertRunId', () => {
  test('accepts canonical ULIDs', () => {
    for (const id of [RUN_ID, '00000000000000000000000000', '7ZZZZZZZZZZZZZZZZZZZZZZZZZ']) {
      expect(() => assertRunId(id)).not.toThrow();
      expect(isRunId(id)).toBe(true);
    }
  });

  const denied: ReadonlyArray<readonly [string, unknown]> = [
    ['empty', ''],
    ['dot dot', '..'],
    ['traversal', '../x'],
    ['traversal padded to 26', '../0000000000000000000000'],
    ['slash', 'a/b'],
    ['slash inside a ULID-length id', '01J8Z3K4M5N6P7Q8R9S0T1V2/3'],
    ['backslash', '01J8Z3K4M5N6P7Q8R9S0T1V2\\3'],
    ['NUL', '01J8Z3K4M5N6P7Q8R9S0T1V2W\0'],
    ['25 chars', RUN_ID.slice(0, 25)],
    ['27 chars', `${RUN_ID}X`],
    ['lowercase', RUN_ID.toLowerCase()],
    ['lowercase with invalid chars', '01j8z3k4m5n6p7q8r9s0t1v2wu'],
    ['Crockford-excluded I', '01J8Z3K4M5N6P7Q8R9S0T1V2WI'],
    ['Crockford-excluded L', '01J8Z3K4M5N6P7Q8R9S0T1V2WL'],
    ['Crockford-excluded O', '01J8Z3K4M5N6P7Q8R9S0T1V2WO'],
    ['Crockford-excluded U', '01J8Z3K4M5N6P7Q8R9S0T1V2WU'],
    ['timestamp overflow', '81J8Z3K4M5N6P7Q8R9S0T1V2W3'],
    ['leading space', ` ${RUN_ID.slice(1)}`],
    ['trailing newline', `${RUN_ID.slice(0, 25)}\n`],
    ['dash and underscore', '01J8Z3K4M5N6P7Q8R9S0T1V-_3'],
    ['undefined', undefined],
    ['number', 123],
    ['object', { toString: () => RUN_ID }],
  ];

  for (const [name, id] of denied) {
    test(`refuses ${name}`, () => {
      expect(() => assertRunId(id)).toThrow(RunFolderError);
      expect(isRunId(id)).toBe(false);
      if (typeof id === 'string') {
        expect(() => runPaths('/srv/runs', id)).toThrow(RunFolderError);
        expect(() => evalDraftDir('/srv/home', id)).toThrow(RunFolderError);
      }
    });
  }

  test('the error does not echo the rejected value', () => {
    try {
      assertRunId('../../etc/passwd');
      throw new Error('expected a throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RunFolderError);
      expect((err as Error).message).not.toContain('passwd');
    }
  });
});

describe('evalDraftDir', () => {
  test('points under <home>/evals/_unreviewed/<run_id>', () => {
    expect(evalDraftDir('/srv/home', RUN_ID)).toBe(`/srv/home/evals/_unreviewed/${RUN_ID}`);
  });

  test('refuses a relative home', () => {
    expect(() => evalDraftDir('home', RUN_ID)).toThrow(RunFolderError);
    expect(() => evalDraftDir('', RUN_ID)).toThrow(RunFolderError);
  });
});

describe('writeFileAtomic', () => {
  const tmpFiles = (dir: string) => readdirSync(dir).filter((f) => f.endsWith('.tmp'));

  test('writes a new file and creates missing parent dirs', async () => {
    const p = runPaths(tmp, RUN_ID);
    await writeFileAtomic(p.evidence('ssfb'), '{"a":1}');
    expect(readFileSync(p.evidence('ssfb'), 'utf8')).toBe('{"a":1}');
    expect(tmpFiles(p.evidenceDir)).toEqual([]);
  });

  test('replaces an existing file', async () => {
    const target = join(tmp, 'report.json');
    writeFileSync(target, 'old');
    await writeFileAtomic(target, 'new');
    expect(readFileSync(target, 'utf8')).toBe('new');
    expect(tmpFiles(tmp)).toEqual([]);
  });

  test('a rename failure keeps the previous content and cleans the temp file', async () => {
    const target = join(tmp, 'report.json');
    writeFileSync(target, 'previous');
    let tempPath = '';
    const failingRename: AtomicFs = {
      mkdir: (path, options) => fsp.mkdir(path, options),
      open: (path, flags, mode) => {
        tempPath = path;
        return fsp.open(path, flags, mode);
      },
      rename: async () => {
        throw new Error('simulated rename failure');
      },
      rm: (path, options) => fsp.rm(path, options),
    };
    await expect(writeFileAtomic(target, 'replacement', failingRename)).rejects.toThrow('simulated rename failure');
    expect(readFileSync(target, 'utf8')).toBe('previous');
    expect(tempPath.startsWith(`${tmp}/`)).toBe(true);
    expect(tmpFiles(tmp)).toEqual([]);
  });

  test('a write that fails half way keeps the previous content', async () => {
    const target = join(tmp, 'report.md');
    writeFileSync(target, 'previous');
    const halfWrite: AtomicFs = {
      mkdir: (path, options) => fsp.mkdir(path, options),
      open: async (path, flags, mode) => {
        const real = await fsp.open(path, flags, mode);
        return {
          writeFile: async (data, encoding) => {
            await real.writeFile(data.slice(0, 3), encoding);
            throw new Error('simulated disk full');
          },
          sync: () => real.sync(),
          close: () => real.close(),
        };
      },
      rename: (from, to) => fsp.rename(from, to),
      rm: (path, options) => fsp.rm(path, options),
    };
    await expect(writeFileAtomic(target, 'replacement', halfWrite)).rejects.toThrow('simulated disk full');
    expect(readFileSync(target, 'utf8')).toBe('previous');
    expect(tmpFiles(tmp)).toEqual([]);
  });

  test('refuses a relative path', async () => {
    await expect(writeFileAtomic('report.json', 'x')).rejects.toThrow(RunFolderError);
  });
});

describe('appendJsonl', () => {
  test('two calls give two parseable lines with a trailing newline', async () => {
    const p = runPaths(tmp, RUN_ID);
    await appendJsonl(p.audit, { n: 1, note: 'line one' });
    await appendJsonl(p.audit, { n: 2, note: 'has\na newline' });
    const text = readFileSync(p.audit, 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    const lines = text.split('\n');
    expect(lines.pop()).toBe('');
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      { n: 1, note: 'line one' },
      { n: 2, note: 'has\na newline' },
    ]);
  });

  test('refuses values JSON cannot represent and writes nothing', async () => {
    const target = join(tmp, 'feedback.jsonl');
    await expect(appendJsonl(target, undefined)).rejects.toThrow(RunFolderError);
    await expect(appendJsonl(target, () => 1)).rejects.toThrow(RunFolderError);
    expect(readdirSync(tmp)).toEqual([]);
  });

  test('refuses a relative path', async () => {
    await expect(appendJsonl('audit.jsonl', {})).rejects.toThrow(RunFolderError);
  });
});

describe('module hygiene', () => {
  test('reads no env var and uses no Bun API', () => {
    const src = readFileSync(join(import.meta.dir, 'run-folder.ts'), 'utf8');
    expect(src).not.toMatch(/process\.env/);
    expect(src).not.toMatch(/\bBun\./);
    expect(src).not.toMatch(/from ['"]bun:/);
  });
});
