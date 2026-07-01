import { parseConfigObject } from "@ai-guard/policy-engine";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applySchema } from "../src/db/init";
import { createPool, type Pool } from "../src/db/pool";
import { NoopObservability } from "../src/services/observability";
import { NoopGuard } from "../src/services/safety";
import { buildServer } from "../src/server";
import {
  createApiKey,
  findActiveApiKeyByToken,
  listApiKeys,
  revokeApiKey,
  rotateApiKey,
} from "../src/modules/keys/repo";
import { createDbKeyResolver } from "../src/modules/keys/resolver";

const DATABASE_URL = process.env.DATABASE_URL;

const config = parseConfigObject({
  project: { name: "test", environment: "test" },
  budgets: {
    global: { monthly_usd: 100, hard_stop_at_percent: 100 },
    by_user_type: {
      logged_in: { daily_usd: 1, daily_requests: 10, models: ["cheap"] },
    },
  },
  features: {
    support_chat: { safety: "dev", model_class: "cheap", max_tokens: 100 },
  },
  model_classes: { cheap: { primary: "openai/gpt-4o-mini" } },
  safety: { preset: "dev" },
});

describe.skipIf(!DATABASE_URL)("api key lifecycle (integration)", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = createPool(DATABASE_URL!);
    await applySchema(pool);
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await pool.query("TRUNCATE api_keys");
  });

  describe("repo", () => {
    it("issues a key, stores only the hash, and resolves it by token", async () => {
      const issued = await createApiKey(pool, {
        name: "svc-a",
        permissions: ["chat:create", "usage:read"],
        projectId: "proj-1",
      });
      expect(issued.secret).toMatch(/^sk-ai-guard-/);
      expect(issued.keyPrefix).toBe(issued.secret.slice(0, issued.keyPrefix.length));

      // The raw secret must never be stored.
      const raw = await pool.query("SELECT key_hash FROM api_keys WHERE id = $1", [issued.id]);
      expect(raw.rows[0].key_hash).not.toContain(issued.secret);

      const active = await findActiveApiKeyByToken(pool, issued.secret);
      expect(active?.name).toBe("svc-a");
      expect(active?.permissions).toEqual(["chat:create", "usage:read"]);
      expect(active?.projectId).toBe("proj-1");
    });

    it("does not resolve revoked keys", async () => {
      const issued = await createApiKey(pool, { name: "svc-b" });
      expect(await revokeApiKey(pool, issued.id)).toBe(true);
      expect(await findActiveApiKeyByToken(pool, issued.secret)).toBeNull();
      // Revoke is idempotent and still reports success for a known id.
      expect(await revokeApiKey(pool, issued.id)).toBe(true);
    });

    it("does not resolve expired keys", async () => {
      const issued = await createApiKey(pool, {
        name: "svc-exp",
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      });
      expect(await findActiveApiKeyByToken(pool, issued.secret)).toBeNull();
    });

    it("rotate mints a new secret and invalidates the old one", async () => {
      const issued = await createApiKey(pool, { name: "svc-rot" });
      const rotated = await rotateApiKey(pool, issued.id);
      expect(rotated).not.toBeNull();
      expect(rotated!.secret).not.toBe(issued.secret);
      expect(rotated!.id).toBe(issued.id);
      expect(await findActiveApiKeyByToken(pool, issued.secret)).toBeNull();
      expect((await findActiveApiKeyByToken(pool, rotated!.secret))?.id).toBe(issued.id);
    });

    it("list hides revoked keys by default", async () => {
      const a = await createApiKey(pool, { name: "keep" });
      const b = await createApiKey(pool, { name: "drop" });
      await revokeApiKey(pool, b.id);
      expect((await listApiKeys(pool)).map((k) => k.id)).toEqual([a.id]);
      expect((await listApiKeys(pool, { includeRevoked: true })).length).toBe(2);
    });

    it("revoke reports false for an unknown id", async () => {
      expect(await revokeApiKey(pool, "00000000-0000-0000-0000-000000000000")).toBe(false);
    });
  });

  describe("admin API + auth resolution", () => {
    function app(): FastifyInstance {
      return buildServer({
        config,
        pool,
        litellm: { chat: async () => ({ content: "ok", model: "m", actualCostUsd: 0, raw: {} }) },
        safety: new NoopGuard(),
        observability: new NoopObservability(),
        logger: false,
        // Bootstrap admin key (env) + DB resolver for issued keys.
        apiKeys: [{ name: "bootstrap", key: "admin-secret", permissions: ["keys:admin"] }],
        keyResolver: createDbKeyResolver(pool, { cacheTtlMs: 10_000 }),
      });
    }

    const admin = { authorization: "Bearer admin-secret" };

    it("creates a key that then authenticates against the DB resolver", async () => {
      const server = app();
      const created = await server.inject({
        method: "POST",
        url: "/v1/admin/keys",
        headers: admin,
        payload: { name: "issued", permissions: ["keys:admin"] },
      });
      expect(created.statusCode).toBe(201);
      const secret = created.json().secret as string;
      expect(secret).toMatch(/^sk-ai-guard-/);

      // The freshly issued key can now act (it has keys:admin).
      const listed = await server.inject({
        method: "GET",
        url: "/v1/admin/keys",
        headers: { authorization: `Bearer ${secret}` },
      });
      expect(listed.statusCode).toBe(200);
      expect(listed.json().items.length).toBe(1);
    });

    it("revoked key stops authenticating immediately (cache cleared on change)", async () => {
      const server = app();
      const created = await server.inject({
        method: "POST",
        url: "/v1/admin/keys",
        headers: admin,
        payload: { name: "issued", permissions: ["keys:admin"] },
      });
      const id = created.json().id as string;
      const secret = created.json().secret as string;

      // Warm the resolver cache by using the key once.
      const ok = await server.inject({
        method: "GET",
        url: "/v1/admin/keys",
        headers: { authorization: `Bearer ${secret}` },
      });
      expect(ok.statusCode).toBe(200);

      const revoked = await server.inject({
        method: "POST",
        url: `/v1/admin/keys/${id}/revoke`,
        headers: admin,
      });
      expect(revoked.statusCode).toBe(200);

      const afterRevoke = await server.inject({
        method: "GET",
        url: "/v1/admin/keys",
        headers: { authorization: `Bearer ${secret}` },
      });
      expect(afterRevoke.statusCode).toBe(401);
    });

    it("rotate invalidates the old secret and issues a working one", async () => {
      const server = app();
      const created = await server.inject({
        method: "POST",
        url: "/v1/admin/keys",
        headers: admin,
        payload: { name: "issued", permissions: ["keys:admin"] },
      });
      const id = created.json().id as string;
      const oldSecret = created.json().secret as string;

      const rotated = await server.inject({
        method: "POST",
        url: `/v1/admin/keys/${id}/rotate`,
        headers: admin,
      });
      expect(rotated.statusCode).toBe(200);
      const newSecret = rotated.json().secret as string;
      expect(newSecret).not.toBe(oldSecret);

      const oldRes = await server.inject({
        method: "GET",
        url: "/v1/admin/keys",
        headers: { authorization: `Bearer ${oldSecret}` },
      });
      expect(oldRes.statusCode).toBe(401);

      const newRes = await server.inject({
        method: "GET",
        url: "/v1/admin/keys",
        headers: { authorization: `Bearer ${newSecret}` },
      });
      expect(newRes.statusCode).toBe(200);
    });

    it("rejects key management without keys:admin", async () => {
      const server = app();
      // Issue a chat-only key, then try to use it on the admin API.
      const created = await server.inject({
        method: "POST",
        url: "/v1/admin/keys",
        headers: admin,
        payload: { name: "chat-only", permissions: ["chat:create"] },
      });
      const secret = created.json().secret as string;
      const res = await server.inject({
        method: "GET",
        url: "/v1/admin/keys",
        headers: { authorization: `Bearer ${secret}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it("rejects unknown tokens with 401", async () => {
      const res = await app().inject({
        method: "GET",
        url: "/v1/admin/keys",
        headers: { authorization: "Bearer sk-ai-guard-nope" },
      });
      expect(res.statusCode).toBe(401);
    });

    it("returns 404 for a malformed key id", async () => {
      const res = await app().inject({
        method: "POST",
        url: "/v1/admin/keys/not-a-uuid/revoke",
        headers: admin,
      });
      expect(res.statusCode).toBe(404);
    });
  });
});
