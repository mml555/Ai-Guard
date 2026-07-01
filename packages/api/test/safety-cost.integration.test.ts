import { parseConfigObject, type SafetyPlan } from "@ai-guard/policy-engine";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applySchema } from "../src/db/init";
import { createPool, type Pool } from "../src/db/pool";
import type { ChatMessage } from "../src/types";
import type { OutputSafetyResult, SafetyGuard, SafetyResult } from "../src/services/safety";
import { NoopObservability } from "../src/services/observability";
import { buildServer } from "../src/server";

const DATABASE_URL = process.env.DATABASE_URL;

// Input estimate ≈ $0.0975 (650k tokens × $0.00015/1k) + tiny output.
const INPUT_TOKENS = 650_000;
const SAFETY_COST = 0.1;

/** Safety guard that charges a fixed classifier cost but allows the request. */
class CostlySafety implements SafetyGuard {
  async inspectInput(messages: ChatMessage[], _plan: SafetyPlan): Promise<SafetyResult> {
    return { action: "allow", messages, piiMasked: false, injectionBlocked: false, findings: [], safetyCostUsd: SAFETY_COST };
  }
  async inspectOutput(content: string, _plan: SafetyPlan): Promise<OutputSafetyResult> {
    return { action: "allow", content, piiMasked: false, findings: [] };
  }
}

function config(dailyUsd: number) {
  return parseConfigObject({
    project: { name: "test", environment: "test" },
    budgets: {
      global: { monthly_usd: 1000, hard_stop_at_percent: 100 },
      by_user_type: { logged_in: { daily_usd: dailyUsd, daily_requests: 100, models: ["cheap"] } },
    },
    features: { support_chat: { safety: "dev", model_class: "cheap", max_tokens: 50 } },
    model_classes: { cheap: { primary: "openai/gpt-4o-mini" } },
    safety: { preset: "dev" },
  });
}

describe.skipIf(!DATABASE_URL)("safety cost is reserved upfront (integration)", () => {
  let pool: Pool;
  beforeAll(async () => {
    pool = createPool(DATABASE_URL!);
    await applySchema(pool);
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await pool.query("TRUNCATE budget_counters, request_logs, budget_reservation_leases");
  });

  function app(dailyUsd: number): FastifyInstance {
    return buildServer({
      config: config(dailyUsd),
      pool,
      litellm: { chat: async () => ({ content: "ok", model: "openai/gpt-4o-mini", actualCostUsd: 0.0975, inputTokens: 650000, outputTokens: 10, raw: {} }) },
      safety: new CostlySafety(),
      observability: new NoopObservability(),
      logger: false,
      apiKey: "secret",
    });
  }

  const body = {
    userId: "u1", userType: "logged_in", feature: "support_chat",
    messages: [{ role: "user", content: "hi" }], inputTokensEstimate: INPUT_TOKENS,
  };

  function post(server: FastifyInstance) {
    return server.inject({ method: "POST", url: "/v1/chat", headers: { authorization: "Bearer secret" }, payload: body });
  }

  it("blocks when model estimate fits but model + safety exceeds the cap", async () => {
    // cap 0.15: model (~0.0975) alone fits, but model + safety (~0.1975) does not.
    const res = await post(app(0.15));
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("budget_exceeded");
  });

  it("admits when the cap covers model + safety, and settles both", async () => {
    const res = await post(app(0.3));
    expect(res.statusCode).toBe(200);
    const { rows } = await pool.query(
      "SELECT used_usd FROM budget_counters WHERE scope = 'user_daily'",
    );
    // settled used = model actual (0.0975) + safety (0.10) ≈ 0.1975
    expect(Number(rows[0].used_usd)).toBeCloseTo(0.1975, 4);
  });
});
