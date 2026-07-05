import { readFileSync } from "node:fs";
import { Pool, type PoolClient, type PoolConfig } from "pg";

export type DatabaseSslMode = "disable" | "require" | "verify-full";

/**
 * Build a node-pg `ssl` config from a mode. `require` encrypts without verifying
 * the server cert (fine when the CA isn't distributed); `verify-full` verifies
 * against the system CAs, or `caPath` if given. `disable` = no TLS.
 */
export function resolveSsl(
  mode: DatabaseSslMode,
  caPath?: string,
): PoolConfig["ssl"] {
  if (mode === "disable") return undefined;
  if (mode === "require") return { rejectUnauthorized: false };
  return {
    rejectUnauthorized: true,
    ...(caPath ? { ca: readFileSync(caPath, "utf8") } : {}),
  };
}

export interface CreatePoolOptions {
  /** Max pooled connections per process. */
  max?: number;
  /** Fail a checkout after this long instead of waiting forever. */
  connectionTimeoutMillis?: number;
  /** Close idle clients after this long. */
  idleTimeoutMillis?: number;
  /** Server- and client-side per-query timeout so a stuck query can't wedge a connection. */
  statementTimeoutMillis?: number;
  /** TLS config for the DB connection (undefined = no TLS). */
  ssl?: PoolConfig["ssl"];
  /** Where to report idle-client errors; defaults to console. */
  onError?: (err: Error) => void;
}

/**
 * Create a Postgres connection pool from a connection string.
 *
 * The pool is explicitly bounded and time-limited: without `connectionTimeoutMillis`
 * a checkout waits forever when the pool is saturated, and without a statement
 * timeout a single stuck query holds a connection indefinitely. The `'error'`
 * handler is mandatory — node-pg emits `'error'` on idle clients when the server
 * drops the connection (failover, restart), and an unhandled EventEmitter
 * `'error'` crashes the process.
 */
export function createPool(
  connectionString: string,
  options: CreatePoolOptions = {},
): Pool {
  const statementTimeout = options.statementTimeoutMillis ?? 30_000;
  const pool = new Pool({
    connectionString,
    max: options.max ?? 10,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 5_000,
    idleTimeoutMillis: options.idleTimeoutMillis ?? 30_000,
    // statement_timeout is enforced server-side; query_timeout is the client-side
    // backstop if the server never responds at all.
    statement_timeout: statementTimeout,
    query_timeout: statementTimeout,
    ssl: options.ssl,
  });

  const onError = options.onError ?? ((err: Error) => {
    console.error("postgres idle client error", err);
  });
  pool.on("error", onError);

  return pool;
}

export async function assertPoolReachable(pool: Pool): Promise<void> {
  await pool.query("SELECT 1");
}

/**
 * Run `fn` inside a single transaction on one pooled client: BEGIN (with an
 * optional `SET LOCAL lock_timeout`), then COMMIT, rolling back and releasing
 * the client on any error. Centralizes the connect/BEGIN/COMMIT/ROLLBACK/release
 * lifecycle so the several budget operations don't each hand-copy it (and can't
 * drift on, e.g., the lock timeout or the release-in-finally).
 */
export async function withTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
  opts: { lockTimeoutMs?: number } = {},
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (opts.lockTimeoutMs != null) {
      // SET does not accept bind parameters; set_config(..., is_local=true) is
      // the parameterized, transaction-scoped equivalent. lock_timeout with no
      // unit is milliseconds.
      await client.query("SELECT set_config('lock_timeout', $1, true)", [
        String(Math.floor(opts.lockTimeoutMs)),
      ]);
    }
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Consume a reservation's single-use lease row inside the caller's transaction,
 * returning whether THIS call actually removed it — i.e. the hold is still ours
 * to settle or free.
 *
 * This is the one home for the money-safety invariant that every reservation
 * ledger (flat budget counters, hierarchical budget nodes, the credit wallet)
 * depends on: the lease row is the authoritative single-use token for a hold, so
 * the settle/release MUST be gated on this delete. If the row is already gone the
 * caller must treat its operation as a no-op — either a retried settle that
 * already committed (booking again would double-charge) or the stale-lease sweep
 * freed the hold (releasing again would double-free a shared counter and let
 * other in-flight requests overshoot the cap). Deleting the lease before touching
 * the counters also keeps a consistent lease→counter lock order with the sweep.
 *
 * A missing `leaseId` means leases are disabled for this caller, which preserves
 * the legacy always-apply behaviour (returns true). Each caller keeps its own
 * downstream ledger mutation — this only centralizes the token-consume step and
 * its rationale, not the per-ledger settle semantics (which legitimately differ:
 * the flat path skips both the used-book and the release when swept, whereas the
 * hierarchical path still books used and only skips the release).
 */
export async function consumeReservationLease(
  client: PoolClient,
  deleteSql: string,
  leaseId?: string,
): Promise<boolean> {
  if (!leaseId) return true;
  const del = await client.query(deleteSql, [leaseId]);
  return (del.rowCount ?? 0) > 0;
}

/**
 * Run `fn` inside a transaction with the RLS tenant context set for its duration:
 * `app.current_tenant` is set with `is_local=true` so it is scoped to this
 * transaction on this pooled connection and cannot leak to the next checkout.
 * The RLS policy on `config_versions` filters on this setting (see db/rls.ts).
 */
export async function withTenantContext<T>(
  pool: Pool,
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withTransaction(pool, async (client) => {
    await client.query("SELECT set_config('app.current_tenant', $1, true)", [tenantId]);
    return fn(client);
  });
}

export type { Pool, PoolClient } from "pg";
