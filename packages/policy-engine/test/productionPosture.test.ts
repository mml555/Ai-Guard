import { describe, expect, it } from "vitest";
import {
  isRemoteDatabaseUrl,
  isWeakSecret,
  productionPostureChecks,
} from "../src/productionPosture";

describe("productionPostureChecks", () => {
  it("passes metrics auth when a strong token is configured", () => {
    const checks = productionPostureChecks({
      METRICS_ENABLED: "true",
      METRICS_AUTH_TOKEN: "metrics-token-abcdefghijklmnopqrstuvwxyz",
      DATABASE_SSL: "verify-full",
    });
    expect(checks).toContainEqual(
      expect.objectContaining({ code: "metrics_auth", severity: "pass" }),
    );
  });

  it("rejects weak metrics tokens", () => {
    const checks = productionPostureChecks({
      METRICS_ENABLED: "true",
      METRICS_AUTH_TOKEN: "secret",
      DATABASE_SSL: "verify-full",
    });
    expect(checks).toContainEqual(
      expect.objectContaining({ code: "metrics_auth", severity: "fail" }),
    );
  });

  it("allows public metrics only when explicitly requested", () => {
    const checks = productionPostureChecks({
      METRICS_ENABLED: "true",
      METRICS_ALLOW_PUBLIC: "true",
      DATABASE_SSL: "verify-full",
    });
    expect(checks.some((c) => c.code === "metrics_auth" && c.severity === "fail")).toBe(false);
  });

  it("permits remote DATABASE_SSL=require only with the no-verify override", () => {
    const checks = productionPostureChecks({
      DATABASE_URL: "postgres://db.example.com/modelgov",
      DATABASE_SSL: "require",
      DATABASE_SSL_NO_VERIFY_ALLOWED: "true",
    });
    expect(checks).toContainEqual(
      expect.objectContaining({ code: "database_ssl", severity: "pass" }),
    );
  });

  it("fails remote DATABASE_SSL=require without certificate verification", () => {
    const checks = productionPostureChecks({
      DATABASE_URL: "postgres://db.example.com/modelgov",
      DATABASE_SSL: "require",
    });
    expect(checks).toContainEqual(
      expect.objectContaining({ code: "database_ssl", severity: "fail" }),
    );
  });

  it("warns when DATABASE_SSL=disable is explicitly allowed for bundled Postgres", () => {
    const checks = productionPostureChecks({
      DATABASE_URL: "postgres://postgres:postgres@postgres:5432/modelgov",
      DATABASE_SSL: "disable",
      DATABASE_SSL_DISABLE_ALLOWED: "true",
    });
    expect(checks).toContainEqual(
      expect.objectContaining({ code: "database_ssl", severity: "warn" }),
    );
  });

  it("fails content capture unless each capture path has an explicit allow flag", () => {
    const checks = productionPostureChecks({
      DATABASE_SSL: "verify-full",
      OBSERVABILITY_CAPTURE_CONTENT: "true",
      IDEMPOTENCY_CAPTURE_CONTENT: "true",
    });
    expect(checks).toContainEqual(expect.objectContaining({ code: "obs_capture" }));
    expect(checks).toContainEqual(expect.objectContaining({ code: "idempotency_capture" }));
  });

  it("passes proxy mode when TRUST_PROXY is set", () => {
    const checks = productionPostureChecks({
      DATABASE_SSL: "verify-full",
      MODELGOV_BEHIND_PROXY: "true",
      TRUST_PROXY: "10.0.0.10",
    });
    expect(checks).toContainEqual(
      expect.objectContaining({ code: "trust_proxy", severity: "pass" }),
    );
  });

  it("fails proxy mode without TRUST_PROXY", () => {
    const checks = productionPostureChecks({
      DATABASE_SSL: "verify-full",
      MODELGOV_BEHIND_PROXY: "true",
    });
    expect(checks).toContainEqual(
      expect.objectContaining({ code: "trust_proxy", severity: "fail" }),
    );
  });

  it("detects Langfuse dev credentials", () => {
    const checks = productionPostureChecks({
      DATABASE_SSL: "verify-full",
      LANGFUSE_PUBLIC_KEY: "pk-lf-modelgov-local",
    });
    expect(checks).toContainEqual(
      expect.objectContaining({ code: "langfuse_dev", severity: "fail" }),
    );
  });

  it("warns for non-production OIDC without audience only when the escape hatch is set", () => {
    const checks = productionPostureChecks({
      DATABASE_SSL: "verify-full",
      OIDC_ISSUER: "https://login.example.com/",
      OIDC_JWKS_URI: "https://login.example.com/jwks.json",
      OIDC_AUDIENCE_OPTIONAL: "true",
    });
    expect(checks).toContainEqual(
      expect.objectContaining({ code: "oidc_audience", severity: "warn" }),
    );
  });

  it("fails production OIDC without audience even when the local escape hatch is set", () => {
    const checks = productionPostureChecks({
      DATABASE_SSL: "verify-full",
      MODELGOV_PRODUCTION: "true",
      OIDC_ISSUER: "https://login.example.com/",
      OIDC_JWKS_URI: "https://login.example.com/jwks.json",
      OIDC_AUDIENCE_OPTIONAL: "true",
    });
    expect(checks).toContainEqual(
      expect.objectContaining({ code: "oidc_audience", severity: "fail" }),
    );
  });
});

describe("production posture helpers", () => {
  it("classifies local and remote database hosts", () => {
    expect(isRemoteDatabaseUrl("postgres://postgres:postgres@postgres:5432/modelgov")).toBe(false);
    expect(isRemoteDatabaseUrl("postgres://localhost:5432/modelgov")).toBe(false);
    expect(isRemoteDatabaseUrl("postgres://[::1]:5432/modelgov")).toBe(false);
    expect(isRemoteDatabaseUrl("postgres://db.internal.local/modelgov")).toBe(false);
    expect(isRemoteDatabaseUrl("postgres://db.example.com/modelgov")).toBe(true);
    expect(isRemoteDatabaseUrl("not a url")).toBe(true);
  });

  it("detects short and placeholder secrets", () => {
    expect(isWeakSecret("short")).toBe(true);
    expect(isWeakSecret("changeme")).toBe(true);
    expect(isWeakSecret("abcdefghijklmnopqrstuvwxyz123456")).toBe(false);
    expect(isWeakSecret(undefined)).toBe(false);
  });
});
