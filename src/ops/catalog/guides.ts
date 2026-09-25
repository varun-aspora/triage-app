// Guides are the knowledge skills (knowledge/<name>/SKILL.md), read from disk
// on every call so a guide written a moment ago is listed. The agents keep
// the tree they loaded at boot (src/agents/skills.ts); this module never
// touches that cache.
//
// Discovery mirrors the loader: a directory with a SKILL.md is a skill and
// owns its subtree, a directory without one is searched further down, and
// dot entries are skipped. method/ and classifier/ hold no skills.
//
// A file the loader would refuse is listed with `problem` set instead of
// failing the list, so the page can show what needs fixing.

import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { parseSkillFile, SKILL_FILE } from '../../agents/skills.ts';
import { ENTITIES, type Entity } from '../../types/core.ts';
import { isSkillName, MAX_DESCRIPTION, oneLineProblem } from './validate.ts';

export const GUIDE_STATUSES = ['ported', 'written', 'stub'] as const;
export type GuideStatus = (typeof GUIDE_STATUSES)[number];

const SKIP_TOP = new Set(['method', 'classifier']);

export type GuideInfo = {
  readonly name: string;
  readonly kind: string;
  readonly entity: string;
  readonly service: string | null;
  readonly status: GuideStatus | null;
  readonly description: string;
  readonly sources: string | null;
  /** Markdown after the front-matter; empty when the file does not parse. */
  readonly body: string;
  readonly problem?: string;
  /** Absolute path of the skill directory. Never sent to a client. */
  readonly dir: string;
};

/** Every skill in the tree, sorted by name. An unreadable or missing dir is an empty list. */
export function listGuides(knowledgeDir: string): GuideInfo[] {
  const seen = new Set<string>();
  const out: GuideInfo[] = [];
  for (const dir of skillDirs(knowledgeDir)) {
    const name = dir.split(sep).pop() as string;
    const info = readGuide(dir, name);
    if (seen.has(name)) out.push({ ...info, problem: `another skill is also named '${name}'` });
    else out.push(info);
    seen.add(name);
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** The skill directories under knowledgeDir, found the way the loader finds them. */
export function skillDirs(knowledgeDir: string): string[] {
  const found: string[] = [];
  for (const entry of entries(knowledgeDir)) {
    if (entry.startsWith('.') || SKIP_TOP.has(entry)) continue;
    const path = join(knowledgeDir, entry);
    if (isDir(path)) walkSkills(path, found);
  }
  return found;
}

function walkSkills(dir: string, out: string[]): void {
  if (isFile(join(dir, SKILL_FILE))) {
    out.push(dir);
    return;
  }
  for (const entry of entries(dir)) {
    const path = join(dir, entry);
    if (!entry.startsWith('.') && isDir(path)) walkSkills(path, out);
  }
}

/**
 * True when any directory in the tree is called name. Skill names must be
 * unique across the whole tree, and a directory without a SKILL.md is a
 * group the loader searches, so any same-named directory counts.
 */
export function dirExistsAnywhere(knowledgeDir: string, name: string): boolean {
  const walk = (dir: string): boolean => {
    for (const entry of entries(dir)) {
      if (entry.startsWith('.')) continue;
      const path = join(dir, entry);
      if (!isDir(path)) continue;
      if (entry === name || walk(path)) return true;
    }
    return false;
  };
  return walk(knowledgeDir);
}

function readGuide(dir: string, name: string): GuideInfo {
  const fallback = guessFromName(name);
  let text: string;
  try {
    text = readFileSync(join(dir, SKILL_FILE), 'utf8');
  } catch {
    return { ...fallback, dir, problem: `${SKILL_FILE} cannot be read` };
  }
  const parsed = parseSkillFile(text);
  if ('error' in parsed) return { ...fallback, dir, problem: parsed.error };

  const { fields, body } = parsed;
  const str = (x: unknown): string | undefined => (typeof x === 'string' ? x : undefined);
  const metadata = typeof fields['metadata'] === 'object' && !Array.isArray(fields['metadata']) ? fields['metadata'] : {};
  const description = str(fields['description'])?.trim() ?? '';
  const status = str(metadata['status']);
  const info: GuideInfo = {
    name,
    kind: str(metadata['kind']) ?? fallback.kind,
    entity: str(metadata['entity']) ?? fallback.entity,
    service: str(metadata['service']) ?? null,
    status: (GUIDE_STATUSES as readonly string[]).includes(status ?? '') ? (status as GuideStatus) : null,
    description,
    sources: str(metadata['sources']) ?? null,
    body,
    dir,
  };
  const problem = skillProblem(name, fields['name'], description, body);
  return problem === undefined ? info : { ...info, problem };
}

// The checks buildSkill in src/agents/skills.ts applies; a file failing any
// of them stops the next boot.
function skillProblem(dirName: string, name: unknown, description: string, body: string): string | undefined {
  if (typeof name !== 'string' || name === '') return 'front-matter has no name';
  if (name !== dirName) return `name '${name}' does not match directory '${dirName}'`;
  if (!isSkillName(name)) return 'name must be lowercase letters, digits and single hyphens, at most 64 characters';
  if (description === '') return 'front-matter has an empty description';
  if (description.length > MAX_DESCRIPTION) return `description is longer than ${MAX_DESCRIPTION} characters`;
  if (body === '') return 'there is no text after the front-matter';
  return undefined;
}

function guessFromName(name: string): Omit<GuideInfo, 'dir'> {
  const dash = name.indexOf('-');
  const head = dash < 0 ? name : name.slice(0, dash);
  const entity = (ENTITIES as readonly string[]).includes(head) ? head : 'shared';
  const rest = dash < 0 ? '' : name.slice(dash + 1);
  const kind = entity === 'shared' ? name : rest === 'overview' ? 'overview' : 'service';
  return {
    name,
    kind,
    entity,
    service: kind === 'service' ? rest : null,
    status: null,
    description: '',
    sources: null,
    body: '',
  };
}

/** The files next to SKILL.md, relative to the skill dir with '/' separators, sorted. */
export function supportingFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of entries(current)) {
      if (entry.startsWith('.')) continue;
      const path = join(current, entry);
      if (isDir(path)) walk(path);
      else if (isFile(path)) {
        const rel = relative(dir, path).split(sep).join('/');
        if (rel !== SKILL_FILE) out.push(rel);
      }
    }
  };
  walk(dir);
  return out.sort();
}

// ---------------------------------------------------------------- writing

export type SkillInput = {
  readonly name: string;
  readonly description: string;
  readonly kind: 'overview' | 'service';
  readonly entity: Entity;
  readonly service?: string;
  readonly sources?: string;
  readonly status: GuideStatus;
  readonly body: string;
};

// Plain values YAML would read as something other than a string; the
// front-matter check in test/knowledge refuses them unquoted.
const YAML_NON_STRING = /^(?:true|false|yes|no|on|off|y|n|null)$/i;

/**
 * SKILL.md text in the front-matter subset knowledge/README.md defines:
 * name plain, description and sources double-quoted (JSON string syntax is
 * valid YAML), metadata a flat map indented by two spaces.
 */
export function renderSkill(input: SkillInput): string {
  const plain = (s: string): string => (YAML_NON_STRING.test(s) ? JSON.stringify(s) : s);
  const lines = ['---', `name: ${input.name}`, `description: ${JSON.stringify(input.description)}`, 'metadata:'];
  lines.push(`  kind: ${input.kind}`, `  entity: ${input.entity}`);
  if (input.kind === 'service' && input.service !== undefined) lines.push(`  service: ${plain(input.service)}`);
  if (input.sources !== undefined) lines.push(`  sources: ${JSON.stringify(input.sources)}`);
  lines.push(`  status: ${input.status}`, '---', '', input.body.trim(), '');
  return lines.join('\n');
}

/**
 * Re-parses rendered text with the loader's parser and applies the loader's
 * rules, and checks nothing changed on the way (for example a body line that
 * the parser would read as front-matter). Returns the problem or undefined.
 */
export function validateRendered(text: string, input: SkillInput): string | undefined {
  const parsed = parseSkillFile(text);
  if ('error' in parsed) return parsed.error;
  const { fields, body } = parsed;
  const problem = skillProblem(input.name, fields['name'], typeof fields['description'] === 'string' ? fields['description'].trim() : '', body);
  if (problem !== undefined) return problem;
  const bad = oneLineProblem(input.description, MAX_DESCRIPTION, 1);
  if (bad !== undefined) return `description ${bad}`;
  if (fields['description'] !== input.description || body !== input.body.trim()) return 'the file does not read back as written';
  const metadata = fields['metadata'];
  if (typeof metadata !== 'object' || Array.isArray(metadata)) return 'metadata does not read back as a map';
  const expected: Record<string, string> = { kind: input.kind, entity: input.entity };
  if (input.kind === 'service' && input.service !== undefined) expected['service'] = input.service;
  if (input.sources !== undefined) expected['sources'] = input.sources;
  expected['status'] = input.status;
  if (JSON.stringify(metadata) !== JSON.stringify(expected)) return 'metadata does not read back as written';
  return undefined;
}

// Repo names that the knowledge lint would read as an environment name, a
// host or a long digit run are left out of the stub rather than refused.
const LINT_UNSAFE = /(?<![A-Za-z0-9])(?:prod|uat|stg|staging)(?![A-Za-z0-9])|\d{6,}|\./i;

/**
 * The body of a stub guide for a new service. Every section is marked
 * unverified so nobody reads it as fact, and it names no env keys, hosts or
 * ids, which the knowledge lint would reject.
 */
export function stubBody(entity: Entity, key: string, repo: string): string {
  const marker = '(unverified: stub, not written yet)';
  const code = LINT_UNSAFE.test(repo) ? 'Its code repo is listed in the registry.' : `Its code is in the \`${repo}\` repo.`;
  return [
    `# ${key} (${entity.toUpperCase()})`,
    '',
    `A placeholder for the ${key} service. ${code} Replace each section with what an investigator needs, then set the status to written.`,
    '',
    '## Tables',
    '',
    `The tables this service owns and how they join. ${marker}`,
    '',
    '## Endpoints',
    '',
    `The read-only endpoints worth calling while investigating. ${marker}`,
    '',
    '## Logs',
    '',
    `The log service name and the messages that matter. ${marker}`,
    '',
    '## Known issues',
    '',
    `Failures seen before and how they were confirmed. ${marker}`,
  ].join('\n');
}

export function stubDescription(entity: Entity, key: string): string {
  return `Placeholder note for the ${entity.toUpperCase()} ${key} service: tables, endpoints, logs and known issues, not written yet. Use when an investigation touches ${key}.`;
}

// ------------------------------------------------------------------ fs

function entries(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

// lstat, as the loader does: a symlinked directory or file is not followed.
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
