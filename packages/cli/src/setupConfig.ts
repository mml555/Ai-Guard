import { copyFileSync, existsSync, readFileSync, readdirSync, rmdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { resolveUserPath } from "./paths.js";
import type { Mode } from "./ops.js";

// Ops helpers act on the user's Modelgov project (compose files, .env, generated
// config), NOT the installed CLI package — resolve relative to the invocation cwd.
const ROOT = resolveUserPath(".");

/** Runtime-generated LiteLLM config: the default proxy config for the local stack. */
const GENERATED_LITELLM_CONFIG = "litellm_config.generated.yaml";
const DEMO_LITELLM_CONFIG = "litellm_config.yaml";

/** Parse a KEY=VALUE .env file into a map (missing file → {}). */
export function readEnvFile(path: string, root: string = ROOT): Record<string, string> {
  const fullPath = resolve(root, path);
  if (!existsSync(fullPath)) return {};
  const text = readFileSync(fullPath, "utf8");
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    let value = trimmed.slice(idx + 1);
    // Strip matching surrounding quotes (e.g. LITELLM_CONFIG_PATH="./x.yaml"),
    // otherwise the quotes become part of the path and resolution fails.
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    out[trimmed.slice(0, idx)] = value;
  }
  return out;
}

/**
 * Seed the host litellm_config.generated.yaml before `up` so Docker never
 * creates it as a directory. Both the litellm and api containers bind-mount this
 * exact host file (litellm reads it; the setup wizard writes it), so it must
 * exist as a real file first. Copies the demo config when absent, and auto-heals
 * an EMPTY directory left by a prior missing-file run. A real file (demo- or
 * wizard-written) is left untouched.
 */
export function ensureGeneratedLitellmConfig(root: string = ROOT): void {
  const target = resolve(root, GENERATED_LITELLM_CONFIG);
  if (existsSync(target)) {
    if (!statSync(target).isDirectory()) return; // real file — keep the active config
    // Docker land-mine: an empty dir it created for a missing mount. Safe to remove.
    if (readdirSync(target).length > 0) return; // non-empty — let the guard surface it
    rmdirSync(target);
  }
  const demo = resolve(root, DEMO_LITELLM_CONFIG);
  if (existsSync(demo)) {
    copyFileSync(demo, target);
    console.log(`Seeded ${GENERATED_LITELLM_CONFIG} from ${DEMO_LITELLM_CONFIG} (demo provider).`);
  }
}

/**
 * Fail fast when the effective LiteLLM config path is missing or a directory.
 *
 * All non-prod compose files bind `${LITELLM_CONFIG_PATH:-./litellm_config.generated.yaml}`
 * to /app/config.yaml. If that host path does not exist, Docker silently creates
 * it as a *directory*, LiteLLM crashes with a cryptic `IsADirectoryError`, and
 * setup fails with only "API did not become ready". ensureGeneratedLitellmConfig
 * seeds the default; this catches a stale LITELLM_CONFIG_PATH that points at a
 * file the wizard never wrote, with an actionable message instead.
 */
export function assertLitellmConfigUsable(root: string = ROOT): void {
  const configured = readEnvFile(".env", root).LITELLM_CONFIG_PATH?.trim();
  // Unset falls back to the seeded ./litellm_config.generated.yaml (see compose).
  const relative = (configured && configured.length > 0 ? configured : `./${GENERATED_LITELLM_CONFIG}`).replace(/^\.\//, "");
  const fullPath = resolve(root, relative);

  if (!existsSync(fullPath)) {
    throw new Error(
      `LITELLM_CONFIG_PATH points at ${relative}, which does not exist. ` +
        `Docker would create it as a directory and the model proxy would crash. ` +
        (configured
          ? `Fix or remove LITELLM_CONFIG_PATH in .env (unset it to use the built-in demo config), ` +
            `or finish the setup wizard's cloud-provider step which writes this file.`
          : `Run this from your Modelgov project directory.`),
    );
  }
  if (statSync(fullPath).isDirectory()) {
    throw new Error(
      `LITELLM_CONFIG_PATH (${relative}) is a directory, not a file — Docker likely created it ` +
        `from an earlier run where the file was missing. Remove it (\`rmdir ${relative}\`) and ` +
        `either unset LITELLM_CONFIG_PATH in .env (built-in demo config) or write a real LiteLLM config there.`,
    );
  }
}

/**
 * Whether the effective LiteLLM config still routes every model to the built-in
 * demo provider (vs. a real provider connected via the setup wizard). Used so the
 * `simple`/`full` success summary doesn't claim "demo AI" after a cloud connect
 * has rewritten litellm_config.generated.yaml. A config counts as real if ANY
 * model_list entry targets something other than the demo sidecar; the hybrid
 * injection-guard entry (which stays on demo-llm) alone does not make it "real".
 */
export function litellmConfigServesDemo(root: string = ROOT): boolean {
  const configured = readEnvFile(".env", root).LITELLM_CONFIG_PATH?.trim();
  const relative = (configured && configured.length > 0 ? configured : `./${GENERATED_LITELLM_CONFIG}`).replace(/^\.\//, "");
  const full = resolve(root, relative);
  if (!existsSync(full) || statSync(full).isDirectory()) return true; // seeded to demo on `up`
  let doc: { model_list?: Array<{ litellm_params?: { model?: string; api_base?: string } }> };
  try {
    doc = parseYaml(readFileSync(full, "utf8")) as typeof doc;
  } catch {
    return true; // unparseable → don't over-claim real spend
  }
  const entries = doc.model_list ?? [];
  if (entries.length === 0) return true;
  const targetsRealProvider = entries.some((e) => {
    const model = e.litellm_params?.model ?? "";
    const apiBase = e.litellm_params?.api_base ?? "";
    const isDemo = model === "openai/modelgov-demo" || apiBase.includes("demo-llm");
    return !isDemo;
  });
  return !targetsRealProvider;
}

/** One-line description of what the running stack is actually serving, per mode. */
export function runningOnSummary(mode: Mode, opts?: { servesDemo?: boolean }): string {
  switch (mode) {
    case "cloud":
      return "the gateway is running with your cloud provider keys.";
    case "azure":
      return "the gateway is running on Azure OpenAI.";
    case "local":
      return "the gateway is running on local Ollama.";
    case "prod":
      return "the gateway is running in production mode.";
    default:
      // simple / full: bootstraps on the built-in demo AI, but the setup wizard
      // may have already connected a real provider — reflect what's actually
      // active so the summary never claims "demo" while real spend is happening.
      return opts?.servesDemo === false
        ? "the gateway is running on your connected provider (real calls are billed)."
        : "the gateway is running on the built-in demo AI (no key needed to start).";
  }
}
