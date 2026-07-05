import { randomUUID } from "node:crypto";
import type { BillingService } from "./service";

/** Outcome of reserving a request's estimated credits under a fresh hold. */
export type CreditHoldResult =
  | { ok: true; holdId?: string; reservedUsd: number }
  | { ok: false; availableUsd: number };

/**
 * Reserve `amountUsd` of prepaid credits under a fresh per-request hold id, or
 * report the available balance for a 402. Shared by the chat pipeline
 * (`reserveFlatBudgetOrReject`) and the embeddings service so the hold-id
 * lifecycle and the reserve/gate step can't drift between them — every new
 * metered surface reserves the same way. A no-op success (no hold, reserved 0)
 * when the deployment does not use prepaid credits.
 *
 * The hold id is minted here (not by callers) so it exists exactly when a lease
 * was actually written; `reserveCredits` records the lease — including a
 * zero-amount lease — that a later lease-gated settle/release consumes.
 */
export async function acquireCreditHold(
  billing: BillingService | undefined,
  tenantId: string,
  userId: string,
  amountUsd: number,
): Promise<CreditHoldResult> {
  if (!billing?.usesCredits()) return { ok: true, reservedUsd: 0 };
  const holdId = randomUUID();
  const reserved = await billing.reserveCredits(tenantId, userId, amountUsd, holdId);
  if (!reserved) {
    const balance = await billing.getBalance(tenantId, userId);
    return { ok: false, availableUsd: balance.creditsAvailableUsd };
  }
  return { ok: true, holdId, reservedUsd: amountUsd };
}
