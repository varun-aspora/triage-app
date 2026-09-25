// Shared helpers for the knowledge/ tests (T12). knowledge/README.md is the
// contract these helpers check:
//
// - walkKnowledge lists every file under a knowledge tree.
// - parseFrontmatter reads the restricted SKILL.md front-matter subset.
// - checkSkillTree applies the layout and front-matter rules to a tree.
// - lintText and lintTree apply the content hygiene rules.
// - KNOWN_TOOLS and allowedTools() give the tool names from HLD §2, per agent.
//
// Node APIs only, so a Vitest contract test can use them too.

import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENTITIES, type Entity } from '../../src/types/core.ts';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const KNOWLEDGE_DIR = join(REPO_ROOT, 'knowledge');
export const CATEGORIES_FILE = join(KNOWLEDGE_DIR, 'classifier', 'categories.json');

export const SKILL_FILE = 'SKILL.md';
/** Top-level directories that are never skills. */
export const NON_SKILL_DIRS = ['method', 'classifier'] as const;
/** The only file allowed directly under knowledge/. */
export const ROOT_FILES = ['README.md'] as const;

// ------------------------------------------------------------------ walker

export type KnowledgeFile = {
  /** Path relative to the knowledge root, with forward slashes. */
  readonly rel: string;
  readonly abs: string;
};

/**
 * Every file under dir, sorted by relative path. Dotfiles are included so the
 * lint sees them. Symbolic links are listed but never followed.
 */
export function walkKnowledge(dir: string): KnowledgeFile[] {
  const out: KnowledgeFile[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current).sort()) {
      const abs = join(current, entry);
      const stat = lstatSync(abs);
      if (stat.isDirectory()) walk(abs);
      else out.push({ rel: relative(dir, abs).split(sep).join('/'), abs });
    }
  };
  walk(dir);
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

/** Top-level directory names under dir, sorted. */
export function topLevelDirs(dir: string): string[] {
  return readdirSync(dir)
    .filter((entry) => lstatSync(join(dir, entry)).isDirectory())
    .sort();
}

// ------------------------------------------------------------ front-matter

export const METADATA_KEYS = ['kind', 'entity', 'service', 'sources', 'status'] as const;
export type MetadataKey = (typeof METADATA_KEYS)[number];

/** Skills that are not tied to one entity. Their kind equals their name. */
export const GLOBAL_SKILLS = ['patterns', 'repo-map', 'codegraph-limits', 'frontend-routing'] as const;
export const SKILL_KINDS = ['overview', 'service', ...GLOBAL_SKILLS] as const;
/** metadata.entity of a global skill. */
export const SHARED_ENTITY = 'shared';
export const SKILL_STATUSES = ['ported', 'written', 'stub'] as const;

export const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const MAX_NAME = 64;
export const MAX_DESCRIPTION = 1024;

export type Frontmatter = {
  readonly name: string;
  readonly description: string;
  readonly metadata: Readonly<Partial<Record<MetadataKey, string>>>;
};

export type ParsedSkill = { readonly frontmatter: Frontmatter; readonly body: string };

const TOP_KEYS = ['name', 'description', 'metadata'] as const;

/**
 * Parses the front-matter subset from knowledge/README.md: top-level keys
 * name, description and metadata, one line each; metadata is a flat map
 * indented by two spaces whose keys are METADATA_KEYS. Values are plain,
 * "double" or 'single' quoted strings. A plain value YAML would read as a
 * boolean, number, null or date is refused, as are lists, nested maps, block
 * scalars and comments. Returns the error text instead of throwing.
 */
export function parseFrontmatter(text: string): ParsedSkill | { error: string } {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines[0] !== '---') return { error: 'the file must start with a --- line' };
  const end = lines.findIndex((line, i) => i > 0 && line === '---');
  if (end < 0) return { error: 'front-matter is not closed with a --- line' };

  const top: Record<string, string> = {};
  const metadata: Partial<Record<MetadataKey, string>> = {};
  let inMetadata = false;
  for (let i = 1; i < end; i++) {
    const line = lines[i] as string;
    const at = `front-matter line ${i + 1}`;
    if (line.trim() === '') continue;
    if (/^\s*#/.test(line)) return { error: `${at}: comments are not part of the subset` };

    const nested = /^ {2}([a-z]+):(?: (.*))?$/.exec(line);
    if (nested) {
      if (!inMetadata) return { error: `${at}: indented line outside metadata` };
      const key = nested[1] as string;
      if (!(METADATA_KEYS as readonly string[]).includes(key)) {
        return { error: `${at}: unknown metadata key '${key}' (allowed: ${METADATA_KEYS.join(', ')})` };
      }
      if (key in metadata) return { error: `${at}: duplicate metadata key '${key}'` };
      const value = scalar(nested[2] ?? '');
      if (typeof value !== 'string') return { error: `${at}: metadata ${key} ${value.error}` };
      metadata[key as MetadataKey] = value;
      continue;
    }

    const topMatch = /^([a-z-]+):(?: (.*))?$/.exec(line);
    if (!topMatch) return { error: `${at}: not 'key: value' (lists and nested maps are not supported)` };
    const key = topMatch[1] as string;
    const raw = topMatch[2] ?? '';
    if (!(TOP_KEYS as readonly string[]).includes(key)) {
      return { error: `${at}: unknown key '${key}' (allowed: ${TOP_KEYS.join(', ')})` };
    }
    if (key in top || (key === 'metadata' && inMetadata)) return { error: `${at}: duplicate key '${key}'` };
    if (key === 'metadata') {
      if (raw.trim() !== '') return { error: `${at}: metadata must be a map on the following lines` };
      inMetadata = true;
      top[key] = '';
      continue;
    }
    inMetadata = false;
    const value = scalar(raw);
    if (typeof value !== 'string') return { error: `${at}: ${key} ${value.error}` };
    top[key] = value;
  }

  if (top['name'] === undefined) return { error: 'front-matter has no name' };
  if (top['description'] === undefined) return { error: 'front-matter has no description' };
  return {
    frontmatter: { name: top['name'], description: top['description'], metadata },
    body: lines.slice(end + 1).join('\n').trim(),
  };
}

// Plain values YAML 1.1 or 1.2 would not read as a string.
const NON_STRING_PLAIN = [
  /^(?:true|false|yes|no|on|off|y|n|null|~)$/i,
  /^(?=[-+]?\.?\d)[-+]?(?:\d[\d_]*)?(?:\.\d*)?(?:e[-+]?\d+)?$/i,
  /^[-+]?0(?:x[0-9a-f]+|o[0-7]+|b[01]+)$/i,
  /^[-+]?\.(?:inf|nan)$/i,
  /^\d{4}-\d{2}-\d{2}(?:[Tt ].*)?$/,
];

function scalar(raw: string): string | { error: string } {
  const value = raw.trim();
  if (value === '') return { error: 'is empty' };
  if (value.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === 'string') return parsed;
    } catch {
      // fall through
    }
    return { error: 'is not a valid double-quoted string' };
  }
  if (value.startsWith("'")) {
    if (value.length < 2 || !value.endsWith("'") || /[^']'(?!')/.test(value.slice(1, -1))) {
      return { error: 'is not a valid single-quoted string' };
    }
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (/^[[\]{}&*!|>%@`,?]/.test(value) || /^-(?:\s|$)/.test(value)) {
    return { error: 'starts with a YAML indicator; quote it' };
  }
  if (/:\s/.test(value) || / #/.test(value)) return { error: "contains ': ' or ' #'; quote it" };
  if (NON_STRING_PLAIN.some((re) => re.test(value))) {
    return { error: `'${value}' is not a string in YAML; quote it` };
  }
  return value;
}

// ------------------------------------------------------------ tree checks

export type TreeProblem = { readonly path: string; readonly reason: string };

/**
 * Checks the layout and every SKILL.md under root against the README
 * contract. Returns all problems; an empty list means the tree is valid. A
 * tree with no skills at all is valid.
 */
export function checkSkillTree(root: string): TreeProblem[] {
  const problems: TreeProblem[] = [];
  const bad = (path: string, reason: string) => problems.push({ path, reason });
  const files = walkKnowledge(root);

  // Layout: the root holds README.md and directories only.
  for (const f of files) {
    const parts = f.rel.split('/');
    if (parts.length === 1 && !(ROOT_FILES as readonly string[]).includes(f.rel)) {
      bad(f.rel, `only ${ROOT_FILES.join(', ')} may sit directly under knowledge/`);
    }
    if (parts[0] === 'method' && (parts.length !== 2 || !f.rel.endsWith('.md'))) {
      bad(f.rel, 'knowledge/method/ holds flat *.md files only');
    }
  }
  for (const dir of topLevelDirs(root)) {
    if ((NON_SKILL_DIRS as readonly string[]).includes(dir)) continue;
    if (!files.some((f) => f.rel === `${dir}/${SKILL_FILE}`)) {
      bad(dir, `a skill directory must hold ${SKILL_FILE}`);
    }
  }

  // Every SKILL.md, wherever it is.
  const seen = new Map<string, string>();
  for (const f of files.filter((file) => file.rel.split('/').pop() === SKILL_FILE)) {
    const parts = f.rel.split('/');
    const first = parts[0] as string;
    if ((NON_SKILL_DIRS as readonly string[]).includes(first)) {
      bad(f.rel, `no ${SKILL_FILE} may sit under knowledge/${first}/`);
      continue;
    }
    if (parts.length !== 2) bad(f.rel, `a skill lives at knowledge/<name>/${SKILL_FILE}, not deeper`);

    const parsed = parseFrontmatter(readFileSync(f.abs, 'utf8'));
    if ('error' in parsed) {
      bad(f.rel, parsed.error);
      continue;
    }
    const { frontmatter: fm, body } = parsed;
    const dirName = parts[parts.length - 2] as string;

    const earlier = seen.get(fm.name);
    if (earlier !== undefined) bad(f.rel, `duplicate skill name '${fm.name}', also in ${earlier}`);
    else seen.set(fm.name, f.rel);

    if (fm.name !== dirName) bad(f.rel, `name '${fm.name}' does not match directory '${dirName}'`);
    if (!SKILL_NAME.test(fm.name) || fm.name.length > MAX_NAME) {
      bad(f.rel, `name '${fm.name}' must be lowercase letters, digits and single hyphens, at most ${MAX_NAME} characters`);
    }
    if (fm.description.trim() === '') bad(f.rel, 'description is empty');
    if (fm.description.length > MAX_DESCRIPTION) {
      bad(f.rel, `description is ${fm.description.length} characters, over ${MAX_DESCRIPTION}`);
    }
    if (body === '') bad(f.rel, 'the body after the front-matter is empty');
    for (const reason of metadataProblems(fm)) bad(f.rel, reason);
  }
  return problems;
}

function metadataProblems(fm: Frontmatter): string[] {
  const out: string[] = [];
  const { kind, entity, service, status } = fm.metadata;
  if (status !== undefined && !(SKILL_STATUSES as readonly string[]).includes(status)) {
    out.push(`metadata.status '${status}' must be one of ${SKILL_STATUSES.join(', ')}`);
  }
  if (kind === undefined) return [...out, 'metadata.kind is required'];
  if (!(SKILL_KINDS as readonly string[]).includes(kind)) {
    return [...out, `metadata.kind '${kind}' must be one of ${SKILL_KINDS.join(', ')}`];
  }
  if (entity === undefined) return [...out, 'metadata.entity is required'];

  if (kind === 'overview' || kind === 'service') {
    if (!(ENTITIES as readonly string[]).includes(entity)) {
      out.push(`metadata.entity '${entity}' must be one of ${ENTITIES.join(', ')} for kind ${kind}`);
    }
    if (kind === 'overview') {
      if (service !== undefined) out.push('an overview has no metadata.service');
      if (fm.name !== `${entity}-overview`) out.push(`an overview is named '${entity}-overview'`);
    } else if (service === undefined) {
      out.push('a service note needs metadata.service');
    } else {
      if (!SKILL_NAME.test(service) || service === 'overview') out.push(`metadata.service '${service}' is not a service key`);
      if (fm.name !== `${entity}-${service}`) out.push(`a service note is named '${entity}-${service}'`);
    }
  } else {
    if (entity !== SHARED_ENTITY) out.push(`metadata.entity of a ${kind} skill is '${SHARED_ENTITY}'`);
    if (service !== undefined) out.push(`a ${kind} skill has no metadata.service`);
    if (fm.name !== kind) out.push(`a ${kind} skill is named '${kind}'`);
  }
  return out;
}

// ------------------------------------------------------------------- lint

export type LintHit = { readonly rule: string; readonly match: string; readonly line: number };

type LintRule = {
  readonly id: string;
  readonly re: RegExp;
  /** Returns true for a match that is not a problem. */
  readonly skip?: (match: RegExpExecArray) => boolean;
};

/**
 * Exact texts that would trip a rule but are allowed: the argo repo name
 * (environment word) and the sim-binding skill path that patterns.json cites
 * as a source_ref (.claude/ directory).
 */
export const ALLOWED_TEXT = [
  'prod-ssfb-aspora-argo',
  'triage-shivalik .claude/skills/aspora-harbor-shivalik-sim-binding-issue/SKILL.md',
] as const;

const TLDS = [
  'com', 'net', 'org', 'io', 'in', 'co', 'uk', 'ae', 'ai', 'app', 'dev', 'cloud', 'local',
  'internal', 'finance', 'tech', 'info', 'biz', 'us', 'eu', 'xyz', 'svc', 'cluster',
];
const FILE_EXTENSIONS = [
  'md', 'json', 'ts', 'tsx', 'js', 'mjs', 'cjs', 'go', 'py', 'sh', 'sql', 'yml', 'yaml', 'java',
  'kt', 'kts', 'swift', 'rb', 'toml', 'txt', 'proto', 'xml', 'gradle', 'csv', 'html', 'rs',
];
const endsWithFileExtension = (host: string): boolean =>
  FILE_EXTENSIONS.some((ext) => host.toLowerCase().endsWith(`.${ext}`));

const word = (w: string, flags = 'gi') => new RegExp(`(?<![A-Za-z0-9_])${w}(?![A-Za-z0-9_])`, flags);
const literal = (s: string) => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');

export const LINT_RULES: readonly LintRule[] = [
  { id: 'uuid', re: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi },
  { id: 'digits', re: /\d{6,}/g },
  { id: 'email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g },
  { id: 'pan', re: /(?<![A-Za-z0-9])[A-Z]{5}[0-9]{4}[A-Z](?![A-Za-z0-9])/g },
  { id: 'url', re: /https?:\/\//gi },
  { id: 'dsn', re: /postgres(?:ql)?:\/\//gi },
  {
    // Any other scheme (redis://, jdbc:postgresql://, ...). http and postgres have their own rules.
    id: 'url-scheme',
    re: /(?<![A-Za-z0-9+.-])[a-z][a-z0-9+.-]*:\/\//gi,
    skip: (m) => /^(?:https?|postgres(?:ql)?):\/\/$/i.test(m[0]),
  },
  {
    id: 'hostname',
    re: new RegExp(`(?<![\\w.-])(?:[a-z0-9-]+\\.)+(?:${TLDS.join('|')})(?![\\w-]|\\.[a-z0-9])`, 'gi'),
  },
  {
    id: 'host-port',
    re: /(?<![\w.-])([a-z][a-z0-9.-]*):(\d{2,5})(?!\d)/gi,
    skip: (m) => endsWithFileExtension(m[1] as string),
  },
  { id: 'ip-address', re: /(?<![\d.])\d{1,3}(?:\.\d{1,3}){3}(?![\d.])/g },
  {
    id: 'bearer',
    re: /\bBearer\s+(?!<)([A-Za-z0-9._~+/=-]{8,})/gi,
    // A token has a digit or symbol, or is long. 'Bearer credentials' is prose.
    skip: (m) => {
      const token = m[1] as string;
      return token.length < 20 && /^[A-Za-z]+$/.test(token);
    },
  },
  { id: 'jwt', re: /eyJ[A-Za-z0-9_-]{8,}/g },
  { id: 'slack-id', re: /(?<![A-Za-z0-9])(?=[UWCG][A-Z0-9]*\d)[UWCG][A-Z0-9]{8,11}(?![A-Za-z0-9])/g },
  { id: 'handle', re: /(?<![\w.+-])@[A-Za-z][\w.-]*(?![\w./-])/g },
  { id: 'dotenv', re: /\.env(?![A-Za-z0-9])/gi },
  { id: 'claude-dir', re: literal('.claude/') },
  { id: 'codex-dir', re: literal('.codex') },
  { id: 'claude-md', re: literal('CLAUDE.md') },
  { id: 'refs-dir', re: /(?<![A-Za-z0-9_-])refs\//gi },
  { id: 'safe-sql', re: literal('safe_sql') },
  { id: 'safe-curl', re: literal('safe_curl') },
  { id: 'cbs-curl', re: literal('cbs_curl') },
  { id: 'search-py', re: literal('search.py') },
  { id: 'lookup-user', re: literal('lookup_user.sh') },
  { id: 'env-flag', re: /--env(?![A-Za-z0-9_-])/gi },
  { id: 'debug-env-key', re: literal('SHIVALIK_DEBUG_') },
  { id: 'quickwit-env-key', re: literal('DEBUG_AI_QUICKWIT') },
  { id: 'mcp-tool', re: literal('mcp__') },
  { id: 'ask-user', re: literal('AskUserQuestion') },
  { id: 'playwright', re: literal('playwright') },
  { id: 'grafana', re: literal('grafana') },
  { id: 'psql', re: word('psql') },
  { id: 'kubectl', re: word('kubectl') },
  { id: 'env-word', re: /(?<![A-Za-z0-9])(?:prod|uat|stg|staging)(?![A-Za-z0-9])/gi },
];

export const LINT_RULE_IDS = LINT_RULES.map((r) => r.id);

/** Every banned pattern in text, with its 1-based line. */
export function lintText(text: string): LintHit[] {
  let clean = text;
  for (const allowed of ALLOWED_TEXT) clean = clean.split(allowed).join(' '.repeat(allowed.length));
  const hits: LintHit[] = [];
  for (const rule of LINT_RULES) {
    for (const m of clean.matchAll(rule.re)) {
      if (rule.skip?.(m)) continue;
      const line = clean.slice(0, m.index).split('\n').length;
      hits.push({ rule: rule.id, match: m[0], line });
    }
  }
  return hits.sort((a, b) => a.line - b.line || (a.rule < b.rule ? -1 : 1));
}

/** Lints every file under root, and each file's own path. Returns "rel:line rule match" strings. */
export function lintTree(root: string): string[] {
  const out: string[] = [];
  for (const f of walkKnowledge(root)) {
    for (const hit of lintText(f.rel)) out.push(`${f.rel} (path) ${hit.rule} ${hit.match}`);
    for (const hit of lintText(readFileSync(f.abs, 'utf8'))) out.push(`${f.rel}:${hit.line} ${hit.rule} ${hit.match}`);
  }
  return out;
}

/** The `<placeholder>` id form from the README: lowercase snake_case in angle brackets. */
export const PLACEHOLDER = /<[a-z][a-z0-9_]*>/g;

/** The `(unverified: <reason>)` marker from the README. */
export const UNVERIFIED_MARKER = /\(unverified: [^)\s][^)]*\)/g;

// ------------------------------------------------------------------ tools

/** Typed tools from HLD §2. */
export const TRIAGE_TOOLS = ['resolve_identity', 'note_evidence', 'finish_report'] as const;
export const INVESTIGATOR_TOOLS = ['logs_search', 'sql_select', 'http_call', 'note_evidence'] as const;
/** Added to investigate_ssfb and investigate_ssfb_deep only (some behind env flags). */
export const SSFB_EXTRA_TOOLS = [
  'get_account_statement',
  'detect_silent_reversals',
  'encrypt_lookup_value',
  'decrypt_fields',
  'cbs_call',
] as const;
export const CODE_TOOLS = [
  'code_explore',
  'code_node',
  'code_impact',
  'repo_read',
  'repo_grep',
] as const;
/** Flue sandbox tools, on every agent through the one inherited sandbox (D45). */
export const SANDBOX_TOOLS = ['read', 'write', 'edit', 'bash', 'grep', 'glob'] as const;
/** Flue framework tools. */
export const FRAMEWORK_TOOLS = ['task', 'activate_skill', 'read_skill_resource', 'finish'] as const;

export const KNOWN_TOOLS: ReadonlySet<string> = new Set([
  ...TRIAGE_TOOLS,
  ...INVESTIGATOR_TOOLS,
  ...SSFB_EXTRA_TOOLS,
  ...CODE_TOOLS,
  ...SANDBOX_TOOLS,
  ...FRAMEWORK_TOOLS,
]);

/** Agent kinds, matching the tool mounts in src/tools/types.ts. */
export const AGENTS = ['triage', 'investigator', 'investigator_deep', 'code_walker'] as const;
export type AgentKind = (typeof AGENTS)[number];

const SKILL_TOOLS = ['activate_skill', 'read_skill_resource'] as const;

/**
 * The tools an agent may have. entity matters for the investigators only:
 * SSFB adds SSFB_EXTRA_TOOLS. The deep investigator adds the code tools.
 */
export function allowedTools(agent: AgentKind, entity?: Entity): ReadonlySet<string> {
  const base: string[] = [...SANDBOX_TOOLS, ...SKILL_TOOLS];
  switch (agent) {
    case 'triage':
      return new Set([...base, ...TRIAGE_TOOLS, 'task']);
    case 'investigator':
    case 'investigator_deep': {
      const tools = [...base, ...INVESTIGATOR_TOOLS, 'finish'];
      if (entity === 'ssfb') tools.push(...SSFB_EXTRA_TOOLS);
      if (agent === 'investigator_deep') tools.push(...CODE_TOOLS);
      return new Set(tools);
    }
    case 'code_walker':
      return new Set([...base, ...CODE_TOOLS, 'note_evidence', 'finish']);
  }
}

/** Delegate names the orchestrator may task (HLD §1). */
export function delegateNames(entities: readonly Entity[] = ENTITIES): string[] {
  return [...entities.flatMap((e) => [`investigate_${e}`, `investigate_${e}_deep`]), 'code_walker'];
}

/**
 * Known tool names mentioned in text. snake_case names match as whole words
 * anywhere; one-word names (read, task, grep, ...) only inside backticks,
 * because they are ordinary English words.
 */
export function mentionedTools(text: string): string[] {
  const found = new Set<string>();
  for (const tool of KNOWN_TOOLS) {
    const re = tool.includes('_')
      ? new RegExp(`(?<![A-Za-z0-9_])${tool}(?![A-Za-z0-9_])`)
      : new RegExp('`' + tool + '`');
    if (re.test(text)) found.add(tool);
  }
  return [...found].sort();
}

/** Known tools mentioned in text that the agent does not have. */
export function toolsOutside(text: string, agent: AgentKind, entity?: Entity): string[] {
  const allowed = allowedTools(agent, entity);
  return mentionedTools(text).filter((t) => !allowed.has(t));
}

// ------------------------------------------------------------- method docs

/** knowledge/method files each agent's instruction is built from (README). */
export function methodFilesFor(agent: AgentKind, entity?: Entity): string[] {
  switch (agent) {
    case 'triage':
      return ['orchestrator.md', 'brief-template.md', 'report-format.md'];
    case 'investigator':
    case 'investigator_deep':
      return entity ? ['investigator.md', 'logs.md', `logs-${entity}.md`] : ['investigator.md', 'logs.md'];
    case 'code_walker':
      return ['code-walker.md'];
  }
}
