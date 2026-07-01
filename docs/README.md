# Ai-Guard documentation

Ai-Guard is a **self-hosted AI control plane**. You run it in your infrastructure;
your applications call it to enforce cost, safety, and routing policy before any
model request reaches a provider.

## Start here

| Doc | Who | What |
| --- | --- | --- |
| [Mental model](./mental-model.md) | Everyone | Who owns what — read this first |
| [Integration checklist](./integration-checklist.md) | App developers | Add Ai-Guard in ~20 minutes |
| [Real app pattern](./integrations/real-app-pattern.md) | App developers | Production integration (event intake) |
| [Self-host overview](./self-host.md) | Decision makers, platform teams | What you deploy, licensing, support model |
| [Getting started](./getting-started.md) | Everyone | Install → first API call in under 5 minutes |
| [Configuration](./configuration.md) | Operators | `ai-guard.yaml` reference |
| [TypeScript SDK](./sdk-typescript.md) | App developers | `createAiGuardClient`, types, errors |
| [HTTP API](./api.md) | Any stack | REST, auth, idempotency, OpenAPI |
| [Operations](./operations.md) | DevOps / SRE | Production deploy, health, backups, scaling |
| [Failure semantics](./failure-semantics.md) | SRE / engineers | Dependency failures, error contract |
| [Budget alerts runbook](./runbooks/budget-alerts.md) | On-call | Alert thresholds, inspect spend, raise caps |
| [Expensive queries](./runbooks/expensive-queries.md) | On-call | Find costly users/features |
| [Integration debugging](./runbooks/integration-debugging.md) | On-call | Host app ↔ Ai-Guard correlation |
| [Architecture](./ARCHITECTURE.md) | Engineers | Policy engine, budgets, authorization boundary |

## Quick links

- Example apps: [`event_intake_app`](../examples/event_intake_app), [`support_chat`](../examples/support_chat), [`saas_tiers`](../examples/saas_tiers), [`document_extraction`](../examples/document_extraction), [`nextjs_support_chat`](../examples/nextjs_support_chat)
- Dev config sample: [`ai-guard.yaml`](../ai-guard.yaml)
- Production policy template: [`ai-guard.production.example.yaml`](../ai-guard.production.example.yaml)
- OpenAPI (when API is running): `GET /openapi.json`
