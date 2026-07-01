import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applySchema } from "../src/db/init";
import { createPool, type Pool } from "../src/db/pool";
import { claimKey, completeKey, releaseKey } from "../src/modules/idempotency/repo";

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)("idempotency repo (integration)", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = createPool(DATABASE_URL!);
    await applySchema(pool);
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await pool.query("TRUNCATE idempotency_keys");
  });

  const params = { key: "k1", userId: "u1", requestHash: "h1" };

  it("first claim wins; the second sees a 'processing' conflict", async () => {
    const a = await claimKey(pool, params);
    const b = await claimKey(pool, params);
    expect(a.state).toBe("claimed");
    expect(b.state).toBe("conflict");
    if (b.state === "conflict") {
      expect(b.existing.status).toBe("processing");
      expect(b.existing.requestHash).toBe("h1");
    }
  });

  it("after completion, a conflicting claim returns the stored response", async () => {
    await claimKey(pool, params);
    await completeKey(pool, {
      userId: "u1",
      key: "k1",
      responseStatus: 200,
      responseBody: { ok: true, body: { model: "m" } },
    });
    const again = await claimKey(pool, params);
    expect(again.state).toBe("conflict");
    if (again.state === "conflict") {
      expect(again.existing.status).toBe("completed");
      expect(again.existing.responseStatus).toBe(200);
      expect(again.existing.responseBody).toEqual({ ok: true, body: { model: "m" } });
    }
  });

  it("only one of many concurrent claims wins", async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () => claimKey(pool, params)),
    );
    expect(results.filter((r) => r.state === "claimed")).toHaveLength(1);
    expect(results.filter((r) => r.state === "conflict")).toHaveLength(9);
  });

  it("release lets a fresh claim win again", async () => {
    await claimKey(pool, params);
    await releaseKey(pool, { userId: "u1", key: "k1" });
    const again = await claimKey(pool, params);
    expect(again.state).toBe("claimed");
  });

  it("scopes keys per user — same key string, different users", async () => {
    const a = await claimKey(pool, { key: "shared", userId: "u1", requestHash: "h1" });
    const b = await claimKey(pool, { key: "shared", userId: "u2", requestHash: "h1" });
    expect(a.state).toBe("claimed");
    expect(b.state).toBe("claimed");
  });
});
