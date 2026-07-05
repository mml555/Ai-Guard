import type { Pool } from "pg";

const PAUSE_KEY = "ai_requests_paused";

/**
 * The `system_flags` key for a pause scope. `undefined` (an UNBOUND platform
 * key) → the platform-wide switch (the only scope in single-tenant deployments);
 * ANY tenant id — including the empty-string default-partition sentinel that
 * `resolveTenantScope` uses — → that tenant's own switch. The distinction is
 * `=== undefined`, NOT truthiness: a key bound to the default partition ("")
 * must scope to its own switch, not silently pause every tenant.
 */
function pauseKey(tenantId?: string): string {
  return tenantId === undefined ? PAUSE_KEY : `${PAUSE_KEY}:${tenantId}`;
}

export interface EmergencyPauseState {
  paused: boolean;
  reason?: string;
  pausedAt?: string;
  pausedBy?: string;
  /** Which switch produced this state (only set when paused). */
  scope?: "platform" | "tenant";
}

/**
 * Effective pause state for a caller. A request is paused when the platform-wide
 * switch is on OR (for a tenant-bound caller) that tenant's switch is on — so a
 * tenant admin can pause only their own tenant while a platform operator can
 * pause everyone. Platform-wide takes precedence in the reported reason.
 */
export async function getEmergencyPause(pool: Pool, tenantId?: string): Promise<EmergencyPauseState> {
  const keys = tenantId === undefined ? [PAUSE_KEY] : [PAUSE_KEY, pauseKey(tenantId)];
  const { rows } = await pool.query(
    `SELECT key, value FROM system_flags WHERE key = ANY($1::text[])`,
    [keys],
  );
  const byKey = new Map<string, EmergencyPauseState>();
  for (const row of rows as Array<{ key: string; value: EmergencyPauseState | null }>) {
    if (row.value) byKey.set(row.key, row.value);
  }
  const platform = byKey.get(PAUSE_KEY);
  if (platform?.paused) return { ...platform, scope: "platform" };
  const tenant = tenantId === undefined ? undefined : byKey.get(pauseKey(tenantId));
  if (tenant?.paused) return { ...tenant, scope: "tenant" };
  return { paused: false };
}

export async function setEmergencyPause(
  pool: Pool,
  params: { paused: boolean; reason?: string; pausedBy?: string; tenantId?: string },
): Promise<EmergencyPauseState> {
  const value: EmergencyPauseState = params.paused
    ? {
        paused: true,
        reason: params.reason,
        pausedAt: new Date().toISOString(),
        pausedBy: params.pausedBy,
        scope: params.tenantId === undefined ? "platform" : "tenant",
      }
    : { paused: false };

  await pool.query(
    `INSERT INTO system_flags (key, value, updated_at)
     VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [pauseKey(params.tenantId), JSON.stringify(value)],
  );
  return value;
}
