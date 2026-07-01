import type { RequestContext } from "../../plugins/requestContext";
import type { UsageQuery } from "./service";

export interface AuthorizedUsageQuery extends UsageQuery {
  /** Project partition for budget_counters (user_daily / feature_monthly). */
  budgetProjectId: string;
  /** When set, recent request stats are filtered to this project. */
  projectScope?: string;
  includeGlobal: boolean;
}

export function authorizeUsageQuery(
  ctx: RequestContext,
  query: UsageQuery,
  defaultProjectId: string,
):
  | { ok: true; value: AuthorizedUsageQuery }
  | { ok: false; status: number; code: string; message: string } {
  const tenantScoped = Boolean(ctx.projectId);

  if (query.userId && ctx.allowedUserIds?.length && !ctx.allowedUserIds.includes(query.userId)) {
    return deny(403, "user_forbidden", "API key is not permitted for this user");
  }

  if (ctx.projectId && query.projectId && query.projectId !== ctx.projectId) {
    return deny(403, "project_mismatch", "API key is not permitted for this project");
  }

  if (tenantScoped && query.userId === undefined && query.feature === undefined) {
    return deny(
      403,
      "usage_scope_required",
      "Tenant-scoped API keys must provide userId or feature on usage queries",
    );
  }

  const budgetProjectId = ctx.projectId ?? query.projectId ?? defaultProjectId;

  return {
    ok: true,
    value: {
      ...query,
      budgetProjectId,
      projectScope: ctx.projectId ?? query.projectId,
      includeGlobal: !tenantScoped,
    },
  };
}

export function authorizeUsageSummary(
  ctx: RequestContext,
  query: { feature?: string; userType?: string; projectId?: string },
  defaultProjectId: string,
):
  | { ok: true; projectScope?: string }
  | { ok: false; status: number; code: string; message: string } {
  if (ctx.projectId && query.projectId && query.projectId !== ctx.projectId) {
    return deny(403, "project_mismatch", "API key is not permitted for this project");
  }

  if (ctx.allowedUserTypes?.length && query.userType && !ctx.allowedUserTypes.includes(query.userType)) {
    return deny(403, "user_type_forbidden", "API key is not permitted for this user type");
  }

  return {
    ok: true,
    projectScope: ctx.projectId ?? query.projectId ?? defaultProjectId,
  };
}

function deny(status: number, code: string, message: string) {
  return { ok: false as const, status, code, message };
}
