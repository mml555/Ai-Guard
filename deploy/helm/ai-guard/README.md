# Ai-Guard Helm chart

Turnkey Kubernetes install of the Ai-Guard gateway — the k8s companion to the
`create-ai-guard` docker-compose scaffold.

## Install

```bash
helm install ai-guard ./deploy/helm/ai-guard \
  --namespace ai-guard --create-namespace \
  --set image.repository=ghcr.io/your-org/ai-guard-api \
  --set image.tag=v0.5.0 \
  --set secret.aiGuardApiKey=$(openssl rand -hex 24) \
  --set secret.databaseUrl='postgres://user:pass@your-db:5432/aiguard' \
  --set-string secret.providerKeys.OPENAI_API_KEY=sk-...
```

Then paste your production policy into `config.aiGuardYaml` (or point at an
existing ConfigMap) and `helm upgrade`.

## What it deploys

| Component | Default | Notes |
| --- | --- | --- |
| API (`Deployment` + `Service`) | 2 replicas | `/health` liveness, `/ready` readiness |
| Migration `Job` | on | pre-install/pre-upgrade **hook** — one migrator, not N replicas racing |
| LiteLLM | in-cluster | set `litellm.enabled=false` + `litellm.baseUrl` to use external |
| Redis | in-cluster | shared rate limits across replicas (HA); `redis.enabled=false` to skip |
| Presidio | **off** | enable for `balanced`/`strict` PII/injection enforcement |
| Postgres | **off** | dev-only in-cluster; use managed Postgres in production |
| Ingress | off | enable + set `ingress.host` |

## Secrets & config

- **Secret** — provide `secret.existingSecret` (recommended: sync from Vault /
  CSI / Sealed Secrets), or let the chart create one from `secret.*`. Carries
  `AI_GUARD_API_KEY`, `DATABASE_URL`, `LITELLM_MASTER_KEY`, optional
  `METRICS_AUTH_TOKEN`, and provider keys (`secret.providerKeys`).
- **Policy** — inline `config.aiGuardYaml` or `config.existingConfigMap`. The API
  pods roll automatically when the config checksum changes.

## Production notes

- Use **managed Postgres** (`postgres.enabled=false`) and set
  `secret.databaseUrl` to it. With in-cluster `postgres.enabled=true` (dev), set
  `migrations.enabled=false` — the pre-install migration hook runs before the
  in-cluster DB is ready, and the API self-migrates under an advisory lock.
- Keep `redis.enabled=true` for multiple API replicas (shared, fail-closed rate
  limits). The atomic budget reserve is the real spend guard regardless.
- Terminate TLS at the ingress; set `METRICS_AUTH_TOKEN` if `/metrics` is
  reachable beyond an internal scrape network.

See [operations](../../../docs/operations.md) and
[high-availability](../../../docs/deployment/high-availability.md).
