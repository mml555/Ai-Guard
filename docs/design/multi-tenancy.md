# Multi-tenancy & hierarchical budgets — design & status

The largest remaining item: move from single-config / flat budgets to true
multi-tenant isolation with nested budgets (org → dept → team → user → feature),
without weakening the concurrency guarantees the current budget engine already
proves.

> **Status:** hierarchical budgets are now **built end-to-end behind a flag**
> (`HIERARCHICAL_BUDGETS=true`): the `budget_nodes` tree + counters + leases,
> atomic multi-level reserve/settle/release (concurrency-proven), the pure
> engine path-walk, `/v1/chat` wiring, counter sharding, and tenant-bound keys +
> per-tenant policy versions. The **flat path remains the default**. RLS and
> per-request per-tenant policy resolution are the documented remaining polish
> (see "Rollout"). All steps are covered by integration tests.

## What exists today (foundations)

- **Project scoping.** `budget_counters` is partitioned by `project_id`
  (migration `0005`); `user_daily` and `feature_monthly` counters are already
  per-project. API keys carry a `projectId` and requests are scoped to it
  (chat/usage/requests reject cross-project access).
- **Atomic reservations.** `reserveBudget()` increments `reserved_usd` under row
  locks and re-checks caps in one transaction; `usage.integration.test.ts`
  proves the exact admission count under concurrency.
- **Per-key scoping.** `projectId` / `environment` / `allowedUserTypes` /
  `allowedUserIds` on each key (now DB-backed, rotatable).

## Gaps

1. **One global counter row.** The global monthly cap is a single
   `budget_counters` row — correct under concurrency but a throughput ceiling at
   very high RPS (all requests contend on one row).
2. **Flat budgets.** Caps exist at `user_type` (daily) and `feature` (monthly)
   and one global — there is no org → dept → team nesting.
3. **Soft tenant isolation.** Isolation is by `project_id` on a shared schema;
   there is no hard tenant boundary (separate credentials/roles per tenant).

## Design

### Budget hierarchy

A `budget_nodes` tree replaces the flat dimensions:

```
budget_nodes(
  id, tenant_id, parent_id, kind,           -- org | dept | team | user | feature
  name,
  window,                                    -- daily | monthly
  cap_usd, request_cap,                      -- nullable = no cap at this level
  primary key (id)
)
```

A request maps to a **leaf path** (e.g. `org:acme → dept:support → team:tier1 →
user:u123 → feature:support_chat`). Every node on the path with a cap is a
budget dimension the request must satisfy.

`budget_counters` becomes `(node_id, window_start)` instead of
`(scope, key, window_start)`.

### Atomic multi-level reservation

Reservation must be all-or-nothing across every ancestor cap:

```
BEGIN
  -- Lock the path's counter rows in a FIXED order (ascending node_id) to make
  -- deadlock impossible when two requests share ancestors.
  SELECT ... FROM budget_counters
   WHERE node_id = ANY($path) AND window_start = $win
   ORDER BY node_id FOR UPDATE;
  -- Re-check every capped node against used+reserved+estimate.
  -- If ALL pass: increment reserved_usd on every node on the path.
  -- Else: rollback → block with the failing node in the reason.
COMMIT
```

This generalizes today's reserve-then-recheck to N levels while preserving the
single-transaction guarantee. Settlement (`recordActualCost`) and release walk
the same path.

### Removing the global-counter ceiling

Shard the top (org/global) counter into `N` sub-rows
(`node_id, shard, window_start`); a request reserves against
`shard = hash(userId) % N`. The cap check sums shards. This trades a single hot
row for `N` cooler rows; `N` is a deploy-time constant. The per-user/team rows
are already naturally sharded by key, so only the top of the tree needs it.

### Tenant isolation

- Each key/operator is bound to a `tenant_id`; every query is filtered by it
  (row-level scoping today, optionally Postgres RLS policies for defense in
  depth).
- Policy versions (`config_versions`) gain a `tenant_id` so each tenant has its
  own policy lineage.
- Per-tenant config is the natural extension of the [dynamic policy
  store](./dynamic-policy.md).

### Engine changes

The pure engine's `UsageSnapshot` / `ReservationCaps` become **arrays keyed by
node**, and `evaluateAiRequest` walks the path instead of the three fixed
dimensions. The decision/reason-code contract is unchanged (a block names the
failing node). This keeps the engine pure and unit-testable, and lets the
concurrency proof extend to the hierarchy.

## Rollout

1. ~~Ship `budget_nodes` + counter migration; keep the flat path as the
   default.~~ **Done** — `0011_budget_nodes`, `modules/budgets/repo.ts`.
2. ~~Atomic multi-level reserve/settle/release with a concurrency proof.~~
   **Done** — `budget-nodes.integration.test.ts` (exact admission against a
   shared ancestor cap; 3-level tree).
3. ~~Pure engine path-walk.~~ **Done** — `evaluateBudgetPath()` (`budgetPath.ts`),
   unit-tested; rule matches the DB `reservePath` upsert.
4. ~~Wire `/v1/chat` behind a flag.~~ **Done** — `HIERARCHICAL_BUDGETS=true`;
   requests carrying a `budgetNodeId` (from the body or the API key) resolve the
   path, `evaluateBudgetPath` pre-check → `reservePath` → `settlePath`/
   `releasePath`, with node-reservation leases (`budget_node_leases`) swept by
   maintenance. Flat path stays default. (`chat-hierarchical.integration.test.ts`)
5. ~~Shard the top counter + benchmark.~~ **Done** — `shard_count` on a node
   splits its counter into N rows (`cap/N` each); measured ~3.3× throughput,
   ~7× lower p95 locally (see [benchmarks](../deployment/benchmarks.md)).
6. ~~Tenant binding on keys + policy versions.~~ **Done** — keys carry
   `tenant_id` + `budget_node_id`; policy versions are per-tenant with one active
   version each and cross-tenant activation blocked (`policy-store` +
   `chat-hierarchical` tests). **RLS** is offered as documented defense-in-depth
   (below), not force-enabled.

### Postgres RLS (optional, defense-in-depth)

Application queries already scope by tenant. For belt-and-suspenders, enable RLS
and have the app connect as a **non-owner** role that sets `app.current_tenant`
per transaction:

```sql
ALTER TABLE config_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON config_versions
  USING (tenant_id = current_setting('app.current_tenant', true));
-- app (non-owner role) per transaction:  SET LOCAL app.current_tenant = 'tenant-a';
```

Left to the operator because it requires a dedicated DB role and per-connection
tenant context; the table owner bypasses RLS.

### Remaining polish (not blocking)

- Per-request **per-tenant policy resolution** (the boot loader currently loads
  one tenant's active version; multi-tenant policy needs request-time selection).
- Extend usage/requests read endpoints with explicit tenant scoping (they scope
  by `project_id` today).
