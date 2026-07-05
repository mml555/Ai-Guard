import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isInsecureRemoteUrl } from "../src/api/insecureRemote";

// The api client runs in a browser; give it just the globals it touches so
// these tests stay dependency-free (no DOM environment package).
const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  vi.stubGlobal("sessionStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  });
  vi.stubGlobal("window", { location: { href: "" } });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function client() {
  return await import("../src/api/client");
}

describe("api client", () => {
  it("persists the login-chosen base URL so one build serves any deployment", async () => {
    const { setBase, apiBase } = await client();
    setBase("https://gateway.example.com/");
    expect(apiBase()).toBe("https://gateway.example.com");
  });

  it("apiFetch targets the persisted base and sends the bearer token", async () => {
    const { setBase, setToken, apiFetch } = await client();
    setBase("https://gw.example.com");
    setToken("tok_123");
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ hello: "world" }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await apiFetch<{ hello: string }>("/v1/usage/summary");
    expect(res.hello).toBe("world");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://gw.example.com/v1/usage/summary");
    expect((init!.headers as Headers).get("authorization")).toBe("Bearer tok_123");
  });

  it("clears the token and redirects to /login on 401", async () => {
    const { setToken, getToken, apiFetch } = await client();
    setToken("tok_expired");
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 401 })));

    await expect(apiFetch("/v1/admin/keys")).rejects.toThrow("Unauthorized");
    expect(getToken()).toBeNull();
    expect((window as unknown as { location: { href: string } }).location.href).toBe("/login");
  });

  it("surfaces the response body as the error message on non-401 failures", async () => {
    const { apiFetch } = await client();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 403, text: async () => "nope" })),
    );
    await expect(apiFetch("/v1/admin/keys")).rejects.toThrow("nope");
  });
});

describe("insecure-remote login warning", () => {
  it("flags plain http to a remote host, allows https and local http", () => {
    expect(isInsecureRemoteUrl("http://gateway.example.com")).toBe(true);
    expect(isInsecureRemoteUrl("https://gateway.example.com")).toBe(false);
    expect(isInsecureRemoteUrl("http://127.0.0.1:3000")).toBe(false);
    expect(isInsecureRemoteUrl("http://localhost:3090")).toBe(false);
    expect(isInsecureRemoteUrl("http://192.168.1.50:3000")).toBe(false);
    expect(isInsecureRemoteUrl("http://10.0.0.2")).toBe(false);
  });

  it("does not treat a remote host that merely starts with a private token as local", () => {
    // Prefix matching (the old bug) classified these as local and suppressed the
    // cleartext-token warning even though the token goes to a remote attacker host.
    expect(isInsecureRemoteUrl("http://127.evil.com/login")).toBe(true);
    expect(isInsecureRemoteUrl("http://localhost.evil.com/")).toBe(true);
    expect(isInsecureRemoteUrl("http://10.evil.com/")).toBe(true);
    expect(isInsecureRemoteUrl("http://192.168.evil.com/")).toBe(true);
    // Genuine private hosts stay unflagged.
    expect(isInsecureRemoteUrl("http://172.16.0.9/")).toBe(false);
    expect(isInsecureRemoteUrl("http://100.64.0.1/")).toBe(false);
  });
});
