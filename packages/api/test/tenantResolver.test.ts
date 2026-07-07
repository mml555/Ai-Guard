import { describe, expect, it } from "vitest";
import { parseConfigObject } from "@modelgov/policy-engine";
import { createTenantPolicyResolver } from "../src/modules/policy/tenantResolver";

// Unit tests for the last-good / bounded-cache behavior (Codex P2). No DB — a
// fake pool returns a per-tenant active version and can be flipped to error.

const YAML = `
project: { name: t, environment: test }
budgets:
  global: { monthly_usd: 100, hard_stop_at_percent: 100 }
  by_user_type: { logged_in: { daily_usd: 1, daily_requests: 10, models: [cheap] } }
features: { support_chat: { model_class: cheap, max_tokens: 100, safety: dev } }
model_classes: { cheap: { primary: openai/gpt-4o-mini } }
safety: { preset: dev }
`;

const fallback = { config: parseConfigObject({
  project: { name: "fallback", environment: "test" },
  budgets: {
    global: { monthly_usd: 1, hard_stop_at_percent: 100 },
    by_user_type: { logged_in: { daily_usd: 1, daily_requests: 1, models: ["cheap"] } },
  },
  features: { support_chat: { model_class: "cheap", max_tokens: 1, safety: "dev" } },
  model_classes: { cheap: { primary: "openai/gpt-4o-mini" } },
  safety: { preset: "dev" },
}), policyMeta: { policyVersion: "fallback" } };

const versionRow = (tenantId: string, active: boolean) => ({
  id: `v-${tenantId}`,
  created_at: new Date("2026-01-01T00:00:00Z"),
  author: null,
  note: null,
  checksum: `sum-${tenantId}`,
  active,
  activated_at: new Date("2026-01-01T00:00:00Z"),
  status: "approved",
  proposed_by: null,
  reviewed_by: "r",
  reviewed_at: new Date("2026-01-01T00:00:00Z"),
  yaml_text: YAML,
});

/** Fake pool: returns an active version for tenants in `withActive`, else none.
 *  When `fail` is set true it throws for the config_versions read. */
function fakePool(withActive: Set<string>, state: { fail: boolean }) {
  return {
    query: async (sql: string, params?: unknown[]) => {
      if (sql.includes("config_versions")) {
        if (state.fail) throw new Error("db read failed");
        const tenantId = String(params?.[0] ?? "");
        return withActive.has(tenantId)
          ? { rows: [versionRow(tenantId, true)], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

describe("createTenantPolicyResolver last-good + bound (P2)", () => {
  it("serves the last-good version for a tenant when a later load errors", async () => {
    const state = { fail: false };
    let clock = 1_000;
    const resolver = createTenantPolicyResolver({
      pool: fakePool(new Set(["acme"]), state) as never,
      fallback,
      ttlMs: 100,
      now: () => clock,
    });

    const first = await resolver.resolve("acme");
    expect(first.policyMeta.policyVersion).toBe("v-acme");

    // Expire the cache and make the store fail — must serve last-good, not fallback.
    clock += 1_000;
    state.fail = true;
    const afterError = await resolver.resolve("acme");
    expect(afterError.policyMeta.policyVersion).toBe("v-acme");
  });

  it("serves fallback (not last-good) for a tenant that never had an active version", async () => {
    const state = { fail: false };
    let clock = 1_000;
    const resolver = createTenantPolicyResolver({
      pool: fakePool(new Set(), state) as never, // no tenant has an active version
      fallback,
      ttlMs: 100,
      now: () => clock,
    });

    const first = await resolver.resolve("ghost");
    expect(first.policyMeta.policyVersion).toBe("fallback");

    clock += 1_000;
    state.fail = true;
    const afterError = await resolver.resolve("ghost");
    // No real version was ever stored in last-good, so it degrades to fallback.
    expect(afterError.policyMeta.policyVersion).toBe("fallback");
  });

  it("bounds last-good: an evicted tenant degrades to fallback on a later error", async () => {
    const state = { fail: false };
    let clock = 1_000;
    const resolver = createTenantPolicyResolver({
      pool: fakePool(new Set(["a", "b", "c"]), state) as never,
      fallback,
      ttlMs: 100,
      maxEntries: 2, // only 2 last-good entries retained
      now: () => clock,
    });

    // Populate last-good for a, b, c in order; a should be evicted (oldest).
    expect((await resolver.resolve("a")).policyMeta.policyVersion).toBe("v-a");
    expect((await resolver.resolve("b")).policyMeta.policyVersion).toBe("v-b");
    expect((await resolver.resolve("c")).policyMeta.policyVersion).toBe("v-c");

    clock += 1_000;
    state.fail = true;
    // 'a' was evicted from last-good → fallback; 'c' is retained → its version.
    expect((await resolver.resolve("a")).policyMeta.policyVersion).toBe("fallback");
    expect((await resolver.resolve("c")).policyMeta.policyVersion).toBe("v-c");
  });
});
