import type { AiGuardConfig } from "@ai-guard/policy-engine";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { sendError } from "../../errors";
import type { RequestContext } from "../../plugins/requestContext";
import type { LiteLLMClient } from "../../services/litellm";
import type { Observability } from "../../services/observability";
import type { SafetyGuard } from "../../services/safety";
import type { BudgetAlertWebhookConfig } from "../usage/budgetAlerts";
import { requestHash, withIdempotency } from "../idempotency/service";
import { chatBodyJsonSchema, chatBodySchema, chatSuccessJsonSchema, errorJsonSchema } from "./schemas";
import { handleChat } from "./service";
import type { ChatInput, ChatResult } from "./types";

export interface ChatRouteDeps {
  config: AiGuardConfig;
  pool: Pool;
  litellm: LiteLLMClient;
  safety: SafetyGuard;
  observability: Observability;
  budgetAlert?: BudgetAlertWebhookConfig;
  /** When false, idempotency replays omit model completion text at rest. */
  idempotencyCaptureContent?: boolean;
}

export function registerChatRoute(
  app: FastifyInstance,
  deps: ChatRouteDeps,
): void {
  app.post("/v1/chat", {
    schema: {
      tags: ["chat"],
      body: chatBodyJsonSchema,
      response: {
        200: chatSuccessJsonSchema,
        400: errorJsonSchema,
        401: errorJsonSchema,
        403: errorJsonSchema,
        409: errorJsonSchema,
        422: errorJsonSchema,
        502: errorJsonSchema,
        503: errorJsonSchema,
      },
    },
  }, async (request, reply) => {
    const parsed = chatBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(
        reply,
        400,
        "invalid_request",
        {
          detail: parsed.error.issues
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("; "),
        },
      );
    }

    const auth = authorizeChatInput(request.ctx, parsed.data as ChatInput);
    if (!auth.ok) {
      return sendError(reply, auth.status, auth.code, auth.details, auth.message);
    }
    const input = auth.value;
    const run = (): Promise<ChatResult> =>
      handleChat({ ...deps, log: request.log }, input);

    let result: ChatResult;
    const rawKey = request.headers["idempotency-key"];
    const idempotencyKey = readIdempotencyKey(rawKey);
    if (idempotencyKey) {
      const outcome = await withIdempotency(
        deps.pool,
        {
          key: idempotencyKey,
          userId: input.userId,
          hash: requestHash(input),
          captureContent: deps.idempotencyCaptureContent ?? false,
        },
        run,
      );
      result = outcome.result;
      reply.header("x-idempotent-replay", outcome.replayed ? "true" : "false");
    } else {
      result = await run();
    }

    if (!result.ok) {
      if (result.auditRequestId) {
        reply.header("x-ai-guard-request-id", result.auditRequestId);
      }
      return sendError(
        reply,
        result.status,
        result.code,
        result.details,
        result.message,
        {
          ...(result.policy ? { policy: result.policy } : {}),
          ...(result.auditRequestId ? { auditRequestId: result.auditRequestId } : {}),
        },
      );
    }

    if (result.body.requestId) {
      reply.header("x-ai-guard-request-id", result.body.requestId);
    }
    return reply.code(200).send(result.body);
  });
}

function authorizeChatInput(
  ctx: RequestContext,
  body: ChatInput,
): { ok: true; value: ChatInput } | {
  ok: false;
  status: number;
  code: string;
  message: string;
  details: Record<string, unknown>;
} {
  if (ctx.apiKeyName && !ctx.permissions?.includes("chat:create")) {
    return deny(403, "forbidden", "API key is not permitted to create chats");
  }
  if (ctx.projectId && body.projectId && body.projectId !== ctx.projectId) {
    return deny(403, "project_mismatch", "API key is not permitted for this project");
  }
  if (ctx.environment && body.environment && body.environment !== ctx.environment) {
    return deny(403, "environment_mismatch", "API key is not permitted for this environment");
  }
  if (ctx.allowedUserTypes?.length && !ctx.allowedUserTypes.includes(body.userType)) {
    return deny(403, "user_type_forbidden", "API key is not permitted for this user type");
  }
  if (ctx.allowedUserIds?.length && !ctx.allowedUserIds.includes(body.userId)) {
    return deny(403, "user_forbidden", "API key is not permitted for this user");
  }

  return {
    ok: true,
    value: {
      ...body,
      projectId: ctx.projectId ?? body.projectId,
      environment: ctx.environment ?? body.environment,
    },
  };
}

function deny(status: number, code: string, message: string) {
  return { ok: false as const, status, code, message, details: {} };
}

function readIdempotencyKey(header: string | string[] | undefined): string | null {
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 255) return null;
  return trimmed;
}
