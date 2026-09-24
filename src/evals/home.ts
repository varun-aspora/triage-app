// Eval home guard (D42, D43).
//
// An eval run is its own deployment: a TRIAGE_HOME whose .env has every
// entity credential blank. The eval driver calls assertEvalHome before it
// starts anything and forceEvalFlags on the overrides it loads config with,
// so even a bypassed mock layer has nothing to connect with.
//
// Errors name keys and fixed reasons only, never values.

import { lookupEnv, rawKeyState, type Config } from '../config/env.ts';
import type { EntityRegistry, Registry } from '../config/registry.ts';

/** SSFB CBS keys from .env.example. The enabled flag is checked on its own. */
export const SSFB_CBS_KEYS = Object.freeze([
  'SSFB_CBS_BASTION',
  'SSFB_CBS_SSH_IDENTITY_FILE',
  'SSFB_CBS_K8S_NAMESPACE',
  'SSFB_CBS_POD_SELECTOR',
  'SSFB_CBS_CONTAINER',
  'SSFB_CBS_CREDS_SECRET',
  'SSFB_CBS_GATEWAY_URL',
  'SSFB_CBS_OAUTH_SCOPE',
  'SSFB_CBS_SOURCE',
  'SSFB_CBS_SOURCE_IDENTIFIER',
]);

/** SSFB DB tunnel keys from .env.example. */
export const SSFB_DB_TUNNEL_KEYS = Object.freeze([
  'SSFB_DB_TUNNEL_REQUIRED',
  'SSFB_DB_TUNNEL_BASTION',
  'SSFB_DB_TUNNEL_IDENTITY_FILE',
  'SSFB_DB_TUNNEL_LOCAL_PORT',
  'SSFB_DB_TUNNEL_REMOTE_HOST',
  'SSFB_DB_TUNNEL_REMOTE_PORT',
]);

/** Keys that are credentials even though no registry file names them. */
export const EXTRA_CREDENTIAL_KEYS = Object.freeze([
  ...SSFB_CBS_KEYS,
  ...SSFB_DB_TUNNEL_KEYS,
  'SSFB_HARBOR_FIELD_ENC_KEY',
  'SSFB_RHYTHM_FIELD_ENC_KEY',
  'SSFB_BRO_ADMIN_TOKEN',
  'SLACK_BOT_TOKEN',
]);

/** The values forceEvalFlags writes. */
export const EVAL_FLAGS: Readonly<Record<string, string>> = Object.freeze({
  TRIAGE_MOCK_MODE: 'true',
  TRIAGE_MOCK_STRICT: 'true',
  TRIAGE_RECORD_FIXTURES: 'false',
});

export type EvalHomeProblem = { readonly key: string; readonly reason: string };

/** Refusal to run evals from this TRIAGE_HOME. Names keys, never values. */
export class EvalHomeError extends Error {
  override readonly name = 'EvalHomeError';
  readonly keys: readonly string[];
  readonly problems: readonly EvalHomeProblem[];

  constructor(problems: readonly EvalHomeProblem[]) {
    const list = problems.length > 0 ? problems : [{ key: 'TRIAGE_HOME', reason: 'is not an eval home' }];
    super(`not an eval home: ${list.map((p) => `${p.key} ${p.reason}`).join('; ')}`);
    this.problems = Object.freeze(list.map((p) => Object.freeze({ key: p.key, reason: p.reason })));
    this.keys = Object.freeze([...new Set(list.map((p) => p.key))]);
  }
}

/**
 * Every env name that could let an eval reach a real system: each registry's
 * DB and API keys, service auth tokens, field encryption keys, Quickwit URL,
 * token and qw context, kube context and AWS profile, plus the SSFB CBS and
 * tunnel keys and SLACK_BOT_TOKEN. Deduplicated, registry keys first.
 */
export function credentialKeys(registry: Registry): readonly string[] {
  const out: string[] = [];
  for (const entity of registry.entities) out.push(...registryCredentialKeys(registry.spec(entity)));
  out.push(...EXTRA_CREDENTIAL_KEYS);
  return Object.freeze([...new Set(out)]);
}

function registryCredentialKeys(spec: EntityRegistry): string[] {
  const out: (string | undefined)[] = [];
  for (const s of Object.values(spec.services)) {
    out.push(s.db, s.api, s.auth?.token_env, s.field_encryption?.key_env);
  }
  const q = spec.quickwit;
  out.push(q.http?.url, q.http?.token, q.qw?.context, spec.kube.context_env, spec.kube.aws_profile_env);
  return out.filter((x): x is string => x !== undefined);
}

/**
 * Throws EvalHomeError unless this config is safe to run evals from.
 * Refused: any credential key with any characters in it (whitespace counts),
 * a CBS flag other than blank or false, a sandbox other than virtual, a db
 * provider other than sqlite, an embedding model other than blank or
 * ollama/* (D43), and mock flags that forceEvalFlags would have set.
 */
export function assertEvalHome(config: Config, registry: Registry): void {
  const problems: EvalHomeProblem[] = [];
  const add = (key: string, reason: string): void => {
    problems.push({ key, reason });
  };

  for (const name of credentialKeys(registry)) {
    if (rawKeyState(config, name) === 'set') add(name, 'must be blank in an eval home');
  }

  for (const entity of registry.entities) {
    const flag = registry.spec(entity).cbs?.enabled_flag;
    if (flag === undefined) continue;
    const l = lookupEnv(config, flag);
    if (l.state === 'set' && l.value.trim() !== 'false') add(flag, 'must be blank or false in an eval home');
  }

  if (config.sandbox.provider !== 'virtual') add('TRIAGE_SANDBOX_PROVIDER', 'must be virtual in an eval home');
  if (config.db.provider !== 'sqlite') add('TRIAGE_DB_PROVIDER', 'must be sqlite in an eval home');

  const embedding = config.models.embedding;
  if (embedding !== undefined && !embedding.startsWith('ollama/')) {
    add('MODEL_EMBEDDING', 'must be blank or ollama/<model> in an eval home (D43)');
  }

  if (!config.mock.enabled) add('TRIAGE_MOCK_MODE', 'must be true in an eval home; call forceEvalFlags');
  if (!config.mock.strict) add('TRIAGE_MOCK_STRICT', 'must be true in an eval home; call forceEvalFlags');
  if (config.mock.record) add('TRIAGE_RECORD_FIXTURES', 'must be false in an eval home; call forceEvalFlags');

  if (problems.length > 0) throw new EvalHomeError(problems);
}

/** Sets the mock flags an eval always runs with, whatever the record held. Mutates and returns env. */
export function forceEvalFlags<T extends Record<string, string | undefined>>(env: T): T {
  Object.assign(env, EVAL_FLAGS);
  return env;
}
