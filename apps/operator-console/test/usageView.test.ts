import { describe, expect, it } from "vitest";
import type { UsageSummary } from "../src/api/usage";
import { agoLabel, fmtUsd, outcomeBars, pctOf, spendVsCap } from "../src/usageView";

describe("usage view helpers", () => {
  it("fmtUsd formats to 4 decimals and tolerates non-finite", () => {
    expect(fmtUsd(1.23456)).toBe("$1.2346");
    expect(fmtUsd(0)).toBe("$0.0000");
    expect(fmtUsd(NaN)).toBe("$0.0000");
  });

  it("pctOf clamps and guards divide-by-zero", () => {
    expect(pctOf(5, 10)).toBe(50);
    expect(pctOf(0, 0)).toBe(0);
    expect(pctOf(20, 10)).toBe(100); // clamped
    expect(pctOf(-5, 10)).toBe(0); // clamped
  });

  describe("spendVsCap", () => {
    it("has no cap when none configured — shows spend, level ok", () => {
      const s = spendVsCap({ windowStart: "w", usedUsd: 3, reservedUsd: 1 });
      expect(s.hasCap).toBe(false);
      expect(s.committedUsd).toBe(4);
      expect(s.pct).toBe(0);
      expect(s.level).toBe("ok");
    });

    it("counts used + reserved against the cap and bands the level", () => {
      expect(spendVsCap({ windowStart: "w", usedUsd: 30, reservedUsd: 10, capUsd: 100 })).toMatchObject({
        committedUsd: 40,
        pct: 40,
        level: "ok",
        hasCap: true,
      });
      expect(spendVsCap({ windowStart: "w", usedUsd: 70, reservedUsd: 10, capUsd: 100 }).level).toBe("warn");
      expect(spendVsCap({ windowStart: "w", usedUsd: 95, reservedUsd: 0, capUsd: 100 }).level).toBe("crit");
    });

    it("treats a zero cap as no cap (avoids divide-by-zero)", () => {
      const s = spendVsCap({ windowStart: "w", usedUsd: 1, reservedUsd: 0, capUsd: 0 });
      expect(s.hasCap).toBe(false);
      expect(s.pct).toBe(0);
    });

    it("handles missing counters", () => {
      expect(spendVsCap(undefined)).toMatchObject({ usedUsd: 0, reservedUsd: 0, hasCap: false });
    });
  });

  it("outcomeBars computes each outcome's share of total requests", () => {
    const summary: UsageSummary = {
      since: "s",
      requests: 100,
      completed: 80,
      blocked: 10,
      degraded: 5,
      fallbacks: 3,
      safetyBlocked: 2,
      actualCostUsd: 1,
      estimatedCostUsd: 1,
    };
    const bars = outcomeBars(summary);
    const byKey = Object.fromEntries(bars.map((b) => [b.key, b]));
    expect(byKey.completed).toMatchObject({ count: 80, pct: 80, cls: "status-ok" });
    expect(byKey.safetyBlocked).toMatchObject({ count: 2, pct: 2, cls: "status-fail" });
    expect(byKey.blocked.pct).toBe(10);
  });

  it("outcomeBars yields zero pct (not NaN) when there are no requests", () => {
    const empty: UsageSummary = {
      since: "s", requests: 0, completed: 0, blocked: 0, degraded: 0, fallbacks: 0,
      safetyBlocked: 0, actualCostUsd: 0, estimatedCostUsd: 0,
    };
    expect(outcomeBars(empty).every((b) => b.pct === 0)).toBe(true);
  });

  it("agoLabel renders seconds then minutes", () => {
    const now = 1_000_000;
    expect(agoLabel(now - 5_000, now)).toBe("5s ago");
    expect(agoLabel(now - 90_000, now)).toBe("2m ago");
    expect(agoLabel(now + 5_000, now)).toBe("0s ago"); // clamped, never negative
  });
});
