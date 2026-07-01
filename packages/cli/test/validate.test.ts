import { describe, expect, it } from "vitest";
import { validateConfig } from "../src/validate.js";
import { runPolicyTestFile } from "../src/testPolicy.js";

describe("ai-guard validate", () => {
  it("accepts production example config when keys are set", () => {
    const result = validateConfig({
      configPath: "ai-guard.production.example.yaml",
      production: true,
      env: { OPENAI_API_KEY: "x", ANTHROPIC_API_KEY: "x" },
    });
    expect(result.ok).toBe(true);
  });

  it("rejects missing provider keys in production mode", () => {
    const result = validateConfig({
      configPath: "ai-guard.yaml",
      production: true,
      env: {},
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === "missing_provider_key")).toBe(true);
  });
});

describe("ai-guard test-policy", () => {
  it("runs repo policy regression file", () => {
    const { ok, results } = runPolicyTestFile("ai-guard.policy-tests.yaml");
    expect(results.length).toBeGreaterThan(0);
    expect(ok).toBe(true);
  });
});
