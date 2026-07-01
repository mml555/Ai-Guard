import {
  evaluateAiRequest,
  PolicyConfigError,
  type AiRequest,
  type PolicyDecision,
} from "@ai-guard/policy-engine";
import type { LiteLLMStreamFinal } from "../../services/litellm";
import { SafetyServiceError } from "../../services/safety";
import { logRequest } from "../usage/auditLogRepo";
import {
  loadUsageSnapshot,
  recordActualCost,
  releaseBudget,
  reserveBudget,
} from "../usage/repo";
import {
  budgetErrorContext,
  policyErrorFromDecision,
  policyErrorMessage,
} from "../../policyErrors";
import { baseLog, baseObs, fail } from "./mapper";
import type { ChatFailure, ChatInput, ChatServiceDeps } from "./types";

/** Everything the route needs to stream and then settle, once gates have passed. */
export interface StreamContext {
  aiRequest: AiRequest;
  decision: PolicyDecision;
  messages: ChatInput["messages"];
  leaseId?: string;
  now: Date;
  reservedUsd: number;
  safetyCostUsd: number;
  piiMasked: boolean;
  injectionBlocked: boolean;
  temperature?: number;
}

export type StreamPrep = ChatFailure | { ok: true; ctx: StreamContext };

/**
 * Pre-flight for a streamed chat: policy eval, the streaming-safety gate, input
 * safety, and budget reservation — everything that can fail with a normal JSON
 * error BEFORE any SSE bytes are written. Returns a ChatFailure to send as JSON,
 * or a ready-to-stream context.
 */
export async function prepareStream(
  deps: ChatServiceDeps,
  body: ChatInput,
): Promise<StreamPrep> {
  const { config, pool, safety, log } = deps;
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

  if (decision.decision === "block") {
    const policy = policyErrorFromDecision(decision, {
      userId: aiRequest.userId,
      userType: aiRequest.userType,
      feature: aiRequest.feature,
    });
    await logRequest(pool, {
      ...baseLog(aiRequest, decision, deps.policyMeta),
      status: "failed",
      error: decision.reason,
      reasonCode: decision.reasonCode,
    });
    deps.observability.recordChat({
      ...baseObs(aiRequest, decision),
      status: "blocked",
      reason: decision.reason,
    });
    return fail(
      403,
      "policy_blocked",
      { reason: decision.reason, reasonCode: decision.reasonCode, budgetRemaining: decision.budgetRemaining },
      policyErrorMessage("policy_blocked", policy),
      policy,
    );
  }

  // Streaming safety gate: we cannot mask/block output that has already been
  // streamed to the client, so streaming is only allowed when the resolved plan
  // does not require output PII protection. Input safety (below) still runs.
  if (decision.safetyPlan.pii !== "off") {
    return fail(
      400,
      "streaming_unsupported",
      { reason: "output PII protection is enabled for this feature; streaming would bypass it" },
      "Streaming is not supported when output PII protection is enabled",
    );
  }

  // Input safety (PII mask on prompt, injection classifier).
  let messages = body.messages;
  let piiMasked = false;
  let injectionBlocked = false;
  let safetyCostUsd = 0;
  try {
    const safetyResult = await safety.inspectInput(messages, decision.safetyPlan);
    messages = safetyResult.messages;
    piiMasked = safetyResult.piiMasked;
    injectionBlocked = safetyResult.injectionBlocked;
    safetyCostUsd = safetyResult.safetyCostUsd;
    if (safetyResult.action === "block") {
      await logRequest(pool, {
        ...baseLog(aiRequest, decision, deps.policyMeta),
        status: "safety_blocked",
        hostMetadata: body.metadata,
        piiMasked,
        injectionBlocked,
        safetyFindings: safetyResult.findings,
        error: safetyResult.blockReason,
      });
      deps.observability.recordChat({
        ...baseObs(aiRequest, decision),
        status: "safety_blocked",
        reason: safetyResult.blockReason,
        piiMasked,
        injectionBlocked,
      });
      return fail(403, "safety_blocked", {
        reason: safetyResult.blockReason,
        findings: safetyResult.findings,
      });
    }
  } catch (err) {
    if (err instanceof SafetyServiceError) {
      log?.error({ err }, "safety backend failure (stream)");
      return fail(503, "safety_unavailable", {}, "Safety service unavailable");
    }
    throw err;
  }

  const reservation = await reserveBudget(pool, {
    projectId: aiRequest.projectId,
    userId: aiRequest.userId,
    feature: aiRequest.feature,
    // Reserve model estimate + the input-safety cost already incurred.
    estimatedCostUsd: decision.estimatedCostUsd + safetyCostUsd,
    estimatedTokens: decision.estimatedTokens,
    caps: decision.reservationCaps,
    now,
  });
  if (!reservation.ok) {
    const policy = budgetErrorContext(
      reservation.failedScope,
      { userId: aiRequest.userId, userType: aiRequest.userType, feature: aiRequest.feature },
      decision.budgetRemaining,
    );
    return fail(
      403,
      "budget_exceeded",
      { scope: reservation.failedScope, reasonCode: policy.reasonCode, budgetRemaining: decision.budgetRemaining },
      policyErrorMessage("budget_exceeded", policy),
      policy,
    );
  }

  return {
    ok: true,
    ctx: {
      aiRequest,
      decision,
      messages,
      leaseId: reservation.leaseId,
      now,
      reservedUsd: decision.estimatedCostUsd + safetyCostUsd,
      safetyCostUsd,
      piiMasked,
      injectionBlocked,
      temperature: body.temperature,
    },
  };
}

/**
 * Settle a completed stream: book actual cost (from the terminal usage) and
 * write the success audit row. Returns the audit request id.
 */
export async function settleStream(
  deps: ChatServiceDeps,
  ctx: StreamContext,
  final: LiteLLMStreamFinal,
): Promise<string | null> {
  const { pool, observability, log } = deps;
  const { aiRequest, decision, leaseId, now, reservedUsd } = ctx;
  // reservedUsd already includes the safety cost; when the provider reports no
  // real cost, settle to the reserved amount (don't add safety again).
  const actualCostUsd =
    final.actualCostUsd != null ? final.actualCostUsd + ctx.safetyCostUsd : reservedUsd;
  try {
    await recordActualCost(pool, {
      projectId: aiRequest.projectId,
      userId: aiRequest.userId,
      feature: aiRequest.feature,
      actualCostUsd,
      estimatedCostUsd: reservedUsd,
      actualTokens: (final.inputTokens ?? 0) + (final.outputTokens ?? 0),
      estimatedTokens: decision.estimatedTokens,
      caps: decision.reservationCaps,
      now,
      leaseId,
    });
  } catch (err) {
    // Cost already incurred; leave the lease for the sweeper rather than
    // releasing budget for money that was spent. Mirrors the non-stream path.
    log?.error({ err }, "stream cost settlement failed; leaving lease for sweep");
  }

  const requestId = await logRequest(pool, {
    ...baseLog(aiRequest, decision, deps.policyMeta),
    resolvedModel: final.model,
    status: "ok",
    actualCostUsd,
    inputTokens: final.inputTokens,
    outputTokens: final.outputTokens,
    piiMasked: ctx.piiMasked,
    injectionBlocked: ctx.injectionBlocked,
  });
  observability.recordChat({
    ...baseObs(aiRequest, decision),
    status: "ok",
    model: final.model,
    inputTokens: final.inputTokens,
    outputTokens: final.outputTokens,
    actualCostUsd,
    piiMasked: ctx.piiMasked,
    injectionBlocked: ctx.injectionBlocked,
  });
  return requestId;
}

/**
 * Release a stream's reservation — used when the client disconnects or the
 * provider fails before/without settlement. Best-effort; the lease sweeper is
 * the backstop.
 */
export async function releaseStream(deps: ChatServiceDeps, ctx: StreamContext): Promise<void> {
  try {
    await releaseBudget(deps.pool, {
      projectId: ctx.aiRequest.projectId,
      userId: ctx.aiRequest.userId,
      feature: ctx.aiRequest.feature,
      estimatedCostUsd: ctx.reservedUsd,
      estimatedTokens: ctx.decision.estimatedTokens,
      caps: ctx.decision.reservationCaps,
      now: ctx.now,
      leaseId: ctx.leaseId,
    });
  } catch (err) {
    deps.log?.error({ err }, "failed to release stream reservation; lease sweep will reconcile");
  }
}
