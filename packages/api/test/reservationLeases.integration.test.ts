import type { ReservationCaps } from "@ai-guard/policy-engine";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applySchema } from "../src/db/init";
import { createPool, type Pool } from "../src/db/pool";
import {
  loadUsageSnapshot,
  reserveBudget,
} from "../src/modules/usage/repo";
import { cleanupStaleReservationLeases } from "../src/modules/usage/reservationLeases";

const DATABASE_URL = process.env.DATABASE_URL;
const PROJECT = "test";
const NOW = new Date("2026-06-30T12:00:00.000Z");

const caps: ReservationCaps = {
  userDailyUsd: 1,
  userDailyRequests: 100,
  featureMonthlyUsd: null,
  globalMonthlyUsd: null,
};

describe.skipIf(!DATABASE_URL)("reservation lease cleanup (integration)", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = createPool(DATABASE_URL!);
    await applySchema(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE budget_counters, budget_reservation_leases");
  });

  it("releases orphaned reserved_usd after the stale TTL", async () => {
    const res = await reserveBudget(pool, {
      projectId: PROJECT,
      userId: "u1",
      feature: "support_chat",
      estimatedCostUsd: 0.04,
      caps,
      now: NOW,
    });
    expect(res.ok).toBe(true);
    expect(res.leaseId).toBeTruthy();

    await pool.query(
      `UPDATE budget_reservation_leases SET leased_at = $1::timestamptz WHERE id = $2::bigint`,
      [new Date(Date.now() - 20 * 60 * 1000).toISOString(), res.leaseId],
    );

    const released = await cleanupStaleReservationLeases(pool, 15 * 60 * 1000);
    expect(released).toBe(1);

    const snap = await loadUsageSnapshot(pool, {
      projectId: PROJECT,
      userId: "u1",
      feature: "support_chat",
      now: NOW,
    });
    expect(snap.userDailyUsdReserved).toBeCloseTo(0, 6);
  });
});
