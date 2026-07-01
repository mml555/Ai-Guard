# Configuration reference

Ai-Guard is controlled by **`ai-guard.yaml`** — the single source of truth for
budgets, features, models, safety, and routing. The API loads this file at
startup (`AI_GUARD_CONFIG` env var). LiteLLM config is **generated** from it for
provider execution; do not treat `litellm_config.yaml` as the policy source.

## File structure

```yaml
project:
  name: my-app
  environment: production

providers:
  openai:
    api_key: env/OPENAI_API_KEY
  anthropic:
    api_key: env/ANTHROPIC_API_KEY

budgets:
  global: { ... }
  by_user_type: { ... }

features:
  support_chat: { ... }

routing:
  degrade_at_percent: 80

model_classes:
  cheap: { primary: ..., fallback: ... }

safety:
  preset: balanced
  protect: { ... }

observability:
  provider: none
```

Keys use **snake_case** in YAML; the policy engine normalizes to camelCase internally.

---

## `project`

| Field | Required | Description |
| --- | --- | --- |
| `name` | Yes | Project identifier; default `projectId` on API requests |
| `environment` | No | Default `development`; e.g. `production`, `staging` |

---

## `providers`

Maps provider id → credentials reference. The API resolves `env/VAR_NAME` to the
process environment at startup.

```yaml
providers:
  openai:
    api_key: env/OPENAI_API_KEY
```

The pure policy engine never reads API keys.

---

## `budgets`

### `budgets.global`

| Field | Type | Description |
| --- | --- | --- |
| `monthly_usd` | number | Global monthly spend cap (USD). `0` = no global cap |
| `alert_at_percent` | 0–100 | Log a warning when spend crosses this % of monthly cap; optional webhook (see below) |
| `hard_stop_at_percent` | 0–100 | Block new requests at this % of monthly cap (default 100) |

When global spend (used + reserved) crosses `degrade_at_percent` (see routing),
the engine may **degrade** to a cheaper permitted model class.

### `budgets.by_user_type`

Map of user type → limits. Your app sends `userType` on each request; it must
match a key here.

| Field | Type | Description |
| --- | --- | --- |
| `daily_usd` | number | Max USD per user per day (used + reserved) |
| `daily_requests` | number | Max requests per user per day |
| `models` | string[] | Allowed model classes, e.g. `["cheap", "standard"]` |

Example:

```yaml
by_user_type:
  anonymous:
    daily_usd: 0.02
    daily_requests: 5
    models: ["cheap"]
  logged_in:
    daily_usd: 0.25
    daily_requests: 50
    models: ["cheap", "standard"]
  admin:
    daily_usd: 10
    daily_requests: 500
    models: ["cheap", "standard", "premium"]
```

---

## `features` (required registry)

**Every API call must name a `feature` that exists here.** This prevents untracked
generic LLM usage.

| Field | Type | Description |
| --- | --- | --- |
| `model_class` | string | Default model class if caller omits `modelClass` |
| `max_tokens` | int | Max output tokens for this feature |
| `safety` | preset or object | Override global safety (`strict`, `balanced`, `dev`, or `{ preset, protect }`) |
| `budget.monthly_usd` | number | Optional per-feature monthly cap |

```yaml
features:
  support_chat:
    safety: strict
    model_class: cheap
    max_tokens: 500
  event_extraction:
    safety: balanced
    model_class: standard
    max_tokens: 1500
    budget:
      monthly_usd: 100
```

After adding features, regenerate SDK types:

```bash
pnpm generate-sdk-types
```

---

## `model_classes`

Defines **primary** and **fallback** models per tier. Apps request a class
(`cheap`, `standard`, `premium`), not a raw model name.

```yaml
model_classes:
  cheap:
    primary: openai/gpt-4o-mini
    fallback: anthropic/claude-haiku
  standard:
    primary: anthropic/claude-sonnet
    fallback: openai/gpt-4o
```

- **allow** → `primary`
- **fallback** (provider failure) → `fallback`
- **degrade** → one tier cheaper (if permitted for user type)

---

## `routing`

| Field | Default | Description |
| --- | --- | --- |
| `degrade_at_percent` | 80 | When global monthly spend ≥ this % of cap, degrade model class |

---

## `safety`

| Field | Description |
| --- | --- |
| `preset` | `dev` \| `balanced` \| `strict` \| `custom` |
| `protect.pii` | `mask` \| `block` \| `off` |
| `protect.prompt_injection` | `block` \| `off` |
| `injection_model` | LiteLLM model name for injection classifier |

Feature-level `safety:` overrides the global preset.

Presidio URLs must be set in the environment for PII enforcement. If missing,
the API logs a warning and PII rules are not enforced.

---

## `observability`

| Field | Values | Description |
| --- | --- | --- |
| `provider` | `none` \| `langfuse` | Trace sink |

Override at runtime with `OBSERVABILITY_PROVIDER=langfuse` and Langfuse env vars.

---

## Environment variables

See [`.env.example`](../.env.example) and [Operations](./operations.md). Key vars:

| Variable | Purpose |
| --- | --- |
| `AI_GUARD_CONFIG` | Path to `ai-guard.yaml` |
| `DATABASE_URL` | Postgres connection string |
| `AI_GUARD_API_KEY` | Bearer token for apps (or use `AI_GUARD_API_KEYS` JSON) |
| `LITELLM_BASE_URL` | LiteLLM proxy URL |
| `LITELLM_MASTER_KEY` | LiteLLM auth |
| `PRESIDIO_ANALYZER_URL` / `PRESIDIO_ANONYMIZER_URL` | PII services |
| `REDIS_URL` | Shared rate limits across API replicas (recommended in production) |
| `IDEMPOTENCY_STALE_MS` | Stale in-flight idempotency claim TTL (default **900000** = 15m) |
| `RESERVATION_STALE_MS` | Orphaned budget reservation release TTL (default **900000** = 15m) |
| `BUDGET_ALERT_WEBHOOK_URL` | POST budget alert once per month when threshold crossed |
| `BUDGET_ALERT_WEBHOOK_SECRET` | Optional HMAC secret for `X-Ai-Guard-Signature` |

### Scoped API keys (multi-tenant operators)

Use `AI_GUARD_API_KEYS` when one deployment serves multiple teams or projects.
Each key is a **principal** with optional scope fields:

| Field | Purpose |
| --- | --- |
| `name` | Label for logs and audit |
| `key` | Bearer secret |
| `projectId` | Pins `projectId` on chat requests; usage queries are tenant-scoped |
| `environment` | Pins `environment` (e.g. `production`) |
| `allowedUserTypes` | Restrict which `userType` values the key may send |
| `allowedUserIds` | Restrict which `userId` values the key may send |
| `permissions` | Default `["chat:create"]`; add `"usage:read"` for ops summaries; add `"requests:read"` for audit log access |

**Key patterns (2026 defaults):**

```json
[
  {
    "name": "ops",
    "key": "replace-long-random",
    "permissions": ["chat:create", "usage:read", "requests:read"]
  },
  {
    "name": "tenant-a-app",
    "key": "replace-long-random",
    "projectId": "tenant-a",
    "environment": "production",
    "allowedUserTypes": ["logged_in"],
    "permissions": ["chat:create"]
  },
  {
    "name": "tenant-a-support",
    "key": "replace-long-random",
    "projectId": "tenant-a",
    "allowedUserIds": ["user_123", "user_456"],
    "permissions": ["chat:create", "usage:read", "requests:read"]
  }
]
```

- **Ops keys** (no `projectId`): full deployment visibility on usage when `usage:read` is granted; optional `?projectId=` targets a tenant partition.
- **Tenant keys** (`projectId` set): must pass `userId` or `feature` on `GET /v1/usage`; global monthly counters are hidden; budget data is read from that project's partition only.
- Default single `AI_GUARD_API_KEY` grants `chat:create` only — add `usage:read` explicitly for monitoring.

Set as one-line JSON in `AI_GUARD_API_KEYS`.

---

## Validation errors

Unknown `feature`, `user_type`, or `model_class` → HTTP **400** with
`unknown_feature` / similar codes from the policy engine.
