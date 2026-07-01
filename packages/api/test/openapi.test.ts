import { parseConfigObject } from "@ai-guard/policy-engine";
import { describe, expect, it } from "vitest";
import { NoopObservability } from "../src/services/observability";
import { NoopGuard } from "../src/services/safety";
import { buildServer } from "../src/server";

const config = parseConfigObject({
  project: { name: "test", environment: "test" },
  budgets: {
    global: { monthly_usd: 100, hard_stop_at_percent: 100 },
    by_user_type: {
      logged_in: { daily_usd: 1, daily_requests: 10, models: ["cheap"] },
    },
  },
  features: {
    support_chat: { safety: "dev", model_class: "cheap", max_tokens: 100 },
  },
  model_classes: {
    cheap: { primary: "openai/gpt-4o-mini" },
  },
  safety: { preset: "dev" },
});

describe("OpenAPI", () => {
  it("serves the generated chat contract", async () => {
    const app = buildServer({
      config,
      pool: {
        query: async () => ({ rows: [], rowCount: 0 }),
        connect: async () => ({
          query: async () => ({ rows: [], rowCount: 1 }),
          release: () => {},
        }),
      } as never,
      litellm: {
        chat: async () => {
          throw new Error("not called");
        },
      },
      safety: new NoopGuard(),
      observability: new NoopObservability(),
      logger: false,
      allowUnauthenticated: true,
    });

    const res = await app.inject({ method: "GET", url: "/openapi.json" });
    expect(res.statusCode).toBe(200);
    expect(res.json().paths["/v1/chat"].post).toBeTruthy();
    expect(res.json().paths["/v1/explain"].post).toBeTruthy();
    expect(res.json().paths["/v1/requests"].get).toBeTruthy();
    expect(res.json().paths["/v1/usage/summary"].get).toBeTruthy();
    await app.close();
  });
});
