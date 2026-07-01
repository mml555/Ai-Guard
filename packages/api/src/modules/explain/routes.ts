import type { AiGuardConfig } from "@ai-guard/policy-engine";
import { PolicyConfigError } from "@ai-guard/policy-engine";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { sendError } from "../../errors";
import type { RequestContext } from "../../plugins/requestContext";
import { errorJsonSchema } from "../chat/schemas";
import {
  explainBodyJsonSchema,
  explainBodySchema,
  explainSuccessJsonSchema,
} from "./schemas";
import { handleExplain } from "./service";
import type { ExplainInput } from "./types";

export interface ExplainRouteDeps {
  config: AiGuardConfig;
  pool: Pool;
}

export function registerExplainRoute(
  app: FastifyInstance,
  deps: ExplainRouteDeps,
): void {
  app.post("/v1/explain", {
    schema: {
      tags: ["explain"],
      description:
        "Dry-run policy evaluation. Returns the decision, resolved model, safety plan, " +
        "and budget snapshot without calling LiteLLM or reserving budget.",
      body: explainBodyJsonSchema,
      response: {
        200: explainSuccessJsonSchema,
        400: errorJsonSchema,
        401: errorJsonSchema,
        403: errorJsonSchema,
      },
    },
  }, async (request, reply) => {
    const parsed = explainBodySchema.safeParse(request.body);
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

    const auth = authorizeExplainInput(request.ctx, parsed.data);
    if (!auth.ok) {
      return sendError(reply, auth.status, auth.code, auth.details, auth.message);
    }

    const result = await handleExplain(deps.config, deps.pool, auth.value);
    if (result instanceof PolicyConfigError) {
      return sendError(reply, 400, result.code, { detail: result.message }, result.message);
    }

    return reply.send(result);
  });
}

function authorizeExplainInput(
  ctx: RequestContext,
  body: ExplainInput,
): { ok: true; value: ExplainInput } | {
  ok: false;
  status: number;
  code: string;
  message: string;
  details: Record<string, unknown>;
} {
  const perms = ctx.permissions ?? ["chat:create"];
  if (ctx.apiKeyName && !perms.includes("chat:create") && !perms.includes("policy:explain")) {
    return deny(403, "forbidden", "API key is not permitted to explain policy");
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
