import { apiFetch } from "./client";

/** GET /v1/usage/summary — aggregated request/cost outcomes over a window. */
export interface UsageSummary {
  since: string;
  requests: number;
  completed: number;
  blocked: number;
  degraded: number;
  fallbacks: number;
  safetyBlocked: number;
  actualCostUsd: number;
  estimatedCostUsd: number;
  topReasonCode?: { code: string; count: number };
  topModel?: { model: string; count: number };
}

/** GET /v1/usage — current budget counters (global month spend vs cap). */
export interface BudgetCounters {
  asOf: string;
  globalMonthly?: {
    windowStart: string;
    usedUsd: number;
    reservedUsd: number;
    capUsd?: number;
  };
  recentRequests: { last24h: number; last24hFailed: number };
}

export const fetchUsageSummary = (since: string): Promise<UsageSummary> =>
  apiFetch<UsageSummary>(`/v1/usage/summary?since=${encodeURIComponent(since)}`);

export const fetchBudgetCounters = (): Promise<BudgetCounters> =>
  apiFetch<BudgetCounters>("/v1/usage");
