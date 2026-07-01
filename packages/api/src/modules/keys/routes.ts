import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { sendError } from "../../errors";
import type { RequestContext } from "../../plugins/requestContext";
import { errorJsonSchema } from "../chat/schemas";
import {
  createApiKey,
  getApiKeyById,
  listApiKeys,
  revokeApiKey,
  rotateApiKey,
} from "./repo";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const createKeyBodySchema = z.object({
  name: z.string().min(1).max(200),
  permissions: z.array(z.string().min(1)).max(32).optional(),
  projectId: z.string().min(1).optional(),
  environment: z.string().min(1).optional(),
  allowedUserTypes: z.array(z.string().min(1)).max(64).optional(),
  allowedUserIds: z.array(z.string().min(1)).max(1000).optional(),
  expiresAt: z.string().datetime().optional(),
});

const keyRecordJsonSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    keyPrefix: { type: "string" },
    permissions: { type: "array", items: { type: "string" } },
    projectId: { type: "string" },
    environment: { type: "string" },
    allowedUserTypes: { type: "array", items: { type: "string" } },
    allowedUserIds: { type: "array", items: { type: "string" } },
    createdAt: { type: "string" },
    createdBy: { type: "string" },
    expiresAt: { type: "string" },
    revokedAt: { type: "string" },
    lastUsedAt: { type: "string" },
  },
} as const;

const issuedKeyJsonSchema = {
  type: "object",
  properties: {
    ...keyRecordJsonSchema.properties,
    secret: {
      type: "string",
      description: "Plaintext secret — shown once, never retrievable again.",
    },
  },
} as const;

/** Deps let the routes invalidate the auth cache the moment a key changes. */
export interface KeysRouteDeps {
  onKeysChanged?: () => void;
}

function requireKeysAdmin(
  ctx: RequestContext,
): { ok: true } | { ok: false; status: number; code: string; message: string } {
  if (!ctx.permissions?.includes("keys:admin")) {
    return {
      ok: false,
      status: 403,
      code: "forbidden",
      message: "API key is not permitted to manage keys",
    };
  }
  return { ok: true };
}

export function registerKeysRoutes(
  app: FastifyInstance,
  pool: Pool,
  deps: KeysRouteDeps = {},
): void {
  app.post("/v1/admin/keys", {
    schema: {
      tags: ["admin"],
      description:
        "Issue a new API key. The plaintext secret is returned once; only its hash is stored.",
      response: {
        201: issuedKeyJsonSchema,
        400: errorJsonSchema,
        401: errorJsonSchema,
        403: errorJsonSchema,
      },
    },
  }, async (request, reply) => {
    const auth = requireKeysAdmin(request.ctx);
    if (!auth.ok) return sendError(reply, auth.status, auth.code, {}, auth.message);

    const parsed = createKeyBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, "invalid_request", {
        detail: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      });
    }

    const issued = await createApiKey(pool, {
      ...parsed.data,
      createdBy: request.ctx.apiKeyName,
    });
    deps.onKeysChanged?.();
    return reply.code(201).send(issued);
  });

  app.get("/v1/admin/keys", {
    schema: {
      tags: ["admin"],
      description: "List API keys (metadata only — never secrets or hashes).",
      querystring: {
        type: "object",
        properties: {
          includeRevoked: { type: "boolean" },
          projectId: { type: "string" },
        },
      },
      response: {
        200: {
          type: "object",
          properties: { items: { type: "array", items: keyRecordJsonSchema } },
        },
        401: errorJsonSchema,
        403: errorJsonSchema,
      },
    },
  }, async (request, reply) => {
    const auth = requireKeysAdmin(request.ctx);
    if (!auth.ok) return sendError(reply, auth.status, auth.code, {}, auth.message);

    const query = request.query as { includeRevoked?: boolean; projectId?: string };
    const items = await listApiKeys(pool, {
      includeRevoked: query.includeRevoked === true,
      projectId: query.projectId,
    });
    return reply.send({ items });
  });

  app.get("/v1/admin/keys/:id", {
    schema: {
      tags: ["admin"],
      params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
      response: {
        200: keyRecordJsonSchema,
        401: errorJsonSchema,
        403: errorJsonSchema,
        404: errorJsonSchema,
      },
    },
  }, async (request, reply) => {
    const auth = requireKeysAdmin(request.ctx);
    if (!auth.ok) return sendError(reply, auth.status, auth.code, {}, auth.message);

    const id = (request.params as { id: string }).id;
    if (!UUID_RE.test(id)) return sendError(reply, 404, "not_found", {}, "Key not found");
    const record = await getApiKeyById(pool, id);
    if (!record) return sendError(reply, 404, "not_found", {}, "Key not found");
    return reply.send(record);
  });

  app.post("/v1/admin/keys/:id/rotate", {
    schema: {
      tags: ["admin"],
      description: "Mint a new secret for an existing key; the old secret stops working immediately.",
      params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
      response: {
        200: issuedKeyJsonSchema,
        401: errorJsonSchema,
        403: errorJsonSchema,
        404: errorJsonSchema,
      },
    },
  }, async (request, reply) => {
    const auth = requireKeysAdmin(request.ctx);
    if (!auth.ok) return sendError(reply, auth.status, auth.code, {}, auth.message);

    const id = (request.params as { id: string }).id;
    if (!UUID_RE.test(id)) return sendError(reply, 404, "not_found", {}, "Key not found");
    const issued = await rotateApiKey(pool, id);
    if (!issued) return sendError(reply, 404, "not_found", {}, "Key not found or revoked");
    deps.onKeysChanged?.();
    return reply.send(issued);
  });

  app.post("/v1/admin/keys/:id/revoke", {
    schema: {
      tags: ["admin"],
      description: "Revoke a key. Idempotent.",
      params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
      response: {
        200: { type: "object", properties: { id: { type: "string" }, revoked: { type: "boolean" } } },
        401: errorJsonSchema,
        403: errorJsonSchema,
        404: errorJsonSchema,
      },
    },
  }, async (request, reply) => {
    const auth = requireKeysAdmin(request.ctx);
    if (!auth.ok) return sendError(reply, auth.status, auth.code, {}, auth.message);

    const id = (request.params as { id: string }).id;
    if (!UUID_RE.test(id)) return sendError(reply, 404, "not_found", {}, "Key not found");
    const ok = await revokeApiKey(pool, id);
    if (!ok) return sendError(reply, 404, "not_found", {}, "Key not found");
    deps.onKeysChanged?.();
    return reply.send({ id, revoked: true });
  });
}
