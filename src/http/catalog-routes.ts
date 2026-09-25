// The service registry and knowledge guides over HTTP, for the web console.
//
//   GET  /services        registry services of each enabled entity, with the
//                         env key NAMES they use (never values) and whether
//                         each is set, blank or missing in the .env right now.
//   POST /services        adds a service to resources/<entity>.entity.json,
//                         adds the entity to the repo's pin in repos.json
//                         when needed, and by default writes a stub guide.
//   GET  /guides          every knowledge skill, with counts by status.
//   GET  /guides/:name    one skill with its markdown body.
//   POST /guides          writes knowledge/<name>/SKILL.md for a service or
//                         an entity overview.
//
// Reads go to disk on every request so a just-written item shows up. The
// agents load the registry and knowledge once at boot, so they only see a
// change after a restart; the module remembers what this process wrote and
// marks those rows pending_restart.
//
// Writes go straight to the files under TRIAGE_HOME (no pull request, by
// decision). They are serialised in this process, validated in full before
// anything is written, never overwrite an existing file, and replace a file
// only through a temp file and a rename. A bad registry or SKILL.md would
// stop the next boot, so each new file is re-validated the way the boot
// reads it before it is written.

import { chmod, mkdir, readFile, rmdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import * as v from 'valibot';
import { SKILL_FILE } from '../agents/skills.ts';
import { envFileKeyState, type Config } from '../config/env.ts';
import { RegistryEnvNameSchema, RepoNameSchema } from '../config/registry.ts';
import { REPOS_FILE } from '../config/repos.ts';
import {
  dirExistsAnywhere,
  GUIDE_STATUSES,
  type GuideInfo,
  type GuideStatus,
  listGuides,
  renderSkill,
  type SkillInput,
  stubBody,
  stubDescription,
  supportingFiles,
  validateRendered,
} from '../ops/catalog/guides.ts';
import {
  addEntityToPin,
  enabledEntities,
  formatPins,
  readPins,
  readRegistryDocs,
  REPOS_LABEL,
  withService,
} from '../ops/catalog/registry.ts';
import {
  EGRESS_REASON,
  egressHits,
  isSkillName,
  MAX_DESCRIPTION,
  MAX_QUICKWIT_SERVICE,
  oneLineProblem,
  QUICKWIT_SERVICE,
  safeJoin,
  serviceKeyProblem,
} from '../ops/catalog/validate.ts';
import { createExclusive, hasCode, writeFileAtomic } from '../runstore/atomic.ts';
import { ENTITIES, type Entity } from '../types/core.ts';

export const MAX_CATALOG_BODY_BYTES = 256 * 1024;
export const MAX_NOTE = 500;
export const MAX_SOURCES = 500;
export const MAX_GUIDE_BODY = 100_000;

const MISSING_ENV_REASON =
  'is not in the .env; add it (a blank value is fine) first, because the server will not boot while the registry names a key the .env lacks';
const FILE_CHANGED = 'file changed on disk, reload and retry';

export type CatalogRouteDeps = {
  readonly config: () => Config;
};

export type EnvKeyState = 'set' | 'blank' | 'missing';
export type EnvKeyRef = { readonly name: string; readonly state: EnvKeyState };

type Problem = { readonly field: string; readonly reason: string };

class FileChangedError extends Error {
  override readonly name = 'FileChangedError';
}

export function createCatalogRoutes(deps: CatalogRouteDeps): Hono {
  const app = new Hono();
  // What this process wrote: 'service:<entity>:<key>' and 'guide:<name>'.
  const written = new Set<string>();
  const serial = mutex();
  const limit = bodyLimit({
    maxSize: MAX_CATALOG_BODY_BYTES,
    onError: (c) => c.json({ error: 'body too large' }, 413),
  });

  app.onError((err, c) => {
    console.error(`triage http: ${c.req.method} ${c.req.routePath} failed (${err instanceof Error ? err.name : 'error'})`);
    return c.json({ error: 'internal error' }, 500);
  });

  app.get('/services', (c) => {
    const config = deps.config();
    const docs = readRegistryDocs(config.paths.resourcesDir);
    const guides = guideIndex(listGuides(config.paths.knowledgeDir));
    const env = envStates(config);
    const entities = enabledEntities(config, docs).map((entity) => {
      const spec = (docs.get(entity) as NonNullable<ReturnType<typeof docs.get>>).spec;
      const services = Object.entries(spec.services).map(([key, s]) => {
        const guide = guides.get(`${entity}-${key}`);
        return {
          key,
          repo: s.repo ?? null,
          quickwit_service: s.quickwit_service ?? null,
          db_env: s.db === undefined ? null : env(s.db),
          api_env: s.api === undefined ? null : env(s.api),
          transport: s.transport ?? null,
          note: s.note ?? null,
          guide: guide === undefined ? null : { name: guide.name, status: guide.status },
          pending_restart: written.has(`service:${entity}:${key}`),
        };
      });
      return { entity, services };
    });
    const repos = readPins(config.paths.resourcesDir).pins.map((p) => ({
      repo: p.repo,
      entities: p.entities,
      ...(p.branch !== undefined ? { branch: p.branch } : {}),
    }));
    return c.json({ restart_required: written.size > 0, entities, repos });
  });

  app.post('/services', limit, async (c) => {
    const body = await readBody(c);
    if (body === NOT_JSON) return invalid(c, [{ field: 'body', reason: 'is not valid JSON' }]);
    if (!isObject(body)) return invalid(c, [{ field: 'body', reason: 'must be a JSON object' }]);
    return serial(() => addService(c, body));
  });

  app.get('/guides', (c) => {
    const config = deps.config();
    const guides = listGuides(config.paths.knowledgeDir);
    const counts = { total: guides.length, ported: 0, written: 0, stub: 0 };
    for (const g of guides) if (g.status !== null) counts[g.status]++;
    return c.json({ restart_required: written.size > 0, counts, guides: guides.map(guideRow) });
  });

  app.get('/guides/:name', (c) => {
    const name = c.req.param('name');
    if (!isSkillName(name)) return invalid(c, [{ field: 'name', reason: 'must be lowercase letters, digits and single hyphens, at most 64 characters' }]);
    const guide = listGuides(deps.config().paths.knowledgeDir).find((g) => g.name === name);
    if (guide === undefined) return c.json({ error: 'guide not found' }, 404);
    return c.json({ ...guideRow(guide), body: guide.body, files: supportingFiles(guide.dir) });
  });

  app.post('/guides', limit, async (c) => {
    const body = await readBody(c);
    if (body === NOT_JSON) return invalid(c, [{ field: 'body', reason: 'is not valid JSON' }]);
    if (!isObject(body)) return invalid(c, [{ field: 'body', reason: 'must be a JSON object' }]);
    return serial(() => addGuide(c, body));
  });

  function guideRow(g: GuideInfo) {
    return {
      name: g.name,
      kind: g.kind,
      entity: g.entity,
      service: g.service,
      status: g.status,
      description: g.description,
      sources: g.sources,
      pending_restart: written.has(`guide:${g.name}`),
      ...(g.problem !== undefined ? { problem: g.problem } : {}),
    };
  }

  // ------------------------------------------------------------ POST /services

  async function addService(c: Context, body: Record<string, unknown>): Promise<Response> {
    const config = deps.config();
    const { resourcesDir, knowledgeDir } = config.paths;
    const docs = readRegistryDocs(resourcesDir);
    const enabled = enabledEntities(config, docs);
    const pinsFile = readPins(resourcesDir);

    const problems: Problem[] = unknownFields(body, [
      'entity', 'key', 'repo', 'quickwit_service', 'db_env', 'api_env', 'note', 'create_guide', 'guide_description',
    ]);
    const bad = (field: string, reason: string): void => void problems.push({ field, reason });

    const entity = body['entity'];
    const entityOk = typeof entity === 'string' && (enabled as readonly string[]).includes(entity) && docs.has(entity as Entity);
    if (!entityOk) bad('entity', `must be one of the enabled entities: ${enabled.join(', ')}`);

    const key = body['key'];
    if (typeof key !== 'string') bad('key', 'must be a string');
    else {
      const why = serviceKeyProblem(key);
      if (why !== undefined) bad('key', why);
    }

    const repo = body['repo'];
    if (typeof repo !== 'string' || !v.is(RepoNameSchema, repo)) bad('repo', 'must be a plain repo name');
    else if (!pinsFile.pins.some((p) => p.repo === repo)) bad('repo', `is not in ${REPOS_LABEL}; add the repo there first`);

    const quickwit = optionalText(body, 'quickwit_service', problems);
    if (quickwit !== undefined && (quickwit.length > MAX_QUICKWIT_SERVICE || !QUICKWIT_SERVICE.test(quickwit))) {
      bad('quickwit_service', `must be 1 to ${MAX_QUICKWIT_SERVICE} letters, digits, dots, dashes or underscores`);
    }

    const warnings: string[] = [];
    const envKey = (field: 'db_env' | 'api_env', what: string): string | undefined => {
      const name = optionalText(body, field, problems);
      if (name === undefined) return undefined;
      const prefix = entityOk ? `${(entity as string).toUpperCase()}_` : undefined;
      if (!v.is(RegistryEnvNameSchema, name) || (prefix !== undefined && !name.startsWith(prefix))) {
        bad(field, `must be an env key name starting with ${prefix ?? 'the entity prefix'}, such as ${prefix ?? 'RTL_'}BILLING_DB_URL`);
        return undefined;
      }
      if (prefix === undefined) return undefined;
      const state = keyState(config, name);
      if (state === 'missing') bad(field, MISSING_ENV_REASON);
      else if (state === 'blank') warnings.push(`${name} is blank in the .env; the investigator skips this ${what} until it is set`);
      return name;
    };
    const db = envKey('db_env', 'database');
    const api = envKey('api_env', 'API');

    const note = optionalText(body, 'note', problems);
    if (note !== undefined) {
      const why = oneLineProblem(note, MAX_NOTE);
      if (why !== undefined) bad('note', why);
    }

    const createGuide = body['create_guide'] ?? true;
    if (typeof createGuide !== 'boolean') bad('create_guide', 'must be true or false');
    const guideDescription = optionalText(body, 'guide_description', problems);
    if (guideDescription !== undefined) {
      const why = oneLineProblem(guideDescription, MAX_DESCRIPTION, 1);
      if (why !== undefined) bad('guide_description', why);
    }

    if (problems.length > 0) return invalid(c, problems);
    const e = entity as Entity;
    const k = key as string;
    const r = repo as string;

    const hits = egressHits({ key: k, quickwit_service: quickwit, note, guide_description: guideDescription });
    if (hits.length > 0) return invalid(c, hits.map((field) => ({ field, reason: EGRESS_REASON })));

    const doc = docs.get(e) as NonNullable<ReturnType<typeof docs.get>>;
    if (Object.hasOwn(doc.spec.services, k)) return c.json({ error: 'service exists', fields: ['key'] }, 409);
    const guideName = `${e}-${k}`;
    if (createGuide === true && dirExistsAnywhere(knowledgeDir, guideName)) {
      return c.json({ error: 'guide exists', fields: ['key'] }, 409);
    }

    const next = withService(doc, {
      key: k,
      repo: r,
      ...(db !== undefined ? { db } : {}),
      ...(api !== undefined ? { api } : {}),
      ...(quickwit !== undefined ? { quickwit_service: quickwit } : {}),
      ...(note !== undefined ? { note } : {}),
    });
    const nextPins = addEntityToPin(pinsFile.pins, r, e);

    let guideText: string | undefined;
    if (createGuide === true) {
      const input: SkillInput = {
        name: guideName,
        description: guideDescription ?? stubDescription(e, k),
        kind: 'service',
        entity: e,
        service: k,
        status: 'stub',
        body: stubBody(e, k, r),
      };
      guideText = renderSkill(input);
      const why = validateRendered(guideText, input);
      if (why !== undefined) return invalid(c, [{ field: 'guide_description', reason: why }]);
      if (!checkEgressText(guideText)) return invalid(c, [{ field: 'key', reason: EGRESS_REASON }]);
    }

    // Writes. Nothing above touched the disk.
    const files: { path: string; action: 'created' | 'updated' }[] = [];
    let guideDir: string | undefined;
    if (guideText !== undefined) {
      const made = await createGuideFile(knowledgeDir, guideName, guideText);
      if (made === 'exists') return c.json({ error: 'guide exists', fields: ['key'] }, 409);
      guideDir = made;
      files.push({ path: `knowledge/${guideName}/${SKILL_FILE}`, action: 'created' });
    }
    const entityPath = join(resourcesDir, `${e}.entity.json`);
    let entityWritten = false;
    try {
      await replaceIfUnchanged(entityPath, doc.text, next.text);
      entityWritten = true;
      files.push({ path: doc.label, action: 'updated' });
      if (nextPins !== undefined) {
        await replaceIfUnchanged(join(resourcesDir, REPOS_FILE), pinsFile.text, formatPins(nextPins));
        files.push({ path: REPOS_LABEL, action: 'updated' });
      }
    } catch (err) {
      // Put back what this request changed so the next boot sees the files
      // as they were, then report. Best effort: a failure here leaves the
      // original error as the one reported.
      if (entityWritten) await writeFileAtomic(entityPath, doc.text).catch(() => {});
      if (guideDir !== undefined) await removeGuideFile(guideDir);
      if (err instanceof FileChangedError) return c.json({ error: FILE_CHANGED }, 409);
      throw err;
    }

    written.add(`service:${e}:${k}`);
    if (guideText !== undefined) written.add(`guide:${guideName}`);
    return c.json({ entity: e, key: k, files, warnings, restart_required: true }, 201);
  }

  // -------------------------------------------------------------- POST /guides

  async function addGuide(c: Context, body: Record<string, unknown>): Promise<Response> {
    const config = deps.config();
    const { resourcesDir, knowledgeDir } = config.paths;
    const docs = readRegistryDocs(resourcesDir);

    const problems: Problem[] = unknownFields(body, ['kind', 'entity', 'service', 'description', 'sources', 'status', 'body']);
    const bad = (field: string, reason: string): void => void problems.push({ field, reason });

    const kind = body['kind'];
    if (kind !== 'service' && kind !== 'overview') bad('kind', 'must be service or overview; other guides are not created here');

    const entity = body['entity'];
    const entityOk = typeof entity === 'string' && (ENTITIES as readonly string[]).includes(entity) && docs.has(entity as Entity);
    if (!entityOk) bad('entity', `must be an entity with a registry file: ${[...docs.keys()].join(', ')}`);

    const service = body['service'];
    if (kind === 'service') {
      if (typeof service !== 'string' || service === '') bad('service', 'is required for a service guide');
      else if (!/^[a-z0-9]+$/.test(service) || service === 'overview') {
        bad('service', 'must be a registry service key made of lowercase letters and digits');
      } else if (entityOk && !Object.hasOwn((docs.get(entity as Entity) as NonNullable<ReturnType<typeof docs.get>>).spec.services, service)) {
        bad('service', `is not a service in resources/${String(entity)}.entity.json`);
      }
    } else if (kind === 'overview' && service !== undefined) {
      bad('service', 'must be left out for an overview');
    }

    const descriptionRaw = body['description'];
    const description = typeof descriptionRaw === 'string' ? descriptionRaw.trim() : undefined;
    if (description === undefined) bad('description', 'must be a string');
    else {
      const why = oneLineProblem(description, MAX_DESCRIPTION, 1);
      if (why !== undefined) bad('description', why);
    }

    const sources = optionalText(body, 'sources', problems);
    if (sources !== undefined) {
      const why = oneLineProblem(sources, MAX_SOURCES);
      if (why !== undefined) bad('sources', why);
    }

    const status = body['status'];
    if (typeof status !== 'string' || !(GUIDE_STATUSES as readonly string[]).includes(status)) {
      bad('status', `must be one of ${GUIDE_STATUSES.join(', ')}`);
    }

    const text = body['body'];
    if (typeof text !== 'string' || text.trim() === '') bad('body', 'must not be empty');
    else if (text.length > MAX_GUIDE_BODY) bad('body', `must be at most ${MAX_GUIDE_BODY} characters`);

    if (problems.length > 0) return invalid(c, problems);

    const e = entity as Entity;
    const name = kind === 'overview' ? `${e}-overview` : `${e}-${service as string}`;
    if (!isSkillName(name)) return invalid(c, [{ field: kind === 'overview' ? 'entity' : 'service', reason: 'makes a guide name that is too long' }]);

    const hits = egressHits({ description, sources, body: text as string });
    if (hits.length > 0) return invalid(c, hits.map((field) => ({ field, reason: EGRESS_REASON })));

    if (dirExistsAnywhere(knowledgeDir, name)) return c.json({ error: 'guide exists', fields: ['name'] }, 409);

    const input: SkillInput = {
      name,
      description: description as string,
      kind: kind as 'service' | 'overview',
      entity: e,
      ...(kind === 'service' ? { service: service as string } : {}),
      ...(sources !== undefined ? { sources } : {}),
      status: status as GuideStatus,
      body: (text as string).trim(),
    };
    const rendered = renderSkill(input);
    const why = validateRendered(rendered, input);
    if (why !== undefined) return invalid(c, [{ field: 'body', reason: why }]);

    const made = await createGuideFile(knowledgeDir, name, rendered);
    if (made === 'exists') return c.json({ error: 'guide exists', fields: ['name'] }, 409);
    written.add(`guide:${name}`);
    return c.json({ name, file: `knowledge/${name}/${SKILL_FILE}`, restart_required: true }, 201);
  }

  return app;
}

// ------------------------------------------------------------------ writing

/**
 * Creates <knowledgeDir>/<name>/SKILL.md. The directory itself must not
 * exist: a directory without a SKILL.md is a group the loader searches, and
 * writing into it would change what else it finds. mkdir without recursive
 * is the claim, so two writers cannot both get the directory. Returns the
 * directory, or 'exists'.
 */
async function createGuideFile(knowledgeDir: string, name: string, text: string): Promise<string | 'exists'> {
  const dir = safeJoin(knowledgeDir, name);
  if (dir === undefined) throw new Error('guide path escapes the knowledge dir');
  await mkdir(knowledgeDir, { recursive: true });
  try {
    await mkdir(dir);
  } catch (err) {
    if (hasCode(err, 'EEXIST')) return 'exists';
    throw err;
  }
  const file = join(dir, SKILL_FILE);
  let created: boolean;
  try {
    created = await createExclusive(file, text);
  } catch (err) {
    await rmdir(dir).catch(() => {});
    throw err;
  }
  if (!created) return 'exists';
  // createExclusive makes 0600 files; knowledge files are ordinary readable files.
  await chmod(file, 0o644);
  return dir;
}

/** Undoes createGuideFile. rmdir refuses a non-empty dir, so nothing else is removed. */
async function removeGuideFile(dir: string): Promise<void> {
  await unlink(join(dir, SKILL_FILE)).catch(() => {});
  await rmdir(dir).catch(() => {});
}

/**
 * Replaces path with next if it still holds expected. The re-read narrows,
 * but cannot close, the window for an edit made by hand between the read
 * and the rename; a lock the operator's editor does not take would not
 * close it either.
 */
async function replaceIfUnchanged(path: string, expected: string, next: string): Promise<void> {
  let current: string;
  try {
    current = await readFile(path, 'utf8');
  } catch (err) {
    if (hasCode(err, 'ENOENT')) throw new FileChangedError('file is gone');
    throw err;
  }
  if (current !== expected) throw new FileChangedError('file changed');
  const mode = (await stat(path)).mode & 0o777;
  await writeFileAtomic(path, next);
  // The temp file behind the rename is 0600; keep the file's own mode.
  await chmod(path, mode);
}

// ------------------------------------------------------------------ helpers

function guideIndex(guides: readonly GuideInfo[]): Map<string, GuideInfo> {
  const out = new Map<string, GuideInfo>();
  for (const g of guides) if (!out.has(g.name)) out.set(g.name, g);
  return out;
}

/** Env key state per name, read once per request. */
function envStates(config: Config): (name: string) => EnvKeyRef {
  const cache = new Map<string, EnvKeyState>();
  return (name) => {
    let state = cache.get(name);
    if (state === undefined) {
      state = keyState(config, name);
      cache.set(name, state);
    }
    return { name, state };
  };
}

// envFileKeyState refuses config-table keys and non-entity names; either
// means the key cannot be a registry key, so it counts as missing.
function keyState(config: Config, name: string): EnvKeyState {
  try {
    return envFileKeyState(config, name);
  } catch {
    return 'missing';
  }
}

function checkEgressText(text: string): boolean {
  return egressHits({ text }).length === 0;
}

/**
 * An optional string field, trimmed. An empty string counts as left out, so
 * a form can send blank inputs as they are.
 */
function optionalText(body: Record<string, unknown>, field: string, problems: Problem[]): string | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    problems.push({ field, reason: 'must be a string' });
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function unknownFields(body: Record<string, unknown>, known: readonly string[]): Problem[] {
  return Object.keys(body)
    .filter((k) => !known.includes(k))
    .map((field) => ({ field, reason: 'is not a known field' }));
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/** Runs async work one at a time, in call order. */
function mutex(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => {});
    return run;
  };
}

const NOT_JSON = Symbol('not json');

async function readBody(c: Context): Promise<unknown> {
  const text = await c.req.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return NOT_JSON;
  }
}

// Names fields only; a reason never repeats the submitted value.
function invalid(c: Context, problems: readonly Problem[]): Response {
  const fields = [...new Set(problems.map((p) => p.field))];
  const reason = problems[0]?.reason;
  return c.json({ error: 'invalid request', fields, ...(reason !== undefined ? { reason } : {}) }, 400);
}
