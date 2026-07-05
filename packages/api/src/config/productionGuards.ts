import type { ApiEnv, ApiKeyEnvPrincipal } from "./env";
import {
  assertDeployProfilePosture,
  isWeakSecret,
  KNOWN_DEV_API_KEYS,
  MIN_PRODUCTION_SECRET_LENGTH,
  productionPostureChecks,
} from "@modelgov/policy-engine";

// Well-known dev keys, secret helpers, and the env-string posture rules are
// single-sourced in @modelgov/policy-engine so this boot guard and the CLI
// `doctor production` report can never drift. Re-exported for existing importers.
export { KNOWN_DEV_API_KEYS, MIN_PRODUCTION_SECRET_LENGTH, isRemoteDatabaseUrl } from "@modelgov/policy-engine";

const ADMIN_PERMISSIONS = new Set([
  "keys:admin",
  "policy:write",
  "data:erase",
]);

function hasAdminPermissions(principal: ApiKeyEnvPrincipal): boolean {
  const perms = principal.permissions ?? [];
  return perms.some((p) => ADMIN_PERMISSIONS.has(p));
}

/**
 * Fail fast on insecure production configuration. Called from the composition root
 * after env validation, before any network listeners or dependency wiring.
 *
 * The env-string posture rules (metrics auth, DB TLS, content capture, proxy
 * trust, Langfuse dev keys, OIDC audience) come from the shared
 * `productionPostureChecks` so `modelgov doctor production` predicts them
 * exactly; this guard adds the structured API-key principal checks (which need
 * the typed env, not raw strings) and throws on any shared "fail".
 */
export function assertProductionEnv(env: ApiEnv): void {
  if (env.MODELGOV_PRODUCTION !== "true") return;

  assertDeployProfilePosture(env as unknown as Record<string, string | undefined>);

  for (const principal of env.apiKeys) {
    if (principal.key && KNOWN_DEV_API_KEYS.has(principal.key)) {
      throw new Error(
        `MODELGOV production refuses known dev API key '${principal.name}' — set a strong random secret`,
      );
    }
    if (principal.key && isWeakSecret(principal.key)) {
      throw new Error(
        `MODELGOV production refuses weak API key '${principal.name}' — use at least ${MIN_PRODUCTION_SECRET_LENGTH} random characters`,
      );
    }
    if (
      principal.key &&
      hasAdminPermissions(principal) &&
      env.ALLOW_BOOTSTRAP_ADMIN_KEY !== "true"
    ) {
      throw new Error(
        `static env key '${principal.name}' has admin permissions — set ALLOW_BOOTSTRAP_ADMIN_KEY=true only for initial bootstrap, then rotate to DB-backed keys`,
      );
    }
  }

  for (const check of productionPostureChecks(env as unknown as Record<string, string | undefined>)) {
    if (check.severity === "fail") {
      throw new Error(check.fix ? `${check.message} — ${check.fix}` : check.message);
    }
  }
}
