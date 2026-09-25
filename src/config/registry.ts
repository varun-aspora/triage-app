// Entity registry: resources/<entity>.entity.json maps each service to the env
// names that hold its DSN, base URL and credentials, plus Quickwit, CBS, kube
// and repo structure (HLD §4.2, D5), and the key naming this deployment's
// deploy manifests repo.
//
// Rules this module keeps:
// - Env values are read only through lookupEnv and are held in a closure.
//   Capability objects carry a value as a non-enumerable property, so
//   JSON.stringify and util.inspect of a capability never show it.
// - For an enabled entity, a referenced env name missing from the .env, or a
//   malformed value for a key with a fixed format, is a startup RegistryError.
//   A blank value only disables that capability.
// - Errors and capabilityReport name keys, never values.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';
import { ENTITIES, type Entity } from '../types/core.ts';
import { lookupEnv, type Config, type EnvLookup } from './env.ts';

// ------------------------------------------------------------------ schema

const ENTITY_PREFIX = /^(SSFB|ATSPL|RTL)_[A-Z0-9_]+$/;

export const RegistryEnvNameSchema = v.pipe(
  v.string(),
  v.regex(ENTITY_PREFIX, 'must be an entity env name such as SSFB_HARBOR_DB_URL'),
);

export const RepoNameSchema = v.pipe(
  v.string(),
  v.regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'must be a plain repo name'),
);
export type RepoName = v.InferOutput<typeof RepoNameSchema>;

export const ServiceNameSchema = v.pipe(v.string(), v.regex(/^[a-z][a-z0-9_]*$/, 'must be lowercase'));

const HeaderNameSchema = v.pipe(v.string(), v.regex(/^[A-Za-z0-9-]+$/, 'must be an HTTP header name'));

export const ServiceAuthSchema = v.strictObject({
  header: HeaderNameSchema,
  scheme: v.picklist(['Bearer', 'Basic']),
  token_env: RegistryEnvNameSchema,
});
export type ServiceAuth = v.InferOutput<typeof ServiceAuthSchema>;

export const FieldEncryptionSchema = v.strictObject({
  algorithm: v.literal('aes-siv'),
  key_env: RegistryEnvNameSchema,
});
export type FieldEncryption = v.InferOutput<typeof FieldEncryptionSchema>;

export const ServiceSpecSchema = v.pipe(
  v.strictObject({
    db: v.optional(RegistryEnvNameSchema),
    api: v.optional(RegistryEnvNameSchema),
    quickwit_service: v.optional(v.pipe(v.string(), v.minLength(1))),
    repo: v.optional(RepoNameSchema),
    customer_header: v.optional(HeaderNameSchema),
    auth: v.optional(ServiceAuthSchema),
    field_encryption: v.optional(FieldEncryptionSchema),
    transport: v.optional(v.literal('cbs')),
    note: v.optional(v.string()),
  }),
  v.check((s) => s.transport === undefined || s.api !== undefined, 'transport cbs needs an api env name'),
);
export type ServiceSpec = v.InferOutput<typeof ServiceSpecSchema>;

export const QuickwitSpecSchema = v.strictObject({
  transport: RegistryEnvNameSchema,
  index: RegistryEnvNameSchema,
  max_concurrency: v.optional(RegistryEnvNameSchema),
  max_hits: v.optional(RegistryEnvNameSchema),
  http: v.optional(
    v.strictObject({
      url: RegistryEnvNameSchema,
      auth: RegistryEnvNameSchema,
      token: v.optional(RegistryEnvNameSchema),
    }),
  ),
  qw: v.optional(v.strictObject({ context: RegistryEnvNameSchema })),
});
export type QuickwitSpec = v.InferOutput<typeof QuickwitSpecSchema>;

export const EntityRegistrySchema = v.strictObject({
  entity: v.picklist(ENTITIES),
  aliases: v.array(v.pipe(v.string(), v.regex(/^[a-z][a-z0-9_-]*$/, 'must be lowercase'))),
  services: v.record(ServiceNameSchema, ServiceSpecSchema),
  quickwit_fields: v.array(v.pipe(v.string(), v.regex(/^[A-Za-z0-9_.-]+$/, 'must be a field name'))),
  quickwit: QuickwitSpecSchema,
  cbs: v.optional(v.strictObject({ enabled_flag: RegistryEnvNameSchema })),
  kube: v.strictObject({ context_env: RegistryEnvNameSchema, aws_profile_env: RegistryEnvNameSchema }),
  repos_extra: v.optional(v.array(RepoNameSchema)),
  /** Env name whose value is `repo` or `repo:path`: the deploy manifests this deployment reads. */
  infra_repo: v.optional(RegistryEnvNameSchema),
});
export type EntityRegistry = v.InferOutput<typeof EntityRegistrySchema>;

// ------------------------------------------------------------------ errors

export type RegistryProblem = { readonly key: string; readonly reason: string };

/** Startup error for the registry. Names keys and files, never env values. */
export class RegistryError extends Error {
  override readonly name = 'RegistryError';
  readonly keys: readonly string[];
  readonly problems: readonly RegistryProblem[];

  constructor(problems: readonly RegistryProblem[]) {
    const list = problems.length > 0 ? problems : [{ key: 'registry', reason: 'invalid' }];
    super(`invalid registry: ${list.map((p) => `${p.key} ${p.reason}`).join('; ')}`);
    this.problems = Object.freeze(list.map((p) => Object.freeze({ key: p.key, reason: p.reason })));
    this.keys = Object.freeze([...new Set(list.map((p) => p.key))]);
  }

  static of(key: string, reason: string): RegistryError {
    return new RegistryError([{ key, reason }]);
  }
}

// ------------------------------------------------------------ capabilities

/**
 * One env-backed capability. On 'ok', `value` is a non-enumerable property:
 * read it with `cap.value`; spreading or serialising the object drops it.
 */
export type Capability =
  | { readonly status: 'ok'; readonly envName: string; readonly value: string }
  | { readonly status: 'disabled'; readonly envName: string; readonly reason: 'blank' };

/** 'cbs' means the base URL is reachable only through cbs_call, never http_call. */
export type ApiCapability = Capability & { readonly transport: 'http' | 'cbs' };
export type AuthCapability = Capability & { readonly header: string; readonly scheme: 'Bearer' | 'Basic' };
export type FieldEncryptionCapability = Capability & { readonly algorithm: 'aes-siv' };
export type KubeCapability = { readonly context: Capability; readonly awsProfile: Capability };

/**
 * The deploy manifests repo from <ENTITY>_INFRA_REPO. `path` is '.' for the
 * repo root. Not a credential, so nothing is hidden.
 */
export type InfraRepoCapability =
  | { readonly status: 'ok'; readonly envName: string; readonly repo: string; readonly path: string }
  | { readonly status: 'disabled'; readonly envName: string; readonly reason: 'blank' };

export type QuickwitAuth = 'none' | 'bearer';
type QuickwitCommon = { readonly status: 'ok'; readonly index: string; readonly maxConcurrency: number; readonly maxHits: number };

/** On http, `url` and `token` are non-enumerable, like Capability.value. */
export type QuickwitCapability =
  | (QuickwitCommon & { readonly transport: 'qw'; readonly context: string })
  | (QuickwitCommon & { readonly transport: 'http'; readonly url: string; readonly auth: QuickwitAuth; readonly token?: string })
  | { readonly status: 'disabled'; readonly reason: string; readonly envNames: readonly string[] };

export const QUICKWIT_DEFAULT_MAX_CONCURRENCY = 1;
export const QUICKWIT_DEFAULT_MAX_HITS = 500;

export type CapabilityStatus = 'ok' | 'blank' | 'missing' | 'invalid' | 'disabled';
export type CapabilityKind = 'db' | 'api' | 'auth' | 'field_encryption' | 'quickwit' | 'cbs' | 'kube_context' | 'aws_profile' | 'infra_repo';

export type CapabilityRow = {
  readonly capability: CapabilityKind;
  readonly service?: string;
  readonly envNames: readonly string[];
  readonly status: CapabilityStatus;
  /** Fixed text naming keys only. */
  readonly reason?: string;
};

export type CapabilityReport = {
  readonly entity: Entity;
  readonly enabled: boolean;
  readonly rows: readonly CapabilityRow[];
};

export type Registry = {
  /** Every entity with a registry file, in ENTITIES order. */
  readonly entities: readonly Entity[];
  resolveEntity(aliasOrId: string): Entity | undefined;
  /** TRIAGE_ENTITIES, narrowed by hints. Hints never add an entity. No hints (or []) means all enabled. */
  enabledEntities(hints?: readonly string[]): readonly Entity[];
  isEnabled(entity: Entity): boolean;
  spec(entity: Entity): EntityRegistry;
  services(entity: Entity): readonly string[];
  service(entity: Entity, service: string): ServiceSpec;
  serviceDb(entity: Entity, service: string): Capability | undefined;
  serviceApi(entity: Entity, service: string): ApiCapability | undefined;
  serviceAuth(entity: Entity, service: string): AuthCapability | undefined;
  fieldEncryption(entity: Entity, service: string): FieldEncryptionCapability | undefined;
  quickwit(entity: Entity): QuickwitCapability;
  quickwitFields(entity: Entity): readonly string[];
  cbsEnabled(entity: Entity): boolean;
  kube(entity: Entity): KubeCapability;
  /** Service repos then repos_extra, deduplicated. */
  repos(entity: Entity): readonly string[];
  /** undefined when the registry names no infra_repo key. */
  infraRepo(entity: Entity): InfraRepoCapability | undefined;
  capabilityReport(entity: Entity): CapabilityReport;
};

export type LoadRegistryOptions = {
  /** Defaults to config.paths.resourcesDir. */
  readonly resourcesDir?: string;
};

// ----------------------------------------------------------------- loading

export function registryFile(entity: Entity): string {
  return `${entity}.entity.json`;
}

/** Reads resources/<entity>.entity.json for every entity and builds the registry. */
export function loadRegistry(config: Config, options: LoadRegistryOptions = {}): Registry {
  const dir = options.resourcesDir ?? config.paths.resourcesDir;
  const problems: RegistryProblem[] = [];
  const docs: { file: string; doc: unknown }[] = [];
  for (const entity of ENTITIES) {
    const key = `resources/${registryFile(entity)}`;
    const file = join(dir, registryFile(entity));
    if (!existsSync(file)) {
      problems.push({ key, reason: 'is missing' });
      continue;
    }
    try {
      docs.push({ file: key, doc: JSON.parse(readFileSync(file, 'utf8')) });
    } catch {
      problems.push({ key, reason: 'is not valid JSON' });
    }
  }
  if (problems.length > 0) throw new RegistryError(problems);
  return buildRegistry(config, docs);
}

/** Pure part of loadRegistry, for tests and callers that already hold the documents. */
export function buildRegistry(config: Config, docs: readonly { file: string; doc: unknown }[]): Registry {
  const problems: RegistryProblem[] = [];
  const specs = new Map<Entity, EntityRegistry>();

  for (const { file, doc } of docs) {
    const parsed = v.safeParse(EntityRegistrySchema, doc);
    if (!parsed.success) {
      for (const issue of parsed.issues) {
        problems.push({ key: file, reason: `${v.getDotPath(issue) ?? '(root)'}: ${issue.message}` });
      }
      continue;
    }
    const spec = parsed.output;
    if (specs.has(spec.entity)) {
      problems.push({ key: file, reason: `declares entity ${spec.entity} a second time` });
      continue;
    }
    problems.push(...structureProblems(file, spec));
    specs.set(spec.entity, deepFreeze(spec));
  }
  if (problems.length > 0) throw new RegistryError(problems);

  const names = aliasTable(specs, problems);
  if (problems.length > 0) throw new RegistryError(problems);
  const resolve = (s: string): Entity | undefined => names.get(s.trim().toLowerCase());

  const enabled: Entity[] = [];
  for (const raw of config.entities) {
    const entity = resolve(raw);
    if (entity === undefined) {
      problems.push({ key: 'TRIAGE_ENTITIES', reason: `names an unknown entity; known: ${[...specs.keys()].join(', ')}` });
    } else if (!enabled.includes(entity)) {
      enabled.push(entity);
    }
  }
  if (problems.length > 0) throw new RegistryError(problems);

  // Snapshot every referenced key once. Values stay in this closure.
  const env = new Map<string, EnvLookup>();
  for (const spec of specs.values()) {
    for (const name of envNamesOf(spec)) env.set(name, lookupEnv(config, name));
  }
  const look = (name: string): EnvLookup => env.get(name) ?? { state: 'missing' };

  for (const entity of enabled) {
    const spec = specs.get(entity) as EntityRegistry;
    for (const name of requiredEnvNamesOf(spec, look)) {
      if (look(name).state === 'missing') {
        problems.push({ key: name, reason: `is referenced by resources/${registryFile(entity)} but absent from the .env` });
      }
    }
    problems.push(...valueProblems(spec, look));
  }
  if (problems.length > 0) throw new RegistryError(problems);

  return makeRegistry(specs, enabled, resolve, look);
}

// Checks the schema cannot express: file name, env prefix, cbs wiring.
function structureProblems(file: string, spec: EntityRegistry): RegistryProblem[] {
  const out: RegistryProblem[] = [];
  const base = file.split('/').pop() ?? file;
  if (base.endsWith('.entity.json') && base !== registryFile(spec.entity)) {
    out.push({ key: file, reason: `declares entity ${spec.entity}; the file name must match` });
  }
  const prefix = `${spec.entity.toUpperCase()}_`;
  for (const name of envNamesOf(spec)) {
    if (!name.startsWith(prefix)) out.push({ key: file, reason: `${name} does not start with ${prefix}` });
  }
  for (const [service, s] of Object.entries(spec.services)) {
    if (s.transport === 'cbs' && spec.cbs === undefined) {
      out.push({ key: file, reason: `services.${service} has transport cbs but the registry has no cbs block` });
    }
  }
  return out;
}

function aliasTable(specs: ReadonlyMap<Entity, EntityRegistry>, problems: RegistryProblem[]): Map<string, Entity> {
  const names = new Map<string, Entity>();
  for (const entity of specs.keys()) names.set(entity, entity);
  for (const spec of specs.values()) {
    for (const alias of spec.aliases) {
      const owner = names.get(alias);
      if (owner !== undefined) {
        problems.push({
          key: `resources/${registryFile(spec.entity)}`,
          reason: `alias ${alias} is already used by ${owner}`,
        });
      } else {
        names.set(alias, spec.entity);
      }
    }
  }
  return names;
}

/** Every env name a registry references, in file order, deduplicated. */
export function envNamesOf(spec: EntityRegistry): readonly string[] {
  const out: string[] = [];
  for (const s of Object.values(spec.services)) {
    out.push(...defined(s.db, s.api, s.auth?.token_env, s.field_encryption?.key_env));
  }
  const q = spec.quickwit;
  out.push(...defined(q.transport, q.index, q.max_concurrency, q.max_hits, q.http?.url, q.http?.auth, q.http?.token, q.qw?.context));
  out.push(...defined(spec.cbs?.enabled_flag, spec.kube.context_env, spec.kube.aws_profile_env, spec.infra_repo));
  return [...new Set(out)];
}

/**
 * The env names that must be present in the .env: every referenced name
 * except the keys of the Quickwit transport that is not in use (qw.context
 * under http; http.url, http.auth and http.token under qw). With the
 * transport unset, blank or invalid, every name stays required.
 */
function requiredEnvNamesOf(spec: EntityRegistry, look: (name: string) => EnvLookup): readonly string[] {
  const q = spec.quickwit;
  const l = look(q.transport);
  const transport = l.state === 'set' ? l.value.trim() : undefined;
  let active = q;
  if (transport === 'http' && q.qw !== undefined) {
    const { qw: _unused, ...rest } = q;
    active = rest;
  } else if (transport === 'qw' && q.http !== undefined) {
    const { http: _unused, ...rest } = q;
    active = rest;
  }
  return active === q ? envNamesOf(spec) : envNamesOf({ ...spec, quickwit: active });
}

// Keys with a fixed format must be well formed when set. Blank is allowed.
function valueProblems(spec: EntityRegistry, look: (name: string) => EnvLookup): RegistryProblem[] {
  const out: RegistryProblem[] = [];
  const check = (name: string | undefined, ok: (value: string) => boolean, reason: string): void => {
    if (name === undefined) return;
    const l = look(name);
    if (l.state === 'set' && !ok(l.value.trim())) out.push({ key: name, reason });
  };
  const q = spec.quickwit;
  check(q.transport, (x) => x === 'qw' || x === 'http', 'must be qw or http');
  check(q.http?.auth, (x) => x === 'none' || x === 'bearer', 'must be none or bearer');
  check(q.max_concurrency, isPositiveInt, 'must be a whole number of at least 1');
  check(q.max_hits, isPositiveInt, 'must be a whole number of at least 1');
  check(spec.cbs?.enabled_flag, (x) => x === 'true' || x === 'false', 'must be true or false');
  check(spec.infra_repo, (x) => parseInfraRepo(x) !== undefined, INFRA_REPO_FORMAT);
  return out;
}

// ---------------------------------------------------------------- registry

function makeRegistry(
  specs: ReadonlyMap<Entity, EntityRegistry>,
  enabled: readonly Entity[],
  resolve: (s: string) => Entity | undefined,
  look: (name: string) => EnvLookup,
): Registry {
  const entities = Object.freeze(ENTITIES.filter((e) => specs.has(e)));
  const enabledList = Object.freeze([...enabled]);

  const specOf = (entity: Entity): EntityRegistry => {
    const spec = specs.get(entity);
    if (spec === undefined) throw RegistryError.of('entity', `${String(entity)} has no registry`);
    return spec;
  };
  const enabledSpec = (entity: Entity): EntityRegistry => {
    const spec = specOf(entity);
    if (!enabledList.includes(entity)) throw RegistryError.of('TRIAGE_ENTITIES', `does not enable ${entity}`);
    return spec;
  };
  const serviceOf = (spec: EntityRegistry, service: string): ServiceSpec => {
    const s = Object.hasOwn(spec.services, service) ? spec.services[service] : undefined;
    if (s === undefined) throw RegistryError.of(`resources/${registryFile(spec.entity)}`, `has no service ${service}`);
    return s;
  };
  const cap = (name: string): Capability => capability(name, look(name));

  const registry: Registry = {
    entities,
    resolveEntity: resolve,
    enabledEntities(hints) {
      if (hints === undefined || hints.length === 0) return enabledList;
      const wanted = new Set(hints.map(resolve).filter((e): e is Entity => e !== undefined));
      return Object.freeze(enabledList.filter((e) => wanted.has(e)));
    },
    isEnabled: (entity) => enabledList.includes(entity),
    spec: specOf,
    services: (entity) => Object.freeze(Object.keys(specOf(entity).services)),
    service: (entity, service) => serviceOf(specOf(entity), service),
    serviceDb(entity, service) {
      const s = serviceOf(enabledSpec(entity), service);
      return s.db === undefined ? undefined : cap(s.db);
    },
    serviceApi(entity, service) {
      const s = serviceOf(enabledSpec(entity), service);
      if (s.api === undefined) return undefined;
      return extend(cap(s.api), { transport: s.transport === 'cbs' ? 'cbs' : 'http' });
    },
    serviceAuth(entity, service) {
      const s = serviceOf(enabledSpec(entity), service);
      if (s.auth === undefined) return undefined;
      return extend(cap(s.auth.token_env), { header: s.auth.header, scheme: s.auth.scheme });
    },
    fieldEncryption(entity, service) {
      const s = serviceOf(enabledSpec(entity), service);
      if (s.field_encryption === undefined) return undefined;
      return extend(cap(s.field_encryption.key_env), { algorithm: s.field_encryption.algorithm });
    },
    quickwit: (entity) => resolveQuickwit(enabledSpec(entity).quickwit, look),
    quickwitFields: (entity) => specOf(entity).quickwit_fields,
    cbsEnabled(entity) {
      const flag = enabledSpec(entity).cbs?.enabled_flag;
      if (flag === undefined) return false;
      const l = look(flag);
      return l.state === 'set' && l.value.trim() === 'true';
    },
    kube(entity) {
      const k = enabledSpec(entity).kube;
      return Object.freeze({ context: cap(k.context_env), awsProfile: cap(k.aws_profile_env) });
    },
    repos(entity) {
      const spec = specOf(entity);
      const fromServices = Object.values(spec.services).flatMap((s) => defined(s.repo));
      return Object.freeze([...new Set([...fromServices, ...(spec.repos_extra ?? [])])]);
    },
    infraRepo(entity) {
      const name = enabledSpec(entity).infra_repo;
      if (name === undefined) return undefined;
      const l = look(name);
      if (l.state !== 'set') return Object.freeze({ status: 'disabled', envName: name, reason: 'blank' });
      // Validated at load for enabled entities.
      const parsed = parseInfraRepo(l.value.trim()) as { repo: string; path: string };
      return Object.freeze({ status: 'ok', envName: name, ...parsed });
    },
    capabilityReport: (entity) => report(specOf(entity), enabledList.includes(entity), look),
  };
  return Object.freeze(registry);
}

function capability(envName: string, l: EnvLookup): Capability {
  if (l.state !== 'set') return Object.freeze({ status: 'disabled', envName, reason: 'blank' });
  return hidden({ status: 'ok', envName }, { value: l.value }) as Capability;
}

// Adds fields to a capability without losing its hidden value.
function extend<T extends object>(base: Capability, extra: T): Capability & T {
  const out = { ...base, ...extra };
  if (base.status === 'ok') Object.defineProperty(out, 'value', { value: base.value, enumerable: false });
  return Object.freeze(out) as Capability & T;
}

// Copies visible fields and adds the secret ones as non-enumerable properties.
function hidden<T extends object>(visible: T, secret: Readonly<Record<string, string>>): T {
  const out = { ...visible };
  for (const [k, value] of Object.entries(secret)) Object.defineProperty(out, k, { value, enumerable: false });
  return Object.freeze(out);
}

type QuickwitResolution = QuickwitCapability | { readonly status: 'invalid' | 'missing'; readonly reason: string; readonly envNames: readonly string[] };

// Enabled entities were validated at load, so only 'ok' and 'disabled' reach
// quickwit(). The report also sees 'invalid' and 'missing' for disabled entities.
function resolveQuickwit(q: QuickwitSpec, look: (name: string) => EnvLookup): QuickwitCapability {
  const r = resolveQuickwitAny(q, look);
  if (r.status === 'invalid' || r.status === 'missing') {
    throw new RegistryError(r.envNames.map((key) => ({ key, reason: r.reason })));
  }
  return r as QuickwitCapability;
}

function resolveQuickwitAny(q: QuickwitSpec, look: (name: string) => EnvLookup): QuickwitResolution {
  const off = (reason: string, ...envNames: string[]): QuickwitResolution =>
    Object.freeze({ status: 'disabled', reason, envNames: Object.freeze(envNames) });
  const bad = (status: 'invalid' | 'missing', name: string, reason: string): QuickwitResolution =>
    Object.freeze({ status, reason: `${name} ${reason}`, envNames: Object.freeze([name]) });
  const read = (name: string): string | undefined => {
    const l = look(name);
    return l.state === 'set' ? l.value.trim() : undefined;
  };

  for (const name of defined(q.transport, q.index, q.max_concurrency, q.max_hits)) {
    if (look(name).state === 'missing') return bad('missing', name, 'is absent from the .env');
  }
  const transport = read(q.transport);
  if (transport === undefined) return off(`${q.transport} is blank`, q.transport);
  if (transport !== 'qw' && transport !== 'http') return bad('invalid', q.transport, 'must be qw or http');

  const limits: number[] = [];
  for (const [name, fallback] of [[q.max_concurrency, QUICKWIT_DEFAULT_MAX_CONCURRENCY], [q.max_hits, QUICKWIT_DEFAULT_MAX_HITS]] as const) {
    const raw = name === undefined ? undefined : read(name);
    if (raw !== undefined && !isPositiveInt(raw)) return bad('invalid', name as string, 'must be a whole number of at least 1');
    limits.push(raw === undefined ? fallback : Number(raw));
  }
  const [maxConcurrency, maxHits] = limits as [number, number];

  const index = read(q.index);
  if (index === undefined) return off(`${q.index} is blank`, q.index);
  const common = { status: 'ok' as const, index, maxConcurrency, maxHits };

  if (transport === 'qw') {
    if (q.qw === undefined) return off('the registry has no quickwit.qw block', q.transport);
    if (look(q.qw.context).state === 'missing') return bad('missing', q.qw.context, 'is absent from the .env');
    const context = read(q.qw.context);
    if (context === undefined) return off(`${q.qw.context} is blank`, q.qw.context);
    return Object.freeze({ ...common, transport: 'qw', context });
  }

  const h = q.http;
  if (h === undefined) return off('the registry has no quickwit.http block', q.transport);
  for (const name of defined(h.url, h.auth, h.token)) {
    if (look(name).state === 'missing') return bad('missing', name, 'is absent from the .env');
  }
  const url = read(h.url);
  if (url === undefined) return off(`${h.url} is blank`, h.url);
  const auth = read(h.auth) ?? 'none';
  if (auth !== 'none' && auth !== 'bearer') return bad('invalid', h.auth, 'must be none or bearer');
  if (auth === 'none') return hidden({ ...common, transport: 'http' as const, auth }, { url }) as QuickwitCapability;
  if (h.token === undefined) return off(`${h.auth} is bearer but the registry names no token key`, h.auth);
  const token = read(h.token);
  if (token === undefined) return off(`${h.token} is blank and ${h.auth} is bearer`, h.token, h.auth);
  return hidden({ ...common, transport: 'http' as const, auth }, { url, token }) as QuickwitCapability;
}

// ------------------------------------------------------------------ report

function report(spec: EntityRegistry, enabled: boolean, look: (name: string) => EnvLookup): CapabilityReport {
  const rows: CapabilityRow[] = [];
  const single = (capability: CapabilityKind, name: string, service?: string, reason?: string): void => {
    const l = look(name);
    const status: CapabilityStatus = l.state === 'set' ? 'ok' : l.state;
    rows.push(Object.freeze({ capability, ...(service === undefined ? {} : { service }), envNames: Object.freeze([name]), status, ...(reason === undefined ? {} : { reason }) }));
  };

  for (const [service, s] of Object.entries(spec.services)) {
    if (s.db !== undefined) single('db', s.db, service);
    if (s.api !== undefined) single('api', s.api, service, s.transport === 'cbs' ? 'reachable only through cbs_call' : undefined);
    if (s.auth !== undefined) single('auth', s.auth.token_env, service);
    if (s.field_encryption !== undefined) single('field_encryption', s.field_encryption.key_env, service);
  }

  const q = spec.quickwit;
  const qwNames = defined(q.transport, q.index, q.max_concurrency, q.max_hits, q.http?.url, q.http?.auth, q.http?.token, q.qw?.context);
  const qr = resolveQuickwitAny(q, look);
  rows.push(Object.freeze({
    capability: 'quickwit',
    envNames: Object.freeze(qwNames),
    status: qr.status,
    ...(qr.status === 'ok' ? {} : { reason: qr.reason }),
  }));

  if (spec.cbs !== undefined) {
    const flag = spec.cbs.enabled_flag;
    const l = look(flag);
    const value = l.state === 'set' ? l.value.trim() : undefined;
    const row = (status: CapabilityStatus, reason?: string): CapabilityRow =>
      Object.freeze({ capability: 'cbs', envNames: Object.freeze([flag]), status, ...(reason === undefined ? {} : { reason }) });
    if (l.state === 'missing') rows.push(row('missing', `${flag} is absent from the .env`));
    else if (value === 'true') rows.push(row('ok'));
    else if (value === undefined || value === 'false') rows.push(row('disabled', `${flag} is not true`));
    else rows.push(row('invalid', `${flag} must be true or false`));
  }

  single('kube_context', spec.kube.context_env);
  single('aws_profile', spec.kube.aws_profile_env);
  if (spec.infra_repo !== undefined) {
    const name = spec.infra_repo;
    const l = look(name);
    const bad = l.state === 'set' && parseInfraRepo(l.value.trim()) === undefined;
    rows.push(Object.freeze({
      capability: 'infra_repo',
      envNames: Object.freeze([name]),
      status: bad ? 'invalid' : l.state === 'set' ? 'ok' : l.state,
      ...(bad ? { reason: `${name} ${INFRA_REPO_FORMAT}` } : {}),
    }));
  }
  return Object.freeze({ entity: spec.entity, enabled, rows: Object.freeze(rows) });
}

// -------------------------------------------------------------- infra repo

const INFRA_REPO_FORMAT = 'must be <repo> or <repo>:<relative/path>';
const PATH_SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

/**
 * Splits `repo` or `repo:path` on the first ':'. No path, or '.', means the
 * repo root. The path is relative, with no '.', '..' or empty segments, so it
 * cannot leave the checkout. undefined when malformed.
 */
export function parseInfraRepo(value: string): { readonly repo: string; readonly path: string } | undefined {
  const at = value.indexOf(':');
  const repo = at === -1 ? value : value.slice(0, at);
  const path = at === -1 ? '.' : value.slice(at + 1);
  if (!v.is(RepoNameSchema, repo)) return undefined;
  if (path === '.') return Object.freeze({ repo, path });
  if (!path.split('/').every((seg) => PATH_SEGMENT.test(seg))) return undefined;
  return Object.freeze({ repo, path });
}

// ----------------------------------------------------------------- helpers

function defined(...xs: (string | undefined)[]): string[] {
  return xs.filter((x): x is string => x !== undefined);
}

function isPositiveInt(x: string): boolean {
  return /^\d+$/.test(x) && Number(x) >= 1;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
