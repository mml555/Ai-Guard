import { getModelPrice, roundUsd } from "@ai-guard/policy-engine";
import type { ChatMessage } from "../types";

interface ModelPrice {
  inputPer1k: number;
  outputPer1k: number;
}

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

/** Terminal value of a streamed completion (returned by the chatStream generator). */
export interface LiteLLMStreamFinal {
  model: string;
  actualCostUsd: number | null;
  inputTokens?: number;
  outputTokens?: number;
}

export interface LiteLLMStreamParams extends LiteLLMChatParams {
  /** Aborts the upstream request (e.g. on client disconnect). */
  signal?: AbortSignal;
}

export interface LiteLLMClient {
  chat(params: LiteLLMChatParams): Promise<LiteLLMChatResult>;
  /**
   * Stream a completion. Yields text deltas as they arrive and RETURNS the
   * terminal usage/cost. Throws ProviderError before the first delta on a
   * connection/5xx failure (fallback-eligible by the caller); an error after
   * streaming has begun propagates from the generator (no mid-stream fallback).
   */
  chatStream?(
    params: LiteLLMStreamParams,
  ): AsyncGenerator<{ delta: string }, LiteLLMStreamFinal, void>;
}

export interface LiteLLMClientOptions {
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Custom per-model prices (from ai-guard.yaml `pricing:`) for the cost fallback. */
  priceOverrides?: Record<string, ModelPrice>;
}

function extractCost(
  headers: Headers,
  json: Record<string, unknown>,
  model: string,
  priceOverrides?: Record<string, ModelPrice>,
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
    const price = getModelPrice(model, priceOverrides);
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
        actualCostUsd: extractCost(res.headers, json, params.model, options.priceOverrides),
        inputTokens: usage?.prompt_tokens,
        outputTokens: usage?.completion_tokens,
        raw: json,
      };
    },

    async *chatStream(params) {
      let res: Response;
      try {
        res = await doFetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "text/event-stream",
            ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
          },
          body: JSON.stringify({
            model: params.model,
            messages: params.messages,
            max_tokens: params.maxTokens,
            temperature: params.temperature,
            stream: true,
            // Ask LiteLLM to emit a final usage chunk so we can settle cost.
            stream_options: { include_usage: true },
          }),
          signal: params.signal,
        });
      } catch (err) {
        throw new ProviderError(
          `LiteLLM stream request failed for model '${params.model}'`,
          undefined,
          { cause: err },
        );
      }

      if (!res.ok || !res.body) {
        const body = await res.text().catch(() => "");
        if (!res.ok && (res.status >= 500 || res.status === 429)) {
          throw new ProviderError(
            `LiteLLM returned ${res.status} for model '${params.model}': ${body}`,
            res.status,
          );
        }
        throw new LiteLLMClientError(
          `LiteLLM rejected stream request (${res.status})`,
          res.status || 502,
          body,
        );
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let model = params.model;
      let inputTokens: number | undefined;
      let outputTokens: number | undefined;

      // Parse an OpenAI-style SSE stream: lines of `data: {json}` terminated by
      // `data: [DONE]`, chunks separated by blank lines.
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") break;
          let chunk: Record<string, unknown>;
          try {
            chunk = JSON.parse(payload);
          } catch {
            continue; // skip malformed keep-alive/comment frames
          }
          if (typeof chunk["model"] === "string") model = chunk["model"] as string;
          const chunkUsage = chunk["usage"] as
            | { prompt_tokens?: number; completion_tokens?: number }
            | null
            | undefined;
          if (chunkUsage) {
            inputTokens = chunkUsage.prompt_tokens ?? inputTokens;
            outputTokens = chunkUsage.completion_tokens ?? outputTokens;
          }
          const choices = chunk["choices"] as
            | Array<{ delta?: { content?: string } }>
            | undefined;
          const delta = choices?.[0]?.delta?.content;
          if (delta) yield { delta };
        }
      }

      const actualCostUsd =
        inputTokens != null || outputTokens != null
          ? (() => {
              const price = getModelPrice(model, options.priceOverrides);
              return roundUsd(
                ((inputTokens ?? 0) / 1000) * price.inputPer1k +
                  ((outputTokens ?? 0) / 1000) * price.outputPer1k,
              );
            })()
          : null;

      return { model, actualCostUsd, inputTokens, outputTokens };
    },
  };
}
