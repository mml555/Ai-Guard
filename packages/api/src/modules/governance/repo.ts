import type { Pool } from "pg";

export interface ErasureResult {
  userId: string;
  requestLogs: number;
  idempotencyKeys: number;
}

/**
 * Right-to-erasure (GDPR Art. 17 / CCPA): remove a user's request-linked data.
 *
 * Erases `request_logs` (per-request audit rows, which carry `user_id` and any
 * captured metadata) and `idempotency_keys` (short-lived request state).
 * Aggregate spend counters (`budget_counters`) are intentionally NOT deleted —
 * they hold no free-text/PII beyond an opaque scope key and are retained for
 * financial-integrity/auditability. Callers should document that stance in
 * their privacy policy.
 */
export async function eraseUserData(pool: Pool, userId: string): Promise<ErasureResult> {
  const rl = await pool.query("DELETE FROM request_logs WHERE user_id = $1", [userId]);
  const ik = await pool.query("DELETE FROM idempotency_keys WHERE user_id = $1", [userId]);
  return {
    userId,
    requestLogs: rl.rowCount ?? 0,
    idempotencyKeys: ik.rowCount ?? 0,
  };
}
