// Runtime skills built from the knowledge/ tree (HLD §1.1, §4.5; D16, D42).
//
// loadKnowledge(dir) runs once at boot. It reads every SKILL.md under the
// knowledge dir, checks the frontmatter and builds each skill with
// defineSkill(). knowledge/method/ holds the always-on instruction text and
// is never a skill. The accessors below only read the cached result, so an
// agent render never touches the filesystem.
//
// No .md file is imported: Flue's build-resolved SKILL.md imports do not load
// under bun test or Vitest, and runtime loading lets both boot the same agent.

import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { basename, extname, isAbsolute, join, relative, sep } from 'node:path';
import { defineSkill, type SkillDefinition } from '@flue/runtime';
import type { Entity } from '../types/core.ts';

export const METHOD_DIR = 'method';
export const SKILL_FILE = 'SKILL.md';

export type KnowledgeProblem = { readonly path: string; readonly reason: string };

export class KnowledgeError extends Error {
  override readonly name = 'KnowledgeError';
  readonly problems: readonly KnowledgeProblem[];

  constructor(problems: readonly KnowledgeProblem[]) {
    super(`invalid knowledge tree: ${problems.map((p) => `${p.path}: ${p.reason}`).join('; ')}`);
    this.problems = Object.freeze(problems.map((p) => Object.freeze({ ...p })));
  }
}

export type Knowledge = {
  readonly dir: string;
  /** knowledge/method/*.md keyed by file name, for example 'orchestrator.md'. */
  readonly method: ReadonlyMap<string, string>;
  /** Skills keyed by directory name, which is also the skill name. */
  readonly skills: ReadonlyMap<string, SkillDefinition>;
  /** Things that do not stop the boot, such as a directory with no SKILL.md. */
  readonly warnings: readonly string[];
};

export type ServiceSkills = {
  readonly skills: readonly SkillDefinition[];
  /** Services that have no <entity>-<service> notes. */
  readonly missing: readonly string[];
};

// ------------------------------------------------------------------ loading

let current: Knowledge | undefined;

/**
 * Reads the knowledge tree at dir (an absolute path, normally
 * config.paths.knowledgeDir, which is TRIAGE_KNOWLEDGE_DIR resolved against
 * TRIAGE_HOME) and caches it for the accessors. Throws KnowledgeError with
 * every bad path at once. Call it at boot, never in an agent render.
 */
export function loadKnowledge(dir: string): Knowledge {
  if (!isAbsolute(dir)) {
    throw new KnowledgeError([{ path: dir, reason: 'knowledge dir must be an absolute path' }]);
  }
  if (!isDir(dir)) throw new KnowledgeError([{ path: dir, reason: 'knowledge dir does not exist' }]);

  const problems: KnowledgeProblem[] = [];
  const warnings: string[] = [];
  const method = readMethod(join(dir, METHOD_DIR), warnings);

  const found: string[] = [];
  for (const entry of sortedEntries(dir)) {
    const path = join(dir, entry);
    if (entry.startsWith('.') || entry === METHOD_DIR || !isDir(path)) continue;
    findSkillDirs(path, found, problems, warnings);
  }

  const skills = new Map<string, SkillDefinition>();
  const firstPath = new Map<string, string>();
  for (const skillDir of found) {
    const name = basename(skillDir);
    const earlier = firstPath.get(name);
    if (earlier !== undefined) {
      problems.push({ path: skillDir, reason: `duplicate skill name '${name}', also at ${earlier}` });
      continue;
    }
    firstPath.set(name, skillDir);
    const skill = buildSkill(skillDir, problems);
    if (skill) skills.set(name, skill);
  }

  if (problems.length > 0) throw new KnowledgeError(problems);
  current = Object.freeze({
    dir,
    method,
    skills,
    warnings: Object.freeze(warnings),
  });
  return current;
}

/** The knowledge loaded at boot. Throws when loadKnowledge has not run. */
export function currentKnowledge(): Knowledge {
  if (!current) throw new Error('knowledge is not loaded: call loadKnowledge(dir) at boot');
  return current;
}

function readMethod(dir: string, warnings: string[]): ReadonlyMap<string, string> {
  const docs = new Map<string, string>();
  if (!isDir(dir)) {
    warnings.push(`${dir}: no method directory, the instruction has run data only`);
    return docs;
  }
  for (const entry of sortedEntries(dir)) {
    const path = join(dir, entry);
    if (extname(entry) !== '.md' || !isFile(path)) continue;
    docs.set(entry, readFileSync(path, 'utf8').trim());
  }
  return docs;
}

// A directory that holds SKILL.md is a skill and owns its whole subtree.
// A directory without one is a group and is searched further down, so
// knowledge/**/SKILL.md is found and names must be unique across the tree.
function findSkillDirs(dir: string, out: string[], problems: KnowledgeProblem[], warnings: string[]): void {
  if (isFile(join(dir, SKILL_FILE))) {
    out.push(dir);
    return;
  }
  const before = out.length;
  for (const entry of sortedEntries(dir)) {
    const path = join(dir, entry);
    if (!entry.startsWith('.') && isDir(path)) findSkillDirs(path, out, problems, warnings);
  }
  if (out.length === before) warnings.push(`${dir}: no ${SKILL_FILE}, skipped`);
}

function buildSkill(dir: string, problems: KnowledgeProblem[]): SkillDefinition | undefined {
  const skillPath = join(dir, SKILL_FILE);
  const parsed = parseSkillFile(readFileSync(skillPath, 'utf8'));
  if ('error' in parsed) {
    problems.push({ path: skillPath, reason: parsed.error });
    return undefined;
  }
  const { fields, body } = parsed;
  const dirName = basename(dir);
  const bad = (reason: string) => problems.push({ path: skillPath, reason });

  const name = fields['name'];
  const description = fields['description'];
  let ok = true;
  if (typeof name !== 'string' || name === '') {
    bad('frontmatter has no name');
    ok = false;
  } else if (name !== dirName) {
    bad(`name '${name}' does not match directory '${dirName}'`);
    ok = false;
  } else if (!SKILL_NAME.test(name) || name.length > 64) {
    bad(`name '${name}' must be lowercase letters, digits and single hyphens, at most 64 characters`);
    ok = false;
  }
  if (typeof description !== 'string' || description.trim() === '') {
    bad('frontmatter has an empty description');
    ok = false;
  } else if (description.length > 1024) {
    bad('description is longer than 1024 characters');
    ok = false;
  }
  if (body === '') {
    bad('SKILL.md has no instructions after the frontmatter');
    ok = false;
  }
  const optional = optionalFields(fields, bad);
  const files = readSupportingFiles(dir, problems);
  if (!ok || !optional || !files) return undefined;

  try {
    return defineSkill({
      name: name as string,
      description: (description as string).trim(),
      instructions: body,
      ...optional,
      ...(Object.keys(files).length > 0 ? { files } : {}),
    });
  } catch (error) {
    bad(`defineSkill rejected it: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

type OptionalFields = Pick<SkillDefinition, 'license' | 'compatibility' | 'metadata' | 'allowedTools'>;

function optionalFields(fields: Fields, bad: (reason: string) => void): OptionalFields | undefined {
  const out: { -readonly [K in keyof OptionalFields]: OptionalFields[K] } = {};
  let ok = true;
  const str = (key: string): string | undefined => {
    const value = fields[key];
    if (value === undefined || typeof value === 'string') return value;
    bad(`frontmatter ${key} must be a string`);
    ok = false;
    return undefined;
  };
  const license = str('license');
  const compatibility = str('compatibility');
  const allowedTools = str('allowed-tools');
  if (license !== undefined) out.license = license;
  if (compatibility !== undefined) out.compatibility = compatibility;
  if (allowedTools !== undefined) out.allowedTools = allowedTools;
  const metadata = fields['metadata'];
  if (metadata !== undefined) {
    if (typeof metadata === 'object' && !Array.isArray(metadata)) out.metadata = metadata;
    else {
      bad('frontmatter metadata must be a map of strings');
      ok = false;
    }
  }
  return ok ? out : undefined;
}

// ------------------------------------------------------- supporting files

const TEXT_EXTENSIONS = new Set(['.md', '.json', '.txt', '.yaml', '.yml', '.csv', '.tsv', '.sql', '.jq']);
// Flue refuses to package these; failing at boot names the file sooner.
const SECRET_NAME = /^\.env(\..*)?$|\.(pem|key|p12|pfx)$|^id_(rsa|dsa|ecdsa|ed25519)/i;

function readSupportingFiles(
  dir: string,
  problems: KnowledgeProblem[],
): Record<string, string | Uint8Array> | undefined {
  const files: Record<string, string | Uint8Array> = {};
  let ok = true;
  const walk = (current: string): void => {
    for (const entry of sortedEntries(current)) {
      const path = join(current, entry);
      const rel = relative(dir, path).split(sep).join('/');
      if (SECRET_NAME.test(entry)) {
        problems.push({ path, reason: 'secret-looking file in a skill directory' });
        ok = false;
        continue;
      }
      if (entry.startsWith('.')) continue;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        problems.push({ path, reason: 'symbolic links are not allowed in a skill directory' });
        ok = false;
      } else if (stat.isDirectory()) {
        if (isFile(join(path, SKILL_FILE))) {
          problems.push({ path, reason: `nested ${SKILL_FILE} inside skill ${basename(dir)}` });
          ok = false;
        } else walk(path);
      } else if (stat.isFile() && rel !== SKILL_FILE) {
        const bytes = readFileSync(path);
        files[rel] = TEXT_EXTENSIONS.has(extname(entry).toLowerCase())
          ? bytes.toString('utf8')
          : new Uint8Array(bytes);
      }
    }
  };
  walk(dir);
  return ok ? files : undefined;
}

// ------------------------------------------------------------ frontmatter

type FieldValue = string | string[] | Record<string, string>;
type Fields = Record<string, FieldValue>;

/**
 * Splits a SKILL.md into frontmatter fields and the markdown body. The
 * frontmatter is the small YAML subset skills use: `key: value` with plain,
 * quoted or block (| and >) values, one level of `key:` map (metadata) and
 * `- item` lists. Anything else is an error rather than a guess.
 */
export function parseSkillFile(text: string): { fields: Fields; body: string } | { error: string } {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return { error: 'missing frontmatter (the file must start with ---)' };
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === '---');
  if (end < 0) return { error: 'frontmatter is not closed with ---' };
  const fields: Fields = {};
  const head = lines.slice(1, end);
  let i = 0;
  while (i < head.length) {
    const line = head[i] as string;
    if (line.trim() === '' || line.trimStart().startsWith('#')) {
      i++;
      continue;
    }
    const match = /^([A-Za-z0-9_-]+):(?:\s+(.*))?$/.exec(line.trimEnd());
    if (!match || /^\s/.test(line)) return { error: `frontmatter line ${i + 2} is not 'key: value'` };
    const key = match[1] as string;
    const raw = (match[2] ?? '').trim();
    const block: string[] = [];
    let j = i + 1;
    while (j < head.length && (/^\s/.test(head[j] as string) || (head[j] as string).trim() === '')) {
      block.push(head[j] as string);
      j++;
    }
    while (block.length > 0 && (block[block.length - 1] as string).trim() === '') block.pop();
    const value = fieldValue(raw, block);
    if (typeof value === 'object' && 'error' in value) return { error: `frontmatter ${key}: ${value.error}` };
    fields[key] = value;
    i = j;
  }
  return { fields, body: lines.slice(end + 1).join('\n').trim() };
}

function fieldValue(raw: string, block: string[]): FieldValue | { error: string } {
  if (/^[|>][+-]?$/.test(raw)) return blockScalar(raw.startsWith('>'), block);
  if (raw !== '') {
    if (block.length > 0) {
      // A plain scalar continued on indented lines folds into one line.
      if (/^["']/.test(raw)) return { error: 'multi-line quoted values are not supported' };
      return [raw, ...block.map((l) => l.trim())].filter((l) => l !== '').join(' ');
    }
    return scalar(raw);
  }
  if (block.length === 0) return '';
  const items = block.filter((l) => l.trim() !== '');
  if (items.every((l) => /^\s+-\s/.test(l) || /^\s+-$/.test(l))) {
    const list: string[] = [];
    for (const l of items) {
      const v = scalar(l.trim().slice(1).trim());
      if (typeof v !== 'string') return v;
      list.push(v);
    }
    return list;
  }
  const map: Record<string, string> = {};
  for (const l of items) {
    const m = /^\s+([A-Za-z0-9_.-]+):\s*(.*)$/.exec(l);
    if (!m) return { error: 'nested values other than a flat map or list are not supported' };
    const v = scalar((m[2] as string).trim());
    if (typeof v !== 'string') return v;
    map[m[1] as string] = v;
  }
  return map;
}

function blockScalar(folded: boolean, block: string[]): string {
  const indents = block.filter((l) => l.trim() !== '').map((l) => (/^\s*/.exec(l) as RegExpExecArray)[0].length);
  const cut = indents.length > 0 ? Math.min(...indents) : 0;
  const lines = block.map((l) => l.slice(cut));
  if (!folded) return lines.join('\n').trim();
  return lines
    .join('\n')
    .split(/\n{2,}/)
    .map((para) => para.split('\n').map((l) => l.trim()).join(' '))
    .join('\n')
    .trim();
}

function scalar(raw: string): string | { error: string } {
  if (raw.startsWith('"')) {
    if (!/"\s*$/.test(raw) || raw.trimEnd().length < 2) return { error: 'unterminated double-quoted value' };
    try {
      const parsed: unknown = JSON.parse(raw.trimEnd());
      return typeof parsed === 'string' ? parsed : { error: 'bad double-quoted value' };
    } catch {
      return { error: 'bad double-quoted value' };
    }
  }
  if (raw.startsWith("'")) {
    const t = raw.trimEnd();
    if (t.length < 2 || !t.endsWith("'")) return { error: 'unterminated single-quoted value' };
    return t.slice(1, -1).replace(/''/g, "'");
  }
  if (raw.startsWith('[') || raw.startsWith('{')) return { error: 'flow collections are not supported' };
  // A plain value ends at ' #', the start of a YAML comment.
  return raw.replace(/\s+#.*$/, '').trim();
}

// ------------------------------------------------------------ accessors

// Service notes are named <entity>-<service>. 'overview' is the entity
// overview, which the root mounts itself, so it is never a service note.
const RESERVED_SERVICE = 'overview';

export function overviewSkill(entity: Entity, knowledge: Knowledge = currentKnowledge()): SkillDefinition | undefined {
  return knowledge.skills.get(`${entity}-overview`);
}

/**
 * The <entity>-<service> notes for the registry's services. Services with no
 * notes are listed in missing so the caller can record the gap; they never
 * throw.
 */
export function serviceSkills(
  entity: Entity,
  services: readonly string[],
  knowledge: Knowledge = currentKnowledge(),
): ServiceSkills {
  const skills: SkillDefinition[] = [];
  const missing: string[] = [];
  for (const service of new Set(services.map((s) => s.trim().toLowerCase()))) {
    if (service === '' || service === RESERVED_SERVICE) continue;
    const skill = knowledge.skills.get(`${entity}-${service}`);
    if (skill) skills.push(skill);
    else missing.push(service);
  }
  return Object.freeze({ skills: Object.freeze(skills), missing: Object.freeze(missing) });
}

export function patternsSkill(knowledge: Knowledge = currentKnowledge()): SkillDefinition | undefined {
  return knowledge.skills.get('patterns');
}

export function frontendRoutingSkill(knowledge: Knowledge = currentKnowledge()): SkillDefinition | undefined {
  return knowledge.skills.get('frontend-routing');
}

export function repoMapSkill(knowledge: Knowledge = currentKnowledge()): SkillDefinition | undefined {
  return knowledge.skills.get('repo-map');
}

export function codegraphLimitsSkill(knowledge: Knowledge = currentKnowledge()): SkillDefinition | undefined {
  return knowledge.skills.get('codegraph-limits');
}

/** One knowledge/method file by name, for delegate instructions (investigator.md, logs-ssfb.md, ...). */
export function methodDoc(fileName: string, knowledge: Knowledge = currentKnowledge()): string | undefined {
  return knowledge.method.get(fileName);
}

// ------------------------------------------------------------------ fs

function sortedEntries(dir: string): string[] {
  return readdirSync(dir).sort();
}

function isDir(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}
