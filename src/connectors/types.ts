// The contract every connector shares (T04). Connectors are plain modules
// that do the real I/O for a tool: Postgres, admin HTTP, Quickwit, CBS and
// the local binaries. They are not Flue tools. A tool builds a
// ConnectorContext inside its run() and passes Flue's signal through it.
//
// Connectors that shell out take an ExecRunner (src/connectors/exec.ts) as an
// argument and never import child_process themselves.
import type { FixtureKind } from '../mock/types.ts';
import type { MockPort } from './mock.ts';

export type Transport = 'real' | 'mock';

export type ConnectorContext = {
  /** The signal from the tool's run(). Every async step takes it. */
  readonly signal: AbortSignal;
  /** Clock for taken_at and duration_ms. */
  now(): Date;
  /** Fixture lookup and recording. See src/connectors/mock.ts. */
  readonly mock: MockPort;
  readonly runId: string;
  /** Ingress-collected names for the persisted redaction profile used when recording (D24). */
  readonly redactionNames?: readonly string[];
};

// An env var name such as SSFB_DB_HARBOR_DSN. The brand means a plain string,
// a DSN or a URL cannot be put in target_env without going through
// envVarName(), which checks the shape.
declare const envVarNameBrand: unique symbol;
export type EnvVarName = string & { readonly [envVarNameBrand]: true };

const ENV_VAR_NAME = /^[A-Z][A-Z0-9_]{0,127}$/;

export class InvalidEnvVarNameError extends Error {
  override readonly name = 'InvalidEnvVarNameError';

  constructor() {
    // The rejected value is left out on purpose: it may be a DSN or a token.
    super('target_env must be an env var name (A-Z, 0-9 and _), never a value');
  }
}

export function isEnvVarName(value: unknown): value is EnvVarName {
  return typeof value === 'string' && ENV_VAR_NAME.test(value);
}

export function envVarName(value: string): EnvVarName {
  if (!isEnvVarName(value)) throw new InvalidEnvVarNameError();
  return value;
}

/**
 * What a connector returns. It carries the env var NAME the target came
 * from, never the value, so audit lines and reports can say which config was
 * used without holding a DSN, URL or token (D20).
 */
export type ConnectorResult<T> = {
  readonly data: T;
  readonly transport: Transport;
  readonly target_env: EnvVarName;
  /** ISO time the call started. */
  readonly taken_at: string;
  readonly duration_ms: number;
  /** Set when the connector hit a size cap and cut the data. */
  readonly truncated?: boolean;
  readonly fixture_miss?: false;
};

/** A non-strict mock miss. The tool renders it as an empty result. */
export type FixtureNotFound = {
  readonly code: 'fixture_not_found';
  readonly kind: FixtureKind;
  readonly key_string: string;
  readonly hash: string;
  readonly message: string;
};

export type ConnectorMiss = {
  readonly data: null;
  readonly transport: 'mock';
  readonly target_env: EnvVarName;
  readonly taken_at: string;
  readonly duration_ms: number;
  readonly fixture_miss: true;
  readonly error: FixtureNotFound;
};

/** What withMock() returns: a result, or a non-strict mock miss. */
export type ConnectorOutcome<T> = ConnectorResult<T> | ConnectorMiss;

export const CONNECTOR_ERROR_CODES = [
  'not_configured',
  'unreachable',
  'timeout',
  'refused',
  'strict_miss',
  'readonly_role_required',
  'cap_exceeded',
] as const;
export type ConnectorErrorCode = (typeof CONNECTOR_ERROR_CODES)[number];

export type ConnectorErrorOptions = {
  readonly cause?: unknown;
  /** Set on strict_miss: which fixture was missing. */
  readonly fixture?: { readonly kind: FixtureKind; readonly key_string: string; readonly hash: string };
};

/**
 * A connector failure. Messages name env var names, entities, services and
 * semantic keys, never a DSN, URL, token or other env value.
 */
export class ConnectorError extends Error {
  override readonly name = 'ConnectorError';
  readonly code: ConnectorErrorCode;
  readonly fixture?: ConnectorErrorOptions['fixture'];

  constructor(code: ConnectorErrorCode, message: string, options: ConnectorErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.code = code;
    if (options.fixture !== undefined) this.fixture = Object.freeze({ ...options.fixture });
  }
}

export function isConnectorError(err: unknown, code?: ConnectorErrorCode): err is ConnectorError {
  return err instanceof ConnectorError && (code === undefined || err.code === code);
}

// Hard ceilings on what a connector reads before it stops and sets truncated
// (or throws cap_exceeded where cutting would give a wrong answer). The
// per-call and per-run budgets in config (TRIAGE_MAX_RESPONSE_BYTES_PER_CALL,
// TRIAGE_MAX_BYTES_PER_RUN) apply later, in the tools.
export const MAX_SQL_RESULT_BYTES = 8 * 1024 * 1024;
export const MAX_HTTP_BODY_BYTES = 4 * 1024 * 1024;
/** Per stream. Kept equal to DEFAULT_MAX_OUTPUT_BYTES in exec.ts (a test checks it) without importing the runner here. */
export const MAX_EXEC_OUTPUT_BYTES = 10 * 1024 * 1024;
