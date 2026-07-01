import type { AiRequest, PolicyDecision } from "@ai-guard/policy-engine";
import type { Pool } from "pg";
import type { ChatObservation, Observability } from "../../services/observability";
import type { SafetyResult } from "../../services/safety";
import { logRequest, type RequestLogRow } from "../usage/auditLogRepo";
import { policyErrorFromDecision, policyErrorMessage } from "../../policyErrors";
import type { BudgetScope } from "../usage/repo";
import { baseLog, baseObs, fail, type PolicyMeta } from "./mapper";
import type { ChatFailure } from "./types";

// The chat request lifecycle has ONE set of failure semantics — reject with an
// audit trail, book classifier spend that already happened, release holds
// without losing spent money — implemented here once and composed by the three
// handlers (flat, hierarchical, stream). The handlers stay separate; what they
// share is this vocabulary, so a fix like "honor the fallback block" or "book
// safety spend on rejection" can never exist in one path and be missing from
// another.

/** Outcome of a budget reservation attempt (flat scope or node path). */
export interface ReserveOutcome {
  ok: boolean;
  failedScope?: BudgetScope;
  failedNodeId?: string;
  leaseId?: string;
}

export interface TopUpOutcome {
  ok: boolean;
  failedScope?: BudgetScope;
}

/**
 * Per-request budget operations. A strategy is stateful: `reserve` captures the
 * hold (lease / path reservation) that `release` and `settle` later operate on.
 * Flat injects `usage/repo`; hierarchical injects `budgets/repo` with the
 * request's node path and shard key. Consumed by the provider-execution helper
 * (Phase B); the rejection helpers below need only `incur`.
 */
export interface BudgetStrategy {
  reserve(estimateUsd: number): Promise<ReserveOutcome>;
  /** Book already-spent money (classifier cost). No cap check; no-op at <= 0. */
  incur(costUsd: number): Promise<void>;
  /** Free the current hold in full. */
  release(): Promise<void>;
  /** Book actual cost against the hold and drop the lease. */
  settle(actualUsd: number, actualTokens?: number): Promise<void>;
  /** Grow the hold for a pricier fallback. Flat only — hierarchical omits it
   * (a pricier fallback settles truthfully, overshooting the estimate). */
  topUp?(additionalUsd: number): Promise<TopUpOutcome>;
}

export type IncurFn = (costUsd: number) => Promise<void>;

/** Everything a rejection needs to leave a correct audit trail. */
export interface RejectionCtx {
  pool: Pool;
  observability: Observability;
  aiRequest: AiRequest;
  policyMeta?: PolicyMeta & { requestedModelClass?: string };
}

/**
 * A chat request is rejected in several places (policy block, input-safety
 * block, budget-exceeded, provider error, output-safety block). Each must do
 * the same trio — append the audit log, emit the observability event, and
 * return the failure. Centralize it so a branch can't record one and forget
 * another, and so the sequence is single-sourced.
 */
export async function recordRejection(
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

/** Book classifier spend that already happened; no-op when there was none. */
export async function bookSafetyIfAny(incur: IncurFn, safetyCostUsd: number): Promise<void> {
  if (safetyCostUsd <= 0) return;
  await incur(safetyCostUsd);
}

/**
 * Free a hold whose model call never delivered, WITHOUT losing the classifier
 * spend inside it: book the safety portion as used first, then release the
 * full hold (net: safety spent, model freed). The ordering is deliberate — a
 * crash between the two leaves the hold for the lease sweep to reconcile,
 * whereas release-then-incur would lose the spend entirely.
 */
export async function releaseWithSafety(
  incur: IncurFn,
  release: () => Promise<void>,
  safetyCostUsd: number,
): Promise<void> {
  await bookSafetyIfAny(incur, safetyCostUsd);
  await release();
}

/**
 * Standard 403 policy_blocked rejection for a block decision — from the
 * initial evaluation or the forceFallback re-eval. Audits the block, emits
 * observability, and returns the stable error contract.
 *
 * `includeBudgetRemaining: false` is for hierarchical mode, where the flat
 * budget gates were evaluated against ZERO_USAGE — reporting their "remaining"
 * would claim full flat headroom while the node tree is the real authority.
 */
export async function rejectPolicyBlock(
  ctx: RejectionCtx,
  block: PolicyDecision,
  opts: { safetyCostUsd?: number; includeBudgetRemaining?: boolean } = {},
): Promise<ChatFailure> {
  const { safetyCostUsd = 0, includeBudgetRemaining = true } = opts;
  const policy = policyErrorFromDecision(block, {
    userId: ctx.aiRequest.userId,
    userType: ctx.aiRequest.userType,
    feature: ctx.aiRequest.feature,
  });
  if (!includeBudgetRemaining) delete policy.budgetRemaining;
  return recordRejection(
    ctx,
    {
      ...baseLog(ctx.aiRequest, block, ctx.policyMeta),
      status: "failed",
      error: block.reason,
      reasonCode: block.reasonCode,
      ...(safetyCostUsd > 0 ? { actualCostUsd: safetyCostUsd } : {}),
    },
    { ...baseObs(ctx.aiRequest, block), status: "blocked", reason: block.reason },
    fail(
      403,
      "policy_blocked",
      {
        reason: block.reason,
        reasonCode: block.reasonCode,
        ...(includeBudgetRemaining ? { budgetRemaining: block.budgetRemaining } : {}),
      },
      policyErrorMessage("policy_blocked", policy),
      policy,
    ),
  );
}

/**
 * Standard 403 safety_blocked rejection: books the classifier spend (the scan
 * was a real provider call even though the request is blocked — booking never
 * gates), then audits and returns the failure.
 */
export async function rejectSafetyBlock(
  ctx: RejectionCtx,
  incur: IncurFn,
  args: {
    decision: PolicyDecision;
    safetyResult: Pick<SafetyResult, "findings" | "blockReason" | "piiMasked" | "injectionBlocked">;
    safetyCostUsd: number;
  },
): Promise<ChatFailure> {
  const { decision, safetyResult, safetyCostUsd } = args;
  await bookSafetyIfAny(incur, safetyCostUsd);
  return recordRejection(
    ctx,
    {
      ...baseLog(ctx.aiRequest, decision, ctx.policyMeta),
      status: "safety_blocked",
      piiMasked: safetyResult.piiMasked,
      injectionBlocked: safetyResult.injectionBlocked,
      safetyFindings: safetyResult.findings,
      error: safetyResult.blockReason,
      ...(safetyCostUsd > 0 ? { actualCostUsd: safetyCostUsd } : {}),
    },
    // NB: no `input` on the observation — on a safety block the input is
    // exactly the content that tripped the guard (PII / injection), so
    // exporting it to the observability backend would leak what we blocked.
    {
      ...baseObs(ctx.aiRequest, decision),
      status: "safety_blocked",
      reason: safetyResult.blockReason,
      piiMasked: safetyResult.piiMasked,
      injectionBlocked: safetyResult.injectionBlocked,
    },
    fail(403, "safety_blocked", {
      reason: safetyResult.blockReason,
      findings: safetyResult.findings,
    }),
  );
}
