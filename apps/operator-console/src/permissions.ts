// Pure permission logic shared by the shell (nav) and pages (action gating).
// Enforcement is server-side on every endpoint — this only hides/disables what
// the operator cannot do, so the UI matches their role.

export interface NavItem {
  path: string;
  label: string;
  /** Permission required to see this item; omitted = always visible. */
  perm?: string;
}

// Ordered as the sidebar renders them.
export const NAV_ITEMS: readonly NavItem[] = [
  { path: "/overview", label: "Overview" },
  { path: "/requests", label: "Requests", perm: "requests:read" },
  { path: "/usage", label: "Usage", perm: "usage:read" },
  { path: "/keys", label: "Keys", perm: "keys:admin" },
  { path: "/policy", label: "Policy", perm: "policy:read" },
  { path: "/audit", label: "Audit", perm: "audit:read" },
  { path: "/privacy", label: "Privacy", perm: "data:erase" },
  // Prometheus /metrics has its own token-based auth (not RBAC), so it isn't
  // permission-gated here — the page guides token setup if the scrape 401s.
  { path: "/metrics", label: "Metrics" },
  { path: "/health", label: "Health" },
];

/** True when the operator holds `perm` (undefined perms → treated as none). */
export function can(perms: readonly string[] | undefined, perm: string): boolean {
  return !!perms && perms.includes(perm);
}

/** Nav items the operator may see. Before whoami loads (perms undefined) show
 *  only ungated items so the shell never flashes links that 403 on click. */
export function visibleNav(perms: readonly string[] | undefined): NavItem[] {
  return NAV_ITEMS.filter((item) => !item.perm || can(perms, item.perm));
}
