import type { Pool } from "pg";

export interface UsageSummaryQuery {
  feature?: string;
  userType?: string;
  since?: string;
  projectScope?: string;
}

export interface UsageSummaryReport {
  since: string;
  feature?: string;
  userType?: string;
  requests: number;
  completed: number;
  blocked: number;
  degraded: number;
  fallbacks: number;
  safetyBlocked: number;
  actualCostUsd: number;
  estimatedCostUsd: number;
  topReasonCode?: { code: string; count: number };
  topModel?: { model: string; count: number };
}

export async function getUsageSummaryReport(
  pool: Pool,
  query: UsageSummaryQuery,
): Promise<UsageSummaryReport> {
  const sinceDate = parseSince(query.since ?? "24h");
  const conditions = ["created_at >= $1::timestamptz"];
  const values: unknown[] = [sinceDate.toISOString()];

  if (query.projectScope) {
    values.push(query.projectScope);
    conditions.push(`project_id = $${values.length}`);
  }
  if (query.feature) {
    values.push(query.feature);
    conditions.push(`feature = $${values.length}`);
  }
  if (query.userType) {
    values.push(query.userType);
    conditions.push(`user_type = $${values.length}`);
  }

  const where = conditions.join(" AND ");

  const { rows } = await pool.query<{
    requests: string;
    completed: string;
    blocked: string;
    degraded: string;
    fallbacks: string;
    safety_blocked: string;
    actual_cost: string;
    estimated_cost: string;
  }>(
    `
    SELECT
      count(*)::text AS requests,
      count(*) FILTER (WHERE status = 'ok')::text AS completed,
      count(*) FILTER (WHERE status = 'failed')::text AS blocked,
      count(*) FILTER (WHERE decision = 'degrade')::text AS degraded,
      count(*) FILTER (WHERE decision = 'fallback')::text AS fallbacks,
      count(*) FILTER (WHERE status = 'safety_blocked')::text AS safety_blocked,
      coalesce(sum(actual_cost_usd), 0)::text AS actual_cost,
      coalesce(sum(estimated_cost_usd), 0)::text AS estimated_cost
    FROM request_logs
    WHERE ${where}
    `,
    values,
  );

  const agg = rows[0];
  const topReason = await topReasonCode(pool, where, values);
  const topModel = await topModelUsed(pool, where, values);

  return {
    since: sinceDate.toISOString(),
    feature: query.feature,
    userType: query.userType,
    requests: Number(agg?.requests ?? 0),
    completed: Number(agg?.completed ?? 0),
    blocked: Number(agg?.blocked ?? 0),
    degraded: Number(agg?.degraded ?? 0),
    fallbacks: Number(agg?.fallbacks ?? 0),
    safetyBlocked: Number(agg?.safety_blocked ?? 0),
    actualCostUsd: Number(agg?.actual_cost ?? 0),
    estimatedCostUsd: Number(agg?.estimated_cost ?? 0),
    topReasonCode: topReason,
    topModel,
  };
}

async function topReasonCode(
  pool: Pool,
  where: string,
  values: unknown[],
): Promise<{ code: string; count: number } | undefined> {
  const { rows } = await pool.query<{ code: string; count: string }>(
    `
    SELECT coalesce(reason_code, 'unknown') AS code, count(*)::text AS count
    FROM request_logs
    WHERE ${where} AND status <> 'ok'
    GROUP BY 1
    ORDER BY count(*) DESC
    LIMIT 1
    `,
    values,
  );
  const row = rows[0];
  if (!row || row.code === "unknown") return undefined;
  return { code: row.code, count: Number(row.count) };
}

async function topModelUsed(
  pool: Pool,
  where: string,
  values: unknown[],
): Promise<{ model: string; count: number } | undefined> {
  const { rows } = await pool.query<{ model: string; count: string }>(
    `
    SELECT resolved_model AS model, count(*)::text AS count
    FROM request_logs
    WHERE ${where} AND resolved_model IS NOT NULL
    GROUP BY 1
    ORDER BY count(*) DESC
    LIMIT 1
    `,
    values,
  );
  const row = rows[0];
  return row ? { model: row.model, count: Number(row.count) } : undefined;
}

function parseSince(raw: string): Date {
  const now = Date.now();
  const match = /^(\d+)(h|d)$/.exec(raw.trim());
  if (match) {
    const amount = Number(match[1]);
    const unit = match[2];
    const ms = unit === "h" ? amount * 60 * 60 * 1000 : amount * 24 * 60 * 60 * 1000;
    return new Date(now - ms);
  }
  const parsed = Date.parse(raw);
  if (Number.isFinite(parsed)) return new Date(parsed);
  throw new Error("invalid_since");
}
