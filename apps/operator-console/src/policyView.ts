import type { DiffEntry, PolicyStatus } from "./api/policy";

/** CSS status class for a version's approval state. */
export function statusClass(status: PolicyStatus): string {
  if (status === "approved") return "status-ok";
  if (status === "rejected") return "status-fail";
  return "status-warn"; // proposed
}

/** Human string for a diff value (undefined = absent on that side). */
export function formatDiffValue(v: unknown): string {
  if (v === undefined) return "∅";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** One readable "path: before → after" line for a diff entry. */
export function diffLine(e: DiffEntry): string {
  return `${e.path}: ${formatDiffValue(e.from)} → ${formatDiffValue(e.to)}`;
}
