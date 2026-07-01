import type {
  FeatureName,
  ModelClassName,
  UserTypeName,
} from "./generated/config-types";

export type { FeatureName, ModelClassName, UserTypeName };

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool" | (string & {});
  content: string;
}

/**
 * A chat request. `feature` and `userType` are REQUIRED — omitting either is a
 * compile-time error, which is how Ai-Guard enforces "every call declares its
 * feature" at the SDK boundary (the API also rejects it at runtime).
 *
 * `FeatureName`, `UserTypeName`, and `ModelClassName` are generated from
 * `ai-guard.yaml` via `pnpm generate-sdk-types`.
 */
export interface ChatRequest {
  userId: string;
  userType: UserTypeName;
  feature: FeatureName;
  messages: ChatMessage[];
  modelClass?: ModelClassName;
  inputTokensEstimate?: number;
  temperature?: number;
  projectId?: string;
  environment?: string;
  metadata?: Record<string, unknown>;
}

export interface BudgetRemaining {
  userDailyUsd: number;
  featureMonthlyUsd: number | null;
  /** null when no global monthly cap is configured (monthly_usd: 0). */
  globalMonthlyUsd: number | null;
  /** Token headroom; present when a token cap is configured, null otherwise. */
  userDailyTokens?: number | null;
  featureMonthlyTokens?: number | null;
  globalMonthlyTokens?: number | null;
}

export interface ChatResponse {
  message: { role: string; content: string };
  model: string;
  /** Provider of the model that ran, e.g. "openai", "openrouter", "azure", "ollama". */
  provider: string;
  decision: "allow" | "degrade" | "fallback";
  reason?: string;
  usage: { inputTokens: number | null; outputTokens: number | null };
  cost: { estimatedUsd: number; actualUsd: number };
  budgetRemaining: BudgetRemaining;
  safety: { piiMasked: boolean; injectionBlocked: boolean };
  /** Audit log id for `ai-guard requests show`. */
  requestId: string;
}

export interface ExplainRequest {
  userId: string;
  userType: UserTypeName;
  feature: FeatureName;
  modelClass?: ModelClassName;
  inputTokensEstimate?: number;
  projectId?: string;
  environment?: string;
}

export interface ExplainResponse {
  decision: "allow" | "block" | "degrade" | "fallback";
  reason?: string;
  requested: {
    userId: string;
    userType: string;
    feature: string;
    modelClass: string;
  };
  resolved: {
    modelClass: string;
    model: string;
    provider: string;
    fallbackModel?: string;
  };
  safety: {
    preset: string;
    pii: string;
    promptInjection: string;
    maxOutputTokens: number;
  };
  cost: { estimatedUsd: number };
  budget: {
    remaining: BudgetRemaining;
    used: {
      userDailyUsd: number;
      userDailyRequests: number;
      featureMonthlyUsd: number;
      globalMonthlyUsd: number;
    };
    permittedModels: string[];
    dailyRequestLimit: number;
    dailyRequestsRemaining: number;
  };
  wouldCallModel: boolean;
  summary: string;
}
