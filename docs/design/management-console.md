# Management console — design & status

A web UI over the control-plane APIs so FinOps, security, and platform teams can
operate Modelgov without editing YAML or using the CLI.

> **Status:** v1 shipped (`apps/operator-console`). A static React/Vite SPA over
> the documented HTTP API — Overview, Requests, Usage, Keys, Policy, Audit, and
> Privacy. The nav and per-row actions are permission-aware (driven by
> `GET /v1/admin/whoami`); server-side RBAC remains the enforcement boundary.

## The APIs already exist

Every surface the console needs is a shipped, authenticated endpoint:

| Console view | Backing API | Permission |
| --- | --- | --- |
| Spend dashboard (by feature/user/type, cost) | `GET /v1/usage`, `GET /v1/usage/summary` | `usage:read` |
| Request audit explorer | `GET /v1/requests`, `/v1/requests/:id` | `requests:read` |
| API key management (issue/rotate/revoke) | `/v1/admin/keys*` | `keys:admin` |
| Policy editor + version history + rollback | `/v1/admin/policy/*` | `policy:read` / `policy:write` |
| Admin audit log + chain verify | `/v1/admin/audit`, `/verify` | `audit:read` |
| Data erasure (DSAR) | `POST /v1/admin/erasure` | `data:erase` |

## Auth

The console authenticates operators via **OIDC SSO** (already implemented,
[`authz`]): the browser gets a JWT from the corporate IdP; the console sends it
as `Authorization: Bearer <jwt>` to the same API. **RBAC roles** (viewer /
finops / key-admin / policy-admin / owner) already gate every endpoint, so the
console just reflects the operator's permissions (hide/disable what they can't
do) — enforcement stays server-side.

## Tech

- Static SPA (React/Vite or SvelteKit) served as its own container or from a CDN
  — no coupling to the API process.
- Talks only to the documented HTTP API (typed against `openapi.json`, the same
  spec the SDKs use).
- No secrets in the browser: the JWT is the only credential; API keys created in
  the UI show their plaintext **once** (matching the API contract) and are never
  re-fetchable.

## Surfaces (v1)

1. **Overview** — live-polling dashboard: global spend-vs-cap gauge and a
   request-outcome bar chart (completed / blocked / degraded / fallback rates)
   from `GET /v1/usage` (`globalMonthly.capUsd`) + `GET /v1/usage/summary`.
2. **Keys** — table with prefix/name/permissions/last-used; create (one-time
   secret modal), rotate, revoke. Reads never expose hashes.
3. **Policy** — YAML editor with client-side validate → save version → diff →
   activate/rollback; version history from `/v1/admin/policy/versions`.
4. **Audit** — filterable admin action log with a "verify chain" button
   surfacing `/v1/admin/audit/verify`.
5. **Requests** — audit explorer (metadata only; content is never stored).
6. **Privacy** — DSAR erasure form (gated by `data:erase`).

## Build notes / roadmap

- The Policy surface is a full editor: paste YAML → validate + diff against the
  active version (`…/preview`) → save → (when the two-person rule is on)
  approve/reject → activate/rollback, with a version-history table showing each
  version's `status`, proposer, and reviewer. Approve/reject buttons appear only
  for operators holding `policy:approve`; activate only for `policy:write`.
- **Zero-restart policy apply** is live (see [dynamic-policy](./dynamic-policy.md)):
  the activate response reports "applied immediately across replicas (hot
  reload)" when the store's hot reload is on, or the rolling-restart note when
  it isn't.
- **Live Overview dashboard** is wired: it polls `GET /v1/usage/summary` and
  `GET /v1/usage` every 15s (with a live/pause toggle and a 24h/7d/30d window
  selector) and renders a **global spend-vs-cap gauge** (used + reserved against
  the configured monthly cap, now surfaced on `/v1/usage` as `capUsd`) plus a
  **request-outcome bar chart** (completed / blocked / safety-blocked / degraded
  / fallback rates). Charts are dependency-free CSS bars — no external chart
  library, so the strict-CSP nginx image serves them unchanged.
- **Metrics page** scrapes Prometheus `/metrics` (with the deployment's
  `METRICS_AUTH_TOKEN` if set) and shows the deployment-wide `modelgov_*` domain
  counters — the alternative Prometheus data source the Overview design mentioned,
  as its own page (deployment-wide, vs the tenant-scoped Overview).
- **Multi-tenant views** are wired (see [multi-tenancy](./multi-tenancy.md)): a
  platform (non-tenant-bound) operator gets a **tenant switcher** (from
  `GET /v1/admin/tenants`) that sends `X-Modelgov-Tenant` on every request,
  re-scoping the whole console to one tenant or the untenanted default. A
  tenant-bound operator has no switcher — the server ignores the header for bound
  keys. Per-tenant budgets surface through the Overview gauge, whose cap follows
  the selected tenant's active policy.

Because the API contract is fixed and typed, the console is decoupled
frontend work — it can be built and shipped independently of the gateway.
