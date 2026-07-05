import { randomUUID } from "node:crypto";
import type { BillingService } from "./service";

type SettleLog = { error(obj: unknown, msg: string): void } | undefined;

/**
 * Settle billing once the provider call has run. Exactly one of two charge
 * paths applies, by mode:
 *  - credits (hybrid/credits_only): book actual spend against the wallet,
 *    releasing the full reservation — the wallet debit IS the charge.
 *  - metered: record a meter event that the maintenance flush reports to the
 *    configured Stripe Billing Meter — the metered invoice IS the charge.
 * Config validation guarantees the two never coexist (double-billing).
 *
 * Must be called on EVERY post-provider-call exit — success AND blocked/failed
 * responses — or the reservation/usage leaks. Meter rows are normally keyed by
 * the audit request id (Stripe-side idempotency); when the audit write failed a
 * synthetic key is minted so the real spend is still metered, never dropped.
 */
export async function settleBillingCredits(
  billing: BillingService | undefined,
  log: SettleLog,
  params: {
    tenantId: string;
    userId: string;
    feature: string;
    reservedUsd: number;
    actualCostUsd: number;
    requestId: string;
    /** Wallet-lease hold id from the credit reserve; absent for hierarchical. */
    creditHoldId?: string;
  },
): Promise<void> {
  if (!billing?.enabled) return;
  try {
    if (billing.usesCredits()) {
      await billing.settleCredits(
        params.tenantId,
        params.userId,
        params.reservedUsd,
        params.actualCostUsd,
        params.creditHoldId,
      );
    }
    if (billing.usesMeter()) {
      await billing.recordMeter({
        // Meter rows are keyed by the audit request id for Stripe-side
        // idempotency. When the audit write failed there is none — mint a
        // synthetic key so the (real) provider spend is still metered instead
        // of silently dropped, which would under-bill in metered mode.
        requestId: params.requestId || `noaudit-${randomUUID()}`,
        tenantId: params.tenantId,
        userId: params.userId,
        feature: params.feature,
        costUsd: params.actualCostUsd,
      });
    }
  } catch (err) {
    log?.error({ err, requestId: params.requestId }, "billing settlement failed");
  }
}

/**
 * Release a credit reservation when the provider call did not run. If safety /
 * prompt-injection spend was already incurred (`incurredUsd`), that portion is
 * booked from the wallet and only the remainder is released — a full refund
 * would give back credits for classifier work that was actually paid for.
 */
export async function releaseBillingCredits(
  billing: BillingService | undefined,
  log: SettleLog,
  params: {
    tenantId: string;
    userId: string;
    reservedUsd: number;
    incurredUsd?: number;
    /** Wallet-lease hold id from the credit reserve; absent for hierarchical. */
    creditHoldId?: string;
  },
): Promise<void> {
  if (!billing?.usesCredits()) return;
  try {
    // Route through settleCredits in both branches: with a hold id it deletes
    // ALL of the hold's leases (base + top-ups) — an amount-matched single-row
    // release could not cover an accumulated multi-lease hold. incurred = 0 is
    // a pure release (debits nothing).
    await billing.settleCredits(
      params.tenantId,
      params.userId,
      params.reservedUsd,
      params.incurredUsd ?? 0,
      params.creditHoldId,
    );
  } catch (err) {
    log?.error({ err }, "billing credit release failed");
  }
}
