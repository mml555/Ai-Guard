import {
  evaluateAiRequest,
  PolicyConfigError,
  type AiRequest,
  type PolicyDecision,
} from "@ai-guard/policy-engine";
import type { Pool } from "pg";
import {
  LiteLLMClientError,
  ProviderError,
  type LiteLLMChatResult,
} from "../../services/litellm";
import type { ChatObservation, Observability } from "../../services/observability";
import { SafetyServiceError } from "../../services/safety";
import { logRequest, type RequestLogRow } from "../usage/auditLogRepo";
import {
  loadUsageSnapshot,
  recordActualCost,
  releaseBudget,
  reserveBudget,
  topUpBudget,
} from "../usage/repo";
import {
  budgetErrorContext,
  policyErrorFromDecision,
  policyErrorMessage,
} from "../../policyErrors";
import { baseLog, baseObs, chatSuccessBody, fail } from "./mapper";
import type { ChatFailure, ChatInput, ChatResult, ChatServiceDeps } from "./types";
import { handleGlobalBudgetAlert } from "../usage/budgetAlerts";

/**
 * A chat request is rejected in several places (policy block, input-safety
 * block, budget-exceeded, provider error, output-safety block). Each must do
 * the same trio — append the audit log, emit the observability event, and
 * return the failure. Centralize it so a branch can't record one and forget
 * another, and so the sequence is single-sourced.
 */
async function recordRejection(
  ctx: { pool: Pool; observability: Observability },
  logRow: RequestLogRow,
  observation: ChatObservation,
  result: ChatFailure,
): Promise<ChatFailure> {
  const auditRequestId = await logRequest(ctx.pool, logRow);
  ctx.observability.recordChat(observation);
  if (!auditRequestId) return result;
  return {
    ...result,
    auditRequestId,
    details: { ...result.details, auditRequestId },
  };
}
export async function handleChat(
  deps: ChatServiceDeps,
  body: ChatInput,
): Promise<ChatResult> {
  const { config, pool, litellm, safety, observability, budgetAlert, log } = deps;
  const aiRequest: AiRequest = {
    projectId: body.projectId ?? config.project.name,
    environment: body.environment ?? config.project.environment,
    userId: body.userId,
    userType: body.userType,
    feature: body.feature,
    requestedModelClass: body.modelClass,
    inputTokensEstimate: body.inputTokensEstimate,
    metadata: body.metadata,
  };
  const now = new Date();
  const usage = await loadUsageSnapshot(pool, {
    projectId: aiRequest.projectId,
    userId: aiRequest.userId,
    feature: aiRequest.feature,
    now,
  });
  let decision: PolicyDecision;
  try {
    decision = evaluateAiRequest({ request: aiRequest, config, usage });
  } catch (err) {
    if (err instanceof PolicyConfigError) {
      return fail(400, err.code, { detail: err.message }, err.message);
    }
    throw err;
  }

  const globalBudget = config.budgets.global;
  if (globalBudget.monthlyUsd > 0) {
    const alertThreshold =
      globalBudget.monthlyUsd * (globalBudget.alertAtPercent / 100);
    const globalSpend =
      usage.globalMonthlyUsdUsed + usage.globalMonthlyUsdReserved;
    if (globalSpend >= alertThreshold) {
      // Fire-and-forget: the alert claim + webhook must not add a synchronous DB
      // round-trip (and possible latency) to every over-threshold chat request.
      void handleGlobalBudgetAlert(
        pool,
        budgetAlert,
        {
          globalSpendUsd: globalSpend,
          alertThresholdUsd: alertThreshold,
          alertAtPercent: globalBudget.alertAtPercent,
          monthlyCapUsd: globalBudget.monthlyUsd,
          now,
        },
        log,
      ).catch((err) => log?.error({ err }, "budget alert handling failed"));
    }
  }

  if (decision.decision === "block") {
    const policy = policyErrorFromDecision(decision, {
      userId: aiRequest.userId,
      userType: aiRequest.userType,
      feature: aiRequest.feature,
    });
    return recordRejection(
      { pool, observability },
      { ...baseLog(aiRequest, decision), status: "failed", error: decision.reason, reasonCode: decision.reasonCode },
      { ...baseObs(aiRequest, decision), status: "blocked", reason: decision.reason },
      fail(
        403,
        "policy_blocked",
        {
          reason: decision.reason,
          reasonCode: decision.reasonCode,
          budgetRemaining: decision.budgetRemaining,
        },
        policyErrorMessage("policy_blocked", policy),
        policy,
      ),
    );
  }
  let messages = body.messages;
  let piiMasked = false;
  let injectionBlocked = false;
  // Real provider cost of the input safety pass (the injection classifier makes
  // a billable model call). Booked into the settled cost below so classifier
  // spend counts against the budget instead of bypassing accounting.
  let safetyCostUsd = 0;
  try {
    const safetyResult = await safety.inspectInput(messages, decision.safetyPlan);
    messages = safetyResult.messages;
    piiMasked = safetyResult.piiMasked;
    injectionBlocked = safetyResult.injectionBlocked;
    safetyCostUsd = safetyResult.safetyCostUsd;
    if (safetyResult.action === "block") {
      return recordRejection(
        { pool, observability },
        {
          ...baseLog(aiRequest, decision),
          status: "safety_blocked",
          hostMetadata: body.metadata,
          piiMasked,
          injectionBlocked,
          safetyFindings: safetyResult.findings,
          error: safetyResult.blockReason,
        },
        // NB: no `input` on the observation — on a safety block the input is
        // exactly the content that tripped the guard (PII / injection), so
        // exporting it to the observability backend would leak what we blocked.
        {
          ...baseObs(aiRequest, decision),
          status: "safety_blocked",
          reason: safetyResult.blockReason,
          piiMasked,
          injectionBlocked,
        },
        fail(403, "safety_blocked", {
          reason: safetyResult.blockReason,
          findings: safetyResult.findings,
        }),
      );
    }
  } catch (err) {
    if (err instanceof SafetyServiceError) {
      log?.error({ err }, "safety backend failure");
      return fail(
        503,
        "safety_unavailable",
        {},
        "Safety service unavailable",
      );
    }
    throw err;
  }
  const reservation = await reserveBudget(pool, {
    projectId: aiRequest.projectId,
    userId: aiRequest.userId,
    feature: aiRequest.feature,
    estimatedCostUsd: decision.estimatedCostUsd,
    caps: decision.reservationCaps,
    now,
  });
  if (!reservation.ok) {
    const reason = `budget_exceeded:${reservation.failedScope}`;
    const policy = budgetErrorContext(
      reservation.failedScope,
      {
        userId: aiRequest.userId,
        userType: aiRequest.userType,
        feature: aiRequest.feature,
      },
      decision.budgetRemaining,
    );
    return recordRejection(
      { pool, observability },
      { ...baseLog(aiRequest, decision), status: "failed", error: reason, reasonCode: policy.reasonCode },
      { ...baseObs(aiRequest, decision), status: "blocked", reason },
      fail(
        403,
        "budget_exceeded",
        {
          scope: reservation.failedScope,
          reasonCode: policy.reasonCode,
          budgetRemaining: decision.budgetRemaining,
        },
        policyErrorMessage("budget_exceeded", policy),
        policy,
      ),
    );
  }
  const leaseId = reservation.leaseId;
  let llm: LiteLLMChatResult;
  let usedModel = decision.resolvedModel;
  let finalDecision = decision.decision;
  // Amount reserved against budget counters (may increase if we top up for fallback).
  let reservedUsd = decision.estimatedCostUsd;
  // Best estimate of the call's cost when LiteLLM reports none. Updated to the
  // fallback model's estimate if we fall back, so we don't book the (possibly
  // cheaper) primary estimate for a call that actually ran on the fallback.
  let costBasis = decision.estimatedCostUsd;
  try {
    try {
      llm = await litellm.chat({
        model: decision.resolvedModel,
        messages,
        maxTokens: decision.maxOutputTokens,
        temperature: body.temperature,
      });
    } catch (err) {
      if (err instanceof ProviderError && decision.fallbackModel) {
        const fb = evaluateAiRequest({
          request: { ...aiRequest, forceFallback: true },
          config,
          usage,
        });
        if (fb.estimatedCostUsd > reservedUsd) {
          const topUp = await topUpBudget(pool, {
            projectId: aiRequest.projectId,
            userId: aiRequest.userId,
            feature: aiRequest.feature,
            additionalCostUsd: fb.estimatedCostUsd - reservedUsd,
            caps: decision.reservationCaps,
            now,
            leaseId,
          });
          if (!topUp.ok) {
            await releaseBudget(pool, {
              projectId: aiRequest.projectId,
              userId: aiRequest.userId,
              feature: aiRequest.feature,
              estimatedCostUsd: reservedUsd,
              caps: decision.reservationCaps,
              now,
              leaseId,
            });
            const policy = budgetErrorContext(
              topUp.failedScope,
              {
                userId: aiRequest.userId,
                userType: aiRequest.userType,
                feature: aiRequest.feature,
              },
              decision.budgetRemaining,
            );
            return fail(
              403,
              "budget_exceeded",
              {
                scope: topUp.failedScope,
                reasonCode: policy.reasonCode,
                budgetRemaining: decision.budgetRemaining,
              },
              policyErrorMessage("budget_exceeded", policy),
              policy,
            );
          }
          reservedUsd = fb.estimatedCostUsd;
        }
        log?.warn(
          { primary: decision.resolvedModel, fallback: fb.resolvedModel },
          "primary provider failed - routing to fallback",
        );
        usedModel = fb.resolvedModel;
        finalDecision = "fallback";
        costBasis = fb.estimatedCostUsd;
        llm = await litellm.chat({
          model: fb.resolvedModel,
          messages,
          maxTokens: fb.maxOutputTokens,
          temperature: body.temperature,
        });
      } else {
        throw err;
      }
    }
  } catch (err) {
    await releaseBudget(pool, {
      projectId: aiRequest.projectId,
      userId: aiRequest.userId,
      feature: aiRequest.feature,
      estimatedCostUsd: reservedUsd,
      caps: decision.reservationCaps,
      now,
      leaseId,
    });
    const detail = (err as Error).message;
    const code =
      err instanceof LiteLLMClientError ? "upstream_rejected" : "provider_unavailable";
    const message =
      err instanceof LiteLLMClientError
        ? "Upstream rejected request"
        : "Provider unavailable";
    return recordRejection(
      { pool, observability },
      {
        ...baseLog(aiRequest, decision),
        resolvedModel: usedModel,
        decision: finalDecision,
        status: "failed",
        error: detail,
      },
      {
        ...baseObs(aiRequest, decision),
        decision: finalDecision,
        status: "error",
        reason: detail,
      },
      fail(502, code, {}, message),
    );
  }
  // The model call happened — settle its cost now, regardless of what output
  // safety decides below. This keeps budget accounting consistent across the
  // mask / block / backend-error branches. Include the input safety pass's own
  // provider spend (injection classifier) — the reservation only covered the
  // model call, so the classifier cost is added on top so it is booked too.
  const actualCostUsd = (llm.actualCostUsd ?? costBasis) + safetyCostUsd;
  try {
    await recordActualCost(pool, {
      projectId: aiRequest.projectId,
      userId: aiRequest.userId,
      feature: aiRequest.feature,
      actualCostUsd,
      estimatedCostUsd: reservedUsd,
      caps: decision.reservationCaps,
      now,
      leaseId,
    });
    if (actualCostUsd > reservedUsd) {
      // Actual exceeded what we reserved (a pricier fallback, or an
      // under-estimate). The spend is booked truthfully — which can push a
      // counter past its cap and block subsequent requests — so surface it
      // rather than overshooting the budget silently.
      log?.warn(
        {
          reservedUsd,
          actualCostUsd,
          model: usedModel,
        },
        "actual cost exceeded the reserved estimate — budget cap may be overshot",
      );
    }
  } catch (err) {
    // The provider call already succeeded and incurred real cost. A settlement
    // failure must not 500 the request (which would release the idempotency key
    // and let a retry re-charge for the call that already ran). Retry the
    // settlement once; if it still fails, LEAVE the reservation in place rather
    // than releasing it — releasing would free budget for money that was
    // actually spent (used_usd never recorded it), letting later requests
    // overspend the cap. The stale-lease sweep reconciles the leftover lease.
    log?.error({ err }, "failed to record actual cost; retrying settlement once");
    try {
      await recordActualCost(pool, {
        projectId: aiRequest.projectId,
        userId: aiRequest.userId,
        feature: aiRequest.feature,
        actualCostUsd,
        estimatedCostUsd: reservedUsd,
        caps: decision.reservationCaps,
        now,
        leaseId,
      });
    } catch (retryErr) {
      log?.error(
        { err: retryErr },
        "cost settlement retry failed; leaving the reservation for the lease-cleanup sweep to reconcile",
      );
    }
  }

  // Output safety: scan the completion for PII before returning it.
  let content = llm.content;
  try {
    const outputSafety = await safety.inspectOutput(content, decision.safetyPlan);
    if (outputSafety.action === "block") {
      return recordRejection(
        { pool, observability },
        {
          ...baseLog(aiRequest, decision),
          resolvedModel: usedModel,
          decision: finalDecision,
          status: "safety_blocked",
          actualCostUsd,
          inputTokens: llm.inputTokens,
          outputTokens: llm.outputTokens,
          piiMasked,
          injectionBlocked,
          safetyFindings: outputSafety.findings,
          error: outputSafety.blockReason,
        },
        {
          ...baseObs(aiRequest, decision),
          decision: finalDecision,
          status: "safety_blocked",
          model: usedModel,
          reason: outputSafety.blockReason,
          actualCostUsd,
          piiMasked,
          injectionBlocked,
        },
        fail(403, "safety_blocked", {
          reason: outputSafety.blockReason,
          findings: outputSafety.findings,
        }),
      );
    }
    content = outputSafety.content;
    if (outputSafety.piiMasked) piiMasked = true;
  } catch (err) {
    if (err instanceof SafetyServiceError) {
      log?.error({ err }, "output safety backend failure");
      await logRequest(pool, {
        ...baseLog(aiRequest, decision),
        resolvedModel: usedModel,
        decision: finalDecision,
        status: "failed",
        actualCostUsd,
        error: "output_safety_unavailable",
      });
      // The model call already ran and its cost is booked. Mark this 503
      // non-retryable so the idempotency layer caches it instead of releasing
      // the key — a retry would re-reserve, re-call the model, and double-charge.
      return {
        ...fail(503, "safety_unavailable", {}, "Safety service unavailable"),
        retryable: false,
      };
    }
    throw err;
  }

  const auditRequestId = await logRequest(pool, {
    ...baseLog(aiRequest, decision),
    resolvedModel: usedModel,
    decision: finalDecision,
    status: "ok",
    actualCostUsd,
    inputTokens: llm.inputTokens,
    outputTokens: llm.outputTokens,
    piiMasked,
    injectionBlocked,
    traceTags: { ...decision.traceTags, policyDecision: finalDecision },
  });
  observability.recordChat({
    ...baseObs(aiRequest, decision),
    decision: finalDecision,
    status: "ok",
    model: usedModel,
    input: messages,
    output: content,
    inputTokens: llm.inputTokens,
    outputTokens: llm.outputTokens,
    actualCostUsd,
    piiMasked,
    injectionBlocked,
  });
  return chatSuccessBody({
    content,
    model: usedModel,
    decision: finalDecision,
    reason: decision.reason,
    inputTokens: llm.inputTokens,
    outputTokens: llm.outputTokens,
    estimatedCostUsd: decision.estimatedCostUsd,
    actualCostUsd,
    budgetRemaining: decision.budgetRemaining,
    piiMasked,
    injectionBlocked,
    requestId: auditRequestId ?? "req_unknown",
  });
}
