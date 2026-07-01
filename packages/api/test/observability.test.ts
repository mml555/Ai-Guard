import type { TraceTags } from "@ai-guard/policy-engine";
import { describe, expect, it } from "vitest";
import {
  createObservability,
  LangfuseObservability,
  NoopObservability,
  type ChatObservation,
} from "../src/services/observability";

const traceTags: TraceTags = {
  userId: "u1",
  feature: "support_chat",
  modelClass: "cheap",
  policyDecision: "allow",
};

const observation: ChatObservation = {
  userId: "u1",
  feature: "support_chat",
  decision: "allow",
  status: "ok",
  model: "openai/gpt-4o-mini",
  input: [{ role: "user", content: "hi" }],
  output: "hello",
  inputTokens: 5,
  outputTokens: 3,
  actualCostUsd: 0.0002,
  traceTags,
};

describe("createObservability", () => {
  it("returns Noop when provider is none", () => {
    const o = createObservability({ provider: "none" });
    expect(o).toBeInstanceOf(NoopObservability);
  });

  it("returns Noop when langfuse keys are missing", () => {
    const o = createObservability({ provider: "langfuse" });
    expect(o).toBeInstanceOf(NoopObservability);
  });

  it("returns Langfuse when fully configured", () => {
    const o = createObservability({
      provider: "langfuse",
      publicKey: "pk",
      secretKey: "sk",
      baseUrl: "http://localhost:3001",
    });
    expect(o).toBeInstanceOf(LangfuseObservability);
  });
});

describe("NoopObservability", () => {
  it("recordChat is a no-op and shutdown resolves", async () => {
    const o = new NoopObservability();
    expect(() => o.recordChat(observation)).not.toThrow();
    await expect(o.shutdown()).resolves.toBeUndefined();
  });
});

describe("LangfuseObservability", () => {
  it("recordChat never throws, even with an unreachable host", async () => {
    const o = new LangfuseObservability({
      publicKey: "pk",
      secretKey: "sk",
      baseUrl: "http://127.0.0.1:1", // unreachable
      captureContent: true,
    });
    expect(() => o.recordChat(observation)).not.toThrow();
    expect(() =>
      o.recordChat({ ...observation, status: "blocked", model: undefined, reason: "over budget" }),
    ).not.toThrow();
    await o.shutdown();
  });
});
