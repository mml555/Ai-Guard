/**
 * Tenant partition filter for reads over `request_logs`.
 *
 * resolveTenantScope (authz/scope.ts) returns "" for the default (untenanted)
 * partition, which `request_logs` stores as NULL — so the "" sentinel MUST
 * become `tenant_id IS NULL`, never `tenant_id = ''` (which matches nothing and
 * would leak: dropping the filter entirely returns every tenant's rows). A
 * `tenantScope` of `undefined` means the caller applies no tenant filter at all.
 *
 * Centralized here so every read over `request_logs` enforces tenant isolation
 * identically instead of re-deriving the NULL-vs-empty-string translation at
 * each call site (where one omission silently breaks isolation).
 */
export function appendRequestLogTenantScope(
  conditions: string[],
  values: unknown[],
  tenantScope: string | undefined,
): void {
  if (tenantScope === undefined) return;
  if (tenantScope === "") {
    conditions.push("tenant_id IS NULL");
    return;
  }
  values.push(tenantScope);
  conditions.push(`tenant_id = $${values.length}`);
}
