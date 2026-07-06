import type { BudgetCounters, UsageSummary } from "./api/usage";

/** Format a USD amount with 4 decimals (sub-cent model spend is common). */
export function fmtUsd(n: number): string {
  return `$${(Number.isFinite(n) ? n : 0).toFixed(4)}`;
}

/** Percentage of `n` over `total`, clamped to [0, 100]; 0 when total is 0. */
export function pctOf(n: number, total: number): number {
  if (!total || total <= 0) return 0;
  return Math.max(0, Math.min(100, (n / total) * 100));
}

export type Level = "ok" | "warn" | "crit";

export interface SpendVsCap {
  usedUsd: number;
  reservedUsd: number;
  committedUsd: number; // used + reserved (what counts against the cap)
  capUsd?: number;
  pct: number; // committed / cap, 0 when no cap
  level: Level;
  hasCap: boolean;
}

/**
 * Spend against the global monthly cap. Reserved (in-flight) spend counts toward
 * the cap just like settled spend — that's what the gateway enforces — so the
 * gauge sums both. Level thresholds mirror the usual degrade/hard-stop bands.
 */
export function spendVsCap(g: BudgetCounters["globalMonthly"] | undefined): SpendVsCap {
  const usedUsd = g?.usedUsd ?? 0;
  const reservedUsd = g?.reservedUsd ?? 0;
  const committedUsd = usedUsd + reservedUsd;
  const capUsd = g?.capUsd;
  const hasCap = typeof capUsd === "number" && capUsd > 0;
  const pct = hasCap ? pctOf(committedUsd, capUsd) : 0;
  const level: Level = !hasCap ? "ok" : pct >= 90 ? "crit" : pct >= 75 ? "warn" : "ok";
  return { usedUsd, reservedUsd, committedUsd, capUsd, pct, level, hasCap };
}

export interface OutcomeBar {
  key: string;
  label: string;
  count: number;
  pct: number; // of total requests
  cls: string; // css status class
}

/**
 * The request-outcome mix for the bar chart. Each bar's width is its share of
 * total requests, so completed (the bulk) and the failure modes read on one
 * scale. Rates of blocked/degraded/fallback are exactly these percentages.
 */
export function outcomeBars(s: UsageSummary): OutcomeBar[] {
  const total = s.requests;
  return [
    { key: "completed", label: "Completed", count: s.completed, cls: "status-ok" },
    { key: "blocked", label: "Budget/policy blocked", count: s.blocked, cls: "status-warn" },
    { key: "safetyBlocked", label: "Safety blocked", count: s.safetyBlocked, cls: "status-fail" },
    { key: "degraded", label: "Degraded", count: s.degraded, cls: "status-warn" },
    { key: "fallbacks", label: "Provider fallbacks", count: s.fallbacks, cls: "status-warn" },
  ].map((b) => ({ ...b, pct: pctOf(b.count, total) }));
}

/** "12s ago" / "3m ago" for a poll timestamp (ms epoch), given now (ms). */
export function agoLabel(then: number, now: number): string {
  const secs = Math.max(0, Math.round((now - then) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  return `${mins}m ago`;
}
