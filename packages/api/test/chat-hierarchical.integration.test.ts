import { parseConfigObject } from "@ai-guard/policy-engine";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applySchema } from "../src/db/init";
import { createPool, type Pool } from "../src/db/pool";
import { createNode, type BudgetNode } from "../src/modules/budgets/repo";
import { NoopObservability } from "../src/services/observability";
import { NoopGuard } from "../src/services/safety";
import { ProviderError, type LiteLLMClient } from "../src/services/litellm";
import { buildServer } from "../src/server";

const DATABASE_URL = process.env.DATABASE_URL;

// inputTokensEstimate is chosen so each request's estimate ≈ $0.15
// (1e6/1000 * 0.00015 input + 100/1000 * 0.0006 output), making cap math clean.
const BIG_INPUT = 1_000_000;

const config = parseConfigObject({
  project: { name: "test", environment: "test" },
  budgets: {
    global: { monthly_usd: 1000, hard_stop_at_percent: 100 },
    by_user_type: { logged_in: { daily_usd: 1000, daily_requests: 1000, models: ["cheap"] } },
  },
  features: { support_chat: { safety: "dev", model_class: "cheap", max_tokens: 100 } },
  model_classes: { cheap: { primary: "openai/gpt-4o-mini" } },
  safety: { preset: "dev" },
});

const okLiteLLM: LiteLLMClient = {
  chat: async () => ({ content: "ok", model: "openai/gpt-4o-mini", actualCostUsd: 0.15, inputTokens: 1000, outputTokens: 10, raw: {} }),
};
const failingLiteLLM: LiteLLMClient = {
  chat: async () => { throw new ProviderError("upstream down"); },
};

describe.skipIf(!DATABASE_URL)("hierarchical budgets — /v1/chat (integration)", () => {
  let pool: Pool;
  beforeAll(async () => {
    pool = createPool(DATABASE_URL!);
    await applySchema(pool);
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await pool.query("TRUNCATE budget_node_counters, budget_node_leases, budget_nodes, request_logs RESTART IDENTITY CASCADE");
  });

  function app(litellm: LiteLLMClient, hierarchical = true): FastifyInstance {
    return buildServer({
      config,
      pool,
      litellm,
      safety: new NoopGuard(),
      observability: new NoopObservability(),
      logger: false,
      apiKey: "secret",
      hierarchicalBudgets: hierarchical,
    });
  }

  async function tree(orgCap: number): Promise<{ org: BudgetNode; user: BudgetNode }> {
    const org = await createNode(pool, { tenantId: "acme", kind: "org", name: "acme", window: "monthly", capUsd: orgCap });
    const user = await createNode(pool, { tenantId: "acme", parentId: org.id, kind: "user", name: "u1", window: "monthly" });
    return { org, user };
  }

  function post(server: FastifyInstance, budgetNodeId?: string) {
    return server.inject({
      method: "POST",
      url: "/v1/chat",
      headers: { authorization: "Bearer secret" },
      payload: {
        userId: "u1", userType: "logged_in", feature: "support_chat",
        messages: [{ role: "user", content: "hi" }],
        inputTokensEstimate: BIG_INPUT,
        ...(budgetNodeId ? { budgetNodeId } : {}),
      },
    });
  }

  async function nodeCounter(id: string) {
    const { rows } = await pool.query("SELECT used_usd, reserved_usd, requests_used FROM budget_node_counters WHERE node_id = $1", [id]);
    const r = rows[0] ?? { used_usd: 0, reserved_usd: 0, requests_used: 0 };
    return { used: Number(r.used_usd), reserved: Number(r.reserved_usd), requests: Number(r.requests_used) };
  }

  async function leaseCount(): Promise<number> {
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM budget_node_leases");
    return rows[0].n;
  }

  it("charges the node path and blocks when an ancestor cap is exhausted", async () => {
    const { org, user } = await tree(0.35); // admits 2 × ~$0.15, rejects the 3rd
    const server = app(okLiteLLM);

    const r1 = await post(server, user.id);
    const r2 = await post(server, user.id);
    const r3 = await post(server, user.id);

    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    expect(r3.statusCode).toBe(403);
    expect(r3.json().error.code).toBe("budget_exceeded");
    expect(r3.json().error.details.failedNodeId).toBe(org.id);

    const c = await nodeCounter(org.id);
    expect(c.used).toBeCloseTo(0.3, 4); // two settled calls at $0.15
    expect(c.reserved).toBeCloseTo(0, 6);
    expect(await leaseCount()).toBe(0); // settled reservations drop their lease
  });

  it("rolls spend up to every node on the path", async () => {
    const { org, user } = await tree(10);
    await post(app(okLiteLLM), user.id);
    expect((await nodeCounter(org.id)).used).toBeCloseTo(0.15, 4);
    expect((await nodeCounter(user.id)).used).toBeCloseTo(0.15, 4);
  });

  it("releases the reservation and lease on a provider failure", async () => {
    const { org, user } = await tree(10);
    const res = await post(app(failingLiteLLM), user.id);
    expect(res.statusCode).toBe(502);
    const c = await nodeCounter(org.id);
    expect(c.reserved).toBeCloseTo(0, 6);
    expect(c.requests).toBe(0);
    expect(await leaseCount()).toBe(0);
  });

  it("rejects an unknown budgetNodeId", async () => {
    const res = await post(app(okLiteLLM), "999999");
    expect(res.statusCode).toBe(400);
  });

  it("uses the flat path (no node counters) when no budgetNodeId is given", async () => {
    const { org } = await tree(0.01); // tiny cap — would block hierarchical, but flat path ignores nodes
    const res = await post(app(okLiteLLM)); // no budgetNodeId
    expect(res.statusCode).toBe(200);
    expect((await nodeCounter(org.id)).used).toBe(0); // node tree untouched
  });

  it("ignores the node path when the flag is off", async () => {
    const { org, user } = await tree(0.01);
    const res = await post(app(okLiteLLM, false), user.id); // flag off
    expect(res.statusCode).toBe(200); // flat path admits
    expect((await nodeCounter(org.id)).used).toBe(0);
  });
});
