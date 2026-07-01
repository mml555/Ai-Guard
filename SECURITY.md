# Security policy

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.x | Yes (active development) |

## Reporting a vulnerability

**Do not** open public GitHub issues for security vulnerabilities.

Report security issues privately:

1. **GitHub (preferred):** open a [private security advisory](https://github.com/ai-guard/ai-guard/security/advisories/new) on this repository.
2. **Email:** `security@ai-guard.dev` (PGP key available on request).

Include:

- Description and impact
- Steps to reproduce
- Affected version / commit
- Suggested fix (optional)

We aim to acknowledge within 72 hours and provide a remediation timeline for
confirmed issues.

## Security model

Ai-Guard is a **self-hosted** control plane. You are responsible for:

- Network exposure and TLS
- API key generation, rotation, and storage
- Postgres access control and encryption at rest
- Provider API key handling (via LiteLLM)

Ai-Guard enforces **AI policy** (budgets, safety, routing). It does **not**
replace application authentication or authorization.

## Hardening recommendations

- Use scoped `AI_GUARD_API_KEYS` with minimal `permissions`
- Never commit `.env` or production secrets
- Place the API behind a reverse proxy with TLS
- Restrict Postgres to private networks
- Pin container images in production
- Set `OBSERVABILITY_CAPTURE_CONTENT=false` unless required
- Set `IDEMPOTENCY_CAPTURE_CONTENT=false` unless you need completion text on idempotency replays
- Set `METRICS_AUTH_TOKEN` when `/metrics` is reachable beyond an internal scrape network
- Review Presidio and Langfuse deployment exposure

## Dependencies

Ai-Guard composes LiteLLM, Presidio, Postgres, and optionally Langfuse. Monitor
CVEs in those components and rebuild images on security patches.
