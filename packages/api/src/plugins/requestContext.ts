import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";

const MAX_REQUEST_ID_LENGTH = 128;

export interface RequestContext {
  readonly requestId: string;
  readonly apiKeyName?: string;
  readonly projectId?: string;
  readonly environment?: string;
  readonly allowedUserTypes?: readonly string[];
  readonly allowedUserIds?: readonly string[];
  readonly permissions?: readonly string[];
  readonly userId?: string;
  readonly orgId?: string;
}

declare module "fastify" {
  interface FastifyRequest {
    ctx: RequestContext;
  }
}

export function registerRequestContext(app: FastifyInstance): void {
  app.addHook("onRequest", async (request) => {
    const requestIdHeader = request.headers["x-request-id"];
    const requestId =
      typeof requestIdHeader === "string" &&
      requestIdHeader.trim() &&
      requestIdHeader.length <= MAX_REQUEST_ID_LENGTH
        ? requestIdHeader.trim()
        : randomUUID();

    Object.defineProperty(request, "ctx", {
      value: Object.freeze({ requestId }),
      enumerable: true,
      configurable: true,
      writable: false,
    });
  });
}

export function setRequestContext(
  request: { ctx: RequestContext },
  patch: Omit<Partial<RequestContext>, "requestId">,
): void {
  Object.defineProperty(request, "ctx", {
    value: Object.freeze({ ...request.ctx, ...patch }),
    enumerable: true,
    configurable: true,
    writable: false,
  });
}
