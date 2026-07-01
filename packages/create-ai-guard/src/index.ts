import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  cancel,
  confirm,
  group,
  intro,
  isCancel,
  multiselect,
  note,
  outro,
  select,
  text,
} from "@clack/prompts";
import {
  renderAiGuardYaml,
  renderEnv,
  type DeployMode,
  type Provider,
  type SafetyPreset,
  type ScaffoldOptions,
} from "./render";

async function main(): Promise<void> {
  intro("create-ai-guard");

  const targetDir = resolve(process.argv[2] ?? ".");

  const answers = await group(
    {
      projectName: () =>
        text({
          message: "Project name",
          placeholder: "my-app",
          defaultValue: "my-app",
        }),
      providers: () =>
        multiselect({
          message: "Which providers will you use?",
          options: [
            { value: "openai", label: "OpenAI" },
            { value: "anthropic", label: "Anthropic" },
            { value: "gemini", label: "Gemini" },
          ],
          required: true,
        }),
      safetyPreset: () =>
        select({
          message: "Default safety preset",
          options: [
            { value: "balanced", label: "balanced (mask PII, block injection)" },
            { value: "strict", label: "strict (block PII, block injection)" },
            { value: "dev", label: "dev (no enforcement)" },
          ],
          initialValue: "balanced",
        }),
      mode: () =>
        select({
          message: "Deploy mode",
          options: [
            { value: "simple", label: "simple (API + LiteLLM + Postgres + Presidio)" },
            { value: "full", label: "full (+ Langfuse observability)" },
          ],
          initialValue: "simple",
        }),
    },
    {
      onCancel: () => {
        cancel("Cancelled.");
        process.exit(0);
      },
    },
  );

  const opts: ScaffoldOptions = {
    projectName: answers.projectName,
    providers: answers.providers as Provider[],
    safetyPreset: answers.safetyPreset as SafetyPreset,
    mode: answers.mode as DeployMode,
  };

  const yamlPath = join(targetDir, "ai-guard.yaml");
  const envPath = join(targetDir, ".env");

  if (existsSync(yamlPath) || existsSync(envPath)) {
    const ok = await confirm({
      message: `Files already exist in ${targetDir}. Overwrite ai-guard.yaml / .env?`,
      initialValue: false,
    });
    if (isCancel(ok) || !ok) {
      cancel("Left existing files untouched.");
      process.exit(0);
    }
  }

  writeFileSync(yamlPath, renderAiGuardYaml(opts));
  writeFileSync(envPath, renderEnv(opts));

  note(
    [
      `Wrote ${yamlPath}`,
      `Wrote ${envPath}`,
      "",
      "Next steps:",
      "  1. Fill in your provider key(s) in .env",
      "  2. Run: ai-guard validate --config ai-guard.yaml",
      "  3. Point an Ai-Guard deployment at this ai-guard.yaml",
    ].join("\n"),
    "Done",
  );
  outro("Ai-Guard is ready to enforce your AI policy.");
}

void main();
