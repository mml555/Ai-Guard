# Ai-Guard

**Self-hosted AI policy gateway** — one config file for AI budgets, model access,
safety rules, routing, and usage logs.

AI features can silently burn money, leak sensitive data, and call the wrong
model. Ai-Guard sits between your app and your model provider. Every request must
declare a **user**, **user type**, and **feature**. Policy is checked **before**
the model call happens.

> Your app decides: *is this user allowed to ask?*
> Ai-Guard decides: *is this AI request allowed to run?*

## Quick start

```bash
make setup       # creates .env if needed, starts the stack, waits, smoke-tests
```

Call Ai-Guard from your app:

```ts
import { createAiGuardClient } from "@ai-guard/sdk";

const ai = createAiGuardClient({
  baseUrl: process.env.AI_GUARD_URL!,
  apiKey: process.env.AI_GUARD_API_KEY!,
});

const res = await ai.chat({
  userId: "user_123",
  userType: "logged_in",
  feature: "support_chat",
  modelClass: "cheap",
  messages: [{ role: "user", content: "Help me reset my password" }],
});
```

Policy lives in `ai-guard.yaml`:

```yaml
features:
  support_chat:
    safety: strict
    model_class: cheap
    max_tokens: 500

budgets:
  by_user_type:
    logged_in:
      daily_usd: 0.25
      daily_requests: 50
      models: ["cheap", "standard"]
```

Debug a decision without spending:

```bash
pnpm ai-guard explain --local \
  --userType logged_in --feature support_chat --modelClass premium

# Validate production config
pnpm ai-guard validate --config ai-guard.yaml --production

# Run policy regression tests
pnpm ai-guard test-policy --file ai-guard.policy-tests.yaml
```

## What you get

| Capability | How |
| --- | --- |
| Per-user / per-feature budgets | Postgres reservations with row locks |
| Model class routing | Primary, fallback, budget-aware degrade |
| Safety | PII mask/block + prompt injection (Presidio) |
| Usage audit trail | Every request logged with cost and decision |
| Typed SDK | `feature` / `userType` unions generated from your YAML |

Every request is checked before it reaches OpenAI, Anthropic, Gemini, Bedrock,
or any LiteLLM-supported provider.

## Examples

| Example | What it shows |
| --- | --- |
| [`support_chat`](./examples/support_chat) | Chat, PII masking, injection block, daily budget |
| [`saas_tiers`](./examples/saas_tiers) | Free vs paid model access |
| [`event_intake_app`](./examples/event_intake_app) | Jewgo-style flyer extraction — real integration pattern |
| [`nextjs_support_chat`](./examples/nextjs_support_chat) | Next.js API route — app auth → Ai-Guard SDK |

```bash
make setup
AI_GUARD_API_KEY=sk-ai-guard-api-local \
  pnpm --filter support-chat-example start "How do I reset my password?"
```

## Packages

| Package | Role |
| --- | --- |
| `@ai-guard/policy-engine` | Pure `evaluateAiRequest()` — no I/O |
| `@ai-guard/api` | Fastify API: budgets, LiteLLM, safety |
| `@ai-guard/sdk` | Typed HTTP client |
| `@ai-guard/cli` | Setup, ops, config validation, and policy dry-runs |
| `create-ai-guard` | Scaffold wizard |

## Deploy modes

| Command | Stack |
| --- | --- |
| `make setup` | First-run setup + readiness wait + smoke test |
| `make up` | API + LiteLLM + Postgres + Presidio |
| `make up-full` | + Langfuse observability |
| `make up-local` | Ollama only — no cloud keys |
| `make up-prod` | Production compose |
| `make status` | Containers plus `/health` and `/ready` |
| `make doctor` | Local prerequisites and runtime health |

## Documentation

| Doc | Audience |
| --- | --- |
| [**Docs index**](./docs/README.md) | Everyone |
| [Mental model](./docs/mental-model.md) | Who owns what (start here) |
| [Integration checklist](./docs/integration-checklist.md) | Add to an existing app in ~20 min |
| [Real app pattern](./docs/integrations/real-app-pattern.md) | Embed in a product workflow (event intake) |
| [Getting started](./docs/getting-started.md) | First deploy + first API call |
| [Configuration](./docs/configuration.md) | `ai-guard.yaml` reference |
| [HTTP API](./docs/api.md) | REST, auth, explain, idempotency |
| [Operations](./docs/operations.md) | Production, health, backups |
| [Architecture](./docs/ARCHITECTURE.md) | Engine design, budgets |

## Develop & test

```bash
pnpm install && pnpm build
pnpm test                 # unit tests
make test-db              # + Postgres integration tests
```

## License

MIT — see [LICENSE](./LICENSE). Security: [SECURITY.md](./SECURITY.md).
