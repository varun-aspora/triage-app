// Checks the coding-agent skill (integrations/coding-agent/triage/SKILL.md)
// and the optional PreToolUse hook example next to it:
//
// - the frontmatter parses, is named 'triage' and says when to trigger
// - every `triage <command> --flag` in the skill exists in the CLI built from
//   the generated command list (hidden commands such as __worker do not count)
// - the posting steps ask in chat first and pass --approved-by
// - no hostnames, tokens, customer-looking ids or shell-wrapper leftovers
// - the hook parses, matches Bash, and lets through only 'triage ' commands
//   with no shell operators (run with sh and node on sample inputs)
// - the knowledge loader's root is knowledge/, so Flue never sees this skill

import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { Command } from 'commander';
import { parse as parseYaml } from 'yaml';
import { loadKnowledge } from '../../src/agents/skills.ts';
import { configFromRecord } from '../../src/config/env.ts';
import { KEY_BY_NAME } from '../../src/config/keys.ts';
import { commands as generatedCommands } from '../../src/cli/command-modules.gen.ts';
import { buildProgram } from '../../src/cli/index.ts';
import type { CliCommand, CliContext } from '../../src/cli/types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
const SKILL_DIR = join(HERE, 'triage');
const SKILL_PATH = join(SKILL_DIR, 'SKILL.md');
const HOOK_PATH = join(HERE, 'pretooluse-triage-only.json');

const skillText = readFileSync(SKILL_PATH, 'utf8');

// ------------------------------------------------------------ frontmatter

function splitFrontmatter(text: string): { fields: Record<string, unknown>; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (m === null) throw new Error('SKILL.md has no frontmatter block');
  const fields = parseYaml(m[1] as string) as unknown;
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) throw new Error('frontmatter is not a mapping');
  return { fields: fields as Record<string, unknown>, body: m[2] as string };
}

describe('frontmatter', () => {
  const { fields, body } = splitFrontmatter(skillText);

  test("is named 'triage'", () => {
    expect(fields.name).toBe('triage');
  });

  test('has a description that says when to trigger', () => {
    expect(typeof fields.description).toBe('string');
    const description = (fields.description as string).trim();
    expect(description.length).toBeGreaterThan(0);
    // Claude Code and Codex cut skill descriptions at 1024 characters.
    expect(description.length).toBeLessThanOrEqual(1024);
    expect(description).toMatch(/Slack thread/i);
    expect(description).toMatch(/NRI banking/i);
    expect(description).toMatch(/\bUse when\b/);
  });

  test('carries only the keys coding agents read', () => {
    expect(Object.keys(fields).sort()).toEqual(['description', 'name']);
  });

  test('has a body', () => {
    expect(body.trim().length).toBeGreaterThan(0);
  });

  test('refuses a file without frontmatter', () => {
    expect(() => splitFrontmatter('# no frontmatter\n')).toThrow('no frontmatter');
  });
});

// ------------------------------------------------- CLI command cross-check

type CliSpec = ReadonlyMap<string, ReadonlySet<string>>;

/** Flags every command accepts: the program's global --json and commander's --help. */
const GLOBAL_FLAGS = ['--json', '--help'];

function nullContext(): CliContext {
  return {
    config: () => {
      throw new Error('the skill test never loads config');
    },
    io: {
      stdout: { write: () => true },
      stderr: { write: () => true },
      stdin: Readable.from([]),
      isTTY: false,
    },
    deps: {},
  };
}

function isHidden(cmd: Command): boolean {
  return (cmd as unknown as { _hidden?: boolean })._hidden === true || cmd.name().startsWith('_');
}

/** Visible command paths ('tunnel up') mapped to the long flags each accepts. */
function cliSpec(commands: readonly CliCommand[]): CliSpec {
  const program = buildProgram(commands, nullContext());
  const spec = new Map<string, Set<string>>();
  const globals = new Set([...GLOBAL_FLAGS, ...program.options.flatMap((o) => (o.long !== undefined ? [o.long] : []))]);
  const walk = (cmd: Command, prefix: readonly string[]): void => {
    for (const child of cmd.commands) {
      if (isHidden(child)) continue;
      const path = [...prefix, child.name()];
      const flags = new Set(globals);
      for (const o of child.options) if (o.long !== undefined) flags.add(o.long);
      spec.set(path.join(' '), flags);
      walk(child, path);
    }
  };
  walk(program, []);
  return spec;
}

type Invocation = { readonly line: string; readonly fenced: boolean };

/**
 * Every `triage ...` line in fenced code blocks, then every inline
 * `triage <word> ...` span. A bare `triage` span names the CLI, not a command.
 */
function triageInvocations(markdown: string): Invocation[] {
  const out: Invocation[] = [];
  const prose: string[] = [];
  let fenced = false;
  for (const line of markdown.split('\n')) {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) {
      const m = /^\s*(?:\$\s+)?(triage(?:\s.*)?)$/.exec(line);
      if (m !== null) out.push({ line: (m[1] as string).trim(), fenced: true });
    } else {
      prose.push(line);
    }
  }
  for (const m of prose.join('\n').matchAll(/`(triage\s[^`]*)`/g)) out.push({ line: (m[1] as string).trim(), fenced: false });
  return out;
}

/** Problems with one invocation: an unknown command, or a flag that command does not define. */
function checkInvocation(line: string, spec: CliSpec): string[] {
  // Quoted values are arguments, never flags.
  const tokens = line
    .replace(/'[^']*'|"[^"]*"/g, 'VALUE')
    .split(/\s+/)
    .filter((t) => t !== '');
  if (tokens[0] !== 'triage') return [`'${line}' does not start with triage`];
  let path = '';
  let i = 1;
  for (; i < tokens.length; i++) {
    const next = path === '' ? (tokens[i] as string) : `${path} ${tokens[i]}`;
    if (!spec.has(next)) break;
    path = next;
  }
  if (path === '') return [`'${line}': unknown command '${tokens[1] ?? ''}'`];
  const flags = spec.get(path) as ReadonlySet<string>;
  const problems: string[] = [];
  for (const token of tokens.slice(i)) {
    if (!token.startsWith('-')) continue;
    const flag = token.split('=')[0] as string;
    if (!flag.startsWith('--')) problems.push(`'${line}': short flag ${flag}; use the long form`);
    else if (!flags.has(flag)) problems.push(`'${line}': 'triage ${path}' has no ${flag}`);
  }
  return problems;
}

/** The command path an invocation resolves to, for coverage checks. */
function commandOf(line: string, spec: CliSpec): string {
  const words = line.split(/\s+/).slice(1);
  let path = '';
  for (const w of words) {
    const next = path === '' ? w : `${path} ${w}`;
    if (!spec.has(next)) break;
    path = next;
  }
  return path;
}

describe('command and flag cross-check', () => {
  const spec = cliSpec(generatedCommands as readonly CliCommand[]);
  const all = triageInvocations(skillText);
  const invocations = all.map((i) => i.line);
  const fencedLines = all.filter((i) => i.fenced).map((i) => i.line);

  test('the CLI spec has the commands the skill relies on', () => {
    for (const name of ['start', 'wait', 'status', 'ask', 'post', 'feedback', 'stop', 'logs']) expect(spec.has(name)).toBe(true);
    expect([...spec.keys()].some((k) => k.includes('worker'))).toBe(false);
  });

  test('every triage command and flag in the skill exists in the CLI', () => {
    expect(invocations.length).toBeGreaterThan(5);
    const problems = invocations.flatMap((line) => checkInvocation(line, spec));
    expect(problems).toEqual([]);
  });

  test('the skill uses start, wait, ask and post in the shapes the plan fixes', () => {
    const byCommand = (name: string) => fencedLines.filter((l) => commandOf(l, spec) === name);
    const starts = byCommand('start');
    expect(starts.length).toBeGreaterThan(0);
    for (const s of starts) {
      expect(s).toContain('--json');
      expect(s).toContain('--interface claude-code');
    }
    expect(starts.some((s) => s.includes('--thread-file'))).toBe(true);
    expect(byCommand('wait').some((w) => /--timeout 90\b/.test(w) && w.includes('--json'))).toBe(true);
    expect(byCommand('ask').length).toBeGreaterThan(0);
    expect(byCommand('post').length).toBeGreaterThan(0);
  });

  test('refuses an unknown command, an unknown flag, --env and the hidden worker', () => {
    expect(checkInvocation('triage nosuch --json', spec)).toHaveLength(1);
    expect(checkInvocation('triage start --text x --env prod', spec)).toEqual([
      "'triage start --text x --env prod': 'triage start' has no --env",
    ]);
    expect(checkInvocation('triage wait <run_id> --follow', spec)).toHaveLength(1);
    expect(checkInvocation('triage post <run_id> -y', spec)).toHaveLength(1);
    expect(checkInvocation('triage __worker <run_id>', spec)).toHaveLength(1);
    expect(checkInvocation('triage status <run_id> --timeout 90', spec)).toHaveLength(1);
  });

  test('accepts known flags, global --json and flag-like text inside quotes', () => {
    expect(checkInvocation('triage post <run_id> --json --yes --approved-by a', spec)).toEqual([]);
    expect(checkInvocation('triage ask <run_id> "what about --bogus" --json', spec)).toEqual([]);
    expect(checkInvocation('triage wait <run_id> --timeout=90', spec)).toEqual([]);
  });

  test('finds invocations in fenced blocks and inline spans only', () => {
    const md = [
      'Run `triage status <id> --json` first; `triage` alone is the CLI name.',
      '```sh',
      '$ triage wait <id> --timeout 90 --json',
      'echo not triage',
      '```',
      'triage outside code is prose',
    ].join('\n');
    expect(triageInvocations(md)).toEqual([
      { line: 'triage wait <id> --timeout 90 --json', fenced: true },
      { line: 'triage status <id> --json', fenced: false },
    ]);
  });
});

// ------------------------------------------------------------ posting rules

describe('posting needs a chat confirmation', () => {
  const spec = cliSpec(generatedCommands as readonly CliCommand[]);

  test('every post with flags passes --yes and --approved-by together', () => {
    const posts = triageInvocations(skillText)
      .map((i) => i.line)
      .filter((l) => commandOf(l, spec) === 'post' && l.includes('--'));
    expect(posts.length).toBeGreaterThan(0);
    for (const p of posts) {
      expect(p).toContain('--yes');
      expect(p).toContain('--approved-by');
    }
  });

  test('the skill asks in chat before the post command and forbids posting without the answer', () => {
    const ask = skillText.indexOf('AskUserQuestion');
    const post = skillText.indexOf('triage post <run_id> --yes');
    expect(ask).toBeGreaterThan(-1);
    expect(post).toBeGreaterThan(ask);
    expect(skillText).toContain('Never run `triage post` without that answer');
    expect(skillText).toMatch(/`--approved-by` is the person who said yes/);
    expect(skillText).toMatch(/If the answer is no or unclear, do not post/);
  });
});

// --------------------------------------------------------- forbidden strings

const FORBIDDEN_SUBSTRINGS = ['safe_sql', 'safe_curl', '--env', 'http://', 'https://', 'triage-shivalik', 'shivalik', 'refs/'];

const FORBIDDEN_PATTERNS: readonly { name: string; re: RegExp }[] = [
  { name: 'hostname', re: /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|in|io|net|org|local|internal|ai|dev|cloud|co)\b/i },
  { name: 'ip address', re: /\b\d{1,3}(?:\.\d{1,3}){3}\b/ },
  { name: 'slack token', re: /\bxox[abposr]-/ },
  { name: 'api key', re: /\bsk-[A-Za-z0-9]/ },
  { name: 'bearer value', re: /\bBearer\s+[A-Za-z0-9._-]{8,}/ },
  { name: 'long digit run (account, phone or ts)', re: /\d{6,}/ },
  { name: 'email address', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
];

function forbiddenHits(text: string): string[] {
  const hits: string[] = [];
  const lower = text.toLowerCase();
  for (const s of FORBIDDEN_SUBSTRINGS) if (lower.includes(s)) hits.push(s);
  for (const { name, re } of FORBIDDEN_PATTERNS) if (re.test(text)) hits.push(name);
  return hits;
}

describe('forbidden strings', () => {
  test('the skill has no hostnames, tokens, customer data or old wrapper names', () => {
    expect(forbiddenHits(skillText)).toEqual([]);
  });

  test('the hook example has none either', () => {
    expect(forbiddenHits(readFileSync(HOOK_PATH, 'utf8'))).toEqual([]);
  });

  test('the check catches each kind', () => {
    const samples: [string, string][] = [
      ['run safe_sql.sh first', 'safe_sql'],
      ['wrap it in safe_curl', 'safe_curl'],
      ['triage start --env prod', '--env'],
      ['see http://example', 'http://'],
      ['see https://example', 'https://'],
      ['copy from triage-shivalik', 'triage-shivalik'],
      ['connect to db.vance.local', 'hostname'],
      ['ssh 10.0.0.1', 'ip address'],
      ['token xoxb-abc', 'slack token'],
      ['key sk-abc', 'api key'],
      ['Authorization: Bearer abcdefgh1234', 'bearer value'],
      ['account 12345678', 'long digit run (account, phone or ts)'],
      ['ask someone@example.org', 'email address'],
    ];
    for (const [text, hit] of samples) expect(forbiddenHits(text)).toContain(hit);
  });
});

// --------------------------------------------------------------- hook example

type HookEntry = { type: string; command: string; timeout?: number };
type HookDoc = { hooks: { PreToolUse: { matcher: string; hooks: HookEntry[] }[] } };

function readHook(): HookDoc {
  return JSON.parse(readFileSync(HOOK_PATH, 'utf8')) as HookDoc;
}

/** Runs the hook command the way Claude Code does: tool input JSON on stdin. */
function runHook(stdin: string): { code: number | null; stderr: string } {
  const command = readHook().hooks.PreToolUse[0]?.hooks[0]?.command as string;
  const r = spawnSync('sh', ['-c', command], { input: stdin, encoding: 'utf8', timeout: 10_000 });
  return { code: r.status, stderr: r.stderr };
}

function bash(command: string): string {
  return JSON.stringify({ tool_name: 'Bash', tool_input: { command } });
}

describe('PreToolUse hook example', () => {
  test('parses as JSON with one Bash matcher and one command hook', () => {
    const doc = readHook();
    expect(Object.keys(doc)).toEqual(['hooks']);
    expect(Object.keys(doc.hooks)).toEqual(['PreToolUse']);
    expect(doc.hooks.PreToolUse).toHaveLength(1);
    const entry = doc.hooks.PreToolUse[0] as HookDoc['hooks']['PreToolUse'][number];
    expect(entry.matcher).toBe('Bash');
    expect(entry.hooks).toHaveLength(1);
    expect(entry.hooks[0]?.type).toBe('command');
    expect(typeof entry.hooks[0]?.command).toBe('string');
  });

  test("lets through commands that start with 'triage '", () => {
    for (const c of [
      'triage start --slack-url VALUE --interface claude-code --json',
      'triage wait 01J0000000000000000000000 --timeout 90 --json',
      'triage ask 01J0000000000000000000000 "why is it pending?" --json',
      "triage post 01J0000000000000000000000 --yes --approved-by 'ops user'",
    ]) {
      expect({ c, ...runHook(bash(c)) }).toMatchObject({ c, code: 0 });
    }
  });

  test('refuses every other command, chained or redirected commands and expansions', () => {
    for (const c of [
      'ls',
      'cat .env',
      'triagex status x',
      ' triage status x',
      'TRIAGE_HOME=/tmp triage status x',
      'triage',
      'triage status x; ls',
      'triage status x && ls',
      'triage status x || ls',
      'triage status x | tee out',
      'triage status x & ls',
      'triage status x > out',
      'triage status x < in',
      'triage ask x "$HOME"',
      'triage ask x "$(id)"',
      'triage ask x `id`',
      'triage status x\nls',
      'triage status x\rls',
      'triage status x \\\nls',
    ]) {
      const r = runHook(bash(c));
      expect({ c, code: r.code }).toEqual({ c, code: 2 });
      expect(r.stderr).toContain('Only triage commands');
    }
  });

  test('fails closed on input it cannot read', () => {
    for (const stdin of ['', 'not json', JSON.stringify({ tool_name: 'Bash' }), JSON.stringify({ tool_input: {} })]) {
      expect({ stdin, code: runHook(stdin).code }).toEqual({ stdin, code: 2 });
    }
  });
});

// ------------------------------------------------------------ knowledge root

describe('the knowledge loader never sees this skill', () => {
  test("TRIAGE_KNOWLEDGE_DIR defaults to './knowledge' and resolves under TRIAGE_HOME", () => {
    expect(KEY_BY_NAME.get('TRIAGE_KNOWLEDGE_DIR')?.default).toBe('./knowledge');
    const config = configFromRecord({}, '/triage/home');
    expect(config.paths.knowledgeDir).toBe('/triage/home/knowledge');
  });

  test('the skill folder is outside knowledge/ and outside any workspace skill dir', () => {
    const rel = relative(join(REPO, 'knowledge'), SKILL_DIR);
    expect(rel.startsWith('..')).toBe(true);
    const segments = relative(REPO, SKILL_DIR).split(sep);
    expect(segments[0]).toBe('integrations');
    expect(segments.some((s) => s === '.agents' || s === '.claude' || s === 'knowledge')).toBe(false);
  });

  test('loading the repo knowledge tree yields no triage skill', () => {
    const knowledge = loadKnowledge(join(REPO, 'knowledge'));
    expect(knowledge.dir).toBe(join(REPO, 'knowledge'));
    expect(knowledge.skills.has('triage')).toBe(false);
  });
});
