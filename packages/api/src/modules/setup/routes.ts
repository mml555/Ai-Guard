import { request as httpRequest } from "node:http";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { PROVIDER_REGISTRY } from "@modelgov/policy-engine";
import { sendError } from "../../errors";
import type { RequestContext } from "../../plugins/requestContext";
import { getActiveConfigVersion } from "../policy/repo";
import { EnvFileError, mergeEnvFile } from "./envFile";
import { preserveBootOnlyPolicyYaml } from "./policyMerge";

const GENERATED_LITELLM_CONFIG = "litellm_config.generated.yaml";
const DOCKER_SOCKET_PATH = "/var/run/docker.sock";
const DOCKER_TIMEOUT_MS = 5000;

// Only provider credential env vars may be written via setup — never arbitrary
// keys like DATABASE_URL or MODELGOV_API_KEY. Derived from the provider registry.
const ALLOWED_SECRET_ENV_VARS = new Set(
  Object.values(PROVIDER_REGISTRY).flatMap((p) => p.credentialEnvVars ?? []),
);

const secretsBodySchema = z.object({
  secrets: z.record(
    z.string(),
    z.string().refine((v) => !/[\r\n]/.test(v), "secret values must not contain newlines"),
  ),
  useCloud: z.boolean().optional(),
  litellmYaml: z.string().min(1).optional(),
});

function requireOwner(ctx: RequestContext) {
  if (!ctx.permissions?.includes("policy:write")) {
    return { ok: false as const, status: 403, code: "forbidden", message: "Setup requires policy:write" };
  }
  return { ok: true as const };
}

export interface SetupRouteDeps {
  enabled: boolean;
  projectRoot: string;
  production: boolean;
  /** For the policy-merge endpoint: load the active version's boot-only fields. */
  pool: Pool;
}

const mergeBodySchema = z.object({ yaml: z.string().min(1) });

async function dockerRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return await new Promise<T>((resolvePromise, reject) => {
    const req = httpRequest(
      {
        socketPath: DOCKER_SOCKET_PATH,
        path,
        method,
        headers: {
          host: "docker",
          ...(payload
            ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }
            : {}),
        },
        timeout: DOCKER_TIMEOUT_MS,
      },
      (res) => {
        let resBody = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { resBody += chunk; });
        res.on("end", () => {
          if ((res.statusCode ?? 500) >= 400) {
            reject(new Error(resBody || `Docker API ${res.statusCode}`));
            return;
          }
          resolvePromise((resBody ? JSON.parse(resBody) : undefined) as T);
        });
      },
    );
    // Without this, a stuck docker daemon would hang the setup request forever.
    req.on("timeout", () => req.destroy(new Error("Docker API timeout")));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

interface DockerContainerInspect {
  Name: string;
  Config: { Env?: string[]; Hostname?: string; [k: string]: unknown };
  HostConfig: Record<string, unknown>;
  NetworkSettings?: { Networks?: Record<string, { Aliases?: string[] | null }> };
}

/**
 * Apply new provider credentials to the running litellm container.
 *
 * A plain Docker `restart` re-runs the SAME container, whose environment was
 * frozen at creation time (in demo mode, `OPENAI_API_KEY=demo-unused`). Because
 * the LiteLLM config reads keys via `os.environ/OPENAI_API_KEY`, a restart never
 * picks up the key the wizard just wrote to `.env` — so real provider calls keep
 * failing while the UI claims success. Only a *recreate* re-injects env.
 *
 * The api container can't run `docker compose`, so we recreate over the Engine
 * API: inspect the live container, merge the new credentials over its env,
 * then swap it out (stop → rename old aside → create replacement with the same
 * name/image/mounts/networks + fresh env → start → remove old). If anything
 * fails before the replacement starts, the original is renamed back and left
 * running, and the caller falls back to printing `reload-providers`.
 *
 * `envOverrides` are the provider credential values just saved (already trimmed).
 */
async function recreateComposeService(
  project: string,
  service: string,
  envOverrides: Record<string, string>,
): Promise<boolean> {
  try {
    const filters = encodeURIComponent(JSON.stringify({
      label: [
        `com.docker.compose.project=${project}`,
        `com.docker.compose.service=${service}`,
      ],
    }));
    const containers = await dockerRequest<Array<{ Id: string }>>(
      "GET",
      `/containers/json?all=true&filters=${filters}`,
    );
    const id = containers[0]?.Id;
    if (!id) return false;

    const info = await dockerRequest<DockerContainerInspect>("GET", `/containers/${id}/json`);
    const name = info.Name.replace(/^\//, "");
    const shortId = id.slice(0, 12);

    // Merge the new credentials over the container's existing environment.
    const envMap = new Map<string, string>();
    for (const entry of info.Config.Env ?? []) {
      const eq = entry.indexOf("=");
      if (eq === -1) continue;
      envMap.set(entry.slice(0, eq), entry.slice(eq + 1));
    }
    for (const [k, v] of Object.entries(envOverrides)) envMap.set(k, v);
    const newEnv = [...envMap].map(([k, v]) => `${k}=${v}`);

    // Preserve the compose network membership + service-name aliases (drop the
    // container-id alias, which is regenerated). Docker's create call accepts a
    // single network in EndpointsConfig; litellm is on the one compose network.
    const networks = info.NetworkSettings?.Networks ?? {};
    const endpointsConfig: Record<string, { Aliases: string[] }> = {};
    for (const [netName, net] of Object.entries(networks)) {
      endpointsConfig[netName] = {
        Aliases: (net.Aliases ?? []).filter((a) => a !== shortId),
      };
    }

    const createBody = {
      ...info.Config,
      // Let Docker assign a fresh hostname (the old one is the prior short id).
      Hostname: undefined,
      Env: newEnv,
      HostConfig: info.HostConfig,
      NetworkingConfig: { EndpointsConfig: endpointsConfig },
    };

    // Swap: stop + move the old container aside so the name is free, create the
    // replacement, start it, then delete the old one. Roll the rename back on
    // any failure so we never strand the stack without a litellm container.
    await dockerRequest("POST", `/containers/${id}/stop?t=10`).catch(() => {});
    const parkedName = `${name}_pre_setup`;
    await dockerRequest("POST", `/containers/${id}/rename?name=${encodeURIComponent(parkedName)}`);

    let created: { Id: string };
    try {
      created = await dockerRequest<{ Id: string }>(
        "POST",
        `/containers/create?name=${encodeURIComponent(name)}`,
        createBody,
      );
    } catch (e) {
      // Restore the original name (and leave it as-is) so the fallback path works.
      await dockerRequest("POST", `/containers/${id}/rename?name=${encodeURIComponent(name)}`).catch(() => {});
      await dockerRequest("POST", `/containers/${id}/start`).catch(() => {});
      throw e;
    }

    await dockerRequest("POST", `/containers/${created.Id}/start`);
    await dockerRequest("DELETE", `/containers/${id}?force=true`).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

export function registerSetupRoutes(app: FastifyInstance, deps: SetupRouteDeps): void {
  if (!deps.enabled || deps.production) return;

  app.post("/v1/setup/secrets", {
    schema: {
      tags: ["setup"],
      description: "Dev-only: merge provider secrets into the project .env file.",
      body: { type: "object", additionalProperties: true },
      response: { 200: { type: "object", additionalProperties: true }, 401: { type: "object" }, 403: { type: "object" } },
    },
  }, async (request, reply) => {
    const auth = requireOwner(request.ctx);
    if (!auth.ok) return sendError(reply, auth.status, auth.code, {}, auth.message);

    const parsed = secretsBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, "invalid_request", {}, parsed.error.message);
    }

    const filtered = Object.fromEntries(
      Object.entries(parsed.data.secrets)
        // Trim before storing — a key pasted with surrounding whitespace would
        // otherwise be written verbatim and break provider auth downstream.
        .map(([k, v]) => [k, v.trim()] as const)
        .filter(([k, v]) => v.length > 0 && ALLOWED_SECRET_ENV_VARS.has(k)),
    );
    // Subscription / OAuth-device providers (e.g. GitHub Copilot) legitimately
    // have no pasteable key. As long as the caller is finishing a provider setup
    // (a litellmYaml to install), an empty secrets map is valid — otherwise it's
    // a no-op request and worth a 400.
    if (Object.keys(filtered).length === 0 && !parsed.data.litellmYaml) {
      return sendError(
        reply,
        400,
        "invalid_request",
        {},
        "No recognized provider secrets provided (only provider credential env vars are accepted)",
      );
    }

    const envPath = resolve(deps.projectRoot, ".env");
    let litellmConfigPath: string | undefined;
    try {
      if (Object.keys(filtered).length > 0) mergeEnvFile(envPath, filtered);

      if (parsed.data.litellmYaml) {
        const configPath = resolve(deps.projectRoot, GENERATED_LITELLM_CONFIG);
        writeFileSync(configPath, parsed.data.litellmYaml.endsWith("\n") ? parsed.data.litellmYaml : `${parsed.data.litellmYaml}\n`, "utf8");
        mergeEnvFile(envPath, { LITELLM_CONFIG_PATH: `./${GENERATED_LITELLM_CONFIG}` });
        litellmConfigPath = GENERATED_LITELLM_CONFIG;
      }
    } catch (e) {
      if (e instanceof EnvFileError) {
        return sendError(reply, 400, "invalid_request", {}, e.message);
      }
      throw e;
    }

    // Recreate (not restart) litellm so it picks up the new credentials from the
    // env — a restart would reuse the container's demo-time environment. Falls
    // back to the reload-providers command if the Engine API isn't reachable.
    const restarted = parsed.data.useCloud
      ? await recreateComposeService("modelgov", "litellm", filtered)
      : false;

    return reply.send({
      ok: true,
      savedKeys: Object.keys(filtered),
      litellmConfigPath,
      restarted,
      nextCommand: parsed.data.useCloud && !restarted ? "pnpm modelgov reload-providers" : undefined,
      message: parsed.data.useCloud
        ? (restarted
            ? "Provider keys saved. The model proxy was reloaded with them — verify with a test message."
            : "Provider keys saved. Run `pnpm modelgov reload-providers` once so the model proxy uses them.")
        : "Provider keys saved.",
    });
  });

  app.get("/v1/setup/status", {
    schema: {
      tags: ["setup"],
      description:
        "Dev-only: whether first-run setup is still needed. `configured` is true once a non-bootstrap policy version is active, so the console can avoid forcing the wizard (and overwriting a live policy) on a second operator. Absent (404) when the setup API is disabled.",
      response: { 200: { type: "object", additionalProperties: true }, 401: { type: "object" } },
    },
  }, async (request, reply) => {
    // The presence of this route already tells the console the setup API is on.
    // `configured` distinguishes the bootstrap seed (author "bootstrap") from a
    // real, operator-applied policy so a teammate on a fresh browser isn't forced
    // through the wizard against an already-configured gateway.
    const active = await getActiveConfigVersion(deps.pool, request.ctx.tenantId);
    const configured = !!active && active.record.author !== "bootstrap";
    return reply.send({ enabled: true, configured });
  });

  app.post("/v1/setup/policy/merge", {
    schema: {
      tags: ["setup"],
      description:
        "Dev-only: preserve boot-only policy fields (routing.retry, pricing, safety.injection_model, billing) from the active version into the wizard's generated config, so the stored policy matches the running process.",
      body: { type: "object", required: ["yaml"], properties: { yaml: { type: "string" } } },
      response: { 200: { type: "object", additionalProperties: true }, 401: { type: "object" }, 403: { type: "object" } },
    },
  }, async (request, reply) => {
    const auth = requireOwner(request.ctx);
    if (!auth.ok) return sendError(reply, auth.status, auth.code, {}, auth.message);

    const parsed = mergeBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, "invalid_request", {}, parsed.error.message);
    }

    // Merge the active version's boot-only fields into the generated config. With
    // no active version yet, there's nothing to preserve — return as-is.
    const active = await getActiveConfigVersion(deps.pool, request.ctx.tenantId);
    const yaml = active ? preserveBootOnlyPolicyYaml(parsed.data.yaml, active.yaml) : parsed.data.yaml;
    return reply.send({ yaml });
  });
}
