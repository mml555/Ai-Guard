# Dynamic policy store — design & status

Moves policy off a static `modelgov.yaml` baked into the image and into a
**versioned, validated, auditable** store, so operators can change budgets,
safety rules, and routing without editing files in the image.

## Built (opt-in via `POLICY_STORE_ENABLED=true`)

- **Versioned store** — `config_versions` table; each version is immutable YAML
  with a SHA-256 checksum, author, and note. A partial unique index enforces
  **exactly one active version**.
- **Validation on write** — `POST /v1/admin/policy/versions` runs the full
  `parseConfig` validator; an invalid config is rejected `400 invalid_config`
  and never enters the store.
- **Activation & rollback** — `POST /v1/admin/policy/versions/:id/activate`
  flips the active version atomically. Rollback is just activating a prior id.
  Re-validates before flipping.
- **Audit** — `policy.save` and `policy.activate` are written to the
  tamper-evident audit log (`[audit]`), with actor + checksum.
- **Boot loading** — with the flag on, a replica loads the active version at
  boot; on an empty store it seeds version 1 from `MODELGOV_CONFIG`.
- **RBAC** — reads require `policy:read`, mutations `policy:write` (the
  `policy-admin` and `owner` roles).
- **Zero-restart hot reload** (default on, `POLICY_HOT_RELOAD`) — an activated
  version applies without a restart. Each request resolves the active version
  through a short-TTL cache (`POLICY_CACHE_TTL_MS`) instead of a `deps.config`
  captured at boot, and activation fires a transactional Postgres
  `NOTIFY modelgov_policy_activated` (payload = tenantId) that every replica
  LISTENs on and invalidates its cache immediately. The TTL is the backstop if a
  notification is missed (a brief connection gap during failover). The listener
  is a dedicated connection that reconnects with backoff; a listener outage
  degrades to TTL-bounded convergence, never a failed boot or request.
- **Approval workflow** (opt-in, `POLICY_APPROVAL_REQUIRED`) — a two-person rule.
  A saved version is `proposed` (recording `proposed_by`); a **different**
  operator holding the distinct `policy:approve` permission approves it
  (`POST …/approve`) or rejects it (`POST …/reject`), recording `reviewed_by`.
  Self-approval is rejected. Only an `approved` version can be activated
  (`409 not_approved` otherwise). The state machine lives in the `status` column
  (migration `0025`); with approval off, saves are born `approved`, so the flow
  is unchanged. `policy.approve` / `policy.reject` are written to the audit log.
- **Structured diffs** — `deepDiff` produces a semantic path-level diff between
  two versions (or a proposed YAML vs the active version via `…/preview`),
  surfaced in the console policy editor.
- **Env interpolation** — a stored version's `providers.<name>.api_key: env/VAR`
  references are resolved against the process environment (`resolveEnvRefs`) on
  the serving path — the boot load and the per-request resolver — exactly like
  file loading, so a secret is referenced, not baked into the database.
  Resolution deliberately does **not** run on `…/diff` or `…/preview` (those
  compare the literal stored YAML, never resolved secrets).

## Roadmap (not yet built)

- Nothing outstanding for the policy store — hot reload, approvals, structured
  diffs, and env interpolation above cover the original roadmap.

See [operations](../operations.md) for enabling the store and the
[HTTP API](../api.md) for the endpoints.
