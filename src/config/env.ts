// Typed, frozen config loaded from <TRIAGE_HOME>/.env.
//
// Rules this module keeps:
// - TRIAGE_HOME comes from the shell (process.env) or the home option, never from a file.
// - The .env is parsed with dotenv.parse; nothing is ever written to process.env
//   except the provider keys applyProviderEnv copies, and no file is ever written.
// - The cwd is ignored. Relative paths resolve against the home.
// - Errors, util.inspect and JSON.stringify show key names only, never values.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { parse } from 'dotenv';
import { INTERFACES, type Interface } from '../types/core.ts';
import { ConfigError, type ConfigProblem } from './errors.ts';
import {
  DEPLOY_MODE_KEY,
  ENTITY_KEY_PATTERN,
  HOME_KEY,
  KEY_BY_NAME,
  PROVIDER_KEYS,
  THINKING_LEVELS,
  isTableKey,
  type KeySpec,
} from './keys.ts';

export type DbProvider = 'sqlite' | 'postgres';
export type ApprovalMode = 'cli' | 'slack';
export type SandboxProvider = 'virtual' | 'e2b' | 'daytona' | 'local';
export type GitProtocol = 'ssh' | 'https';
/** Colour theme of the web console. Display only; nothing else branches on it. */
export type UiEnv = 'production' | 'non-production';
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export type Config = {
  readonly home: string;
  readonly display: { readonly envLabel?: string };
  readonly entities: readonly string[];
  readonly paths: {
    readonly resourcesDir: string;
    readonly dataDir: string;
    readonly auditLog: string;
    readonly runsDir: string;
    readonly reposDir?: string;
    readonly knowledgeDir: string;
    readonly fixturesDir: string;
  };
  readonly db: {
    readonly provider: DbProvider;
    readonly url: string;
    /** Postgres only (D57): attempts per call on a lost connection; the wait doubles from delayMs up to maxDelayMs, with jitter. */
    readonly retry: { readonly attempts: number; readonly delayMs: number; readonly maxDelayMs: number };
  };
  readonly runs: { readonly retentionDays?: number; readonly priorCases: boolean };
  readonly approval: { readonly mode: ApprovalMode };
  readonly mock: { readonly enabled: boolean; readonly strict: boolean; readonly record: boolean };
  readonly budgets: {
    readonly maxToolCallsPerRun: number;
    readonly maxTasksPerRun: number;
    /** Questions to the requester per run (ask_requester); 0 leaves the tool unmounted. */
    readonly maxAsksPerRun: number;
    readonly maxResponseBytesPerCall: number;
    readonly maxBytesPerRun: number;
    readonly runTimeoutMs: number;
    readonly runMaxAttempts: number;
    readonly httpTimeoutMs: number;
    readonly defaultLookbackDays: number;
  };
  readonly sql: {
    readonly maxRows: number;
    readonly statementTimeoutMs: number;
    readonly lockTimeoutMs: number;
    readonly requireReadonlyRole: boolean;
    /** D57: attempts per entity DB call on a lost connection; the wait doubles from delayMs up to maxDelayMs, with jitter. */
    readonly retry: { readonly attempts: number; readonly delayMs: number; readonly maxDelayMs: number };
  };
  readonly models: {
    readonly classifier?: string;
    readonly tierCheap?: string;
    readonly tierMid?: string;
    readonly tierStrong?: string;
    readonly codeWalker?: string;
    readonly thinkingCheap: ThinkingLevel;
    readonly thinkingMid: ThinkingLevel;
    readonly thinkingStrong: ThinkingLevel;
    readonly embedding?: string;
  };
  readonly providers: {
    readonly anthropicApiKey?: string;
    readonly openaiApiKey?: string;
    readonly openrouterApiKey?: string;
    readonly ollamaBaseUrl?: string;
  };
  readonly evals: { readonly judgeModel?: string; readonly maxCostUsd?: number };
  readonly http: { readonly port: number; readonly authToken?: string; readonly allowSlackPost: boolean };
  readonly ui: { readonly env: UiEnv };
  readonly slack: {
    readonly botToken?: string;
    readonly signingSecret?: string;
    readonly reviewerEmail?: string;
    readonly fallbackGroupHandle?: string;
  };
  readonly sandbox: {
    readonly provider: SandboxProvider;
    readonly python: boolean;
    readonly timeoutMs: number;
    readonly e2bApiKey?: string;
    readonly daytonaApiKey?: string;
    readonly daytonaApiUrl?: string;
  };
  readonly code: { readonly codegraphBin: string; readonly qwBin: string; readonly syncBeforeQuery: boolean };
  readonly git: { readonly protocol: GitProtocol; readonly host: string; readonly org: string; readonly httpsToken?: string };
  readonly repos: { readonly syncIntervalMs: number; readonly syncInterfaces: readonly Interface[] };
};

export type EnvLookup =
  | { readonly state: 'missing' }
  | { readonly state: 'blank' }
  | { readonly state: 'set'; readonly value: string };

export type LoadOptions = {
  /** Overrides process.env TRIAGE_HOME. */
  readonly home?: string;
  /** Values that take precedence over the .env file. */
  readonly overrides?: Readonly<Record<string, string>>;
};

export type RecordOptions = {
  /** false skips only the v1 policy refusals (local sandbox, slack approval). Test files only. */
  readonly policyChecks?: boolean;
};

type Hidden = { readonly record: Readonly<Record<string, string>>; readonly deployMode: string };

const hidden = new WeakMap<object, Hidden>();
const INSPECT = Symbol.for('nodejs.util.inspect.custom');

export function loadConfig(options: LoadOptions = {}): Config {
  const home = options.home ?? process.env[HOME_KEY];
  if (home === undefined || home.trim() === '') {
    throw ConfigError.of(HOME_KEY, 'is not set; export it in the shell');
  }
  if (!isAbsolute(home)) throw ConfigError.of(HOME_KEY, 'must be an absolute path');
  const envFile = join(home, '.env');
  if (!existsSync(envFile) || !statSync(envFile).isFile()) {
    throw ConfigError.of(HOME_KEY, 'has no .env file');
  }
  const fromFile = parse(readFileSync(envFile, 'utf8'));
  return configFromRecord({ ...fromFile, ...options.overrides }, home);
}

export function configFromRecord(
  record: Readonly<Record<string, string>>,
  home: string,
  options: RecordOptions = {},
): Config {
  if (!isAbsolute(home)) throw ConfigError.of(HOME_KEY, 'must be an absolute path');
  const root = resolve(home);
  const rec: Record<string, string> = { ...record };
  // TRIAGE_HOME is shell-only: a value in the file is ignored.
  delete rec[HOME_KEY];
  const r = new Reader(rec, root);

  const provider = r.enumOf<DbProvider>('TRIAGE_DB_PROVIDER');
  const config: Config = {
    home: root,
    display: { envLabel: r.str('TRIAGE_ENV_LABEL') },
    entities: r.csv('TRIAGE_ENTITIES').map((e) => e.toLowerCase()),
    paths: {
      resourcesDir: join(root, 'resources'),
      dataDir: r.requiredPath('TRIAGE_DATA_DIR'),
      auditLog: r.requiredPath('TRIAGE_AUDIT_LOG'),
      runsDir: r.requiredPath('TRIAGE_RUNS_DIR'),
      reposDir: r.path('TRIAGE_REPOS_DIR'),
      knowledgeDir: r.requiredPath('TRIAGE_KNOWLEDGE_DIR'),
      fixturesDir: r.requiredPath('TRIAGE_FIXTURES_DIR'),
    },
    db: {
      provider,
      url: r.dbUrl(provider),
      retry: {
        attempts: r.requiredInt('TRIAGE_DB_RETRY_ATTEMPTS'),
        delayMs: r.requiredInt('TRIAGE_DB_RETRY_DELAY_MS'),
        maxDelayMs: r.requiredInt('TRIAGE_DB_RETRY_MAX_DELAY_MS'),
      },
    },
    runs: { retentionDays: r.int('TRIAGE_RUNS_RETENTION_DAYS'), priorCases: r.bool('TRIAGE_PRIOR_CASES') },
    approval: { mode: r.enumOf<ApprovalMode>('TRIAGE_APPROVAL_MODE') },
    mock: {
      enabled: r.bool('TRIAGE_MOCK_MODE'),
      strict: r.bool('TRIAGE_MOCK_STRICT'),
      record: r.bool('TRIAGE_RECORD_FIXTURES'),
    },
    budgets: {
      maxToolCallsPerRun: r.requiredInt('TRIAGE_MAX_TOOL_CALLS_PER_RUN'),
      maxTasksPerRun: r.requiredInt('TRIAGE_MAX_TASKS_PER_RUN'),
      maxAsksPerRun: r.requiredInt('TRIAGE_MAX_ASKS_PER_RUN'),
      maxResponseBytesPerCall: r.requiredInt('TRIAGE_MAX_RESPONSE_BYTES_PER_CALL'),
      maxBytesPerRun: r.requiredInt('TRIAGE_MAX_BYTES_PER_RUN'),
      runTimeoutMs: r.requiredInt('TRIAGE_RUN_TIMEOUT_MS'),
      runMaxAttempts: r.requiredInt('TRIAGE_RUN_MAX_ATTEMPTS'),
      httpTimeoutMs: r.requiredInt('TRIAGE_HTTP_TIMEOUT_MS'),
      defaultLookbackDays: r.requiredInt('TRIAGE_DEFAULT_LOOKBACK_DAYS'),
    },
    sql: {
      maxRows: r.requiredInt('TRIAGE_SQL_MAX_ROWS'),
      statementTimeoutMs: r.requiredInt('TRIAGE_SQL_STATEMENT_TIMEOUT_MS'),
      lockTimeoutMs: r.requiredInt('TRIAGE_SQL_LOCK_TIMEOUT_MS'),
      requireReadonlyRole: r.bool('TRIAGE_REQUIRE_READONLY_DB_ROLE'),
      retry: {
        attempts: r.requiredInt('TRIAGE_SQL_RETRY_ATTEMPTS'),
        delayMs: r.requiredInt('TRIAGE_SQL_RETRY_DELAY_MS'),
        maxDelayMs: r.requiredInt('TRIAGE_SQL_RETRY_MAX_DELAY_MS'),
      },
    },
    models: {
      classifier: r.str('MODEL_CLASSIFIER'),
      tierCheap: r.str('MODEL_TIER_CHEAP'),
      tierMid: r.str('MODEL_TIER_MID'),
      tierStrong: r.str('MODEL_TIER_STRONG'),
      codeWalker: r.str('MODEL_CODE_WALKER'),
      thinkingCheap: r.enumOf<ThinkingLevel>('MODEL_THINKING_CHEAP'),
      thinkingMid: r.enumOf<ThinkingLevel>('MODEL_THINKING_MID'),
      thinkingStrong: r.enumOf<ThinkingLevel>('MODEL_THINKING_STRONG'),
      embedding: r.str('MODEL_EMBEDDING'),
    },
    providers: {
      anthropicApiKey: r.str('ANTHROPIC_API_KEY'),
      openaiApiKey: r.str('OPENAI_API_KEY'),
      openrouterApiKey: r.str('OPENROUTER_API_KEY'),
      ollamaBaseUrl: r.str('OLLAMA_BASE_URL'),
    },
    evals: { judgeModel: r.str('TRIAGE_EVAL_JUDGE_MODEL'), maxCostUsd: r.num('TRIAGE_EVAL_MAX_COST_USD') },
    http: {
      port: r.requiredInt('TRIAGE_HTTP_PORT'),
      authToken: r.str('TRIAGE_HTTP_AUTH_TOKEN'),
      allowSlackPost: r.bool('TRIAGE_HTTP_ALLOW_SLACK_POST'),
    },
    ui: { env: r.enumOf<UiEnv>('TRIAGE_UI_ENV') },
    slack: {
      botToken: r.str('SLACK_BOT_TOKEN'),
      signingSecret: r.str('SLACK_SIGNING_SECRET'),
      reviewerEmail: r.str('SLACK_REVIEWER_EMAIL'),
      fallbackGroupHandle: r.str('SLACK_FALLBACK_GROUP_HANDLE'),
    },
    sandbox: {
      provider: r.enumOf<SandboxProvider>('TRIAGE_SANDBOX_PROVIDER'),
      python: r.bool('TRIAGE_SANDBOX_PYTHON'),
      timeoutMs: r.requiredInt('TRIAGE_SANDBOX_TIMEOUT_MS'),
      e2bApiKey: r.str('E2B_API_KEY'),
      daytonaApiKey: r.str('DAYTONA_API_KEY'),
      daytonaApiUrl: r.str('DAYTONA_API_URL'),
    },
    code: {
      codegraphBin: r.requiredStr('CODEGRAPH_BIN'),
      qwBin: r.requiredStr('QW_BIN'),
      syncBeforeQuery: r.bool('CODEGRAPH_SYNC_BEFORE_QUERY'),
    },
    git: {
      protocol: r.enumOf<GitProtocol>('TRIAGE_GIT_PROTOCOL'),
      host: r.matching('TRIAGE_GIT_HOST', GIT_HOST, 'must be a host name such as github.com'),
      org: r.matching('TRIAGE_GIT_ORG', GIT_ORG, 'must be a plain organisation name'),
      httpsToken: r.str('TRIAGE_GIT_HTTPS_TOKEN'),
    },
    repos: {
      syncIntervalMs: r.duration('TRIAGE_REPOS_SYNC_INTERVAL'),
      syncInterfaces: r.interfaces('TRIAGE_REPOS_SYNC_INTERFACES'),
    },
  };
  // Raw string, no enum check (D32): preflight warns on an unknown value.
  const deployMode = r.str(DEPLOY_MODE_KEY) ?? '';

  if (config.mock.enabled && config.mock.record) {
    r.problem('TRIAGE_RECORD_FIXTURES', 'requires TRIAGE_MOCK_MODE=false');
  }
  if (options.policyChecks !== false) {
    if (config.sandbox.provider === 'local') {
      r.problem('TRIAGE_SANDBOX_PROVIDER', 'local is refused (D45): it is not an isolation boundary; use virtual, e2b or daytona');
    }
    if (config.approval.mode === 'slack') {
      r.problem('TRIAGE_APPROVAL_MODE', 'slack is reserved for v2; use cli');
    }
  }
  if (r.problems.length > 0) throw new ConfigError(r.problems);

  seal(config, 'Config', () => Object.keys(rec).sort());
  hidden.set(config, { record: Object.freeze(rec), deployMode });
  return config;
}

/**
 * Looks up an entity key (SSFB_*, ATSPL_*, RTL_*) for the registry.
 * Keys in the keys.ts table are read through config instead, so they are refused here.
 */
export function lookupEnv(config: Config, name: string): EnvLookup {
  if (isTableKey(name)) throw ConfigError.of(name, 'is a config key; read it from config, not lookupEnv');
  const value = hiddenOf(config).record[name];
  if (value === undefined) return { state: 'missing' };
  if (value.trim() === '') return { state: 'blank' };
  return { state: 'set', value };
}

/** The only accessor for the deploy mode. Used by src/ops/preflight.ts alone. */
export function deployModeForPreflight(config: Config): string {
  return hiddenOf(config).deployMode;
}

export type EnvFileKeyState = 'missing' | 'blank' | 'set';

/**
 * Whether an entity key is in <home>/.env as the file is now, not as it was at
 * boot. The catalog uses it before it writes a registry entry that names the
 * key: the registry refuses to boot when a named key is absent, and an
 * operator may have just added it without restarting. Never returns the value.
 * An unreadable .env counts as missing, which makes the caller refuse.
 */
export function envFileKeyState(config: Config, name: string): EnvFileKeyState {
  if (isTableKey(name)) throw ConfigError.of(name, 'is a config key; read it from config, not envFileKeyState');
  if (!ENTITY_KEY_PATTERN.test(name)) throw ConfigError.of(name, 'is not an entity key');
  let fromFile: Record<string, string>;
  try {
    fromFile = parse(readFileSync(join(config.home, '.env'), 'utf8'));
  } catch {
    return 'missing';
  }
  const value = fromFile[name];
  if (value === undefined) return 'missing';
  return value.trim() === '' ? 'blank' : 'set';
}

export type RawKeyState = 'missing' | 'empty' | 'set';

/**
 * Whether a key had any characters in the parsed .env, before trimming or
 * defaults. Works for every key and never returns the value. The eval home
 * guard uses it, because there a whitespace-only credential still counts as
 * set (D42).
 */
export function rawKeyState(config: Config, name: string): RawKeyState {
  const value = hiddenOf(config).record[name];
  if (value === undefined) return 'missing';
  return value === '' ? 'empty' : 'set';
}

/** Non-blank provider credentials, by the env names pi-ai reads. */
export function providerEnv(config: Config): Readonly<Record<string, string>> {
  const values: Record<(typeof PROVIDER_KEYS)[number], string | undefined> = {
    ANTHROPIC_API_KEY: config.providers.anthropicApiKey,
    OPENAI_API_KEY: config.providers.openaiApiKey,
    OPENROUTER_API_KEY: config.providers.openrouterApiKey,
  };
  const out: Record<string, string> = {};
  for (const name of PROVIDER_KEYS) {
    const value = values[name];
    if (value !== undefined) out[name] = value;
  }
  return Object.freeze(out);
}

/** Copies non-blank provider credentials into process.env in memory. Returns the key names set. */
export function applyProviderEnv(config: Config): readonly string[] {
  const env = providerEnv(config);
  for (const [name, value] of Object.entries(env)) process.env[name] = value;
  return Object.freeze(Object.keys(env));
}

function hiddenOf(config: Config): Hidden {
  const h = hidden.get(config);
  if (h === undefined) throw ConfigError.of('config', 'was not built by loadConfig or configFromRecord');
  return h;
}

// Adds name-only toJSON and inspect output, then freezes, for every nested plain object.
function seal(obj: object, label: string, names: () => string[]): void {
  for (const [key, value] of Object.entries(obj)) {
    if (Array.isArray(value)) Object.freeze(value);
    else if (value !== null && typeof value === 'object') seal(value, `${label}.${key}`, () => Object.keys(value));
  }
  Object.defineProperty(obj, 'toJSON', { value: () => ({ [label]: names() }), enumerable: false });
  Object.defineProperty(obj, INSPECT, { value: () => `${label} { ${names().join(', ')} }`, enumerable: false });
  Object.freeze(obj);
}

const DSN = /^postgres(ql)?:\/\//i;
// Host and organisation for built clone URLs; they end up in a git argv.
const GIT_HOST = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*$/;
const GIT_ORG = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const DURATION = /^(\d{1,6})(m|h|d)$/;
const UNIT_MS: Readonly<Record<string, number>> = { m: 60_000, h: 3_600_000, d: 86_400_000 };
const MIN_DURATION_MS = 60_000;
const MAX_DURATION_MS = 365 * 86_400_000;

// Reads typed values from the record. Problems are collected so one error lists every bad key.
class Reader {
  readonly problems: ConfigProblem[] = [];
  private readonly rec: Readonly<Record<string, string>>;
  private readonly home: string;

  constructor(rec: Readonly<Record<string, string>>, home: string) {
    this.rec = rec;
    this.home = home;
  }

  problem(key: string, reason: string): void {
    this.problems.push({ key, reason });
  }

  // Blank or missing gives the default from keys.ts, or undefined.
  private raw(name: string, type: KeySpec['type']): { spec: KeySpec; value?: string } {
    const spec = KEY_BY_NAME.get(name);
    if (spec === undefined || spec.type !== type) throw new Error(`keys.ts has no ${type} key ${name}`);
    const v = this.rec[name]?.trim();
    return { spec, value: v === undefined || v === '' ? spec.default : v };
  }

  str(name: string): string | undefined {
    return this.raw(name, 'string').value;
  }

  requiredStr(name: string): string {
    const v = this.str(name);
    if (v === undefined) this.problem(name, 'is required');
    return v ?? '';
  }

  // '30m', '6h', '1d': minutes, hours or days, from one minute to a year.
  duration(name: string): number {
    const m = DURATION.exec((this.raw(name, 'duration').value ?? '').toLowerCase());
    const ms = m === null ? NaN : Number(m[1]) * (UNIT_MS[m[2] as string] as number);
    if (!(ms >= MIN_DURATION_MS && ms <= MAX_DURATION_MS)) {
      this.problem(name, 'must be a duration from 1m to 365d, such as 30m, 6h or 1d');
      return UNIT_MS['d'] as number;
    }
    return ms;
  }

  // Interface names from src/types/core.ts, or 'none' alone for an empty list.
  interfaces(name: string): Interface[] {
    const list = this.csv(name).map((s) => s.toLowerCase());
    if (list.length === 1 && list[0] === 'none') return [];
    const known = list.filter((s): s is Interface => (INTERFACES as readonly string[]).includes(s));
    if (known.length !== list.length) this.problem(name, `must list ${INTERFACES.join(', ')}, or be none`);
    return known;
  }

  // A required string that must match the pattern. The reason never echoes the value.
  matching(name: string, pattern: RegExp, reason: string): string {
    const v = this.requiredStr(name);
    if (v !== '' && !pattern.test(v)) this.problem(name, reason);
    return v;
  }

  bool(name: string): boolean {
    const { value } = this.raw(name, 'bool');
    const v = value?.toLowerCase();
    if (v === 'true') return true;
    if (v === 'false') return false;
    this.problem(name, 'must be true or false');
    return false;
  }

  int(name: string): number | undefined {
    const { spec, value } = this.raw(name, 'int');
    if (value === undefined) return undefined;
    if (!/^\d+$/.test(value)) {
      this.problem(name, 'must be a whole number');
      return undefined;
    }
    return this.bounded(spec, Number(value));
  }

  requiredInt(name: string): number {
    const v = this.int(name);
    if (v === undefined && !this.problems.some((p) => p.key === name)) this.problem(name, 'is required');
    return v ?? 0;
  }

  num(name: string): number | undefined {
    const { spec, value } = this.raw(name, 'number');
    if (value === undefined) return undefined;
    if (!/^\d+(\.\d+)?$/.test(value)) {
      this.problem(name, 'must be a number');
      return undefined;
    }
    return this.bounded(spec, Number(value));
  }

  enumOf<T extends string>(name: string): T {
    const { spec, value } = this.raw(name, 'enum');
    const allowed = spec.values ?? [];
    if (value !== undefined && allowed.includes(value)) return value as T;
    this.problem(name, `must be one of ${allowed.join(', ')}`);
    return (spec.default ?? allowed[0]) as T;
  }

  csv(name: string): string[] {
    const { value } = this.raw(name, 'csv');
    if (value === undefined) return [];
    return [...new Set(value.split(',').map((s) => s.trim()).filter((s) => s !== ''))];
  }

  path(name: string): string | undefined {
    const { value } = this.raw(name, 'path');
    return value === undefined ? undefined : resolve(this.home, value);
  }

  requiredPath(name: string): string {
    const v = this.path(name);
    if (v === undefined) this.problem(name, 'is required');
    return v ?? this.home;
  }

  // A file path under the home for sqlite, a postgresql:// DSN for postgres.
  dbUrl(provider: DbProvider): string {
    const name = 'TRIAGE_DB_URL';
    const spec = KEY_BY_NAME.get(name);
    const set = this.rec[name]?.trim();
    const value = set === undefined || set === '' ? undefined : set;
    if (provider === 'postgres') {
      if (value === undefined || !DSN.test(value)) {
        this.problem(name, 'must be a postgresql:// DSN when TRIAGE_DB_PROVIDER=postgres');
        return '';
      }
      return value;
    }
    if (value !== undefined && DSN.test(value)) {
      this.problem(name, 'is a postgres DSN but TRIAGE_DB_PROVIDER=sqlite');
      return '';
    }
    const file = value ?? spec?.default ?? './.data/triage.sqlite';
    return file === ':memory:' ? file : resolve(this.home, file);
  }

  private bounded(spec: KeySpec, n: number): number | undefined {
    if ((spec.min !== undefined && n < spec.min) || (spec.max !== undefined && n > spec.max)) {
      const range =
        spec.max === undefined ? `at least ${spec.min}` : `between ${spec.min ?? 0} and ${spec.max}`;
      this.problem(spec.name, `must be ${range}`);
      return undefined;
    }
    return n;
  }
}
