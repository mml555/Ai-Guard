import { apiFetch } from "./client";

/** Shape of GET /v1/admin/whoami — the operator's own identity + permissions. */
export interface Whoami {
  name: string | null;
  permissions: string[];
  tenantId: string | null;
  /** True when locked to one tenant; false = platform operator (may switch). */
  tenantBound: boolean;
}

export function fetchWhoami(): Promise<Whoami> {
  return apiFetch<Whoami>("/v1/admin/whoami");
}

/** Selectable tenants (platform operators see all; bound operators see own). */
export function fetchTenants(): Promise<string[]> {
  return apiFetch<{ tenants: string[] }>("/v1/admin/tenants").then((r) => r.tenants);
}
