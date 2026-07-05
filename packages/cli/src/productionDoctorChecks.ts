/** Offline production posture checks for `modelgov doctor production`. */

import {
  deployProfileChecks,
  isWeakSecret,
  KNOWN_DEV_API_KEYS,
  MIN_PRODUCTION_SECRET_LENGTH,
  productionPostureChecks,
  type DeployProfileCheck,
} from "@modelgov/policy-engine";

export type ProductionCheck = DeployProfileCheck;

export function productionDoctorChecksFromEnv(env: Record<string, string>): ProductionCheck[] {
  const checks: ProductionCheck[] = [];
  const push = (severity: ProductionCheck["severity"], code: string, message: string, fix?: string) => {
    checks.push({ severity, code, message, fix });
  };

  if (env.MODELGOV_PRODUCTION !== "true") {
    push("warn", "production_mode", "MODELGOV_PRODUCTION is not true", "Set MODELGOV_PRODUCTION=true");
  }

  // Single-key check (the CLI reads MODELGOV_API_KEY from env; the boot guard
  // instead validates the structured API-key principals it loads).
  const apiKey = env.MODELGOV_API_KEY;
  if (apiKey && KNOWN_DEV_API_KEYS.has(apiKey)) {
    push("fail", "dev_api_key", "API key is a known dev default", "Generate a random secret");
  } else if (apiKey && isWeakSecret(apiKey)) {
    push("fail", "weak_api_key", "API key is too short or weak", `Use at least ${MIN_PRODUCTION_SECRET_LENGTH} random characters`);
  } else if (apiKey) {
    push("pass", "api_key", "API key is not a known dev default");
  }

  // Env-string posture rules shared verbatim with the boot guard
  // (assertProductionEnv) — see @modelgov/policy-engine/productionPosture.
  checks.push(...productionPostureChecks(env));

  // Doctor-only advisory warnings (not fatal at boot).
  if (env.RATE_LIMIT_FAIL_OPEN === "true") {
    push("warn", "rate_limit_fail_open", "Rate limits fail open when Redis unreachable");
  }

  if (!env.REDIS_URL && env.MODELGOV_PRODUCTION === "true") {
    push("warn", "redis", "REDIS_URL not set — per-replica rate limits only", "Configure managed Redis for multi-replica");
  }

  for (const c of deployProfileChecks(env, { production: env.MODELGOV_PRODUCTION === "true" })) {
    push(c.severity, c.code, c.message, c.fix);
  }

  return checks;
}
