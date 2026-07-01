import type {
  AiGuardConfig,
  BudgetRemaining,
} from "@ai-guard/policy-engine";
import type { Pool } from "pg";
import type { LiteLLMClient } from "../../services/litellm";
import type { Observability } from "../../services/observability";
import type { SafetyGuard } from "../../services/safety";
import type { ChatMessage } from "../../types";
import type { BudgetAlertWebhookConfig } from "../usage/budgetAlerts";

export interface ChatServiceDeps {
  config: AiGuardConfig;
  pool: Pool;
  litellm: LiteLLMClient;
  safety: SafetyGuard;
  observability: Observability;
  budgetAlert?: BudgetAlertWebhookConfig;
  log?: {
    warn(obj: unknown, msg: string): void;
    error(obj: unknown, msg: string): void;
  };
}

export interface ChatInput {
  userId: string;
  userType: string;
  feature: string;
  modelClass?: string;
  messages: ChatMessage[];
  inputTokensEstimate?: number;
  temperature?: number;
  stream?: boolean;
  budgetNodeId?: string;
  projectId?: string;
  environment?: string;
  metadata?: Record<string, unknown>;
}

export interface ChatSuccess {
  ok: true;
  body: {
    message: { role: "assistant"; content: string };
    model: string;
    decision: "allow" | "degrade" | "fallback";
    reason?: string;
    usage: { inputTokens: number | null; outputTokens: number | null };
    cost: { estimatedUsd: number; actualUsd: number };
    budgetRemaining: BudgetRemaining;
    safety: { piiMasked: boolean; injectionBlocked: boolean };
    /** Audit log id — use with `ai-guard requests show <id>`. */
    requestId: string;
  };
}

export interface ChatFailure {
  ok: false;
  status: number;
  code: string;
  message?: string;
  details: Record<string, unknown>;
  /**
   * For 5xx results: when false, the idempotency layer caches the failure
   * instead of releasing the key. Set on failures that occur AFTER the model
   * call has run (and its cost booked), so a retry cannot re-charge for work
   * that already happened. Defaults to retryable (release) when unset.
   */
  retryable?: boolean;
  policy?: import("../../policyErrors").PolicyErrorContext;
  /** Audit log id (`req_<n>`) when a request_logs row was written. */
  auditRequestId?: string;
}

export type ChatResult = ChatSuccess | ChatFailure;
