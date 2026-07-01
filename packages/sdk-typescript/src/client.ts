import type { ChatRequest, ChatResponse, ExplainRequest, ExplainResponse } from "./types";

export interface AiGuardClientOptions {
  baseUrl: string;
  /** Sent as `Authorization: Bearer <apiKey>` when provided. */
  apiKey?: string;
  /** Injectable for tests / custom transports. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/** Base error carrying the HTTP status and the API's structured error body. */
export class AiGuardError extends Error {
  readonly status: number;
  readonly code: string;
  readonly body: unknown;
  constructor(status: number, code: string, body: unknown) {
    super(`ai-guard request failed (${status}): ${code}`);
    this.name = "AiGuardError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

/** Thrown on 403 policy_blocked / budget_exceeded. */
export class PolicyBlockedError extends AiGuardError {
  constructor(status: number, code: string, body: unknown) {
    super(status, code, body);
    this.name = "PolicyBlockedError";
  }
}

/** Thrown on 403 safety_blocked (PII or prompt injection). */
export class SafetyBlockedError extends AiGuardError {
  constructor(status: number, code: string, body: unknown) {
    super(status, code, body);
    this.name = "SafetyBlockedError";
  }
}

export interface ChatOptions {
  /**
   * Sent as the `Idempotency-Key` header. Retrying with the same key replays
   * the first result instead of re-charging budget / re-calling the model.
   */
  idempotencyKey?: string;
}

/** Terminal metadata frame emitted once a streamed completion finishes. */
export interface ChatStreamDone {
  done: true;
  model: string;
  usage: { inputTokens: number | null; outputTokens: number | null };
  requestId: string;
}

export interface AiGuardClient {
  chat(request: ChatRequest, options?: ChatOptions): Promise<ChatResponse>;
  /**
   * Stream a completion as it is generated. Yields text deltas, then a final
   * `ChatStreamDone` metadata frame. Pre-stream failures (policy/safety/budget/
   * provider) throw the same typed errors as `chat()`. Requires the feature's
   * output PII protection to be off (the server rejects otherwise).
   */
  chatStream(
    request: ChatRequest,
  ): AsyncGenerator<string, ChatStreamDone | undefined, void>;
  explain(request: ExplainRequest): Promise<ExplainResponse>;
}

export function createAiGuardClient(
  options: AiGuardClientOptions,
): AiGuardClient {
  const doFetch = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/$/, "");

  return {
    async chat(request, opts) {
      const res = await doFetch(`${baseUrl}/v1/chat`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
          ...(opts?.idempotencyKey
            ? { "idempotency-key": opts.idempotencyKey }
            : {}),
        },
        body: JSON.stringify(request),
      });

      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;

      if (!res.ok) {
        const code = errorCode(body);
        if (code === "safety_blocked") {
          throw new SafetyBlockedError(res.status, code, body);
        }
        if (code === "policy_blocked" || code === "budget_exceeded") {
          throw new PolicyBlockedError(res.status, code, body);
        }
        throw new AiGuardError(res.status, code, body);
      }

      return body as unknown as ChatResponse;
    },

    async *chatStream(request) {
      const res = await doFetch(`${baseUrl}/v1/chat`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
        },
        body: JSON.stringify({ ...request, stream: true }),
      });

      if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        const code = errorCode(body);
        if (code === "safety_blocked") throw new SafetyBlockedError(res.status, code, body);
        if (code === "policy_blocked" || code === "budget_exceeded") {
          throw new PolicyBlockedError(res.status, code, body);
        }
        throw new AiGuardError(res.status, code, body);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let done: ChatStreamDone | undefined;
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") return done;
          try {
            const parsed = JSON.parse(payload) as Record<string, unknown>;
            if (parsed.done === true) done = parsed as unknown as ChatStreamDone;
            else if (typeof parsed.delta === "string") yield parsed.delta;
          } catch {
            // ignore keep-alive / comment frames
          }
        }
      }
      return done;
    },

    async explain(request) {
      const res = await doFetch(`${baseUrl}/v1/explain`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
        },
        body: JSON.stringify(request),
      });

      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        throw new AiGuardError(res.status, errorCode(body), body);
      }

      return body as unknown as ExplainResponse;
    },
  };
}

function errorCode(body: Record<string, unknown>): string {
  if (typeof body.error === "string") return body.error;
  if (
    body.error &&
    typeof body.error === "object" &&
    "code" in body.error &&
    typeof body.error.code === "string"
  ) {
    return body.error.code;
  }
  return "error";
}
