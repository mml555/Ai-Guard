import { estimateCostUsd, roundUsd } from "./cost";
import {
  nextPermittedCheaperClass,
  resolveModelInfo,
} from "./routing";
import { resolveSafetyPlan } from "./safety";
import {
  PolicyConfigError,
  type AiGuardConfig,
  type BudgetRemaining,
  type EvaluateInput,
  type FeatureConfig,
  type GlobalBudget,
  type PolicyDecision,
  type PolicyDecisionKind,
  type ReservationCaps,
  type SafetyPlan,
  type UsageSnapshot,
  type UserTypeBudget,
} from "./types";

/**
 * The core IP. Pure and deterministic — no I/O, no clock, no randomness. Given
 * the request, the parsed config, and a usage snapshot (used + reserved), it
 * decides whether the call is allowed and which model/safety policy applies.
 *
 * Throws PolicyConfigError for contract violations (unknown feature / model
 * class / user type) — the API maps those to HTTP 400. Policy *outcomes*
 * (allow / block / degrade / fallback) are returned, never thrown.
 */
export function evaluateAiRequest(input: EvaluateInput): PolicyDecision {
  const { request, config, usage } = input;

  const feature = config.features[request.feature];
  if (!feature) {
    throw new PolicyConfigError(
      `unknown feature: '${request.feature}'`,
      "unknown_feature",
    );
  }

  const userBudget = config.budgets.byUserType[request.userType];
  if (!userBudget) {
    throw new PolicyConfigError(
      `unknown user_type: '${request.userType}'`,
      "unknown_user_type",
    );
  }

  const requestedClass = request.requestedModelClass ?? feature.modelClass;
  if (!config.modelClasses[requestedClass]) {
    throw new PolicyConfigError(
      `unknown model_class: '${requestedClass}'`,
      "unknown_model_class",
    );
  }

  const safetyPlan = resolveSafetyPlan(config, feature);
  const ctx: BuildCtx = {
    config,
    feature,
    userBudget,
    usage,
    safetyPlan,
    userId: request.userId,
    featureName: request.feature,
    inputTokensEstimate: request.inputTokensEstimate,
  };

  // ── Permitted-class check ────────────────────────────────────────────────
  // (Skipped on fallback re-eval: the request was already approved.)
  if (!request.forceFallback && !userBudget.models.includes(requestedClass)) {
    return buildDecision(ctx, {
      decision: "block",
      reasonCode: "model_class_not_permitted",
      reason: `model_class '${requestedClass}' is not permitted for user_type '${request.userType}'`,
      effectiveClass: requestedClass,
      useFallback: false,
    });
  }

  // ── Budget-aware degrade ───────────────────────────────────────────────────
  // Runs on the fallback re-eval too (NOT gated on !forceFallback): a request
  // degraded for budget reasons must stay degraded when it falls back, so the
  // fallback resolves the *degraded* class's fallback model rather than the
  // original (more expensive) class's. The usage snapshot is unchanged between
  // the two evals, so this re-derives the same degraded class deterministically.
  let effectiveClass = requestedClass;
  let degraded = false;
  const global = config.budgets.global;
  const globalSpend = usage.globalMonthlyUsdUsed + usage.globalMonthlyUsdReserved;
  if (global.monthlyUsd > 0) {
    const degradeThreshold = global.monthlyUsd * (config.routing.degradeAtPercent / 100);
    if (globalSpend >= degradeThreshold) {
      const cheaper = nextPermittedCheaperClass(
        effectiveClass,
        userBudget.models,
        config,
      );
      if (cheaper) {
        effectiveClass = cheaper;
        degraded = true;
      }
    }
  }

  // ── Fallback path (post provider-failure re-eval) ──────────────────────────
  // Resolve the fallback model for the (possibly degraded) class and return
  // without re-running budget gates — the request is already in flight.
  if (request.forceFallback) {
    return buildDecision(ctx, {
      decision: "fallback",
      reasonCode: "provider_fallback",
      reason: "provider failure on primary — routed to fallback model",
      effectiveClass,
      useFallback: true,
    });
  }

  // ── Budget gates (block on any breach) ─────────────────────────────────────
  const { model } = resolveModelInfo(config, effectiveClass, false);
  const estimate = estimateCostUsd(
    model,
    request.inputTokensEstimate,
    safetyPlan.maxOutputTokens,
  );

  if (usage.userDailyRequestsUsed + 1 > userBudget.dailyRequests) {
    return buildDecision(ctx, {
      decision: "block",
      reasonCode: "daily_request_limit_reached",
      reason: `daily request limit reached (${userBudget.dailyRequests})`,
      effectiveClass,
      useFallback: false,
    });
  }

  const userDailySpend = usage.userDailyUsdUsed + usage.userDailyUsdReserved;
  if (userDailySpend + estimate > userBudget.dailyUsd) {
    return buildDecision(ctx, {
      decision: "block",
      reasonCode: "daily_budget_exceeded",
      reason: `user daily budget exceeded (cap $${userBudget.dailyUsd})`,
      effectiveClass,
      useFallback: false,
    });
  }

  const featureCap = feature.budget?.monthlyUsd ?? null;
  const featureSpend =
    usage.featureMonthlyUsdUsed + usage.featureMonthlyUsdReserved;
  if (featureCap !== null && featureSpend + estimate > featureCap) {
    return buildDecision(ctx, {
      decision: "block",
      reasonCode: "feature_monthly_budget_exceeded",
      reason: `feature monthly budget exceeded (cap $${featureCap})`,
      effectiveClass,
      useFallback: false,
    });
  }

  if (global.monthlyUsd > 0) {
    const hardStop = global.monthlyUsd * (global.hardStopAtPercent / 100);
    if (globalSpend + estimate > hardStop) {
      return buildDecision(ctx, {
        decision: "block",
        reasonCode: "global_monthly_budget_exceeded",
        reason: `global monthly budget hard stop reached (cap $${hardStop})`,
        effectiveClass,
        useFallback: false,
      });
    }
  }

  // ── Allowed (possibly degraded) ────────────────────────────────────────────
  return buildDecision(ctx, {
    decision: degraded ? "degrade" : "allow",
    reasonCode: degraded ? "global_budget_degraded" : undefined,
    reason: degraded
      ? `global budget >= ${config.routing.degradeAtPercent}% — degraded to '${effectiveClass}'`
      : undefined,
    effectiveClass,
    useFallback: false,
  });
}

// ── Internal decision builder ────────────────────────────────────────────────

interface BuildCtx {
  config: AiGuardConfig;
  feature: FeatureConfig;
  userBudget: UserTypeBudget;
  usage: UsageSnapshot;
  safetyPlan: SafetyPlan;
  userId: string;
  featureName: string;
  inputTokensEstimate?: number;
}

interface BuildArgs {
  decision: PolicyDecisionKind;
  reason?: string;
  reasonCode?: PolicyDecision["reasonCode"];
  effectiveClass: string;
  useFallback: boolean;
}

function buildDecision(ctx: BuildCtx, args: BuildArgs): PolicyDecision {
  const { config, feature, userBudget, usage, safetyPlan } = ctx;
  const { model, provider, fallback } = resolveModelInfo(
    config,
    args.effectiveClass,
    args.useFallback,
  );
  const estimatedCostUsd = estimateCostUsd(
    model,
    ctx.inputTokensEstimate,
    safetyPlan.maxOutputTokens,
  );

  const global: GlobalBudget = config.budgets.global;
  const globalCap =
    global.monthlyUsd > 0
      ? global.monthlyUsd * (global.hardStopAtPercent / 100)
      : null;
  const featureCap = feature.budget?.monthlyUsd ?? null;

  const userDailySpend = usage.userDailyUsdUsed + usage.userDailyUsdReserved;
  const featureSpend =
    usage.featureMonthlyUsdUsed + usage.featureMonthlyUsdReserved;
  const globalSpend =
    usage.globalMonthlyUsdUsed + usage.globalMonthlyUsdReserved;

  const budgetRemaining: BudgetRemaining = {
    userDailyUsd: roundUsd(userBudget.dailyUsd - userDailySpend),
    featureMonthlyUsd:
      featureCap !== null ? roundUsd(featureCap - featureSpend) : null,
    globalMonthlyUsd: globalCap !== null ? roundUsd(globalCap - globalSpend) : null,
  };

  const reservationCaps: ReservationCaps = {
    userDailyUsd: userBudget.dailyUsd,
    userDailyRequests: userBudget.dailyRequests,
    featureMonthlyUsd: featureCap,
    globalMonthlyUsd: globalCap,
  };

  return {
    decision: args.decision,
    reason: args.reason,
    reasonCode: args.reasonCode,
    resolvedModelClass: args.effectiveClass,
    resolvedModel: model,
    resolvedProvider: provider,
    fallbackModel: fallback,
    safetyPreset: safetyPlan.preset,
    safetyPlan,
    maxOutputTokens: safetyPlan.maxOutputTokens,
    estimatedCostUsd,
    budgetRemaining,
    reservationCaps,
    traceTags: {
      userId: ctx.userId,
      feature: ctx.featureName,
      modelClass: args.effectiveClass,
      policyDecision: args.decision,
    },
  };
}
