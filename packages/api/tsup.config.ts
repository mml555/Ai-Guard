import { defineConfig } from "tsup";

// Bundle only our own workspace code (@ai-guard/policy-engine) into the API
// output so the runtime doesn't need a workspace symlink. All third-party deps
// stay external — bundling their CJS internals into ESM triggers esbuild's
// dynamic-require shim, which throws at runtime. Runtime image installs these.
export default defineConfig({
  entry: ["src/index.ts", "src/migrate.ts", "src/openapiExport.ts"],
  format: ["esm"],
  target: "es2022",
  platform: "node",
  clean: true,
  noExternal: ["@ai-guard/policy-engine"],
  external: [
    "@fastify/rate-limit",
    "fastify",
    "pg",
    "zod",
    "yaml",
    "langfuse",
    "ioredis",
  ],
});
