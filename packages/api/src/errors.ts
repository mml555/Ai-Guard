import { randomUUID } from "node:crypto";
import type { FastifyReply } from "fastify";
import type { PolicyErrorContext } from "./policyErrors";

export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: Record<string, unknown>;

  constructor(
    status: number,
    code: string,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface SendErrorOptions {
  /** Promoted to the top-level error object (stable client contract). */
  policy?: PolicyErrorContext;
  /** Audit log id (`req_<n>`) when a request_logs row was written. */
  auditRequestId?: string;
}

export function sendError(
  reply: FastifyReply,
  status: number,
  code: string,
  details: Record<string, unknown> = {},
  message = humanizeCode(code),
  options?: SendErrorOptions,
): FastifyReply {
  const request = reply.request as { ctx?: { requestId?: string } };
  return reply.code(status).send({
    error: {
      code,
      message,
      ...(options?.policy ?? {}),
      ...(options?.auditRequestId ? { auditRequestId: options.auditRequestId } : {}),
      details,
      requestId: request.ctx?.requestId ?? randomUUID(),
    },
  });
}

function humanizeCode(code: string): string {
  return code
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
