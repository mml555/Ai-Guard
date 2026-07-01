# Operations guide

Run Ai-Guard in production on your own infrastructure.

## Production checklist

- [ ] TLS termination (nginx, ALB, Cloudflare) in front of the API
- [ ] Strong `AI_GUARD_API_KEY` / scoped `AI_GUARD_API_KEYS` (include `usage:read` for ops)
- [ ] Managed Postgres with automated backups
- [ ] Pinned container images (see [Production deploy](#production-deploy))
- [ ] Provider keys in a secrets manager, not git
- [ ] `GET /ready` wired to load balancer health checks
- [ ] Log shipping from API container
- [ ] Review [SECURITY.md](../SECURITY.md)

## Production deploy

### 1. Build the API image

```bash
docker build -t your-registry/ai-guard-api:1.0.0 -f packages/api/Dockerfile .
docker push your-registry/ai-guard-api:1.0.0
```

### 2. Configure policy

Copy [`ai-guard.production.example.yaml`](../ai-guard.production.example.yaml) → `ai-guard.yaml` and customize:

- `project.name` — matches your app and scoped API key `projectId` when used
- `budgets` — global monthly cap and per-`user_type` limits
- `features` — one entry per SDK `feature` your apps will call
- `model_classes` — align `primary` / `fallback` with [`litellm_config.yaml`](../litellm_config.yaml)

### 3. Configure environment

Copy [`.env.production.example`](../.env.production.example) → `.env.production` and set:

- `AI_GUARD_API_IMAGE` — your built image (immutable digest recommended)
- `POSTGRES_IMAGE`, `LITELLM_IMAGE`, `PRESIDIO_*_IMAGE`, `REDIS_IMAGE` — pinned digests
- `DATABASE_URL` — production Postgres (or use compose postgres with strong password)
- Provider and API keys

### 4. Launch

```bash
make up-prod    # uses docker-compose.production.yml + .env.production
make down-prod
```

Or manually:

```bash
docker compose -f docker-compose.production.yml --env-file .env.production up -d
```

For Kubernetes, see [deploy/k8s/README.md](../deploy/k8s/README.md).

### 5. Verify

```bash
curl -s http://localhost:3000/health
curl -s http://localhost:3000/ready
```

Use **`/ready`** for load balancer readiness. It gates on the database and reports LiteLLM/Presidio status when configured.

## Health endpoints

| Endpoint | Checks | Use for |
| --- | --- | --- |
| `/health` | Process only | Liveness |
| `/ready` | Database gates readiness; LiteLLM + Presidio are reported if configured | Readiness / traffic routing |

## Backups

Back up the **Postgres** volume (or managed DB snapshots). Critical tables:

- `budget_counters` — spend state
- `request_logs` — audit trail
- `idempotency_keys` — short-lived; less critical

Restore procedure: restore DB snapshot → restart API → verify `/ready`.

## Scaling

| Concern | v1 guidance |
| --- | --- |
| **API replicas** | Supported — set `REDIS_URL` so rate limits are shared |
| **Rate limits** | In-memory per instance without Redis; set `REDIS_URL` (included in production compose) for shared limits across replicas |
| **Budget counters** | Centralized in Postgres — safe across replicas |
| **Migrations** | Run **one** migrator on deploy; avoid N containers racing `migrate.js` |
| **LiteLLM** | Single instance SPOF in default compose — add HA LiteLLM for high traffic |

For multiple API replicas, run migrations as a separate init job:

```bash
docker run --rm --env-file .env.production your-registry/ai-guard-api:1.0.0 node dist/migrate.js
```

Then start API containers with `CMD ["node", "dist/index.js"]` (override default migrate+start).

## Maintenance

The API runs background cleanup when `MAINTENANCE_ENABLED=true` (default on):

- Stale idempotency `processing` rows older than `IDEMPOTENCY_STALE_MS` (default **15m**)
- Orphaned budget `reserved_usd` from worker crashes, via reservation leases older than `RESERVATION_STALE_MS` (default **15m**, aligned with idempotency)

When `REDIS_URL` is set, rate limiting **fails closed** if Redis is unavailable (requests are rejected rather than bypassing limits).

## Budget alerts

When global spend (used + reserved) crosses `alert_at_percent` in `ai-guard.yaml`:

1. The API logs a structured warning **once per calendar month** (deduped in Postgres)
2. If `BUDGET_ALERT_WEBHOOK_URL` is set, it **POSTs once per calendar month** on the same dedupe claim

Webhook payload:

```json
{
  "event": "budget.alert",
  "scope": "global_monthly",
  "windowStart": "2026-06-01",
  "globalSpendUsd": 85.5,
  "alertThresholdUsd": 80,
  "alertAtPercent": 80,
  "monthlyCapUsd": 100,
  "sentAt": "2026-06-30T12:00:00.000Z"
}
```

If `BUDGET_ALERT_WEBHOOK_SECRET` is set, the request includes
`X-Ai-Guard-Signature: sha256=<hmac-sha256-hex>` over the JSON body.

## Docker image

Build locally:

```bash
make build-image
# or: scripts/build-api-image.sh ghcr.io/your-org/ai-guard-api:1.0.0
```

CI publishes to **GitHub Container Registry** on version tags (`v*`) and on every
push as a commit-SHA tag. There is **no floating `:latest` tag** — pin an
immutable reference in production:

```text
# Release tag (preferred)
ghcr.io/<owner>/<repo>/ai-guard-api:v1.0.0

# Or commit SHA (also published on each build)
ghcr.io/<owner>/<repo>/ai-guard-api:<git-sha>

# Best: resolve the tag to a digest and set AI_GUARD_API_IMAGE=...@sha256:...
docker buildx imagetools inspect ghcr.io/<owner>/<repo>/ai-guard-api:v1.0.0
```

Production without a registry:

```bash
# .env.production
AI_GUARD_API_IMAGE=ai-guard-api:local
BUILD_LOCAL_IMAGE=true
make up-prod
```

## Data retention

`request_logs` and `idempotency_keys` grow without bound in v1. Plan:

- Periodic `DELETE FROM request_logs WHERE created_at < now() - interval '90 days'`
- Idempotency rows are cleaned automatically when stale

## Local Ollama

```bash
ollama pull llama3.2:1b
ollama pull llama3.2:3b
make up-local
```

API on port **3080**. No cloud provider keys required.

## Observability

| Mode | Traces |
| --- | --- |
| `observability.provider: none` | Postgres `request_logs` only |
| `make up-full` / Langfuse | UI at :3001 |

Set `OBSERVABILITY_CAPTURE_CONTENT=false` in production unless you need prompt logging in Langfuse.

Set `IDEMPOTENCY_CAPTURE_CONTENT=false` (default) so model completions are not stored in the idempotency table at rest — replays then return the response envelope with empty `message.content`.

## Metrics

Prometheus metrics are exposed at `GET /metrics` (`METRICS_ENABLED=true`, default on): request rate/errors/latency (`http_requests_total`, `http_request_duration_seconds`), pg pool saturation (`pg_pool_connections_total` / `_idle`, `pg_pool_clients_waiting`), and Node process defaults.

By default `/metrics` is unauthenticated — keep it on an internal scrape network, not the public LB. Set `METRICS_AUTH_TOKEN` to require `Authorization: Bearer <token>` from your Prometheus scraper.

Alert on: 5xx rate, p95 of `http_request_duration_seconds`, sustained `pg_pool_clients_waiting > 0`, and budget-block / provider-fallback rates.

## Health vs readiness

- `GET /health` — **liveness**, in-process only (never touches the DB). Point a k8s `livenessProbe` here; a DB blip must not restart pods.
- `GET /ready` — **readiness**, gates on the database only. LiteLLM/Presidio health is reported in the body but does not flip readiness (they fail closed per request), so a transient upstream blip won't deschedule the fleet. Point `readinessProbe` / the LB health check here.

## Data retention

`request_logs` is pruned by the maintenance sweep down to `REQUEST_LOG_RETENTION_MS` (default 30 days), in batches. The sweep runs on a single replica per tick (elected via a Postgres advisory lock); idempotency keys and reservation leases are swept on the same tick.

## Networking & TLS

- Terminate TLS at a proxy/LB in front of the API (there is no built-in TLS). Set `TRUST_PROXY` to your proxy's IP/CIDR list so client IPs and rate-limit buckets are real and can't be spoofed via `X-Forwarded-For`.
- Set `DATABASE_SSL=verify-full` (with `DATABASE_SSL_CA`) whenever Postgres is remote/managed.
- Migrations serialize across replicas via a Postgres advisory lock, so the default image entrypoint (`migrate && start`) is safe even when scaling up.

## Upgrades

1. Backup Postgres
2. Build and push new API image
3. Run migrations (`node dist/migrate.js`)
4. Rolling restart API containers
5. Smoke test `POST /v1/chat` and `GET /v1/usage`

## Known limitations (v1)

- No hosted SaaS — self-host only
- Single `ai-guard.yaml` per deployment
- `user_daily` and `feature_monthly` budget counters are partitioned by `project_id` (from the API key or `ai-guard.yaml` `project.name`); global monthly remains one deployment-wide counter
- **No response streaming** — `/v1/chat` returns the full completion in one response (cost is settled after the call). Interactive streaming (SSE) is not supported in v1.
- **Global budget is a single counter row** — correct under concurrency (atomic, cap-safe) but a throughput ceiling at very high RPS. A per-transaction `lock_timeout` makes contention fail fast rather than pile up; shard the counter if you outgrow it.
- **Fallback cost is pre-reserved** — when the primary provider fails, the API tops up the reservation to the fallback model's estimate before calling it, so caps are not marginally overshot on that path. Actual cost can still exceed the estimate if LiteLLM reports a higher real cost.
- **Rate limiting requires Redis in multi-replica mode and fails closed by default** — a Redis outage rejects `/v1/chat` (429) unless `RATE_LIMIT_FAIL_OPEN=true`. The atomic budget reserve remains the real spend guard.
- Budget windows are attributed by UTC day/month; a request spanning UTC midnight books to the window it reserved in.
- Reservation sweeper TTL defaults to 15m; very slow requests (>TTL) may see a duplicate reservation attempt after cleanup

See [Architecture](./ARCHITECTURE.md) for design details.
