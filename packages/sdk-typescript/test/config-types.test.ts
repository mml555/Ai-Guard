import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseConfig } from "@ai-guard/policy-engine";
import { describe, expect, it } from "vitest";

const ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const GENERATED = resolve(
  ROOT,
  "packages/sdk-typescript/src/generated/config-types.ts",
);

function extractUnion(name: string, source: string): string[] {
  const re = new RegExp(
    `export type ${name} = ([^;]+);`,
  );
  const match = source.match(re);
  if (!match?.[1]) return [];
  return match[1]
    .split("|")
    .map((s) => s.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
}

describe("generated SDK config types", () => {
  it("matches feature and user_type keys from ai-guard.yaml", () => {
    const yaml = readFileSync(resolve(ROOT, "ai-guard.yaml"), "utf8");
    const config = parseConfig(yaml);
    const generated = readFileSync(GENERATED, "utf8");

    expect(extractUnion("FeatureName", generated).sort()).toEqual(
      Object.keys(config.features).sort(),
    );
    expect(extractUnion("UserTypeName", generated).sort()).toEqual(
      Object.keys(config.budgets.byUserType).sort(),
    );
    expect(extractUnion("ModelClassName", generated).sort()).toEqual(
      Object.keys(config.modelClasses).sort(),
    );
  });
});
