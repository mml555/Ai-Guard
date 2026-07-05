import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseConfigObject } from "@modelgov/policy-engine";
import { createBillingService } from "../src/modules/billing/service";
import { verifyStripeWebhookSignature } from "../src/modules/billing/stripe";

describe("billing service", () => {
  it("parses billing config from yaml object", () => {
    const cfg = parseConfigObject({
      project: { name: "t", environment: "dev" },
      providers: {},
      budgets: {
        global: { monthly_usd: 100 },
        by_user_type: {
          free: { daily_usd: 1, daily_requests: 10, models: ["cheap"] },
        },
      },
      features: {
        chat: { model_class: "cheap", max_tokens: 100 },
      },
      model_classes: { cheap: { primary: "openai/gpt-4o-mini" } },
      billing: {
        provider: "stripe",
        mode: "hybrid",
        // Prepaid credits use Stripe only for top-ups (plan_map), never a usage
        // meter — meter_event_name alongside a credits mode is rejected by config
        // validation (it would double-bill). See config.test.ts.
        stripe: {
          plan_map: { price_pro: "paid_user" },
        },
      },
    });
    expect(cfg.billing?.mode).toBe("hybrid");
    expect(cfg.billing?.stripe?.planMap?.price_pro).toBe("paid_user");
  });

  it("is disabled when billing mode is internal_only", () => {
    const cfg = parseConfigObject({
      project: { name: "t", environment: "dev" },
      providers: {},
      budgets: {
        global: { monthly_usd: 0 },
        by_user_type: {
          free: { daily_usd: 1, daily_requests: 10, models: ["cheap"] },
        },
      },
      features: {
        chat: { model_class: "cheap", max_tokens: 100 },
      },
      model_classes: { cheap: { primary: "openai/gpt-4o-mini" } },
      billing: { provider: "none", mode: "internal_only" },
    });
    const svc = createBillingService({ query: async () => ({ rows: [] }) } as never, {
      billing: cfg.billing,
    });
    expect(svc).toBeUndefined();
  });

  it("metered mode: no prepaid credits, meter active", () => {
    const cfg = parseConfigObject({
      project: { name: "t", environment: "dev" },
      providers: {},
      budgets: {
        global: { monthly_usd: 100 },
        by_user_type: {
          free: { daily_usd: 1, daily_requests: 10, models: ["cheap"] },
        },
      },
      features: { chat: { model_class: "cheap", max_tokens: 100 } },
      model_classes: { cheap: { primary: "openai/gpt-4o-mini" } },
      billing: {
        provider: "stripe",
        mode: "metered",
        stripe: { secret_key: "sk_test", meter_event_name: "modelgov_usage" },
      },
    });
    const svc = createBillingService({ query: async () => ({ rows: [] }) } as never, {
      billing: cfg.billing,
    });
    expect(svc?.enabled).toBe(true);
    expect(svc?.usesCredits()).toBe(false);
    expect(svc?.usesMeter()).toBe(true);
  });

  it("refuses to construct a double-billing service (credits mode + meter event)", () => {
    // Config validation rejects this earlier; the constructor guard is defense
    // in depth for programmatic BillingConfig values.
    expect(() =>
      createBillingService({ query: async () => ({ rows: [] }) } as never, {
        billing: {
          provider: "stripe",
          mode: "credits_only",
          stripe: { meterEventName: "modelgov_usage" },
        },
      }),
    ).toThrow(/double|second time|meter/i);
    expect(() =>
      createBillingService({ query: async () => ({ rows: [] }) } as never, {
        billing: { provider: "stripe", mode: "metered", stripe: {} },
      }),
    ).toThrow(/meterEventName/);
    // Metered mode with a meter name but no Stripe secret would record meter
    // events that never flush (silently unbilled) — reject it at construction.
    expect(() =>
      createBillingService({ query: async () => ({ rows: [] }) } as never, {
        billing: { provider: "stripe", mode: "metered", stripe: { meterEventName: "modelgov_usage" } },
      }),
    ).toThrow(/secret/i);
  });

  it("flushPendingMeters reports pending events to the Stripe meter and marks them", async () => {
    const queries: string[] = [];
    const pool = {
      query: async (sql: string) => {
        queries.push(sql);
        if (sql.includes("FROM meter_events")) {
          return {
            rows: [
              {
                request_id: "req_1",
                tenant_id: "",
                user_id: "u1",
                feature: "chat",
                cost_usd: 0.25,
                stripe_customer_id: "cus_123",
              },
            ],
          };
        }
        return { rows: [], rowCount: 1 };
      },
    };
    const fetchCalls: Array<{ url: string; body: string }> = [];
    const fetchImpl = (async (url: unknown, init?: { body?: unknown }) => {
      fetchCalls.push({ url: String(url), body: String(init?.body) });
      return {
        ok: true,
        json: async () => ({ identifier: "req_1" }),
      };
    }) as unknown as typeof fetch;

    const svc = createBillingService(pool as never, {
      billing: {
        provider: "stripe",
        mode: "metered",
        stripe: { meterEventName: "modelgov_usage" },
      },
      stripeSecretKey: "sk_test",
      fetchImpl,
    });
    const reported = await svc!.flushPendingMeters();
    expect(reported).toBe(1);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toContain("meter_events");
    expect(fetchCalls[0]!.body).toContain("modelgov_usage");
    expect(fetchCalls[0]!.body).toContain("cus_123");
    expect(queries.some((q) => q.includes("UPDATE meter_events"))).toBe(true);
  });
});

describe("stripe webhook signature", () => {
  it("rejects invalid signatures", () => {
    const ok = verifyStripeWebhookSignature(
      Buffer.from('{"id":"evt_1"}'),
      "t=1,v1=deadbeef",
      "whsec_test",
    );
    expect(ok).toBe(false);
  });

  it("accepts any matching v1 entry during secret rotation", () => {
    const body = Buffer.from('{"id":"evt_1"}');
    const t = Math.floor(Date.now() / 1000);
    const goodSig = createHmac("sha256", "whsec_new")
      .update(`${t}.${body.toString("utf8")}`)
      .digest("hex");
    // Stripe signs with both secrets during rotation: the entry signed by the
    // OLD secret comes first, the NEW one second — it must still verify.
    const header = `t=${t},v1=${"0".repeat(64)},v1=${goodSig}`;
    expect(verifyStripeWebhookSignature(body, header, "whsec_new")).toBe(true);
    expect(verifyStripeWebhookSignature(body, header, "whsec_other")).toBe(false);
  });
});
