import { describe, expect, it } from "vitest";
import { resolveEffectiveTenant } from "../src/plugins/auth";

describe("resolveEffectiveTenant", () => {
  it("locks a tenant-bound principal to its tenant, ignoring any override header", () => {
    expect(resolveEffectiveTenant("acme", "globex")).toBe("acme");
    expect(resolveEffectiveTenant("acme", undefined)).toBe("acme");
  });

  it("treats an empty/whitespace binding as unbound so the header still applies", () => {
    // A key persisted with tenant_id "" (rather than NULL) must not be silently
    // locked to the empty partition; it behaves like a platform key.
    expect(resolveEffectiveTenant("", "globex")).toBe("globex");
    expect(resolveEffectiveTenant("   ", "globex")).toBe("globex");
    expect(resolveEffectiveTenant("", undefined)).toBeUndefined();
  });

  it("lets a platform (unbound) principal target a tenant via the header", () => {
    expect(resolveEffectiveTenant(undefined, "acme")).toBe("acme");
    expect(resolveEffectiveTenant(undefined, "  acme  ")).toBe("acme"); // trimmed
  });

  it("treats a platform principal with no usable header as untenanted (undefined)", () => {
    expect(resolveEffectiveTenant(undefined, undefined)).toBeUndefined();
    expect(resolveEffectiveTenant(undefined, "")).toBeUndefined();
    expect(resolveEffectiveTenant(undefined, "   ")).toBeUndefined();
  });

  it("rejects an over-long header value", () => {
    expect(resolveEffectiveTenant(undefined, "x".repeat(201))).toBeUndefined();
  });

  it("ignores a non-string header (e.g. a repeated header parsed as an array)", () => {
    expect(resolveEffectiveTenant(undefined, ["acme", "globex"])).toBeUndefined();
  });
});
