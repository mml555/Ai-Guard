import { apiFetch } from "./client";

export interface SetupSecretsResult {
  ok: boolean;
  savedKeys: string[];
  litellmConfigPath?: string;
  restarted?: boolean;
  nextCommand?: string;
  message: string;
}

export function saveSetupSecrets(
  secrets: Record<string, string>,
  options: { useCloud: boolean; litellmYaml?: string },
): Promise<SetupSecretsResult> {
  return apiFetch<SetupSecretsResult>("/v1/setup/secrets", {
    method: "POST",
    body: JSON.stringify({
      secrets,
      useCloud: options.useCloud,
      litellmYaml: options.litellmYaml,
    }),
  });
}

/**
 * Merge boot-only policy fields (routing.retry, pricing, safety.injection_model,
 * billing) from the active version into the wizard's generated config, so the
 * stored policy matches the running gateway instead of silently dropping them.
 * Returns the generated YAML unchanged when there is no active version.
 */
export async function mergeSetupPolicy(yaml: string): Promise<string> {
  const res = await apiFetch<{ yaml: string }>("/v1/setup/policy/merge", {
    method: "POST",
    body: JSON.stringify({ yaml }),
  });
  return res.yaml;
}
