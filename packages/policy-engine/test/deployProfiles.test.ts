import { describe, expect, it } from "vitest";
import {
  assertDeployProfilePosture,
  deployProfileChecks,
  profileEnvFlags,
  resolveDeployProfile,
} from "../src/deployProfiles";

describe("resolveDeployProfile", () => {
  it("uses explicit MODELGOV_DEPLOY_PROFILE", () => {
    expect(resolveDeployProfile({ MODELGOV_DEPLOY_PROFILE: "selfhost" })).toBe("selfhost");
    expect(resolveDeployProfile({ MODELGOV_DEPLOY_PROFILE: "multitenant" })).toBe("multitenant");
  });

  it("infers multitenant from MULTI_TENANT_POLICY", () => {
    expect(resolveDeployProfile({ MULTI_TENANT_POLICY: "true" })).toBe("multitenant");
  });

  it("infers multitenant from policy store plus RLS", () => {
    expect(resolveDeployProfile({ POLICY_STORE_ENABLED: "true", DB_RLS_ENABLED: "true" })).toBe("multitenant");
    expect(resolveDeployProfile({ POLICY_STORE_ENABLED: "true" })).toBeUndefined();
  });
});

describe("profileEnvFlags", () => {
  it("selfhost keeps flat single-tenant defaults", () => {
    expect(profileEnvFlags("selfhost")).toMatchObject({
      HIERARCHICAL_BUDGETS: "false",
      MULTI_TENANT_POLICY: "false",
      POLICY_STORE_ENABLED: "false",
    });
  });

  it("multitenant enables policy store and RLS but not hierarchy by default", () => {
    expect(profileEnvFlags("multitenant")).toMatchObject({
      HIERARCHICAL_BUDGETS: "false",
      MULTI_TENANT_POLICY: "true",
      POLICY_STORE_ENABLED: "true",
      DB_RLS_ENABLED: "true",
    });
  });
});

describe("deployProfileChecks", () => {
  it("fails multitenant profile when RLS is off in production", () => {
    const checks = deployProfileChecks(
      {
        MODELGOV_DEPLOY_PROFILE: "multitenant",
        MODELGOV_PRODUCTION: "true",
        POLICY_STORE_ENABLED: "true",
        MULTI_TENANT_POLICY: "true",
        DB_RLS_ENABLED: "false",
      },
      { production: true },
    );
    expect(checks.some((c) => c.code === "multitenant_rls" && c.severity === "fail")).toBe(true);
  });

  it("warns selfhost when hierarchical budgets are enabled", () => {
    const checks = deployProfileChecks({
      MODELGOV_DEPLOY_PROFILE: "selfhost",
      HIERARCHICAL_BUDGETS: "true",
    });
    expect(checks.some((c) => c.code === "selfhost_hierarchical")).toBe(true);
  });

  it("fails partial multitenant flags after profile inference", () => {
    const checks = deployProfileChecks({
      MULTI_TENANT_POLICY: "true",
      POLICY_STORE_ENABLED: "false",
      DB_RLS_ENABLED: "false",
    });
    expect(checks).toContainEqual(
      expect.objectContaining({ code: "multitenant_rls", severity: "fail" }),
    );
    expect(checks).toContainEqual(
      expect.objectContaining({ code: "multitenant_policy_store", severity: "fail" }),
    );
  });

  it("passes a complete multitenant profile and warns on platform hierarchy", () => {
    const checks = deployProfileChecks({
      MODELGOV_DEPLOY_PROFILE: "multitenant",
      MODELGOV_PRODUCTION: "true",
      POLICY_STORE_ENABLED: "true",
      MULTI_TENANT_POLICY: "true",
      DB_RLS_ENABLED: "true",
      REDIS_URL: "redis://redis:6379",
      HIERARCHICAL_BUDGETS: "true",
    });
    expect(checks).toContainEqual(
      expect.objectContaining({ code: "multitenant_policy_store", severity: "pass" }),
    );
    expect(checks).toContainEqual(
      expect.objectContaining({ code: "multitenant_redis", severity: "pass" }),
    );
    expect(checks).toContainEqual(
      expect.objectContaining({ code: "hierarchical_platform", severity: "warn" }),
    );
  });

  it("warns when selfhost enables multitenant policy-store flags", () => {
    const checks = deployProfileChecks({
      MODELGOV_DEPLOY_PROFILE: "selfhost",
      MULTI_TENANT_POLICY: "true",
      POLICY_STORE_ENABLED: "true",
    });
    expect(checks).toContainEqual(
      expect.objectContaining({ code: "selfhost_multitenant_mismatch", severity: "warn" }),
    );
    expect(checks).toContainEqual(
      expect.objectContaining({ code: "selfhost_policy_store", severity: "warn" }),
    );
  });

  it("assertDeployProfilePosture throws on production multitenant misconfig", () => {
    expect(() =>
      assertDeployProfilePosture({
        MODELGOV_PRODUCTION: "true",
        MODELGOV_DEPLOY_PROFILE: "multitenant",
        POLICY_STORE_ENABLED: "true",
        MULTI_TENANT_POLICY: "true",
        DB_RLS_ENABLED: "false",
      }),
    ).toThrow(/Deploy profile posture failed/);
  });
});
