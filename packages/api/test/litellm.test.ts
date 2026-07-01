import { describe, expect, it } from "vitest";
import {
  createLiteLLMClient,
  LiteLLMClientError,
  ProviderError,
} from "../src/services/litellm";

function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

const completion = {
  model: "openai/gpt-4o-mini",
  choices: [{ message: { content: "hi there" } }],
  usage: { prompt_tokens: 10, completion_tokens: 20 },
};

describe("LiteLLM client", () => {
  it("returns content + actual cost from the response header", async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse(completion, { headers: { "x-litellm-response-cost": "0.0123" } });
    const client = createLiteLLMClient({ baseUrl: "http://x", fetchImpl });

    const r = await client.chat({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "hello" }],
    });
    expect(r.content).toBe("hi there");
    expect(r.actualCostUsd).toBeCloseTo(0.0123, 6);
    expect(r.inputTokens).toBe(10);
    expect(r.outputTokens).toBe(20);
  });

  it("computes cost from token usage when no header is present", async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse({
        model: "openai/gpt-4o-mini",
        choices: [{ message: { content: "hi" } }],
        usage: { prompt_tokens: 1000, completion_tokens: 1000 },
      });
    const client = createLiteLLMClient({ baseUrl: "http://x", fetchImpl });
    const r = await client.chat({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "hello" }],
    });
    // 1000/1k * 0.00015 + 1000/1k * 0.0006 = 0.00075
    expect(r.actualCostUsd).toBeCloseTo(0.00075, 9);
  });

  it("uses custom price overrides for the token-usage cost fallback", async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse({
        model: "openrouter/exotic",
        choices: [{ message: { content: "hi" } }],
        usage: { prompt_tokens: 1000, completion_tokens: 1000 },
      });
    const client = createLiteLLMClient({
      baseUrl: "http://x",
      fetchImpl,
      priceOverrides: { "openrouter/exotic": { inputPer1k: 2, outputPer1k: 4 } },
    });
    const r = await client.chat({ model: "openrouter/exotic", messages: [{ role: "user", content: "x" }] });
    // 1000/1k*2 + 1000/1k*4 = 6
    expect(r.actualCostUsd).toBeCloseTo(6, 6);
  });

  it("throws ProviderError on 5xx (fallback-eligible)", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("upstream down", { status: 503 });
    const client = createLiteLLMClient({ baseUrl: "http://x", fetchImpl });
    await expect(
      client.chat({ model: "m", messages: [{ role: "user", content: "x" }] }),
    ).rejects.toBeInstanceOf(ProviderError);
  });

  it("throws ProviderError when fetch itself fails", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    const client = createLiteLLMClient({ baseUrl: "http://x", fetchImpl });
    await expect(
      client.chat({ model: "m", messages: [{ role: "user", content: "x" }] }),
    ).rejects.toBeInstanceOf(ProviderError);
  });

  it("throws LiteLLMClientError on 4xx (not fallback-eligible)", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("bad model", { status: 400 });
    const client = createLiteLLMClient({ baseUrl: "http://x", fetchImpl });
    await expect(
      client.chat({ model: "m", messages: [{ role: "user", content: "x" }] }),
    ).rejects.toBeInstanceOf(LiteLLMClientError);
  });
});
