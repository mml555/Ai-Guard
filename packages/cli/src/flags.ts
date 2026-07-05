import type { UsageSnapshot } from "@modelgov/policy-engine";

/** Default API base URL used across CLI commands when none is configured. */
export const DEFAULT_BASE_URL = "http://localhost:3090";

/**
 * Return the value following `flag` in `args`, or undefined when the flag is
 * absent. Shared by the CLI command parsers so the lookup lives in one place.
 */
export function flagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

/** A zero-filled usage snapshot (no spend/requests recorded yet). */
export function zeroUsage(): UsageSnapshot {
  return {
    userDailyUsdUsed: 0,
    userDailyUsdReserved: 0,
    userDailyRequestsUsed: 0,
    featureMonthlyUsdUsed: 0,
    featureMonthlyUsdReserved: 0,
    globalMonthlyUsdUsed: 0,
    globalMonthlyUsdReserved: 0,
  };
}
