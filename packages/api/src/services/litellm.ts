import { getModelPrice, roundUsd } from "@ai-guard/policy-engine";
import type { ChatMessage } from "../types";

// Talks to the LiteLLM proxy (OpenAI-compatible). The proxy owns provider
// credentials and returns the real cost via the `x-litellm-response-cost`
// header — that real cost reconciles the reservation after the call.

export interface LiteLLMChatParams {
  model: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  /** Per-call override of the client default timeout (e.g. a short bound for the tiny injection classifier). */
  timeoutMs?: number;
}

export interface LiteLLMChatResult {
  content: string;
  model: string;
  /** Real cost reported by LiteLLM, or computed from token usage; null if unknown. */
  actualCostUsd: number | null;
  inputTokens?: number;
  outputTokens?: number;
  raw: unknown;
}

/**
 * A provider-side failure (network error, timeout, 5xx, or 429). This is the
 * signal the orchestrator uses to re-evaluate with forceFallback and retry on
 * the fallback model. 4xx client errors do NOT use this type.
 */
export class ProviderError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ProviderError";
    this.status = status;
  }
}

/** A non-retryable client/config error from LiteLLM (4xx other than 429). */
export class LiteLLMClientError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = "LiteLLMClientError";
    this.status = status;
    this.body = body;
  }
}

export interface LiteLLMClient {
  chat(params: LiteLLMChatParams): Promise<LiteLLMChatResult>;
}

export interface LiteLLMClientOptions {
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

function extractCost(
  headers: Headers,
  json: Record<string, unknown>,
  model: string,
): number | null {
  const header = headers.get("x-litellm-response-cost");
  if (header) {
    const n = Number(header);
    // Reject NaN / Infinity / negative: a garbage cost header must not be
    // booked verbatim into the budget counter.
    if (Number.isFinite(n) && n >= 0) return n;
  }
  const hidden = (json["_hidden_params"] as Record<string, unknown> | undefined)
    ?.["response_cost"];
  if (typeof hidden === "number" && Number.isFinite(hidden) && hidden >= 0) {
    return hidden;
  }

  const usage = json["usage"] as
    | { prompt_tokens?: number; completion_tokens?: number }
    | undefined;
  if (usage) {
    const price = getModelPrice(model);
    return roundUsd(
      ((usage.prompt_tokens ?? 0) / 1000) * price.inputPer1k +
        ((usage.completion_tokens ?? 0) / 1000) * price.outputPer1k,
    );
  }
  return null;
}

export function createLiteLLMClient(
  options: LiteLLMClientOptions,
): LiteLLMClient {
  const doFetch = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const timeoutMs = options.timeoutMs ?? 60_000;

  return {
    async chat(params) {
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        params.timeoutMs ?? timeoutMs,
      );
      let res: Response;
      try {
        res = await doFetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(options.apiKey
              ? { authorization: `Bearer ${options.apiKey}` }
              : {}),
          },
          body: JSON.stringify({
            model: params.model,
            messages: params.messages,
            max_tokens: params.maxTokens,
            temperature: params.temperature,
          }),
          signal: controller.signal,
        });
      } catch (err) {
        // Network failure / abort -> provider failure (fallback-eligible).
        throw new ProviderError(
          `LiteLLM request failed for model '${params.model}'`,
          undefined,
          { cause: err },
        );
      } finally {
        clearTimeout(timer);
      }

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        if (res.status >= 500 || res.status === 429) {
          throw new ProviderError(
            `LiteLLM returned ${res.status} for model '${params.model}': ${body}`,
            res.status,
          );
        }
        throw new LiteLLMClientError(
          `LiteLLM rejected request (${res.status})`,
          res.status,
          body,
        );
      }

      const json = (await res.json()) as Record<string, unknown>;
      const choices = json["choices"] as
        | Array<{ message?: { content?: string } }>
        | undefined;
      const content = choices?.[0]?.message?.content ?? "";
      const usage = json["usage"] as
        | { prompt_tokens?: number; completion_tokens?: number }
        | undefined;

      return {
        content,
        model: (json["model"] as string) ?? params.model,
        actualCostUsd: extractCost(res.headers, json, params.model),
        inputTokens: usage?.prompt_tokens,
        outputTokens: usage?.completion_tokens,
        raw: json,
      };
    },
  };
}
