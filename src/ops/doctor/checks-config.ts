// Doctor checks over config and local files only (HLD §7 Doctor, D4, D31,
// D36, D40, D41, D45).
//
// No network, SQL or subprocess call happens here. The one outward call is
// the embedding probe, and it goes through an embedder the caller injects;
// in mock mode it is skipped. Rows name env keys and never print a value.
// TRIAGE_DEPLOY_MODE is not read here: it belongs to pre-flight alone (D32).

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { hasProvider } from '@flue/runtime/internal';
import { lookupEnv, type Config } from '../../config/env.ts';
import { ConfigError } from '../../config/errors.ts';
import {
  RegistryError,
  loadRegistry,
  type CapabilityRow,
  type Registry,
} from '../../config/registry.ts';
import { EMBEDDING_KEY, parseEmbeddingSpec, type EmbeddingSpec } from '../../embed/spec.ts';
import type { Embedder } from '../../embed/index.ts';
import { redactPersisted } from '../../gate/redact.ts';
import { loadRulesFile } from '../../gate/rules-file.ts';
import { classifierModel, codeWalkerModel, lookupModel, modelForTier, parseSpec, type ModelLookup } from '../../models.ts';
import { ENTITIES, type Entity } from '../../types/core.ts';
import { describeError } from './run.ts';
import type { DoctorCheck, DoctorContext, DoctorStatus, NamedCheck } from './types.ts';

declare module './types.ts' {
  interface DoctorContext {
    /** Used for the embedding probe outside mock mode. Absent means the probe is skipped. */
    readonly embedder?: Embedder | null;
    /** pi-ai metadata lookup; defaults to lookupModel from src/models.ts. */
    readonly modelLookup?: ModelLookup;
  }
}

/** The fixed text the embedding probe embeds. It holds no id or name. */
export const EMBEDDING_PROBE_TEXT = 'triage doctor embedding probe';

type Row = Omit<DoctorCheck, 'id'>;

const row = (status: DoctorStatus, key_names: readonly string[], message: string, entity?: Entity): Row =>
  entity === undefined ? { status, key_names, message } : { status, key_names, message, entity };

const withId = (id: string, rows: readonly Row[]): DoctorCheck[] => rows.map((r) => ({ id, ...r }));

// ------------------------------------------------------------------ registry

type RegistryResult = { readonly ok: true; readonly registry: Registry } | { readonly ok: false; readonly error: RegistryError };

const loaded = new WeakMap<DoctorContext, RegistryResult>();

// Loads the registry once per doctor run. A RegistryError is kept, not thrown,
// so the env check can list each problem and the rules check can skip.
function registryOf(ctx: DoctorContext): RegistryResult {
  if (ctx.registry !== undefined) return { ok: true, registry: ctx.registry };
  const cached = loaded.get(ctx);
  if (cached !== undefined) return cached;
  let result: RegistryResult;
  try {
    result = { ok: true, registry: loadRegistry(ctx.config) };
  } catch (err) {
    if (!(err instanceof RegistryError)) throw err;
    result = { ok: false, error: err };
  }
  loaded.set(ctx, result);
  return result;
}

const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

function entityOfKey(key: string): Entity | undefined {
  const prefix = key.split('_')[0]?.toLowerCase();
  return ENTITIES.find((e) => e === prefix);
}

// ------------------------------------------------------------------ env

const PLACEHOLDER = /<user>|<password>/i;

async function envCheck(ctx: DoctorContext): Promise<DoctorCheck[]> {
  const rows: Row[] = [];
  if (ctx.config.entities.length === 0) {
    rows.push(row('warn', ['TRIAGE_ENTITIES'], 'TRIAGE_ENTITIES is blank; no entity is enabled'));
  }
  const r = registryOf(ctx);
  if (!r.ok) {
    for (const p of r.error.problems) {
      const keys = ENV_NAME.test(p.key) ? [p.key] : [];
      rows.push(row('fail', keys, `${p.key} ${p.reason}`, entityOfKey(p.key)));
    }
    return withId('env', rows);
  }
  const { registry } = r;
  for (const entity of registry.entities) {
    if (!registry.isEnabled(entity)) {
      rows.push(row('disabled', ['TRIAGE_ENTITIES'], 'not in TRIAGE_ENTITIES; not checked', entity));
      continue;
    }
    for (const cap of registry.capabilityReport(entity).rows) rows.push(capabilityRow(ctx.config, entity, cap));
  }
  return withId('env', rows);
}

function capabilityRow(config: Config, entity: Entity, cap: CapabilityRow): Row {
  const what = cap.service === undefined ? cap.capability : `${cap.capability} ${cap.service}`;
  const keys = cap.envNames;
  const reason = cap.reason === undefined ? '' : ` (${cap.reason})`;
  switch (cap.status) {
    case 'ok': {
      const placeholders = keys.filter((name) => {
        const l = lookupEnv(config, name);
        return l.state === 'set' && PLACEHOLDER.test(l.value);
      });
      if (placeholders.length > 0) {
        return row('fail', placeholders, `${what}: ${placeholders.join(', ')} still holds a <user> or <password> placeholder`, entity);
      }
      return row('ok', keys, `${what}: set${reason}`, entity);
    }
    case 'blank':
      return row('disabled', keys, `${what} off: ${keys.join(', ')} is blank`, entity);
    case 'disabled':
      return row('disabled', keys, `${what} off${reason}`, entity);
    case 'missing':
      return row('fail', keys, `${what}: ${keys.join(', ')} is absent from the .env${reason}`, entity);
    case 'invalid':
      return row('fail', keys, `${what}: invalid${reason}`, entity);
  }
}

// ------------------------------------------------------------------ sandbox

async function sandboxCheck(ctx: DoctorContext): Promise<DoctorCheck[]> {
  const s = ctx.config.sandbox;
  const key = 'TRIAGE_SANDBOX_PROVIDER';
  const one = (r: Row): DoctorCheck[] => withId('sandbox', [r]);
  switch (s.provider) {
    case 'virtual':
      return one(row('ok', [key], `${key} is virtual (in memory, network off)`));
    case 'local':
      return one(row('fail', [key], `${key} is local, which is refused (D45): not an isolation boundary; use virtual, e2b or daytona`));
    case 'e2b':
      return s.e2bApiKey === undefined
        ? one(row('fail', [key, 'E2B_API_KEY'], `${key} is e2b but E2B_API_KEY is blank`))
        : one(row('ok', [key, 'E2B_API_KEY'], `${key} is e2b and E2B_API_KEY is set`));
    case 'daytona':
      return s.daytonaApiKey === undefined
        ? one(row('fail', [key, 'DAYTONA_API_KEY'], `${key} is daytona but DAYTONA_API_KEY is blank`))
        : one(row('ok', [key, 'DAYTONA_API_KEY'], `${key} is daytona and DAYTONA_API_KEY is set`));
  }
}

// ------------------------------------------------------------------ models

// The key each provider needs. Other registered providers (faux in tests) need none.
const PROVIDER_KEYS: Readonly<Record<string, { key: string; value: (c: Config) => string | undefined }>> = {
  anthropic: { key: 'ANTHROPIC_API_KEY', value: (c) => c.providers.anthropicApiKey },
  openai: { key: 'OPENAI_API_KEY', value: (c) => c.providers.openaiApiKey },
  openrouter: { key: 'OPENROUTER_API_KEY', value: (c) => c.providers.openrouterApiKey },
  ollama: { key: 'OLLAMA_BASE_URL', value: (c) => c.providers.ollamaBaseUrl },
};

// Blank provider key for a valid spec, or undefined when the key is set or not needed.
function blankProviderKey(config: Config, spec: string): string | undefined {
  const provider = parseSpec(spec)?.provider;
  const need = provider === undefined ? undefined : PROVIDER_KEYS[provider];
  return need !== undefined && need.value(config) === undefined ? need.key : undefined;
}

// One row for a model slot. validate() applies the src/models.ts rules and throws ConfigError.
function slotRow(config: Config, key: string, validate: () => string): { row: Row; spec?: string } {
  let spec: string;
  try {
    spec = validate();
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    return { row: row('fail', [...err.keys], err.problems.map((p) => `${p.key} ${p.reason}`).join('; ')) };
  }
  const blank = blankProviderKey(config, spec);
  if (blank !== undefined) return { row: row('fail', [key, blank], `${key} needs ${blank}, which is blank`) };
  return { row: row('ok', [key], `${key} is set`), spec };
}

async function modelsCheck(ctx: DoctorContext): Promise<DoctorCheck[]> {
  const c = ctx.config;
  const rows: Row[] = [];
  rows.push(slotRow(c, 'MODEL_CLASSIFIER', () => classifierModel(c)).row);
  rows.push(slotRow(c, 'MODEL_TIER_CHEAP', () => modelForTier('cheap', c)).row);
  rows.push(slotRow(c, 'MODEL_TIER_MID', () => modelForTier('mid', c)).row);
  const strong = slotRow(c, 'MODEL_TIER_STRONG', () => modelForTier('strong', c));
  rows.push(strong.row);
  if (c.models.codeWalker === undefined) {
    rows.push(row('ok', ['MODEL_CODE_WALKER', 'MODEL_TIER_STRONG'], 'MODEL_CODE_WALKER is blank; code_walker uses MODEL_TIER_STRONG'));
  } else {
    rows.push(slotRow(c, 'MODEL_CODE_WALKER', () => codeWalkerModel(c)).row);
  }
  rows.push(imageRow(strong.spec, ctx.modelLookup ?? lookupModel));
  rows.push(judgeRow(c));
  return withId('models', rows);
}

// D36: the strong tier must take image input.
function imageRow(spec: string | undefined, lookup: ModelLookup): Row {
  const key = 'MODEL_TIER_STRONG';
  if (spec === undefined) return row('skipped', [key], `image input not checked: ${key} is not usable`);
  const meta = lookup(spec);
  if (meta === undefined) return row('warn', [key], `${key} is not in the pi-ai model metadata; image input unknown (D36)`);
  if (!meta.input.includes('image')) return row('fail', [key], `${key} does not accept image input (D36)`);
  return row('ok', [key], `${key} accepts image input (D36)`);
}

function judgeRow(c: Config): Row {
  const key = 'TRIAGE_EVAL_JUDGE_MODEL';
  const spec = c.evals.judgeModel;
  if (spec === undefined) return row('disabled', [key], `${key} is blank; model evals refuse to run without a judge`);
  const parsed = parseSpec(spec);
  if (parsed === undefined) return row('fail', [key], `${key} must be a 'provider/model' spec`);
  if (parsed.provider === 'openrouter') return row('fail', [key], `${key} may not use openrouter (D41)`);
  const known = PROVIDER_KEYS[parsed.provider] !== undefined || hasProvider(parsed.provider);
  if (!known) return row('fail', [key], `${key} names a provider that is not built in and not registered`);
  const blank = blankProviderKey(c, spec);
  if (blank !== undefined) return row('fail', [key, blank], `${key} needs ${blank}, which is blank`);
  return row('ok', [key], `${key} is set`);
}

// ------------------------------------------------------------------ embedding

async function embeddingCheck(ctx: DoctorContext): Promise<DoctorCheck[]> {
  const one = (r: Row): DoctorCheck[] => withId('embedding', [r]);
  const c = ctx.config;
  let spec: EmbeddingSpec | null;
  try {
    spec = parseEmbeddingSpec(c.models.embedding);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    return one(row('fail', [EMBEDDING_KEY], err.problems.map((p) => `${p.key} ${p.reason}`).join('; ')));
  }
  if (spec === null) return one(row('disabled', [EMBEDDING_KEY], `embeddings off: ${EMBEDDING_KEY} is blank`));

  const need = PROVIDER_KEYS[spec.provider];
  if (need !== undefined && need.value(c) === undefined) {
    return one(row('fail', [EMBEDDING_KEY, need.key], `${EMBEDDING_KEY} needs ${need.key}, which is blank`));
  }
  if (c.mock.enabled) return one(row('skipped', [EMBEDDING_KEY], `${EMBEDDING_KEY} is set; probe skipped in mock mode`));
  const embedder = ctx.embedder;
  if (embedder === undefined || embedder === null) {
    return one(row('skipped', [EMBEDDING_KEY], `${EMBEDDING_KEY} is set; no embedder given, probe skipped`));
  }
  try {
    const vectors = await embedder.embed([redactPersisted(EMBEDDING_PROBE_TEXT)], { signal: ctx.signal });
    const length = vectors[0]?.length ?? 0;
    if (length === 0) return one(row('warn', [EMBEDDING_KEY], `${embedder.model}: probe returned no vector`));
    return one(row('ok', [EMBEDDING_KEY], `${embedder.model}: vector length ${length}`));
  } catch (err) {
    return one(row('warn', [EMBEDDING_KEY], `embedding probe failed: ${describeError(err)}`));
  }
}

// ------------------------------------------------------------------ fixtures

const UNREVIEWED = '_unreviewed';

async function fixturesCheck(ctx: DoctorContext): Promise<DoctorCheck[]> {
  const key = 'TRIAGE_FIXTURES_DIR';
  const dir = ctx.config.paths.fixturesDir;
  if (!isDir(dir)) return withId('fixtures', [row('fail', [key], `${key} points at a folder that does not exist`)]);
  const rows: Row[] = [row('ok', [key], `${key} exists`)];
  const count = countFiles(join(dir, UNREVIEWED));
  if (count > 0) {
    rows.push(row('warn', [key], `${count} unreviewed fixture file(s) in ${UNREVIEWED}/; run triage fixtures review`));
  }
  return withId('fixtures', rows);
}

function isDir(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory();
}

// Regular files under dir, recursively, skipping dotfiles such as .gitkeep.
function countFiles(dir: string): number {
  if (!isDir(dir)) return 0;
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    if (e.isDirectory()) n += countFiles(join(dir, e.name));
    else if (e.isFile()) n += 1;
  }
  return n;
}

// ------------------------------------------------------------------ rules

async function rulesCheck(ctx: DoctorContext): Promise<DoctorCheck[]> {
  const r = registryOf(ctx);
  if (!r.ok) return withId('rules', [row('skipped', [], 'rules not checked: the entity registry did not load')]);
  const { registry } = r;
  const rows: Row[] = [];
  for (const entity of registry.enabledEntities()) {
    try {
      const rules = loadRulesFile(ctx.config.home, entity, registry.services(entity));
      for (const w of rules.warnings) rows.push(row('warn', [], `${rules.file}: ${w}`, entity));
      if (rules.warnings.length === 0) rows.push(row('ok', [], `${rules.file}: ${rules.rules.length} rule(s)`, entity));
    } catch (err) {
      if (!(err instanceof RegistryError)) throw err;
      for (const p of err.problems) rows.push(row('fail', [], `${p.key} ${p.reason}`, entity));
    }
  }
  return withId('rules', rows);
}

// ------------------------------------------------------------------ export

/** The config checks, in the order the doctor prints them. */
export const configChecks: readonly NamedCheck[] = Object.freeze([
  { id: 'env', run: envCheck },
  { id: 'sandbox', run: sandboxCheck },
  { id: 'models', run: modelsCheck },
  { id: 'embedding', run: embeddingCheck },
  { id: 'fixtures', run: fixturesCheck },
  { id: 'rules', run: rulesCheck },
]);
