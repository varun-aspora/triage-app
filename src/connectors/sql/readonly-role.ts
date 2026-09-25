// Read-only role check for the SQL connector (D33, Q6, Q23).
//
// The check asks Postgres two things in one fixed statement: whether the
// server is a replica (pg_is_in_recovery()), and whether the connected role
// holds INSERT, UPDATE or DELETE on any user table. It runs inside the same
// BEGIN READ ONLY / SET LOCAL wrapper as every other call, so the check
// itself can never write.
//
// Policy: the check runs once per env var name per process. A replica cannot
// write whatever the role's grants are, so a reader passes without a warning
// or a block. On a primary, a writable role is a warning by default, which
// the tool and doctor can surface; with TRIAGE_REQUIRE_READONLY_DB_ROLE=true
// it blocks real calls with readonly_role_required. The server is asked
// rather than the host name matched: the DSN often points at a local tunnel
// port, and an Aurora reader endpoint routes to the writer when the cluster
// has no replicas. The connector in pg-client.ts wires this in; this file
// holds the statement, the cache and the policy.
import type { Entity } from '../../types/core.ts';
import { ConnectorError, type ConnectorContext, type EnvVarName } from '../types.ts';

/** The one statement the role check runs. Trusted constant, no parameters. */
export const ROLE_CHECK_SQL = [
  'SELECT pg_is_in_recovery() AS reader, coalesce(bool_or(',
  "  has_table_privilege(c.oid, 'INSERT')",
  "  OR has_table_privilege(c.oid, 'UPDATE')",
  "  OR has_table_privilege(c.oid, 'DELETE')",
  '), false) AS writable',
  'FROM pg_catalog.pg_class c',
  'JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace',
  "WHERE c.relkind IN ('r', 'p')",
  "  AND n.nspname <> 'information_schema'",
  "  AND n.nspname NOT LIKE 'pg\\_%'",
].join('\n');

export type RoleCheck = {
  /** The role holds INSERT, UPDATE or DELETE on some user table. */
  readonly writable: boolean;
  /** The server is a replica (pg_is_in_recovery()), so it cannot write whatever the role holds. */
  readonly reader: boolean;
  readonly target_env: EnvVarName;
};

export type RolePolicyOutcome = RoleCheck & {
  /** Set when the role can write and the policy only warns. Names env vars, never values. */
  readonly warning?: string;
};

/** Runs ROLE_CHECK_SQL for one entity and service in real mode. Supplied by the connector. */
export type RoleCheckRunner = (ctx: ConnectorContext, entity: Entity, service: string) => Promise<RoleCheck>;

/**
 * Remembers one role check per env var name. Failed checks are dropped so the
 * next call tries again. Concurrent first calls share one check.
 */
export class RoleCheckCache {
  readonly #checks = new Map<string, Promise<RoleCheck>>();

  get(envName: string, run: () => Promise<RoleCheck>): Promise<RoleCheck> {
    const known = this.#checks.get(envName);
    if (known !== undefined) return known;
    const pending = run();
    this.#checks.set(envName, pending);
    pending.catch(() => {
      if (this.#checks.get(envName) === pending) this.#checks.delete(envName);
    });
    return pending;
  }

  has(envName: string): boolean {
    return this.#checks.has(envName);
  }

  clear(): void {
    this.#checks.clear();
  }
}

/** The cache every connector uses unless it is given its own (tests do). */
export const processRoleCache = new RoleCheckCache();

/** Reads the two flags from the role check's single row. Anything else is an error, not a guess. */
export function parseRoleCheckRows(rows: readonly Record<string, unknown>[]): { writable: boolean; reader: boolean } {
  const row = rows.length === 1 ? rows[0] : undefined;
  const writable = row?.['writable'];
  const reader = row?.['reader'];
  if (typeof writable !== 'boolean' || typeof reader !== 'boolean') {
    throw new ConnectorError('refused', 'the read-only role check returned an unexpected result');
  }
  return { writable, reader };
}

export function writableRoleWarning(entity: Entity, service: string, target_env: EnvVarName): string {
  return (
    `the role behind ${target_env} (${entity}:${service}) can INSERT, UPDATE or DELETE on some tables. ` +
    'Calls still run in a read-only transaction. Set TRIAGE_REQUIRE_READONLY_DB_ROLE=true to block real calls until a read-only role is set up.'
  );
}

export type RolePolicyOptions = {
  readonly requireReadonlyRole: boolean;
  readonly runCheck: RoleCheckRunner;
  /** The env var name for entity:service. Resolving it is the connector's job. */
  readonly envNameOf: (entity: Entity, service: string) => EnvVarName;
  readonly cache?: RoleCheckCache;
};

export type RolePolicy = {
  /** Runs the check now, without the cache and without applying the policy. */
  checkReadOnlyRole(ctx: ConnectorContext, entity: Entity, service: string): Promise<RoleCheck>;
  /**
   * Runs the check once per env var name, then applies the policy: a replica
   * passes; on a primary it throws readonly_role_required when the role can
   * write and the policy blocks, otherwise returns the outcome with a warning
   * when the role can write.
   */
  enforceRolePolicy(ctx: ConnectorContext, entity: Entity, service: string): Promise<RolePolicyOutcome>;
};

export function createRolePolicy(options: RolePolicyOptions): RolePolicy {
  const cache = options.cache ?? processRoleCache;

  function checkReadOnlyRole(ctx: ConnectorContext, entity: Entity, service: string): Promise<RoleCheck> {
    return options.runCheck(ctx, entity, service);
  }

  async function enforceRolePolicy(ctx: ConnectorContext, entity: Entity, service: string): Promise<RolePolicyOutcome> {
    const envName = options.envNameOf(entity, service);
    const check = await cache.get(envName, () => options.runCheck(ctx, entity, service));
    if (!check.writable || check.reader) {
      return Object.freeze({ writable: check.writable, reader: check.reader, target_env: check.target_env });
    }
    if (options.requireReadonlyRole) {
      throw new ConnectorError(
        'readonly_role_required',
        `real calls on ${entity}:${service} are blocked: the role behind ${check.target_env} can write and ` +
          'TRIAGE_REQUIRE_READONLY_DB_ROLE=true',
      );
    }
    return Object.freeze({
      writable: true,
      reader: false,
      target_env: check.target_env,
      warning: writableRoleWarning(entity, service, check.target_env),
    });
  }

  return Object.freeze({ checkReadOnlyRole, enforceRolePolicy });
}
