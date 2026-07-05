import type { Pool } from "pg";
import { getEmergencyPause } from "./repo";

/**
 * Hot-path pause gate for data-plane requests (chat, embeddings). A request is
 * paused when the platform-wide switch is on OR the caller's tenant switch is
 * on. Lives in the service layer — routes.ts owns only the admin endpoints.
 */
export async function assertAiRequestsNotPaused(
  pool: Pool,
  tenantId?: string,
): Promise<{
  paused: boolean;
  reason?: string;
}> {
  const state = await getEmergencyPause(pool, tenantId);
  if (!state.paused) return { paused: false };
  return { paused: true, reason: state.reason };
}
