import type { Pool } from "pg";

/**
 * Distinct tenant ids known to the deployment — the union of tenants that have
 * an API key or any logged request. Sourced from `api_keys` and `request_logs`
 * (both non-RLS) rather than `config_versions` so the list is complete even when
 * `DB_RLS_ENABLED=true` would filter the config store to one tenant. A tenant
 * with neither a key nor traffic yet simply doesn't appear.
 */
export async function listTenants(pool: Pool): Promise<string[]> {
  const { rows } = await pool.query<{ tenant_id: string }>(
    `SELECT DISTINCT tenant_id FROM (
       SELECT tenant_id FROM api_keys WHERE tenant_id IS NOT NULL AND tenant_id <> ''
       UNION
       SELECT tenant_id FROM request_logs WHERE tenant_id IS NOT NULL AND tenant_id <> ''
     ) t
     ORDER BY tenant_id`,
  );
  return rows.map((r) => r.tenant_id);
}
