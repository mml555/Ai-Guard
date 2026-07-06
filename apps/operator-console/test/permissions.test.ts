import { describe, expect, it } from "vitest";
import { can, visibleNav } from "../src/permissions";
import { diffLine, formatDiffValue, statusClass } from "../src/policyView";

describe("permissions", () => {
  it("can() is false for missing/undefined perms and true for held ones", () => {
    expect(can(undefined, "policy:read")).toBe(false);
    expect(can([], "policy:read")).toBe(false);
    expect(can(["policy:read"], "policy:read")).toBe(true);
    expect(can(["usage:read"], "policy:read")).toBe(false);
  });

  it("visibleNav shows only ungated items before whoami resolves", () => {
    const labels = visibleNav(undefined).map((n) => n.label);
    // Overview and Health are ungated; permissioned tabs are hidden.
    expect(labels).toContain("Overview");
    expect(labels).toContain("Health");
    expect(labels).not.toContain("Keys");
    expect(labels).not.toContain("Policy");
    expect(labels).not.toContain("Privacy");
  });

  it("visibleNav reflects the operator's permissions", () => {
    const policyAdmin = ["policy:read", "policy:write", "usage:read", "requests:read", "audit:read"];
    const labels = visibleNav(policyAdmin).map((n) => n.label);
    // Metrics is ungated (token-based), so it shows regardless of permissions.
    expect(labels).toEqual(["Overview", "Requests", "Usage", "Policy", "Audit", "Metrics", "Health"]);
    // No keys:admin or data:erase → Keys and Privacy stay hidden.
    expect(labels).not.toContain("Keys");
    expect(labels).not.toContain("Privacy");
  });

  it("owner sees every tab", () => {
    const owner = ["chat:create", "usage:read", "requests:read", "keys:admin", "policy:read", "policy:write", "policy:approve", "audit:read", "data:erase", "billing:write"];
    const labels = visibleNav(owner).map((n) => n.label);
    expect(labels).toEqual(["Overview", "Requests", "Usage", "Keys", "Policy", "Audit", "Privacy", "Metrics", "Health"]);
  });
});

describe("policy view helpers", () => {
  it("maps status to a css class", () => {
    expect(statusClass("approved")).toBe("status-ok");
    expect(statusClass("rejected")).toBe("status-fail");
    expect(statusClass("proposed")).toBe("status-warn");
  });

  it("formats diff values, marking an absent side", () => {
    expect(formatDiffValue(undefined)).toBe("∅");
    expect(formatDiffValue(250)).toBe("250");
    expect(formatDiffValue("cheap")).toBe("cheap");
    expect(formatDiffValue(["a", "b"])).toBe('["a","b"]');
  });

  it("renders a readable diff line", () => {
    expect(diffLine({ path: "budgets.global.monthly_usd", from: 100, to: 250 }))
      .toBe("budgets.global.monthly_usd: 100 → 250");
    expect(diffLine({ path: "features.x", from: undefined, to: { a: 1 } }))
      .toBe('features.x: ∅ → {"a":1}');
  });
});
