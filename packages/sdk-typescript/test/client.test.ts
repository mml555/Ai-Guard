import { describe, expect, it } from "vitest";
import {
  createAiGuardClient,
  PolicyBlockedError,
  SafetyBlockedError,
} from "../src/client";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const baseRequest = {
  userId: "u1",
  userType: "logged_in" as const,
  feature: "support_chat" as const,
  messages: [{ role: "user", content: "hi" }],
};

describe("createAiGuardClient", () => {
  it("posts to /v1/chat and returns the parsed response", async () => {
    let capturedUrl = "";
    let capturedBody: unknown;
    const fetchImpl: typeof fetch = async (url, init) => {
      capturedUrl = String(url);
      capturedBody = JSON.parse(String(init?.body));
      return jsonResponse({
        message: { role: "assistant", content: "hello" },
        model: "openai/gpt-4o-mini",
        decision: "allow",
      });
    };
    const client = createAiGuardClient({ baseUrl: "http://api/", fetchImpl });
    const res = await client.chat(baseRequest);

    expect(capturedUrl).toBe("http://api/v1/chat");
    expect(capturedBody).toMatchObject({ feature: "support_chat" });
    expect(res.model).toBe("openai/gpt-4o-mini");
  });

  it("throws PolicyBlockedError on a 403 policy_blocked", async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse(
        {
          error: {
            code: "policy_blocked",
            message: "Policy blocked",
            details: { reason: "over budget" },
            requestId: "req_1",
          },
        },
        403,
      );
    const client = createAiGuardClient({ baseUrl: "http://api", fetchImpl });
    await expect(client.chat(baseRequest)).rejects.toBeInstanceOf(PolicyBlockedError);
  });

  it("throws SafetyBlockedError on a 403 safety_blocked", async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse(
        {
          error: {
            code: "safety_blocked",
            message: "Safety blocked",
            details: { reason: "prompt_injection" },
            requestId: "req_1",
          },
        },
        403,
      );
    const client = createAiGuardClient({ baseUrl: "http://api", fetchImpl });
    await expect(client.chat(baseRequest)).rejects.toBeInstanceOf(SafetyBlockedError);
  });

  it("sends the Authorization header when an apiKey is set", async () => {
    let auth: string | null = null;
    const fetchImpl: typeof fetch = async (_url, init) => {
      auth = new Headers(init?.headers).get("authorization");
      return jsonResponse({ message: { role: "assistant", content: "x" } });
    };
    const client = createAiGuardClient({ baseUrl: "http://api", apiKey: "secret", fetchImpl });
    await client.chat(baseRequest);
    expect(auth).toBe("Bearer secret");
  });

  it("posts to /v1/explain and returns the parsed response", async () => {
    let capturedUrl = "";
    const fetchImpl: typeof fetch = async (url) => {
      capturedUrl = String(url);
      return jsonResponse({
        decision: "block",
        summary: "Decision: block",
        wouldCallModel: false,
      });
    };
    const client = createAiGuardClient({ baseUrl: "http://api/", fetchImpl });
    const res = await client.explain({
      userId: "u1",
      userType: "logged_in",
      feature: "support_chat",
      modelClass: "premium",
    });

    expect(capturedUrl).toBe("http://api/v1/explain");
    expect(res.decision).toBe("block");
  });
});
