import type { ReservationCaps } from "@ai-guard/policy-engine";
import type { Pool } from "pg";
import { releaseBudget } from "./repo";

// window_day / window_month are `date` columns, which node-pg parses into JS
// Date objects by default (local-midnight, timezone-sensitive). Cast them to
// text so they come back as the same 'YYYY-MM-DD' strings reserveBudget wrote;
// otherwise the release below re-derives a Date and can target the wrong day's
// counter (never freeing the reservation) in a non-UTC process timezone.
const STALE_SELECT_SQL = `
  SELECT id::text, project_id, user_id, feature, estimated_cost, caps,
         window_day::text AS window_day, window_month::text AS window_month
  FROM budget_reservation_leases
  WHERE leased_at < $1::timestamptz
  ORDER BY id
  FOR UPDATE SKIP LOCKED
`;

export async function cleanupStaleReservationLeases(
  pool: Pool,
  staleMs: number,
  now = Date.now(),
  log?: { info(obj: unknown, msg: string): void },
): Promise<number> {
  const cutoff = new Date(now - staleMs).toISOString();
  const { rows } = await pool.query<{
    id: string;
    project_id: string;
    user_id: string;
    feature: string;
    estimated_cost: string;
    caps: ReservationCaps;
    window_day: string;
    window_month: string;
  }>(STALE_SELECT_SQL, [cutoff]);

  let released = 0;
  for (const row of rows) {
    await releaseBudget(pool, {
      projectId: row.project_id,
      userId: row.user_id,
      feature: row.feature,
      estimatedCostUsd: Number(row.estimated_cost),
      caps: row.caps,
      now: new Date(`${row.window_day}T12:00:00.000Z`),
      windows: { day: row.window_day, month: row.window_month },
      leaseId: row.id,
    });
    released += 1;
  }

  if (released > 0) {
    log?.info({ released, staleMs }, "released stale budget reservation leases");
  }
  return released;
}
