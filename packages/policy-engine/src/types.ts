// ── Core type contracts shared across Ai-Guard ──────────────────────────────
// These describe the parsed `ai-guard.yaml` (camelCase) plus the pure
// evaluator's input/output. The Policy Engine performs NO I/O; everything it
// needs is passed in via EvaluateInput.

export type SafetyPresetName = "dev" | "balanced" | "strict" | "custom";
export type PiiMode = "mask" | "block" | "off";
export type InjectionMode = "block" | "off";
export type ObservabilityProvider = "none" | "langfuse";
export type PolicyDecisionKind = "allow" | "block" | "degrade" | "fallback";

/** Stable machine-readable codes for policy outcomes (versioned contract). */
export type PolicyReasonCode =
  | "model_class_not_permitted"
  | "daily_request_limit_reached"
  | "daily_budget_exceeded"
  | "feature_monthly_budget_exceeded"
  | "global_monthly_budget_exceeded"
  | "global_budget_degraded"
  | "provider_fallback";

// ── Parsed config (ai-guard.yaml) ───────────────────────────────────────────

export interface ProjectConfig {
  name: string;
  environment: string;
}

export interface ProviderConfig {
  /** Resolved by the API layer (env/VAR). The pure engine never reads it. */
  apiKey?: string;
}

export interface GlobalBudget {
  monthlyUsd: number;
  alertAtPercent: number;
  hardStopAtPercent: number;
}

export interface UserTypeBudget {
  dailyUsd: number;
  dailyRequests: number;
  /** Model classes this user type is permitted to use. */
  models: string[];
}

export interface FeatureBudget {
  monthlyUsd: number;
}

export interface ProtectConfig {
  pii?: PiiMode;
  promptInjection?: InjectionMode;
}

export interface SafetyConfig {
  preset: SafetyPresetName;
  protect: ProtectConfig;
  /** Model (LiteLLM name) used to classify prompt injection, when enabled. */
  injectionModel?: string;
}

/** A feature may set `safety:` to either a preset name or an override object. */
export interface FeatureSafetyOverride {
  preset?: SafetyPresetName;
  protect?: ProtectConfig;
}

export interface FeatureConfig {
  safety?: FeatureSafetyOverride;
  modelClass: string;
  maxTokens: number;
  budget?: FeatureBudget;
}

export interface ModelClassConfig {
  primary: string;
  fallback?: string;
}

export interface RoutingConfig {
  degradeAtPercent: number;
}

export interface AiGuardConfig {
  project: ProjectConfig;
  providers: Record<string, ProviderConfig>;
  budgets: {
    global: GlobalBudget;
    byUserType: Record<string, UserTypeBudget>;
  };
  features: Record<string, FeatureConfig>;
  routing: RoutingConfig;
  modelClasses: Record<string, ModelClassConfig>;
  safety: SafetyConfig;
  observability: { provider: ObservabilityProvider };
}

// ── Evaluator input ─────────────────────────────────────────────────────────

export interface AiRequest {
  projectId: string;
  environment: string;
  userId: string;
  userType: string;
  /** REQUIRED — must exist in config.features. */
  feature: string;
  requestedModelClass?: string;
  inputTokensEstimate?: number;
  /**
   * Set by the API on a fallback re-evaluation (after a provider failure on the
   * primary model). Keeps the engine pure: provider health is never observed
   * inside the engine — the API signals it via this flag.
   */
  forceFallback?: boolean;
  metadata?: Record<string, unknown>;
}

export interface UsageSnapshot {
  userDailyUsdUsed: number;
  userDailyUsdReserved: number;
  userDailyRequestsUsed: number;
  featureMonthlyUsdUsed: number;
  featureMonthlyUsdReserved: number;
  globalMonthlyUsdUsed: number;
  globalMonthlyUsdReserved: number;
}

export interface EvaluateInput {
  request: AiRequest;
  config: AiGuardConfig;
  usage: UsageSnapshot;
}

// ── Evaluator output ────────────────────────────────────────────────────────

/** Resolved safety policy for a request — what to enforce, not how. */
export interface SafetyPlan {
  preset: SafetyPresetName;
  pii: PiiMode;
  promptInjection: InjectionMode;
  injectionModel?: string;
  maxOutputTokens: number;
}

export interface BudgetRemaining {
  userDailyUsd: number;
  /** null when the feature has no monthly cap configured. */
  featureMonthlyUsd: number | null;
  /** null when no global monthly cap is configured (monthly_usd: 0). */
  globalMonthlyUsd: number | null;
}

export interface TraceTags {
  userId: string;
  feature: string;
  modelClass: string;
  policyDecision: string;
}

/**
 * Caps the API needs to re-check atomically when reserving budget. `null`
 * means the dimension has no cap (skip the conditional re-check for it).
 */
export interface ReservationCaps {
  userDailyUsd: number;
  userDailyRequests: number;
  featureMonthlyUsd: number | null;
  /** Already computed as monthlyUsd * hardStopAtPercent / 100. */
  globalMonthlyUsd: number | null;
}

export interface PolicyDecision {
  decision: PolicyDecisionKind;
  reason?: string;
  /** Stable code for clients; present on block/degrade/fallback outcomes. */
  reasonCode?: PolicyReasonCode;
  resolvedModelClass: string;
  resolvedModel: string;
  resolvedProvider: string;
  fallbackModel?: string;
  safetyPreset: SafetyPresetName;
  safetyPlan: SafetyPlan;
  maxOutputTokens: number;
  estimatedCostUsd: number;
  budgetRemaining: BudgetRemaining;
  reservationCaps: ReservationCaps;
  traceTags: TraceTags;
}

/**
 * Thrown by the engine for contract violations (unknown feature / model class /
 * user type). The API maps these to HTTP 400. Distinct from policy *outcomes*
 * (block / degrade / fallback), which are returned, not thrown.
 */
export class PolicyConfigError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "PolicyConfigError";
    this.code = code;
  }
}
