import type { Pool } from "pg";
import { withTransaction } from "../../db/pool";
import { dayWindowStart, monthWindowStart } from "../../services/windows";

// Hierarchical budgets. Standalone from the flat budget_counters path (which
// remains the default); this powers org → dept → team → user → feature nesting.
// The atomic multi-level reservation mirrors the proven flat upsert: a single
// check-and-increment statement per node (rowCount 0 = cap breach), all inside
// one transaction, with nodes locked in ascending id order so concurrent
// requests that share ancestors can never deadlock.

const LOCK_TIMEOUT_MS = 3000;
const MAX_DEPTH = 32;

export type NodeKind = "org" | "dept" | "team" | "user" | "feature";
export type BudgetWindow = "daily" | "monthly";

export interface BudgetNode {
  id: string;
  tenantId: string;
  parentId?: string;
  kind: NodeKind;
  name: string;
  window: BudgetWindow;
  capUsd: number | null;
  requestCap: number | null;
}

interface NodeDbRow {
  id: string;
  tenant_id: string;
  parent_id: string | null;
  kind: NodeKind;
  name: string;
  budget_window: BudgetWindow;
  cap_usd: string | null;
  request_cap: number | null;
}

const NODE_FIELDS = "id, tenant_id, parent_id, kind, name, budget_window, cap_usd, request_cap";

function rowToNode(r: NodeDbRow): BudgetNode {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    parentId: r.parent_id ?? undefined,
    kind: r.kind,
    name: r.name,
    window: r.budget_window,
    capUsd: r.cap_usd != null ? Number(r.cap_usd) : null,
    requestCap: r.request_cap,
  };
}

export interface CreateNodeInput {
  tenantId: string;
  parentId?: string;
  kind: NodeKind;
  name: string;
  window?: BudgetWindow;
  capUsd?: number | null;
  requestCap?: number | null;
}

export async function createNode(pool: Pool, input: CreateNodeInput): Promise<BudgetNode> {
  const { rows } = await pool.query<NodeDbRow>(
    `INSERT INTO budget_nodes (tenant_id, parent_id, kind, name, budget_window, cap_usd, request_cap)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${NODE_FIELDS}`,
    [
      input.tenantId,
      input.parentId ?? null,
      input.kind,
      input.name,
      input.window ?? "monthly",
      input.capUsd ?? null,
      input.requestCap ?? null,
    ],
  );
  const row = rows[0];
  if (!row) throw new Error("budget node insert returned no row");
  return rowToNode(row);
}

export async function getNode(pool: Pool, id: string): Promise<BudgetNode | null> {
  const { rows } = await pool.query<NodeDbRow>(
    `SELECT ${NODE_FIELDS} FROM budget_nodes WHERE id = $1`,
    [id],
  );
  return rows[0] ? rowToNode(rows[0]) : null;
}

export async function listNodes(pool: Pool, tenantId: string): Promise<BudgetNode[]> {
  const { rows } = await pool.query<NodeDbRow>(
    `SELECT ${NODE_FIELDS} FROM budget_nodes WHERE tenant_id = $1 ORDER BY id`,
    [tenantId],
  );
  return rows.map(rowToNode);
}

/**
 * Resolve a leaf node's full path root→leaf by walking parent_id. Returns [] if
 * the leaf is unknown; throws on a cycle or a path deeper than MAX_DEPTH (a
 * corrupt tree must fail loudly, not loop).
 */
export async function resolvePath(pool: Pool, leafId: string): Promise<BudgetNode[]> {
  const path: BudgetNode[] = [];
  const seen = new Set<string>();
  let current: string | undefined = leafId;
  while (current) {
    if (seen.has(current)) throw new Error(`cycle in budget_nodes at id ${current}`);
    if (path.length >= MAX_DEPTH) throw new Error(`budget_nodes path exceeds max depth ${MAX_DEPTH}`);
    seen.add(current);
    const node = await getNode(pool, current);
    if (!node) return path.length === 0 ? [] : path.reverse();
    path.push(node);
    current = node.parentId;
  }
  return path.reverse();
}

function windowStartFor(node: BudgetNode, now: Date): string {
  return node.window === "daily" ? dayWindowStart(now) : monthWindowStart(now);
}

export interface PathReservationEntry {
  nodeId: string;
  windowStart: string;
}

export interface PathReservation {
  entries: PathReservationEntry[];
  amountUsd: number;
  requestDelta: number;
}

export interface ReservePathResult {
  ok: boolean;
  failedNodeId?: string;
  reservation?: PathReservation;
}

class NodeRejected extends Error {
  constructor(readonly nodeId: string) {
    super(`reservation rejected at node ${nodeId}`);
    this.name = "NodeRejected";
  }
}

// Same check-and-increment shape as the flat RESERVE_SQL: the INSERT…SELECT…
// WHERE guards a fresh window row; the ON CONFLICT DO UPDATE…WHERE guards an
// existing row. rowCount 0 means the cap would be breached.
const NODE_RESERVE_SQL = `
  INSERT INTO budget_node_counters (node_id, window_start, used_usd, reserved_usd, requests_used)
  SELECT $1, $2, 0, $3, $4
  WHERE ($5::numeric IS NULL OR $3::numeric <= $5::numeric)
    AND ($6::int IS NULL OR $4::int <= $6::int)
  ON CONFLICT (node_id, window_start) DO UPDATE
    SET reserved_usd  = budget_node_counters.reserved_usd + EXCLUDED.reserved_usd,
        requests_used = budget_node_counters.requests_used + EXCLUDED.requests_used
    WHERE ($5::numeric IS NULL
           OR budget_node_counters.used_usd + budget_node_counters.reserved_usd + EXCLUDED.reserved_usd <= $5::numeric)
      AND ($6::int IS NULL
           OR budget_node_counters.requests_used + EXCLUDED.requests_used <= $6::int)
  RETURNING reserved_usd
`;

/**
 * Atomically reserve `estimatedCostUsd` against every node on the path. All caps
 * on the path must pass or the whole reservation rolls back. Uncapped nodes
 * still accumulate (for roll-up reporting). Nodes are processed in ascending id
 * order for deadlock safety.
 */
export async function reservePath(
  pool: Pool,
  params: { nodes: BudgetNode[]; estimatedCostUsd: number; now: Date; requestDelta?: number },
): Promise<ReservePathResult> {
  const requestDelta = params.requestDelta ?? 1;
  const ordered = [...params.nodes].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
  const entries: PathReservationEntry[] = ordered.map((n) => ({
    nodeId: n.id,
    windowStart: windowStartFor(n, params.now),
  }));
  try {
    await withTransaction(
      pool,
      async (client) => {
        for (const node of ordered) {
          const windowStart = windowStartFor(node, params.now);
          const res = await client.query(NODE_RESERVE_SQL, [
            node.id,
            windowStart,
            params.estimatedCostUsd,
            requestDelta,
            node.capUsd,
            node.requestCap,
          ]);
          if (res.rowCount === 0) throw new NodeRejected(node.id);
        }
      },
      { lockTimeoutMs: LOCK_TIMEOUT_MS },
    );
    return { ok: true, reservation: { entries, amountUsd: params.estimatedCostUsd, requestDelta } };
  } catch (err) {
    if (err instanceof NodeRejected) return { ok: false, failedNodeId: err.nodeId };
    throw err;
  }
}

/** Settle a reservation: book actual cost as used and release the held estimate. */
export async function settlePath(
  pool: Pool,
  reservation: PathReservation,
  actualCostUsd: number,
): Promise<void> {
  const ordered = [...reservation.entries].sort((a, b) => (BigInt(a.nodeId) < BigInt(b.nodeId) ? -1 : 1));
  await withTransaction(pool, async (client) => {
    for (const e of ordered) {
      await client.query(
        `UPDATE budget_node_counters
           SET used_usd = used_usd + $3,
               reserved_usd = GREATEST(reserved_usd - $4, 0)
         WHERE node_id = $1 AND window_start = $2`,
        [e.nodeId, e.windowStart, actualCostUsd, reservation.amountUsd],
      );
    }
  }, { lockTimeoutMs: LOCK_TIMEOUT_MS });
}

/** Release a reservation (provider failure / client disconnect): free the hold. */
export async function releasePath(pool: Pool, reservation: PathReservation): Promise<void> {
  const ordered = [...reservation.entries].sort((a, b) => (BigInt(a.nodeId) < BigInt(b.nodeId) ? -1 : 1));
  await withTransaction(pool, async (client) => {
    for (const e of ordered) {
      await client.query(
        `UPDATE budget_node_counters
           SET reserved_usd = GREATEST(reserved_usd - $3, 0),
               requests_used = GREATEST(requests_used - $4, 0)
         WHERE node_id = $1 AND window_start = $2`,
        [e.nodeId, e.windowStart, reservation.amountUsd, reservation.requestDelta],
      );
    }
  }, { lockTimeoutMs: LOCK_TIMEOUT_MS });
}
