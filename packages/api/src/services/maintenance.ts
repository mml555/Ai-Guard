import type { FastifyBaseLogger } from "fastify";
import type { Pool } from "pg";
import {
  cleanupOldRequestLogs,
  cleanupOldRequestLogsForFeature,
} from "../modules/usage/auditLogRepo";
import { cleanupStaleIdempotencyKeys } from "../modules/idempotency/repo";
import { cleanupStaleReservationLeases } from "../modules/usage/reservationLeases";
import { cleanupStaleNodeLeases } from "../modules/budgets/repo";

const INTERVAL_MS = 60_000;
// Distinct from the migration advisory lock key.
const MAINTENANCE_LOCK_KEY = 918_273_646;

export interface MaintenanceOptions {
  pool: Pool;
  idempotencyStaleMs: number;
  reservationStaleMs: number;
  requestLogRetentionMs: number;
  /** Optional per-feature retention overrides (days), applied after the global sweep. */
  featureRetentionDays?: Record<string, number>;
  log?: FastifyBaseLogger;
}

export function startMaintenance(opts: MaintenanceOptions): NodeJS.Timeout {
  const tick = async () => {
    // Only one replica sweeps per tick. Every replica runs this timer, but a
    // non-blocking advisory lock elects a single worker so the DB doesn't do N×
    // the cleanup and N concurrent bulk DELETEs don't contend. Losers just skip.
    const client = await opts.pool.connect();
    let held = false;
    try {
      const { rows } = await client.query<{ ok: boolean }>(
        "SELECT pg_try_advisory_lock($1) AS ok",
        [MAINTENANCE_LOCK_KEY],
      );
      held = rows[0]?.ok === true;
      if (!held) return;

      const removedKeys = await cleanupStaleIdempotencyKeys(
        opts.pool,
        opts.idempotencyStaleMs,
      );
      if (removedKeys > 0) {
        opts.log?.info({ removed: removedKeys }, "cleaned stale idempotency keys");
      }

      await cleanupStaleReservationLeases(
        opts.pool,
        opts.reservationStaleMs,
        Date.now(),
        opts.log,
      );

      // Hierarchical-budget reservation leases (same TTL as the flat path).
      const releasedNodeLeases = await cleanupStaleNodeLeases(
        opts.pool,
        opts.reservationStaleMs,
      );
      if (releasedNodeLeases > 0) {
        opts.log?.info({ released: releasedNodeLeases }, "released stale budget node leases");
      }

      const removedLogs = await cleanupOldRequestLogs(
        opts.pool,
        opts.requestLogRetentionMs,
      );
      if (removedLogs > 0) {
        opts.log?.info({ removed: removedLogs }, "pruned old request_logs rows");
      }

      // Per-feature retention overrides (stricter windows for sensitive features).
      for (const [feature, days] of Object.entries(opts.featureRetentionDays ?? {})) {
        const removed = await cleanupOldRequestLogsForFeature(
          opts.pool,
          feature,
          days * 24 * 60 * 60 * 1000,
        );
        if (removed > 0) {
          opts.log?.info({ feature, removed }, "pruned request_logs for feature retention");
        }
      }
    } catch (err) {
      opts.log?.error({ err }, "maintenance tick failed");
    } finally {
      if (held) {
        await client
          .query("SELECT pg_advisory_unlock($1)", [MAINTENANCE_LOCK_KEY])
          .catch(() => {});
      }
      client.release();
    }
  };

  void tick();
  return setInterval(() => void tick(), INTERVAL_MS);
}
