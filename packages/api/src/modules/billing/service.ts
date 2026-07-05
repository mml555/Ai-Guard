import type { BillingMode } from "@modelgov/policy-engine";
import type { Pool } from "pg";
import {
  findAccountByStripeCustomer,
  getBillingAccount,
  listPendingMeterEvents,
  markMeterReported,
  recordMeterEvent,
  releaseCredits,
  reserveCredits,
  settleCredits,
  topUpCreditsInTransaction,
  upsertBillingAccount,
} from "./repo";
import {
  createStripeMeterEvent,
  verifyStripeWebhookSignature,
  type StripeCheckoutSession,
  type StripeEvent,
  type StripeInvoice,
  type StripeSubscription,
} from "./stripe";
import { mapWithConcurrency } from "../../util/concurrency";
import type { BillingBalance, BillingServiceConfig } from "./types";

export interface BillingService {
  readonly enabled: boolean;
  readonly mode: BillingMode;
  usesCredits(): boolean;
  /** True when usage is invoiced via a Stripe Billing Meter (mode "metered"). */
  usesMeter(): boolean;
  getBalance(tenantId: string, userId: string): Promise<BillingBalance>;
  checkCredits(
    tenantId: string,
    userId: string,
    estimatedUsd: number,
  ): Promise<{ ok: true; availableUsd: number } | { ok: false; availableUsd: number }>;
  /** holdId groups a request's leases so a crashed request can be swept. */
  reserveCredits(
    tenantId: string,
    userId: string,
    amountUsd: number,
    holdId?: string,
  ): Promise<boolean>;
  releaseCredits(
    tenantId: string,
    userId: string,
    amountUsd: number,
    holdId?: string,
  ): Promise<void>;
  settleCredits(
    tenantId: string,
    userId: string,
    reservedUsd: number,
    actualUsd: number,
    holdId?: string,
  ): Promise<void>;
  recordMeter(
    params: {
      requestId: string;
      tenantId: string;
      userId: string;
      feature: string;
      costUsd: number;
    },
  ): Promise<void>;
  flushPendingMeters(log?: { error(obj: unknown, msg: string): void }): Promise<number>;
  handleStripeWebhook(
    rawBody: Buffer,
    signature: string | undefined,
    log?: { warn(obj: unknown, msg: string): void },
  ): Promise<void>;
  adminTopUp(params: {
    tenantId: string;
    userId: string;
    creditsUsd: number;
    stripeCustomerId?: string;
    userType?: string;
  }): Promise<void>;
}

export function createBillingService(
  pool: Pool,
  opts: BillingServiceConfig,
): BillingService | undefined {
  const billing = opts.billing;
  if (!billing || billing.provider === "none" || billing.mode === "internal_only") {
    return undefined;
  }

  const stripeSecret = opts.stripeSecretKey ?? billing.stripe?.secretKey;
  const stripeWebhookSecret = opts.stripeWebhookSecret ?? billing.stripe?.webhookSecret;
  const planMap = billing.stripe?.planMap ?? {};
  const usdPerCredit = billing.stripe?.usdPerCredit ?? 0.01;
  const meterEventName = billing.stripe?.meterEventName;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const usesCredits = billing.mode === "hybrid" || billing.mode === "credits_only";

  // Defense in depth (config validation already enforces both): prepaid credits
  // and a Stripe usage meter must never coexist — the wallet debit and the
  // metered invoice would charge the same usage twice. Conversely, metered mode
  // has no other way to bill usage, so the meter event name is mandatory there.
  if (usesCredits && meterEventName) {
    throw new Error(
      `billing.mode "${billing.mode}" bills usage by debiting the prepaid credit wallet ` +
        "and cannot be combined with a Stripe usage meter (stripe.meterEventName) — the " +
        'same usage would be invoiced a second time. Remove stripe.meterEventName, or switch to mode "metered".',
    );
  }
  if (billing.mode === "metered" && !meterEventName) {
    throw new Error(
      'billing.mode "metered" requires stripe.meterEventName — usage is billed by reporting it to that Stripe Billing Meter.',
    );
  }
  if (billing.mode === "metered" && !stripeSecret) {
    // Without a Stripe secret the meter flush no-ops, so metered usage is
    // recorded, never reported, then pruned as "abandoned" — silently unbilled.
    // Fail fast instead of losing revenue.
    throw new Error(
      'billing.mode "metered" requires a Stripe secret key (stripe.secretKey / STRIPE_SECRET_KEY) — usage is billed by reporting meter events to Stripe, which cannot happen without it.',
    );
  }

  return {
    enabled: true,
    mode: billing.mode,
    usesCredits() {
      return usesCredits;
    },
    usesMeter() {
      return Boolean(meterEventName);
    },

    async getBalance(tenantId, userId) {
      const account = await getBillingAccount(pool, tenantId, userId);
      const creditsUsd = account?.creditsUsd ?? 0;
      const creditsReservedUsd = account?.creditsReservedUsd ?? 0;
      return {
        userId,
        creditsUsd,
        creditsReservedUsd,
        creditsAvailableUsd: Math.max(creditsUsd - creditsReservedUsd, 0),
        userType: account?.userType ?? null,
        stripeCustomerId: account?.stripeCustomerId ?? null,
        mode: billing.mode,
      };
    },

    async checkCredits(tenantId, userId, estimatedUsd) {
      const balance = await this.getBalance(tenantId, userId);
      if (balance.creditsAvailableUsd >= estimatedUsd) {
        return { ok: true, availableUsd: balance.creditsAvailableUsd };
      }
      return { ok: false, availableUsd: balance.creditsAvailableUsd };
    },

    async reserveCredits(tenantId, userId, amountUsd, holdId) {
      const amount = Math.max(amountUsd, 0);
      if (amount <= 0) {
        // Without a hold a zero-amount reserve records nothing and trivially
        // succeeds. With a hold the repo still writes the (zero) lease so the
        // lease-gated settle can book the actual cost — but the zero amount skips
        // the balance UPDATE, so an out-of-credit wallet would slip past the gate
        // and later be debited (floored at 0) for real spend. Gate it: require a
        // funded wallet, so an empty account still gets a 402 instead of free use.
        if (!holdId) return true;
        const account = await getBillingAccount(pool, tenantId, userId);
        const available = Math.max(
          (account?.creditsUsd ?? 0) - (account?.creditsReservedUsd ?? 0),
          0,
        );
        if (available <= 0) return false;
      }
      return reserveCredits(pool, { tenantId, userId, amountUsd: amount, holdId });
    },

    releaseCredits(tenantId, userId, amountUsd, holdId) {
      // With a holdId even a zero-amount release must reach the repo: reserve
      // recorded a (possibly zero-amount) lease, and only deleting it cleans the
      // hold — otherwise the lease lingers until the stale-lease sweep.
      if (amountUsd <= 0 && !holdId) return Promise.resolve();
      return releaseCredits(pool, { tenantId, userId, amountUsd: Math.max(amountUsd, 0), holdId });
    },

    settleCredits(tenantId, userId, reservedUsd, actualUsd, holdId) {
      return settleCredits(pool, { tenantId, userId, reservedUsd, actualUsd, holdId });
    },

    async recordMeter(params) {
      if (params.costUsd <= 0) return;
      const client = await pool.connect();
      try {
        await recordMeterEvent(client, params);
      } finally {
        client.release();
      }
    },

    async flushPendingMeters(log) {
      if (!stripeSecret || !meterEventName) return 0;
      // The repo query only returns rows whose billing account has a Stripe
      // customer id: a row without one can never be reported, and with the
      // batch's ORDER BY created_at LIMIT it would otherwise permanently occupy
      // batch slots and starve newer events. Customer-less rows are left
      // pending for the retention sweep to prune.
      const pending = await listPendingMeterEvents(pool);
      // Independent, idempotent POSTs (keyed by requestId) — report them with
      // bounded concurrency so a large backlog drains within a tick instead of
      // serializing up to `limit` round trips at hundreds of ms each.
      const outcomes = await mapWithConcurrency(pending, 8, async (event) => {
        try {
          const id = await createStripeMeterEvent(
            stripeSecret,
            {
              eventName: meterEventName,
              stripeCustomerId: event.stripeCustomerId,
              value: event.costUsd,
              identifier: event.requestId,
            },
            fetchImpl,
          );
          if (id) {
            await markMeterReported(pool, event.requestId, id);
            return true;
          }
        } catch (err) {
          log?.error({ err, requestId: event.requestId }, "stripe meter report failed");
        }
        return false;
      });
      return outcomes.filter(Boolean).length;
    },

    async handleStripeWebhook(rawBody, signature, log) {
      if (!stripeWebhookSecret) {
        throw new Error("Stripe webhook secret is not configured");
      }
      if (!signature || !verifyStripeWebhookSignature(rawBody, signature, stripeWebhookSecret)) {
        throw new Error("Invalid Stripe webhook signature");
      }

      const event = JSON.parse(rawBody.toString("utf8")) as StripeEvent;
      await applyStripeEvent(pool, event, {
        planMap,
        usdPerCredit,
        downgradeUserType: billing.stripe?.downgradeUserType ?? "free_user",
        log,
      });
    },

    async adminTopUp(params) {
      await topUpCreditsInTransaction(pool, params);
    },
  };
}

async function applyStripeEvent(
  pool: Pool,
  event: StripeEvent,
  opts: {
    planMap: Record<string, string>;
    usdPerCredit: number;
    /** user_type applied on invoice.payment_failed (config: stripe.downgrade_user_type). */
    downgradeUserType: string;
    log?: { warn(obj: unknown, msg: string): void };
  },
): Promise<void> {
  const obj = event.data.object;

  switch (event.type) {
    case "checkout.session.completed": {
      const session = obj as StripeCheckoutSession;
      const userId = session.metadata?.user_id ?? session.metadata?.userId;
      if (!userId) return;
      const customerId = typeof session.customer === "string" ? session.customer : undefined;
      // Resolve which tenant the credits belong to. Prefer explicit metadata
      // (an empty string is a valid single-tenant value and is respected as-is).
      // If tenant_id is absent, fall back to the tenant of the customer's
      // existing billing account (a returning buyer). Only if neither resolves
      // do we credit the default "" tenant — and we warn, because in a
      // multi-tenant deployment that silently strands a paid top-up in the wrong
      // tenant (the buyer's wallet lives under their real tenant).
      let tenantId = session.metadata?.tenant_id ?? session.metadata?.tenantId;
      if (tenantId == null && customerId) {
        const existing = await findAccountByStripeCustomer(pool, customerId);
        if (existing) tenantId = existing.tenantId;
      }
      if (tenantId == null) {
        opts.log?.warn(
          { customerId, userId, eventId: event.id },
          "checkout.session.completed has no tenant_id metadata and no existing account for the customer; crediting the default tenant. Set metadata.tenant_id on the Checkout Session for multi-tenant deployments.",
        );
        tenantId = "";
      }
      // metadata.credits_usd is integrator-set free text: only honor a finite,
      // positive number (guards against NaN / Infinity, e.g. "1e309", which the
      // numeric column would reject and 500 the webhook). Otherwise fall back to
      // the Stripe-authoritative amount_total.
      const metaCredits = Number(session.metadata?.credits_usd);
      const creditsUsd =
        Number.isFinite(metaCredits) && metaCredits > 0
          ? metaCredits
          : session.amount_total != null
            ? session.amount_total / 100
            : 0;
      if (creditsUsd > 0 && Number.isFinite(creditsUsd)) {
        await topUpCreditsInTransaction(pool, {
          tenantId,
          userId,
          creditsUsd,
          stripeCustomerId: customerId,
          userType: session.metadata?.user_type,
          // Replay-safe: the same event id grants credits at most once.
          stripeEventId: event.id,
        });
      }
      break;
    }
    case "customer.subscription.updated":
    case "customer.subscription.created": {
      const sub = obj as StripeSubscription;
      const customerId = typeof sub.customer === "string" ? sub.customer : undefined;
      if (!customerId) return;
      const account = await findAccountByStripeCustomer(pool, customerId);
      if (!account) return;
      const priceId = sub.items?.data?.[0]?.price?.id;
      const userType = priceId ? opts.planMap[priceId] : undefined;
      if (userType) {
        await upsertBillingAccount(pool, {
          tenantId: account.tenantId,
          userId: account.userId,
          userType,
          stripeCustomerId: customerId,
        });
      }
      break;
    }
    case "invoice.payment_failed": {
      const invoice = obj as StripeInvoice;
      const customerId = typeof invoice.customer === "string" ? invoice.customer : undefined;
      if (!customerId) return;
      const account = await findAccountByStripeCustomer(pool, customerId);
      if (!account) return;
      await upsertBillingAccount(pool, {
        tenantId: account.tenantId,
        userId: account.userId,
        userType: opts.downgradeUserType,
        stripeCustomerId: customerId,
      });
      break;
    }
    default:
      break;
  }
}
