import { parseConfig } from "@ai-guard/policy-engine";
import { describe, expect, it } from "vitest";
import {
  composeFileFor,
  renderAiGuardYaml,
  renderEnv,
  type ScaffoldOptions,
} from "../src/render";

const base: ScaffoldOptions = {
  projectName: "my-app",
  providers: ["openai", "anthropic"],
  mode: "simple",
  safetyPreset: "balanced",
};

describe("renderAiGuardYaml", () => {
  it("produces config that parses against the real schema", () => {
    const cfg = parseConfig(renderAiGuardYaml(base));
    expect(cfg.project.name).toBe("my-app");
    expect(cfg.features.support_chat?.modelClass).toBe("cheap");
    expect(cfg.modelClasses.cheap?.primary).toBe("openai/gpt-4o-mini");
    expect(cfg.modelClasses.cheap?.fallback).toBe("anthropic/claude-haiku");
    expect(cfg.safety.preset).toBe("balanced");
    expect(cfg.observability.provider).toBe("none");
  });

  it("sets langfuse observability in full mode", () => {
    const cfg = parseConfig(renderAiGuardYaml({ ...base, mode: "full" }));
    expect(cfg.observability.provider).toBe("langfuse");
  });

  it("parses for a single-provider setup (no fallback)", () => {
    const cfg = parseConfig(
      renderAiGuardYaml({ ...base, providers: ["openai"] }),
    );
    expect(cfg.modelClasses.cheap?.fallback).toBeUndefined();
    // standard still references a valid (openai) model
    expect(cfg.modelClasses.standard?.primary).toBe("openai/gpt-4o");
  });

  it("parses for anthropic-only", () => {
    const cfg = parseConfig(
      renderAiGuardYaml({ ...base, providers: ["anthropic"] }),
    );
    expect(cfg.modelClasses.cheap?.primary).toBe("anthropic/claude-haiku");
    expect(cfg.modelClasses.standard?.primary).toBe("anthropic/claude-sonnet");
  });
});

describe("renderEnv", () => {
  it("includes a key line per provider and Presidio for non-dev presets", () => {
    const env = renderEnv(base);
    expect(env).toContain("OPENAI_API_KEY=");
    expect(env).toContain("ANTHROPIC_API_KEY=");
    expect(env).toContain("AI_GUARD_API_KEY=sk-ai-guard-api-local");
    expect(env).toContain("PRESIDIO_ANALYZER_URL=");
  });

  it("omits Presidio for the dev preset", () => {
    const env = renderEnv({ ...base, safetyPreset: "dev" });
    expect(env).not.toContain("PRESIDIO_ANALYZER_URL=");
  });
});

describe("composeFileFor", () => {
  it("maps modes to compose files", () => {
    expect(composeFileFor("simple")).toBe("-f docker-compose.simple.yml");
    expect(composeFileFor("full")).toBe(
      "-f docker-compose.simple.yml -f docker-compose.full.yml",
    );
  });
});
