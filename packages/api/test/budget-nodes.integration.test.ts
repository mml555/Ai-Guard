import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applySchema } from "../src/db/init";
import { createPool, type Pool } from "../src/db/pool";
import {
  createNode,
  listNodes,
  releasePath,
  reservePath,
  resolvePath,
  settlePath,
  type BudgetNode,
} from "../src/modules/budgets/repo";

const DATABASE_URL = process.env.DATABASE_URL;
const NOW = new Date("2026-07-01T12:00:00Z");

async function counter(pool: Pool, nodeId: string): Promise<{ used: number; reserved: number; requests: number }> {
  const { rows } = await pool.query(
    "SELECT used_usd, reserved_usd, requests_used FROM budget_node_counters WHERE node_id = $1",
    [nodeId],
  );
  const r = rows[0] ?? { used_usd: 0, reserved_usd: 0, requests_used: 0 };
  return { used: Number(r.used_usd), reserved: Number(r.reserved_usd), requests: Number(r.requests_used) };
}

describe.skipIf(!DATABASE_URL)("hierarchical budgets (integration)", () => {
  let pool: Pool;
  beforeAll(async () => {
    pool = createPool(DATABASE_URL!);
    await applySchema(pool);
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await pool.query("TRUNCATE budget_node_counters, budget_node_leases, budget_nodes RESTART IDENTITY CASCADE");
  });

  async function tree(orgCap: number | null): Promise<{ org: BudgetNode; team: BudgetNode; user: BudgetNode }> {
    const org = await createNode(pool, { tenantId: "acme", kind: "org", name: "acme", window: "monthly", capUsd: orgCap });
    const team = await createNode(pool, { tenantId: "acme", parentId: org.id, kind: "team", name: "tier1", window: "monthly" });
    const user = await createNode(pool, { tenantId: "acme", parentId: team.id, kind: "user", name: "u123", window: "monthly" });
    return { org, team, user };
  }

  it("resolves a leaf path root→leaf", async () => {
    const { org, team, user } = await tree(null);
    const path = await resolvePath(pool, user.id);
    expect(path.map((n) => n.id)).toEqual([org.id, team.id, user.id]);
    expect(await resolvePath(pool, "999999")).toEqual([]);
    expect((await listNodes(pool, "acme")).length).toBe(3);
  });

  it("enforces an ancestor cap atomically under concurrency", async () => {
    const { org, user } = await tree(1.0); // org monthly cap $1
    const path = await resolvePath(pool, user.id);

    // 10 concurrent $0.30 reservations against the shared org cap. Exactly
    // floor(1.0 / 0.3) = 3 may be admitted; the rest reject on the org node.
    const results = await Promise.all(
      Array.from({ length: 10 }, () => reservePath(pool, { nodes: path, estimatedCostUsd: 0.3, now: NOW })),
    );
    const admitted = results.filter((r) => r.ok);
    const rejected = results.filter((r) => !r.ok);
    expect(admitted).toHaveLength(3);
    expect(rejected).toHaveLength(7);
    expect(rejected.every((r) => r.failedNodeId === org.id)).toBe(true);

    // The org counter reflects exactly the admitted reservations.
    const c = await counter(pool, org.id);
    expect(c.reserved).toBeCloseTo(0.9, 6);
    expect(c.requests).toBe(3);
  });

  it("enforces a request_cap on a node", async () => {
    const org = await createNode(pool, { tenantId: "t", kind: "org", name: "o", requestCap: 2 });
    const path = [org];
    const r1 = await reservePath(pool, { nodes: path, estimatedCostUsd: 0.01, now: NOW });
    const r2 = await reservePath(pool, { nodes: path, estimatedCostUsd: 0.01, now: NOW });
    const r3 = await reservePath(pool, { nodes: path, estimatedCostUsd: 0.01, now: NOW });
    expect([r1.ok, r2.ok, r3.ok]).toEqual([true, true, false]);
    expect(r3.failedNodeId).toBe(org.id);
  });

  it("settles reserved → used across every node on the path (roll-up)", async () => {
    const { org, team, user } = await tree(10);
    const path = await resolvePath(pool, user.id);
    const r = await reservePath(pool, { nodes: path, estimatedCostUsd: 0.5, now: NOW });
    expect(r.ok).toBe(true);
    await settlePath(pool, r.reservation!, 0.42);

    for (const n of [org, team, user]) {
      const c = await counter(pool, n.id);
      expect(c.used, `node ${n.kind}`).toBeCloseTo(0.42, 6);
      expect(c.reserved, `node ${n.kind}`).toBeCloseTo(0, 6);
    }
  });

  it("releases a reservation (frees hold + request count)", async () => {
    const { org, user } = await tree(10);
    const path = await resolvePath(pool, user.id);
    const r = await reservePath(pool, { nodes: path, estimatedCostUsd: 0.5, now: NOW });
    expect((await counter(pool, org.id)).reserved).toBeCloseTo(0.5, 6);
    await releasePath(pool, r.reservation!);
    const c = await counter(pool, org.id);
    expect(c.reserved).toBeCloseTo(0, 6);
    expect(c.requests).toBe(0);
  });

  it("uses per-node windows (daily vs monthly buckets)", async () => {
    const org = await createNode(pool, { tenantId: "t", kind: "org", name: "o", window: "monthly", capUsd: 10 });
    const user = await createNode(pool, { tenantId: "t", parentId: org.id, kind: "user", name: "u", window: "daily", capUsd: 5 });
    const path = await resolvePath(pool, user.id);
    await reservePath(pool, { nodes: path, estimatedCostUsd: 1, now: NOW });

    const orgWin = await pool.query("SELECT window_start FROM budget_node_counters WHERE node_id = $1", [org.id]);
    const userWin = await pool.query("SELECT window_start FROM budget_node_counters WHERE node_id = $1", [user.id]);
    expect(orgWin.rows[0].window_start.toISOString().slice(0, 10)).toBe("2026-07-01"); // month bucket = 1st
    expect(userWin.rows[0].window_start.toISOString().slice(0, 10)).toBe("2026-07-01"); // day bucket
  });
});
