import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { sendError } from "../errors";
import { setRequestContext } from "./requestContext";

const BEARER_PREFIX = "Bearer ";

export interface ApiKeyPrincipal {
  name: string;
  /** Plaintext key (dev / simple mode). Prefer `keyHash` in production. */
  key?: string;
  /** Lowercase SHA-256 hex of the key; lets operators store hashes, not secrets. */
  keyHash?: string;
  /** ISO-8601 instant after which this key is rejected (rotation / expiry). */
  expiresAt?: string;
  projectId?: string;
  environment?: string;
  allowedUserTypes?: readonly string[];
  allowedUserIds?: readonly string[];
  permissions?: readonly string[];
}

export function registerAuth(
  app: FastifyInstance,
  principals: readonly ApiKeyPrincipal[],
  options?: { metricsAuthToken?: string },
): void {
  app.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?", 1)[0];
    if (path === "/health" || path === "/ready") return;

    if (path === "/metrics") {
      const token = options?.metricsAuthToken;
      if (!token) return;
      const authorization = request.headers.authorization;
      const presented =
        typeof authorization === "string" && authorization.startsWith(BEARER_PREFIX)
          ? authorization.slice(BEARER_PREFIX.length)
          : "";
      if (!constantTimeEquals(presented, token)) {
        return sendError(
          reply,
          401,
          "unauthorized",
          {},
          "Missing or invalid metrics token",
        );
      }
      return;
    }

    const authorization = request.headers.authorization;
    const token =
      typeof authorization === "string" && authorization.startsWith(BEARER_PREFIX)
        ? authorization.slice(BEARER_PREFIX.length)
        : "";

    const principal = findPrincipal(token, principals);
    if (!principal) {
      return sendError(
        reply,
        401,
        "unauthorized",
        {},
        "Missing or invalid API key",
      );
    }

    setRequestContext(request, {
      apiKeyName: principal.name,
      projectId: principal.projectId,
      environment: principal.environment,
      allowedUserTypes: principal.allowedUserTypes,
      allowedUserIds: principal.allowedUserIds,
      permissions: principal.permissions ?? ["chat:create"],
    });
  });
}

function findPrincipal(
  candidate: string,
  principals: readonly ApiKeyPrincipal[],
): ApiKeyPrincipal | null {
  const now = Date.now();
  for (const principal of principals) {
    if (matchesPrincipal(candidate, principal, now)) return principal;
  }
  return null;
}

function matchesPrincipal(
  candidate: string,
  principal: ApiKeyPrincipal,
  now: number,
): boolean {
  if (principal.expiresAt) {
    const expiry = Date.parse(principal.expiresAt);
    if (Number.isFinite(expiry) && now > expiry) return false;
  }
  // Prefer hash comparison so operators can store SHA-256 hashes, not raw keys.
  if (principal.keyHash) {
    const candidateHash = createHash("sha256").update(candidate).digest();
    const expected = Buffer.from(principal.keyHash, "hex");
    return (
      candidateHash.length === expected.length &&
      timingSafeEqual(candidateHash, expected)
    );
  }
  if (principal.key) {
    return constantTimeEquals(candidate, principal.key);
  }
  return false;
}

function constantTimeEquals(candidate: string, expected: string): boolean {
  const candidateBuffer = Buffer.from(candidate);
  const expectedBuffer = Buffer.from(expected);
  return (
    candidateBuffer.length === expectedBuffer.length &&
    timingSafeEqual(candidateBuffer, expectedBuffer)
  );
}
