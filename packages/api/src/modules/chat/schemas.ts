import { z } from "zod";

// Bounds on caller-supplied size. The 1 MiB body limit is the outer wall; these
// stop a request from packing thousands of messages the injection classifier
// then concatenates and forwards, amplifying cost, latency, and the 503 surface.
const MAX_MESSAGES = 64;
const MAX_CONTENT_CHARS = 100_000;
const MAX_METADATA_KEYS = 32;

export const messageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.string().max(MAX_CONTENT_CHARS),
});

export const chatBodySchema = z.object({
  userId: z.string().min(1),
  userType: z.string().min(1),
  feature: z.string().min(1),
  modelClass: z.string().optional(),
  messages: z.array(messageSchema).min(1).max(MAX_MESSAGES),
  inputTokensEstimate: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  /** Stream the completion as SSE. Requires the feature's output PII mode to be off. */
  stream: z.boolean().optional(),
  projectId: z.string().optional(),
  environment: z.string().optional(),
  metadata: z
    .record(z.string(), z.unknown())
    .refine((m) => Object.keys(m).length <= MAX_METADATA_KEYS, {
      message: `metadata may not exceed ${MAX_METADATA_KEYS} keys`,
    })
    .optional(),
});

export const chatBodyJsonSchema = {
  type: "object",
  required: ["userId", "userType", "feature", "messages"],
  additionalProperties: false,
  properties: {
    userId: { type: "string", minLength: 1 },
    userType: { type: "string", minLength: 1 },
    feature: { type: "string", minLength: 1 },
    modelClass: { type: "string" },
    messages: {
      type: "array",
      minItems: 1,
      maxItems: 64,
      items: {
        type: "object",
        required: ["role", "content"],
        additionalProperties: false,
        properties: {
          role: { type: "string", enum: ["system", "user", "assistant", "tool"] },
          content: { type: "string", maxLength: 100000 },
        },
      },
    },
    inputTokensEstimate: { type: "integer", minimum: 1 },
    temperature: { type: "number", minimum: 0, maximum: 2 },
    stream: { type: "boolean" },
    projectId: { type: "string" },
    environment: { type: "string" },
    metadata: { type: "object", additionalProperties: true, maxProperties: 32 },
  },
} as const;

export const chatSuccessJsonSchema = {
  type: "object",
  required: ["message", "model", "decision", "usage", "cost", "budgetRemaining", "safety", "requestId"],
  properties: {
    message: {
      type: "object",
      required: ["role", "content"],
      properties: {
        role: { type: "string" },
        content: { type: "string" },
      },
    },
    model: { type: "string" },
    decision: { type: "string", enum: ["allow", "degrade", "fallback"] },
    reason: { type: "string" },
    usage: {
      type: "object",
      required: ["inputTokens", "outputTokens"],
      properties: {
        inputTokens: { anyOf: [{ type: "integer" }, { type: "null" }] },
        outputTokens: { anyOf: [{ type: "integer" }, { type: "null" }] },
      },
    },
    cost: {
      type: "object",
      required: ["estimatedUsd", "actualUsd"],
      properties: {
        estimatedUsd: { type: "number" },
        actualUsd: { type: "number" },
      },
    },
    budgetRemaining: {
      type: "object",
      required: ["userDailyUsd", "featureMonthlyUsd", "globalMonthlyUsd"],
      properties: {
        userDailyUsd: { type: "number" },
        featureMonthlyUsd: { anyOf: [{ type: "number" }, { type: "null" }] },
        globalMonthlyUsd: { anyOf: [{ type: "number" }, { type: "null" }] },
      },
    },
    safety: {
      type: "object",
      required: ["piiMasked", "injectionBlocked"],
      properties: {
        piiMasked: { type: "boolean" },
        injectionBlocked: { type: "boolean" },
      },
    },
    requestId: { type: "string" },
  },
} as const;

export const errorJsonSchema = {
  type: "object",
  required: ["error"],
  properties: {
    error: {
      type: "object",
      required: ["code", "message", "details", "requestId"],
      properties: {
        code: { type: "string" },
        message: { type: "string" },
        auditRequestId: { type: "string" },
        details: { type: "object", additionalProperties: true },
        requestId: { type: "string" },
        decision: { type: "string" },
        feature: { type: "string" },
        userType: { type: "string" },
        userId: { type: "string" },
        reason: { type: "string" },
        reasonCode: { type: "string" },
        resolvedModelClass: { type: "string" },
        scope: { type: "string" },
        budgetRemaining: {
          type: "object",
          properties: {
            userDailyUsd: { type: "number" },
            featureMonthlyUsd: { anyOf: [{ type: "number" }, { type: "null" }] },
            globalMonthlyUsd: { anyOf: [{ type: "number" }, { type: "null" }] },
          },
        },
      },
      additionalProperties: true,
    },
  },
} as const;
