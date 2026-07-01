import type { ReservationCaps, UsageSnapshot } from "@ai-guard/policy-engine";
import type { Pool } from "pg";
import { withTransaction } from "../../db/pool";
import { dayWindowStart, monthWindowStart } from "../../services/windows";

// lock_timeout for the budget-counter transactions: a contended row must fail
// fast rather than pile up connections behind a long lock wait.
const LOCK_TIMEOUT_MS = 3000;

/**
 * Thrown inside a reserve/top-up transaction when a dimension breaches its cap,
 * so `withTransaction` rolls the whole (partial) reservation back. Caught by the
 * caller and mapped to a `{ ok: false }` result rather than propagated.
 */
class ReservationRejected extends Error {
  constructor(readonly scope: Scope) {
    super(`reservation rejected on scope ${scope}`);
    this.name = "ReservationRejected";
  }
}

// All Postgres reads/writes for budget accounting live here. The pure engine
// never touches the DB; it consumes the UsageSnapshot this repo loads.
//
// user_daily + feature_monthly counters are scoped by project_id.
// global_monthly is deployment-wide (project_id = '').

type Scope = "user_daily" | "feature_monthly" | "global_monthly";

export type BudgetScope = Scope;

/** Empty project_id marks deployment-wide dimensions (global monthly). */
export const GLOBAL_PROJECT_ID = "";

interface Dimension {
  scope: Scope;
  projectId: string;
  key: string;
  windowStart: string;
  usdCap: number | null;
  reqCap: number | null;
  reqDelta: number;
}

export interface ReserveParams {
  projectId: string;
  userId: string;
  feature: string;
  estimatedCostUsd: number;
  caps: ReservationCaps;
  now: Date;
}

export interface ReserveResult {
  ok: boolean;
  failedScope?: Scope;
  leaseId?: string;
}

interface WindowOverride {
  day: string;
  month: string;
}

function dimensionsFor(
  projectId: string,
  userId: string,
  feature: string,
  caps: ReservationCaps,
  now: Date,
  windows?: WindowOverride,
): Dimension[] {
  const day = windows?.day ?? dayWindowStart(now);
  const month = windows?.month ?? monthWindowStart(now);
  return [
    {
      scope: "user_daily",
      projectId,
      key: userId,
      windowStart: day,
      usdCap: caps.userDailyUsd,
      reqCap: caps.userDailyRequests,
      reqDelta: 1,
    },
    {
      scope: "feature_monthly",
      projectId,
      key: feature,
      windowStart: month,
      usdCap: caps.featureMonthlyUsd,
      reqCap: null,
      reqDelta: 0,
    },
    {
      scope: "global_monthly",
      projectId: GLOBAL_PROJECT_ID,
      key: "global",
      windowStart: month,
      usdCap: caps.globalMonthlyUsd,
      reqCap: null,
      reqDelta: 0,
    },
  ];
}

const SNAPSHOT_SQL = `
  SELECT scope, used_usd, reserved_usd, requests_used
  FROM budget_counters
  WHERE (scope = 'user_daily'      AND project_id = $1 AND key = $2 AND window_start = $3)
     OR (scope = 'feature_monthly' AND project_id = $1 AND key = $4 AND window_start = $5)
     OR (scope = 'global_monthly'  AND project_id = ''  AND key = 'global' AND window_start = $5)
`;

/** Read used + reserved for the three budget dimensions of this request. */
export async function loadUsageSnapshot(
  pool: Pool,
  params: { projectId: string; userId: string; feature: string; now: Date },
): Promise<UsageSnapshot> {
  const day = dayWindowStart(params.now);
  const month = monthWindowStart(params.now);
  const { rows } = await pool.query(SNAPSHOT_SQL, [
    params.projectId,
    params.userId,
    day,
    params.feature,
    month,
  ]);

  const snapshot: UsageSnapshot = {
    userDailyUsdUsed: 0,
    userDailyUsdReserved: 0,
    userDailyRequestsUsed: 0,
    featureMonthlyUsdUsed: 0,
    featureMonthlyUsdReserved: 0,
    globalMonthlyUsdUsed: 0,
    globalMonthlyUsdReserved: 0,
  };

  for (const row of rows as Array<{
    scope: Scope;
    used_usd: string;
    reserved_usd: string;
    requests_used: number;
  }>) {
    const used = Number(row.used_usd);
    const reserved = Number(row.reserved_usd);
    if (row.scope === "user_daily") {
      snapshot.userDailyUsdUsed = used;
      snapshot.userDailyUsdReserved = reserved;
      snapshot.userDailyRequestsUsed = Number(row.requests_used);
    } else if (row.scope === "feature_monthly") {
      snapshot.featureMonthlyUsdUsed = used;
      snapshot.featureMonthlyUsdReserved = reserved;
    } else {
      snapshot.globalMonthlyUsdUsed = used;
      snapshot.globalMonthlyUsdReserved = reserved;
    }
  }
  return snapshot;
}

// The cap must be enforced on BOTH the first reservation of a window and every
// subsequent one. The DO UPDATE ... WHERE guards the conflict (existing-row)
// path; the INSERT ... SELECT ... WHERE guards the fresh-row path — without it,
// the very first request of a scope/window would insert unconditionally and
// slip past the cap. On a fresh window "used + reserved" is 0, so the fresh-row
// check is simply "this reservation alone <= cap".
const RESERVE_SQL = `
  INSERT INTO budget_counters (scope, project_id, key, window_start, used_usd, reserved_usd, requests_used)
  SELECT $1, $2, $3, $4, 0, $5, $6
  WHERE ($7::numeric IS NULL OR $5::numeric <= $7::numeric)
    AND ($8::int IS NULL OR $6::int <= $8::int)
  ON CONFLICT (scope, project_id, key, window_start) DO UPDATE
    SET reserved_usd  = budget_counters.reserved_usd + EXCLUDED.reserved_usd,
        requests_used = budget_counters.requests_used + EXCLUDED.requests_used
    WHERE ($7::numeric IS NULL
           OR budget_counters.used_usd + budget_counters.reserved_usd + EXCLUDED.reserved_usd <= $7::numeric)
      AND ($8::int IS NULL
           OR budget_counters.requests_used + EXCLUDED.requests_used <= $8::int)
  RETURNING reserved_usd
`;

export async function reserveBudget(
  pool: Pool,
  params: ReserveParams,
): Promise<ReserveResult> {
  const dims = dimensionsFor(
    params.projectId,
    params.userId,
    params.feature,
    params.caps,
    params.now,
  );
  const day = dims[0]!.windowStart;
  const month = dims[1]!.windowStart;
  try {
    const leaseId = await withTransaction(
      pool,
      async (client) => {
        for (const d of dims) {
          const res = await client.query(RESERVE_SQL, [
            d.scope,
            d.projectId,
            d.key,
            d.windowStart,
            params.estimatedCostUsd,
            d.reqDelta,
            d.usdCap,
            d.reqCap,
          ]);
          if (res.rowCount === 0) throw new ReservationRejected(d.scope);
        }
        const lease = await client.query<{ id: string }>(LEASE_INSERT_SQL, [
          params.projectId,
          params.userId,
          params.feature,
          params.estimatedCostUsd,
          JSON.stringify(params.caps),
          day,
          month,
        ]);
        return lease.rows[0]?.id;
      },
      { lockTimeoutMs: LOCK_TIMEOUT_MS },
    );
    return { ok: true, leaseId };
  } catch (err) {
    if (err instanceof ReservationRejected) {
      return { ok: false, failedScope: err.scope };
    }
    throw err;
  }
}

export interface TopUpParams {
  projectId: string;
  userId: string;
  feature: string;
  additionalCostUsd: number;
  caps: ReservationCaps;
  now: Date;
  leaseId?: string;
}

/** Increase an in-flight reservation when the fallback model costs more than the primary estimate. */
export async function topUpBudget(
  pool: Pool,
  params: TopUpParams,
): Promise<ReserveResult> {
  if (params.additionalCostUsd <= 0) {
    return { ok: true, leaseId: params.leaseId };
  }
  const dims = dimensionsFor(
    params.projectId,
    params.userId,
    params.feature,
    params.caps,
    params.now,
  );
  try {
    await withTransaction(
      pool,
      async (client) => {
        for (const d of dims) {
          const res = await client.query(RESERVE_SQL, [
            d.scope,
            d.projectId,
            d.key,
            d.windowStart,
            params.additionalCostUsd,
            0,
            d.usdCap,
            d.reqCap,
          ]);
          if (res.rowCount === 0) throw new ReservationRejected(d.scope);
        }
        if (params.leaseId) {
          await client.query(
            `UPDATE budget_reservation_leases
             SET estimated_cost = estimated_cost + $2::numeric
             WHERE id = $1::bigint`,
            [params.leaseId, params.additionalCostUsd],
          );
        }
      },
      { lockTimeoutMs: LOCK_TIMEOUT_MS },
    );
    return { ok: true, leaseId: params.leaseId };
  } catch (err) {
    if (err instanceof ReservationRejected) {
      return { ok: false, failedScope: err.scope };
    }
    throw err;
  }
}

const RECORD_SQL = `
  UPDATE budget_counters
  SET used_usd     = used_usd + $5::numeric,
      reserved_usd = GREATEST(reserved_usd - $6::numeric, 0)
  WHERE scope = $1 AND project_id = $2 AND key = $3 AND window_start = $4
`;

export async function recordActualCost(
  pool: Pool,
  params: {
    projectId: string;
    userId: string;
    feature: string;
    actualCostUsd: number;
    estimatedCostUsd: number;
    caps: ReservationCaps;
    now: Date;
    leaseId?: string;
  },
): Promise<void> {
  const dims = dimensionsFor(
    params.projectId,
    params.userId,
    params.feature,
    params.caps,
    params.now,
  );
  await withTransaction(
    pool,
    async (client) => {
      for (const d of dims) {
        await client.query(RECORD_SQL, [
          d.scope,
          d.projectId,
          d.key,
          d.windowStart,
          params.actualCostUsd,
          params.estimatedCostUsd,
        ]);
      }
      if (params.leaseId) {
        await client.query(LEASE_DELETE_SQL, [params.leaseId]);
      }
    },
    { lockTimeoutMs: LOCK_TIMEOUT_MS },
  );
}

const RELEASE_SQL = `
  UPDATE budget_counters
  SET reserved_usd  = GREATEST(reserved_usd - $5::numeric, 0),
      requests_used = GREATEST(requests_used - $6::int, 0)
  WHERE scope = $1 AND project_id = $2 AND key = $3 AND window_start = $4
`;

const LEASE_INSERT_SQL = `
  INSERT INTO budget_reservation_leases
    (project_id, user_id, feature, estimated_cost, caps, window_day, window_month)
  VALUES ($1, $2, $3, $4, $5::jsonb, $6::date, $7::date)
  RETURNING id::text
`;

const LEASE_DELETE_SQL = `DELETE FROM budget_reservation_leases WHERE id = $1::bigint`;

export async function releaseBudget(
  pool: Pool,
  params: {
    projectId: string;
    userId: string;
    feature: string;
    estimatedCostUsd: number;
    caps: ReservationCaps;
    now: Date;
    windows?: WindowOverride;
    leaseId?: string;
  },
): Promise<void> {
  const dims = dimensionsFor(
    params.projectId,
    params.userId,
    params.feature,
    params.caps,
    params.now,
    params.windows,
  );
  await withTransaction(
    pool,
    async (client) => {
      for (const d of dims) {
        await client.query(RELEASE_SQL, [
          d.scope,
          d.projectId,
          d.key,
          d.windowStart,
          params.estimatedCostUsd,
          d.reqDelta,
        ]);
      }
      if (params.leaseId) {
        await client.query(LEASE_DELETE_SQL, [params.leaseId]);
      }
    },
    { lockTimeoutMs: LOCK_TIMEOUT_MS },
  );
}
