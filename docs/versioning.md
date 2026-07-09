# Versioning, compatibility & release policy

How Modelgov versions its **HTTP API**, **SDKs**, and **config schema**; the
supported-version window; and the compatibility guarantees you can build on.

> **Status:** Modelgov **1.0.0** is released, so the compatibility guarantees
> below are now in effect: breaking changes to the HTTP API, SDKs, or config
> schema require a new major version. [SECURITY.md](../SECURITY.md) lists the
> currently supported version line.

---

## How we choose the version number

Modelgov honors SemVer's **compatibility contract**: the only guarantee a `^1.x`
consumer relies on is that **nothing breaks the HTTP API, SDKs, or config schema
except a MAJOR bump.** Within that contract we are deliberately **conservative
about the MINOR digit** so the version tracks real maturity, not commit volume:

| Change | Version bump |
| --- | --- |
| Breaking change to any surface (see the compatibility tables below) | **MAJOR** — `1.6.0 → 2.0.0` |
| A substantial, cohesive, **announced capability milestone** | **MINOR** — `1.6.0 → 1.7.0` (rare, deliberate) |
| Everything else backward-compatible — bug fixes, docs, perf, refactors, dependency/security bumps, and **small or gap-filling additive changes** (a new optional field, an SDK method that fills a parity gap) | **PATCH** — `1.6.0 → 1.6.1` |
| A change not yet part of a cut release | **no bump** — log under `[Unreleased]`; it ships in the next release |

This is intentionally **stricter than textbook SemVer**, which tags every
additive change a MINOR. Patch-shipping a small addition is safe — it never
breaks a `^1.x` consumer — and it keeps the minor digit meaningful as a
milestone marker.

**Cadence — not every merge is a release.** Changes accumulate under
`[Unreleased]` in [CHANGELOG.md](../CHANGELOG.md); cutting a release is a
deliberate act (bump every version surface, tag `vX.Y.Z`), taken when there is a
coherent set worth shipping. Default to a **PATCH**; reach for a MINOR only when
you are shipping a milestone worth naming. The full mechanics are in
[releasing.md](./releasing.md).

> **History:** releases `1.1`–`1.6` predate this policy and were cut per-feature
> as minors; they stand (published versions are immutable and only increase).
> This policy governs everything from `1.6.0` onward.

---

## SemVer, applied to three surfaces

Modelgov follows [Semantic Versioning](https://semver.org/) (`MAJOR.MINOR.PATCH`).
It has three independently meaningful compatibility surfaces.

> The **Bump** column in the tables below is each change's **compatibility
> class**, not the digit we always move. The MAJOR rows are the hard boundary —
> they *always* require a major. The MINOR rows are backward-compatible; per the
> policy above we ship them as **PATCH** by default and fold them into a MINOR
> only as part of an announced milestone.

### 1. HTTP API

The wire contract at `/v1/*`: routes, request/response shapes, error envelope,
status codes, and the **stable `reasonCode` values** in
[failure-semantics.md](./failure-semantics.md).

| Change | Bump |
| --- | --- |
| Add an optional request field, a new endpoint, a new optional response field | **MINOR** |
| Add a new `reasonCode` or error `code` | **MINOR** (consumers must tolerate unknown codes) |
| Remove/rename a field; change a status code for an existing case; change a documented `reasonCode`'s meaning; make an optional field required | **MAJOR** |
| Bug fix that does not change the contract | **PATCH** |

The URL carries the **API major** (`/v1`). A breaking API change introduces
`/v2` and is supported alongside `/v1` for the deprecation window below — the path
prefix, not just the package version, is the API's compatibility promise.
`GET /openapi.json` is the machine-readable source of truth for a running server.

**Explicitly stable (won't break within a major):** the `error` envelope shape
(`code`, `message`, `details`, `requestId`), the block-error `details` fields
(`decision`, `reasonCode`, `budgetRemaining`, `auditRequestId`), request-ID header
`x-modelgov-request-id`, and existing `reasonCode` string values.

### 2. SDKs (`@modelgov/sdk` and generated types)

npm packages follow SemVer against their **public TypeScript API**
(`createModelgovClient`, method signatures, exported types/errors).

| Change | Bump |
| --- | --- |
| Add a method or optional option | **MINOR** |
| Change/remove a signature or exported type; drop a runtime/Node version | **MAJOR** |

The SDK generates `FeatureName` / `UserTypeName` / `ModelClassName` unions from
**your** `modelgov.yaml` (`pnpm generate-sdk-types`). Those types reflect your
config, not the library version — regenerating after a config change is expected
and is not an SDK breaking change.

**SDK ↔ API compatibility:** an SDK targets an API **major**. A given SDK minor
works against any API server of the same major at ≥ the API minor it was built
for (forward-compatible: servers add optional fields). Pin the SDK major to your
API major.

### 3. Config schema (`modelgov.yaml`)

The policy file is a compatibility surface for operators.

| Change | Bump |
| --- | --- |
| Add an optional key with a safe default | **MINOR** |
| Remove/rename a key, change a default that alters enforcement, tighten validation so a previously valid file is rejected | **MAJOR** |

Validate before deploy with `pnpm modelgov validate --config modelgov.yaml
--production`. `litellm_config.yaml` is **generated** from `modelgov.yaml` and is
not a hand-editable compatibility surface.

---

## Supported-versions window & EOL

> In effect as of **1.0.0**. See [SECURITY.md](../SECURITY.md) for the currently supported line.

| Line | Support |
| --- | --- |
| **Current major** (latest minor) | Full support: features, fixes, security patches |
| **Previous major** | Security + critical fixes for **≥ 6 months** after the next major GA (EOL date announced at that GA) |
| **Older majors** | Unsupported (EOL) |
| **Pre-1.0 (0.x)** | Only the latest 0.x minor is supported; minors may break |

- **Security patches** land on the current major and any in-window previous
  major. Report privately per [SECURITY.md](../SECURITY.md).
- **API `/vN` sunset:** when `/v(N+1)` ships, `/vN` is supported for the previous-
  major window above, with a deprecation notice in release notes and (where
  feasible) response headers before removal.
- **EOL definition:** no further releases (including security) for that major.

---

## Upgrade & migration guarantees

- **Database migrations run forward automatically and are safe under concurrency**
  — serialized across replicas via a Postgres advisory lock; the default image
  entrypoint runs `migrate && start`, or run `node dist/migrate.js` as a
  standalone init job. See [operations upgrades](./operations.md#upgrades) and the
  [HA migration pattern](./deployment/high-availability.md#migration-init-job-pattern).
- **No automated schema downgrades.** Roll back via a Postgres restore (see
  [DR runbook](./runbooks/disaster-recovery.md)); always back up before upgrading.
- **Rolling upgrades within a major** are supported (stateless API replicas +
  backward-compatible migrations). Across a major, follow the release notes'
  migration guide.
- **Images are immutable and pinned** — no floating `:latest`; pin by tag or, best,
  by digest. Every breaking change ships with a **CHANGELOG entry + migration
  notes** — see [CHANGELOG.md](../CHANGELOG.md) (breaking entries are marked
  **⚠ Breaking** with a migration note).
- **Deprecation before removal:** a feature/field is marked deprecated for at
  least one MINOR release (with a documented replacement) before a MAJOR removes it.

---

## Post-1.0 hardening checklist

> **Status:** 1.0 shipped and the compatibility guarantees above are in effect,
> but not every surface is fully *frozen* yet. This tracks what still needs to be
> locked down; an unchecked box is a **known area to treat carefully**, not a
> licence to break compatibility (breaking changes still require a MAJOR).

What remains to be **frozen and guaranteed**:

**API contract**

- [ ] Freeze `/v1` route set, request/response schemas, and status-code mapping.
- [ ] Freeze the error-envelope shape and the full `reasonCode` enumeration as
      append-only.
- [x] Publish `openapi.json` as a versioned artifact per release; treat it as the
      contract of record — the `release` workflow attaches `openapi-<tag>.json` to
      each GitHub Release (`.github/workflows/release.yml`).
- [ ] Confirm no known breaking API change is pending (e.g. actor/subject model is
      explicitly **post-v1** and must stay additive).

**SDK**

- [ ] Freeze the public `@modelgov/sdk` surface (methods, options, exported types,
      error classes).
- [ ] Document the SDK-major ↔ API-major support matrix.
- [ ] Pin and document the supported Node/runtime range.

**Config schema**

- [ ] Freeze `modelgov.yaml` key names and enforcement-affecting defaults.
- [ ] Ship a schema version or validation that rejects unknown keys predictably.
- [ ] Document every field's default and its bump class (MINOR-add vs MAJOR-change).

**Migrations & data**

- [ ] Confirm forward migrations are idempotent and advisory-locked (done).
- [ ] Document the backup-before-upgrade requirement and rollback-via-restore path.

**Process & docs**

- [x] Adopt a maintained **CHANGELOG** with a breaking-changes section per release
      — [CHANGELOG.md](../CHANGELOG.md) (Keep a Changelog format; **⚠ Breaking**
      entries carry migration notes).
- [ ] Publish the deprecation policy (≥1 MINOR notice) and the supported-version
      window with concrete EOL dates.
- [ ] Update [SECURITY.md](../SECURITY.md) supported-versions table when 1.0 ships
      to the 1.x support window.
- [ ] Define the `/v1 → /v2` coexistence + sunset procedure before the first
      breaking API change lands.

**Known post-v1 items (intentionally deferred, must stay additive):** response
streaming (SSE), actor/subject policy model, global-counter sharding, routing
experiments/weighted rotation. These are documented as not-in-v1 and 1.0 must not
depend on them; when they land they must be backward-compatible additions.

Related: [operations](./operations.md), [API reference](./api.md),
[failure semantics](./failure-semantics.md), [SECURITY.md](../SECURITY.md).
