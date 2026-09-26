// The registry files as the catalog sees them: resources/<entity>.entity.json
// and resources/repos.json, read from disk on every call.
//
// This never goes through loadRegistry/buildRegistry. Those also check that
// every env key the registry names is in the boot-time .env, and would throw
// for a service added since boot whose key the operator has only just put in
// the .env. The catalog needs the file contents, not a working registry.
//
// Writers keep the files' hand-written layout, so a change shows up as a few
// added lines in a diff rather than the whole file reflowed.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';
import type { Config } from '../../config/env.ts';
import { EntityRegistrySchema, envNamesOf, type EntityRegistry, registryFile } from '../../config/registry.ts';
import { REPOS_FILE, ReposFileSchema } from '../../config/repos.ts';
import { ENTITIES, type Entity } from '../../types/core.ts';

export class CatalogFileError extends Error {
  override readonly name = 'CatalogFileError';
  /** Relative label such as resources/rtl.entity.json. Never an absolute path. */
  readonly file: string;

  constructor(file: string, reason: string) {
    super(`${file} ${reason}`);
    this.file = file;
  }
}

export type RegistryDoc = {
  readonly entity: Entity;
  /** Relative label, for example resources/rtl.entity.json. */
  readonly label: string;
  /** The file text exactly as read, to detect a change before writing. */
  readonly text: string;
  /** The parsed JSON as it is in the file, key order kept. */
  readonly raw: Record<string, unknown>;
  readonly spec: EntityRegistry;
};

export function registryLabel(entity: Entity): string {
  return `resources/${registryFile(entity)}`;
}

export const REPOS_LABEL = `resources/${REPOS_FILE}`;

/**
 * Reads and schema-checks one entity file. undefined when the file does not
 * exist; CatalogFileError when it is not valid JSON or fails the schema.
 */
export function readRegistryDoc(resourcesDir: string, entity: Entity): RegistryDoc | undefined {
  const label = registryLabel(entity);
  let text: string;
  try {
    text = readFileSync(join(resourcesDir, registryFile(entity)), 'utf8');
  } catch {
    return undefined;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new CatalogFileError(label, 'is not valid JSON');
  }
  const parsed = v.safeParse(EntityRegistrySchema, raw);
  if (!parsed.success || parsed.output.entity !== entity) throw new CatalogFileError(label, 'does not match the registry schema');
  return { entity, label, text, raw: raw as Record<string, unknown>, spec: parsed.output };
}

/** Every entity file that exists, in ENTITIES order. */
export function readRegistryDocs(resourcesDir: string): ReadonlyMap<Entity, RegistryDoc> {
  const out = new Map<Entity, RegistryDoc>();
  for (const entity of ENTITIES) {
    const doc = readRegistryDoc(resourcesDir, entity);
    if (doc !== undefined) out.set(entity, doc);
  }
  return out;
}

/**
 * TRIAGE_ENTITIES resolved through ids and aliases, as buildRegistry does,
 * returned in ENTITIES order. Names that resolve to nothing are dropped: the
 * server would not have booted with one, so this only happens if a file
 * changed since boot.
 */
export function enabledEntities(config: Config, docs: ReadonlyMap<Entity, RegistryDoc>): readonly Entity[] {
  const names = new Map<string, Entity>();
  for (const doc of docs.values()) {
    names.set(doc.entity, doc.entity);
    for (const alias of doc.spec.aliases) if (!names.has(alias)) names.set(alias, doc.entity);
  }
  const on = new Set<Entity>();
  for (const raw of config.entities) {
    const entity = names.get(raw.trim().toLowerCase());
    if (entity !== undefined) on.add(entity);
  }
  return ENTITIES.filter((e) => on.has(e));
}

// ------------------------------------------------------------------- repos

export type PinRow = {
  readonly repo: string;
  readonly entities: readonly string[];
  readonly branch?: string;
  readonly remote?: string;
};

export type PinsFile = { readonly text: string; readonly pins: readonly PinRow[] };

/** resources/repos.json, schema-checked. A missing file is an empty list. */
export function readPins(resourcesDir: string): PinsFile {
  let text: string;
  try {
    text = readFileSync(join(resourcesDir, REPOS_FILE), 'utf8');
  } catch {
    return { text: '', pins: [] };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new CatalogFileError(REPOS_LABEL, 'is not valid JSON');
  }
  const parsed = v.safeParse(ReposFileSchema, raw);
  if (!parsed.success) throw new CatalogFileError(REPOS_LABEL, 'does not match the repos schema');
  return { text, pins: parsed.output };
}

/**
 * The pins with entity added to repo's pin, or undefined when that pin
 * already lists it. The repo must have a pin.
 */
export function addEntityToPin(pins: readonly PinRow[], repo: string, entity: Entity): PinRow[] | undefined {
  const at = pins.findIndex((p) => p.repo === repo);
  const pin = pins[at];
  if (pin === undefined) throw new CatalogFileError(REPOS_LABEL, `has no pin for ${repo}`);
  if (pin.entities.includes(entity)) return undefined;
  const out = [...pins];
  out[at] = { ...pin, entities: [...pin.entities, entity] };
  return out;
}

/** repos.json in its hand-written layout: one pin per line. */
export function formatPins(pins: readonly PinRow[]): string {
  if (pins.length === 0) return '[]\n';
  const line = (p: PinRow): string => {
    const parts = [`"repo": ${JSON.stringify(p.repo)}`, `"entities": ${inlineArray(p.entities)}`];
    if (p.branch !== undefined) parts.push(`"branch": ${JSON.stringify(p.branch)}`);
    if (p.remote !== undefined) parts.push(`"remote": ${JSON.stringify(p.remote)}`);
    return `  { ${parts.join(', ')} }`;
  };
  return `[\n${pins.map(line).join(',\n')}\n]\n`;
}

// --------------------------------------------------------------- services

export type NewService = {
  readonly key: string;
  readonly db?: string;
  readonly api?: string;
  readonly quickwit_service?: string;
  readonly repo: string;
  readonly note?: string;
};

/**
 * The entity document with the service appended, re-validated the way the
 * boot does (schema, then every env name under the entity's prefix), and
 * its file text. Throws CatalogFileError if the result would not load.
 */
export function withService(doc: RegistryDoc, service: NewService): { raw: Record<string, unknown>; text: string } {
  const spec: Record<string, string> = {};
  // Key order matches the existing entries: db, api, quickwit_service, repo, note.
  if (service.db !== undefined) spec['db'] = service.db;
  if (service.api !== undefined) spec['api'] = service.api;
  if (service.quickwit_service !== undefined) spec['quickwit_service'] = service.quickwit_service;
  spec['repo'] = service.repo;
  if (service.note !== undefined) spec['note'] = service.note;

  const services = doc.raw['services'];
  if (typeof services !== 'object' || services === null || Array.isArray(services)) {
    throw new CatalogFileError(doc.label, 'has no services map');
  }
  if (Object.hasOwn(services, service.key)) throw new CatalogFileError(doc.label, `already has service ${service.key}`);
  const raw = { ...doc.raw, services: { ...(services as Record<string, unknown>), [service.key]: spec } };

  const parsed = v.safeParse(EntityRegistrySchema, raw);
  if (!parsed.success) throw new CatalogFileError(doc.label, 'would not match the registry schema');
  const prefix = `${doc.entity.toUpperCase()}_`;
  if (envNamesOf(parsed.output).some((name) => !name.startsWith(prefix))) {
    throw new CatalogFileError(doc.label, `would name a key outside ${prefix}`);
  }
  return { raw, text: formatEntityDoc(raw) };
}

/**
 * An entity file in its hand-written layout: two-space indent, arrays of
 * plain values and small flat objects on one line, but the top level, the
 * services map and each service always one key per line. The test checks
 * that it reproduces the repo's resources/*.entity.json byte for byte.
 */
export function formatEntityDoc(doc: Record<string, unknown>): string {
  return `${format(doc, 0, [])}\n`;
}

function format(value: unknown, depth: number, path: readonly string[]): string {
  if (Array.isArray(value)) {
    if (value.every(isPlain)) return inlineArray(value);
    const pad = '  '.repeat(depth + 1);
    return `[\n${value.map((x) => pad + format(x, depth + 1, path)).join(',\n')}\n${'  '.repeat(depth)}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value);
    if (entries.length === 0) return '{}';
    const alwaysOpen = depth === 0 || (path[0] === 'services' && path.length <= 2);
    if (!alwaysOpen && entries.every(([, x]) => isPlain(x) || (Array.isArray(x) && x.every(isPlain)))) {
      return `{ ${entries.map(([k, x]) => `${JSON.stringify(k)}: ${format(x, depth + 1, [...path, k])}`).join(', ')} }`;
    }
    const pad = '  '.repeat(depth + 1);
    const body = entries.map(([k, x]) => `${pad}${JSON.stringify(k)}: ${format(x, depth + 1, [...path, k])}`);
    return `{\n${body.join(',\n')}\n${'  '.repeat(depth)}}`;
  }
  return JSON.stringify(value);
}

function isPlain(x: unknown): boolean {
  return x === null || typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean';
}

function inlineArray(xs: readonly unknown[]): string {
  return xs.length === 0 ? '[]' : `[${xs.map((x) => JSON.stringify(x)).join(', ')}]`;
}
