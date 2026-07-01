import type { RequestContext } from "../../plugins/requestContext";
import type { RequestListQuery } from "./types";

export interface AuthorizedRequestQuery extends RequestListQuery {
  projectScope?: string;
}

export function authorizeRequestList(
  ctx: RequestContext,
  query: RequestListQuery,
  defaultProjectId: string,
):
  | { ok: true; value: AuthorizedRequestQuery }
  | { ok: false; status: number; code: string; message: string } {
  if (!ctx.permissions?.includes("requests:read")) {
    return deny(403, "forbidden", "API key is not permitted to read requests");
  }

  if (query.userId && ctx.allowedUserIds?.length && !ctx.allowedUserIds.includes(query.userId)) {
    return deny(403, "user_forbidden", "API key is not permitted for this user");
  }

  if (ctx.projectId && query.projectId && query.projectId !== ctx.projectId) {
    return deny(403, "project_mismatch", "API key is not permitted for this project");
  }

  if (ctx.allowedUserTypes?.length && query.userType && !ctx.allowedUserTypes.includes(query.userType)) {
    return deny(403, "user_type_forbidden", "API key is not permitted for this user type");
  }

  return {
    ok: true,
    value: {
      ...query,
      projectScope: ctx.projectId ?? query.projectId ?? defaultProjectId,
    },
  };
}

export function authorizeRequestShow(
  ctx: RequestContext,
  projectId?: string,
):
  | { ok: true; projectScope?: string }
  | { ok: false; status: number; code: string; message: string } {
  if (!ctx.permissions?.includes("requests:read")) {
    return deny(403, "forbidden", "API key is not permitted to read requests");
  }

  if (ctx.projectId && projectId && projectId !== ctx.projectId) {
    return deny(403, "project_mismatch", "API key is not permitted for this project");
  }

  return { ok: true, projectScope: ctx.projectId ?? projectId };
}

function deny(status: number, code: string, message: string) {
  return { ok: false as const, status, code, message };
}
