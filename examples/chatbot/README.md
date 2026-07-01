# Ai-Guard Chatbot Demo

A small chatbot that proves the whole project in usage: **every message goes
through Ai-Guard before the model runs**, and the UI shows what Ai-Guard decided
for each reply — model, decision (allow/degrade/fallback), tokens in/out, cost,
and the daily budget/token headroom left. Blocks (over budget, over **token
limit**, wrong tier, safety) render as visible bubbles.

It runs fully locally against **Ollama** — no cloud API key. LiteLLM maps the
"cloud" model names in `ai-guard.yaml` (`openai/gpt-4o-mini`, …) to local Ollama
models, so Ai-Guard behaves exactly as it would against a real provider (cost
estimates use the real price table; execution is local).

## Run it (two commands)

**1. Start the gateway** (Postgres + LiteLLM→Ollama + Ai-Guard API):

```bash
ollama pull llama3.2:1b && ollama pull llama3.2:3b   # once
cd examples/chatbot
docker compose up --build            # gateway on http://localhost:3000
```

**2. Start the chatbot UI:**

```bash
cd examples/chatbot
cp .env.example .env
npm install
npm run dev                          # http://localhost:3002
```

(If you already run a gateway another way — e.g. `npx create-ai-guard` or
`make up-local` — just point `.env`'s `AI_GUARD_URL`/`AI_GUARD_API_KEY` at it and
skip step 1. The gateway must load this folder's `ai-guard.yaml`.)

## Prove it — a 60-second tour

1. **Chat as `anonymous`.** You get real replies from the local model. Each reply
   shows a receipt: `allow · openai/gpt-4o-mini · 31→18 tok · $0.00003 · req_…`.
2. **Send a second message.** `anonymous` hits its **token cap**
   (`daily_tokens: 720`, ~700 estimated per message) → a red bubble: *"Daily
   token limit reached for this tier."* That's Ai-Guard stopping spend **before**
   the model call.
3. **Pick the `notes_helper` feature while still `anonymous`.** It requires the
   `standard` model class, which `anonymous` isn't allowed → *"This tier isn't
   allowed to use that model class."* (`model_class_not_permitted`).
4. **Switch the tier to `logged_in`.** Higher caps + `standard` access — messages
   flow again, and the budget bar shows more headroom.
5. **Watch the budget bar** update after every reply (remaining USD + tokens).

## What this demonstrates

- The boundary: the app owns the user/tier; Ai-Guard owns the AI-call policy.
- **Cost *and* token** budgets, enforced per tier, per feature, globally.
- Model-class access control by tier, and degrade/fallback (visible in the badge).
- Per-request audit id (`requestId`) surfaced to the client.

### Optional: see safety blocking

Set `support_chat`'s `safety: strict` in `ai-guard.yaml` and run the gateway with
Presidio (see the repo's `make up` / operations docs). Then a message containing
an email or SSN is blocked with a `safety_blocked` bubble.
