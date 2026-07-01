import type { FastifyInstance } from "fastify";
import {
  chatBodyJsonSchema,
  chatSuccessJsonSchema,
  errorJsonSchema,
} from "../modules/chat/schemas";
import {
  explainBodyJsonSchema,
  explainSuccessJsonSchema,
} from "../modules/explain/schemas";
import {
  requestListJsonSchema,
  requestRecordJsonSchema,
} from "../modules/requests/schemas";

export function buildOpenApiDocument() {
  return {
    openapi: "3.0.3",
    info: {
      title: "Ai-Guard API",
      version: "0.1.0",
    },
    paths: {
      "/health": {
        get: {
          tags: ["health"],
          responses: {
            200: { description: "Healthy" },
            503: { description: "Unhealthy", content: json(errorJsonSchema) },
          },
        },
      },
      "/ready": {
        get: {
          tags: ["health"],
          responses: {
            200: { description: "Ready" },
            503: { description: "Not ready", content: json(errorJsonSchema) },
          },
        },
      },
      "/v1/usage": {
        get: {
          tags: ["usage"],
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: "userId", in: "query", schema: { type: "string" } },
            { name: "feature", in: "query", schema: { type: "string" } },
            { name: "projectId", in: "query", schema: { type: "string" } },
          ],
          responses: {
            200: { description: "Usage summary" },
            401: { description: "Unauthorized", content: json(errorJsonSchema) },
            403: { description: "Forbidden", content: json(errorJsonSchema) },
          },
        },
      },
      "/v1/chat": {
        post: {
          tags: ["chat"],
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: "Idempotency-Key",
              in: "header",
              required: false,
              schema: { type: "string", maxLength: 255 },
            },
          ],
          requestBody: {
            required: true,
            content: json(chatBodyJsonSchema),
          },
          responses: {
            200: { description: "Chat completion", content: json(chatSuccessJsonSchema) },
            400: { description: "Invalid request", content: json(errorJsonSchema) },
            401: { description: "Unauthorized", content: json(errorJsonSchema) },
            403: { description: "Policy or safety block", content: json(errorJsonSchema) },
            409: { description: "Idempotency key in progress", content: json(errorJsonSchema) },
            422: { description: "Idempotency key reuse", content: json(errorJsonSchema) },
            502: { description: "Provider failure", content: json(errorJsonSchema) },
            503: { description: "Safety unavailable", content: json(errorJsonSchema) },
          },
        },
      },
      "/v1/explain": {
        post: {
          tags: ["explain"],
          description:
            "Dry-run policy evaluation without calling LiteLLM or reserving budget.",
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: json(explainBodyJsonSchema),
          },
          responses: {
            200: { description: "Policy explanation", content: json(explainSuccessJsonSchema) },
            400: { description: "Invalid request", content: json(errorJsonSchema) },
            401: { description: "Unauthorized", content: json(errorJsonSchema) },
            403: { description: "Forbidden", content: json(errorJsonSchema) },
          },
        },
      },
      "/v1/usage/summary": {
        get: {
          tags: ["usage"],
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: "feature", in: "query", schema: { type: "string" } },
            { name: "userType", in: "query", schema: { type: "string" } },
            { name: "since", in: "query", schema: { type: "string" } },
            { name: "projectId", in: "query", schema: { type: "string" } },
          ],
          responses: {
            200: { description: "Aggregated usage summary" },
            401: { description: "Unauthorized", content: json(errorJsonSchema) },
            403: { description: "Forbidden", content: json(errorJsonSchema) },
          },
        },
      },
      "/v1/requests": {
        get: {
          tags: ["requests"],
          description: "List request audit records (metadata only).",
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: "userId", in: "query", schema: { type: "string" } },
            { name: "feature", in: "query", schema: { type: "string" } },
            { name: "userType", in: "query", schema: { type: "string" } },
            { name: "status", in: "query", schema: { type: "string" } },
            { name: "reasonCode", in: "query", schema: { type: "string" } },
            { name: "since", in: "query", schema: { type: "string" } },
            { name: "limit", in: "query", schema: { type: "integer" } },
          ],
          responses: {
            200: { description: "Request list", content: json(requestListJsonSchema) },
            401: { description: "Unauthorized", content: json(errorJsonSchema) },
            403: { description: "Forbidden", content: json(errorJsonSchema) },
          },
        },
      },
      "/v1/requests/{id}": {
        get: {
          tags: ["requests"],
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: {
            200: { description: "Request record", content: json(requestRecordJsonSchema) },
            401: { description: "Unauthorized", content: json(errorJsonSchema) },
            403: { description: "Forbidden", content: json(errorJsonSchema) },
            404: { description: "Not found", content: json(errorJsonSchema) },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
        },
      },
    },
  };
}

export function registerOpenApi(app: FastifyInstance): void {
  app.get("/openapi.json", async () => buildOpenApiDocument());
}

function json(schema: unknown) {
  return {
    "application/json": { schema },
  };
}
