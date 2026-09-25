// Every non-entity key in .env.example, with its type, default and group.
// Entity keys (SSFB_*, ATSPL_*, RTL_*) are not listed here: the registry
// resolves them through lookupEnv. A test keeps this table and .env.example
// in sync, including each default.

export type KeyType = 'string' | 'int' | 'number' | 'bool' | 'enum' | 'path' | 'csv' | 'duration';

export type KeyGroup =
  | 'runtime'
  | 'persistence'
  | 'runstore'
  | 'approval'
  | 'mock'
  | 'budgets'
  | 'sql'
  | 'models'
  | 'providers'
  | 'evals'
  | 'http'
  | 'slack'
  | 'sandbox'
  | 'code'
  | 'repos';

export type KeySpec = {
  readonly name: string;
  readonly type: KeyType;
  readonly group: KeyGroup;
  /** Raw value used when the key is missing or blank. No default means undefined. */
  readonly default?: string;
  /** Value shown in .env.example when it differs from the default (blank means something else). */
  readonly example?: string;
  /** Allowed values for enum keys. */
  readonly values?: readonly string[];
  /** Inclusive bounds for int and number keys. */
  readonly min?: number;
  readonly max?: number;
  /** Credential. Never printed; test homes blank it. */
  readonly secret?: boolean;
  /** Read from the shell only; a value in .env is ignored. */
  readonly shellOnly?: boolean;
};

/** Entity keys match this and are resolved by the registry, not by this table. */
export const ENTITY_KEY_PATTERN = /^(SSFB|ATSPL|RTL)_/;

export const HOME_KEY = 'TRIAGE_HOME';

/** Read only through deployModeForPreflight (D32). A source guard allows this string here and in preflight only. */
export const DEPLOY_MODE_KEY = 'TRIAGE_DEPLOY_MODE';

export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/** Provider credentials copied into process.env for pi-ai by applyProviderEnv. */
export const PROVIDER_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY'] as const;

export const KEYS: readonly KeySpec[] = [
  // Runtime
  { name: HOME_KEY, type: 'path', group: 'runtime', shellOnly: true },
  { name: 'TRIAGE_ENV_LABEL', type: 'string', group: 'runtime' },
  // Kept as a raw string with no enum check: an unknown value reaches preflight, which warns (D32).
  { name: DEPLOY_MODE_KEY, type: 'string', group: 'runtime', default: 'local' },
  { name: 'TRIAGE_ENTITIES', type: 'csv', group: 'runtime', default: 'ssfb,atspl,rtl' },
  { name: 'TRIAGE_DATA_DIR', type: 'path', group: 'runtime', default: './.data' },
  { name: 'TRIAGE_AUDIT_LOG', type: 'path', group: 'runtime', default: './.data/audit.jsonl' },
  { name: 'TRIAGE_RUNS_DIR', type: 'path', group: 'runtime', default: './.data/runs' },
  { name: 'TRIAGE_REPOS_DIR', type: 'path', group: 'runtime', example: './data/repos' },
  { name: 'TRIAGE_KNOWLEDGE_DIR', type: 'path', group: 'runtime', default: './knowledge' },

  // Flue persistence (D38). TRIAGE_DB_URL is a path for sqlite and a DSN for postgres.
  { name: 'TRIAGE_DB_PROVIDER', type: 'enum', group: 'persistence', default: 'sqlite', values: ['sqlite', 'postgres'] },
  { name: 'TRIAGE_DB_URL', type: 'string', group: 'persistence', default: './.data/triage.sqlite', secret: true },

  // Run store (D43). Blank retention means keep.
  { name: 'TRIAGE_RUNS_RETENTION_DAYS', type: 'int', group: 'runstore', example: '365', min: 1 },
  { name: 'TRIAGE_PRIOR_CASES', type: 'bool', group: 'runstore', default: 'false' },

  // Approval (D39). slack is parsed so the policy check can refuse it by name.
  { name: 'TRIAGE_APPROVAL_MODE', type: 'enum', group: 'approval', default: 'cli', values: ['cli', 'slack'] },

  // Mock mode (D19, D27)
  { name: 'TRIAGE_MOCK_MODE', type: 'bool', group: 'mock', default: 'true' },
  { name: 'TRIAGE_MOCK_STRICT', type: 'bool', group: 'mock', default: 'true' },
  { name: 'TRIAGE_RECORD_FIXTURES', type: 'bool', group: 'mock', default: 'false' },
  { name: 'TRIAGE_FIXTURES_DIR', type: 'path', group: 'mock', default: './fixtures' },

  // Per-run budgets
  { name: 'TRIAGE_MAX_TOOL_CALLS_PER_RUN', type: 'int', group: 'budgets', default: '120', min: 1 },
  { name: 'TRIAGE_MAX_TASKS_PER_RUN', type: 'int', group: 'budgets', default: '12', min: 0 },
  { name: 'TRIAGE_MAX_ASKS_PER_RUN', type: 'int', group: 'budgets', default: '2', min: 0 },
  { name: 'TRIAGE_MAX_RESPONSE_BYTES_PER_CALL', type: 'int', group: 'budgets', default: '1048576', min: 1 },
  { name: 'TRIAGE_MAX_BYTES_PER_RUN', type: 'int', group: 'budgets', default: '20971520', min: 1 },
  { name: 'TRIAGE_RUN_TIMEOUT_MS', type: 'int', group: 'budgets', default: '900000', min: 1 },
  { name: 'TRIAGE_RUN_MAX_ATTEMPTS', type: 'int', group: 'budgets', default: '2', min: 1 },
  { name: 'TRIAGE_HTTP_TIMEOUT_MS', type: 'int', group: 'budgets', default: '30000', min: 1 },
  { name: 'TRIAGE_DEFAULT_LOOKBACK_DAYS', type: 'int', group: 'budgets', default: '7', min: 1 },

  // SQL (D33)
  { name: 'TRIAGE_SQL_MAX_ROWS', type: 'int', group: 'sql', default: '200', min: 1 },
  { name: 'TRIAGE_SQL_STATEMENT_TIMEOUT_MS', type: 'int', group: 'sql', default: '30000', min: 1 },
  { name: 'TRIAGE_SQL_LOCK_TIMEOUT_MS', type: 'int', group: 'sql', default: '2000', min: 1 },
  { name: 'TRIAGE_REQUIRE_READONLY_DB_ROLE', type: 'bool', group: 'sql', default: 'false' },

  // Models. Specs are parsed by src/models.ts; blank MODEL_CODE_WALKER falls back to the strong tier there.
  { name: 'MODEL_CLASSIFIER', type: 'string', group: 'models', example: 'openrouter/typesafe/jev-1.13' },
  { name: 'MODEL_TIER_CHEAP', type: 'string', group: 'models', example: 'openai/gpt-6-luna' },
  { name: 'MODEL_TIER_MID', type: 'string', group: 'models', example: 'openai/gpt-6-sol' },
  { name: 'MODEL_TIER_STRONG', type: 'string', group: 'models', example: 'openai/gpt-6-sol' },
  { name: 'MODEL_CODE_WALKER', type: 'string', group: 'models', example: 'openai/gpt-6-sol' },
  { name: 'MODEL_THINKING_CHEAP', type: 'enum', group: 'models', example: 'low', default: 'off', values: THINKING_LEVELS },
  { name: 'MODEL_THINKING_MID', type: 'enum', group: 'models', example: 'medium', default: 'low', values: THINKING_LEVELS },
  { name: 'MODEL_THINKING_STRONG', type: 'enum', group: 'models', default: 'high', values: THINKING_LEVELS },
  { name: 'MODEL_EMBEDDING', type: 'string', group: 'models', example: 'openai/text-embedding-3-small' },

  // Provider credentials
  { name: 'ANTHROPIC_API_KEY', type: 'string', group: 'providers', secret: true },
  { name: 'OPENAI_API_KEY', type: 'string', group: 'providers', secret: true },
  { name: 'OPENROUTER_API_KEY', type: 'string', group: 'providers', secret: true },
  { name: 'OLLAMA_BASE_URL', type: 'string', group: 'providers' },

  // Evals (D42)
  { name: 'TRIAGE_EVAL_JUDGE_MODEL', type: 'string', group: 'evals', example: 'openai/gpt-6-sol' },
  { name: 'TRIAGE_EVAL_MAX_COST_USD', type: 'number', group: 'evals', min: 0 },

  // HTTP API
  { name: 'TRIAGE_HTTP_PORT', type: 'int', group: 'http', default: '3000', min: 1, max: 65535 },
  { name: 'TRIAGE_HTTP_AUTH_TOKEN', type: 'string', group: 'http', secret: true },
  { name: 'TRIAGE_HTTP_ALLOW_SLACK_POST', type: 'bool', group: 'http', default: 'false' },

  // Slack
  { name: 'SLACK_BOT_TOKEN', type: 'string', group: 'slack', secret: true },
  { name: 'SLACK_SIGNING_SECRET', type: 'string', group: 'slack', secret: true },
  { name: 'SLACK_REVIEWER_EMAIL', type: 'string', group: 'slack' },
  { name: 'SLACK_FALLBACK_GROUP_HANDLE', type: 'string', group: 'slack' },

  // Sandbox (D45). local is parsed so the policy check can refuse it by name.
  { name: 'TRIAGE_SANDBOX_PROVIDER', type: 'enum', group: 'sandbox', default: 'virtual', values: ['virtual', 'e2b', 'daytona', 'local'] },
  { name: 'TRIAGE_SANDBOX_PYTHON', type: 'bool', group: 'sandbox', default: 'true' },
  { name: 'TRIAGE_SANDBOX_TIMEOUT_MS', type: 'int', group: 'sandbox', default: '30000', min: 1 },
  { name: 'E2B_API_KEY', type: 'string', group: 'sandbox', secret: true },
  { name: 'DAYTONA_API_KEY', type: 'string', group: 'sandbox', secret: true },
  { name: 'DAYTONA_API_URL', type: 'string', group: 'sandbox' },

  // Code navigation. Binary names are looked up on PATH, so they are strings, not paths.
  { name: 'CODEGRAPH_BIN', type: 'string', group: 'code', default: 'codegraph' },
  { name: 'QW_BIN', type: 'string', group: 'code', default: 'qw' },
  { name: 'CODEGRAPH_SYNC_BEFORE_QUERY', type: 'bool', group: 'code', default: 'true' },

  // Repo checkouts (D37, D46). A pin in resources/repos.json without a remote is cloned from
  // <protocol> + TRIAGE_GIT_HOST + TRIAGE_GIT_ORG + <repo>. The token is sent to git through
  // its environment, never in argv, a URL or .git/config.
  { name: 'TRIAGE_GIT_PROTOCOL', type: 'enum', group: 'repos', default: 'ssh', values: ['ssh', 'https'] },
  { name: 'TRIAGE_GIT_HOST', type: 'string', group: 'repos', default: 'github.com' },
  { name: 'TRIAGE_GIT_ORG', type: 'string', group: 'repos', default: 'Vance-Club' },
  { name: 'TRIAGE_GIT_HTTPS_TOKEN', type: 'string', group: 'repos', secret: true },
  // Automatic sync (D47): the longest the checkouts may go without a sync, and the interfaces
  // where it runs. http is the server's timer plus runs sent over HTTP; the others are runs
  // started there. none turns it off.
  { name: 'TRIAGE_REPOS_SYNC_INTERVAL', type: 'duration', group: 'repos', default: '24h' },
  { name: 'TRIAGE_REPOS_SYNC_INTERFACES', type: 'csv', group: 'repos', default: 'cli,http,claude-code,slack' },
];

export const KEY_BY_NAME: ReadonlyMap<string, KeySpec> = new Map(KEYS.map((k) => [k.name, k]));

export function isTableKey(name: string): boolean {
  return KEY_BY_NAME.has(name);
}

export function isEntityKey(name: string): boolean {
  return ENTITY_KEY_PATTERN.test(name);
}
