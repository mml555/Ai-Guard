import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { fail } from "../chat/mapper";
import type { ChatResult } from "../chat/types";
import { claimKey, completeKey, releaseKey } from "./repo";

/**
 * Deterministic JSON serialization: object keys are sorted recursively so two
 * semantically identical bodies hash the same. `JSON.stringify` is
 * insertion-order dependent, so a retry whose `metadata` object emits keys in a
 * different order would otherwise hash differently and be rejected as reuse.
 * Arrays keep their order (it is significant).
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v === undefined ? null : v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",")}}`;
}

/** Stable fingerprint of a request body, to detect key reuse with a different payload. */
export function requestHash(body: unknown): string {
  return createHash("sha256").update(stableStringify(body)).digest("hex");
}

export interface IdempotentOutcome {
  result: ChatResult;
  replayed: boolean;
}

/**
 * Run `produce` under an idempotency key. The first request for a key executes
 * `produce` and stores its result; retries with the same key replay it without
 * re-reserving budget or re-calling the model. A key reused with a different
 * body is rejected (422); a key still in flight returns 409.
 *
 * Transient failures (HTTP >= 500) release the claim so the client can retry;
 * deterministic outcomes (2xx and 4xx blocks) are cached.
 *
 * When `captureContent` is false the cached success body is stored WITHOUT the
 * model's completion text, so disabling content capture also keeps generated
 * content out of the idempotency store at rest (a replay then returns the
 * envelope with empty content).
 */
export async function withIdempotency(
  pool: Pool,
  params: { key: string; userId: string; hash: string; captureContent: boolean },
  produce: () => Promise<ChatResult>,
): Promise<IdempotentOutcome> {
  const claim = await claimKey(pool, {
    key: params.key,
    userId: params.userId,
    requestHash: params.hash,
  });

  if (claim.state === "conflict") {
    const existing = claim.existing;
    if (existing.requestHash !== params.hash) {
      return {
        result: fail(
          422,
          "idempotency_key_reuse",
          {},
          "Idempotency-Key was already used with a different request body",
        ),
        replayed: false,
      };
    }
    if (existing.status === "processing") {
      return {
        result: fail(
          409,
          "idempotency_in_progress",
          {},
          "A request with this Idempotency-Key is still being processed",
        ),
        replayed: false,
      };
    }
    // completed — replay the stored result verbatim.
    return { result: existing.responseBody as ChatResult, replayed: true };
  }

  // We own the key. Produce the result, then cache or release.
  let result: ChatResult;
  try {
    result = await produce();
  } catch (err) {
    await releaseKey(pool, { userId: params.userId, key: params.key });
    throw err;
  }

  const httpStatus = result.ok ? 200 : result.status;
  // A 5xx normally releases the key so the client can safely retry. But a
  // failure flagged `retryable: false` happened AFTER the model call ran and its
  // cost was booked — releasing would let the retry re-run the flow and
  // re-charge. Cache those instead, so the retry replays the error.
  const retryableFailure = result.ok ? false : result.retryable !== false;
  if (httpStatus >= 500 && retryableFailure) {
    await releaseKey(pool, { userId: params.userId, key: params.key });
  } else {
    await completeKey(pool, {
      userId: params.userId,
      key: params.key,
      responseStatus: httpStatus,
      responseBody: params.captureContent ? result : redactForStorage(result),
    });
  }
  return { result, replayed: false };
}

/**
 * Strip the model's completion text from a result before it is persisted, when
 * content capture is disabled. The live caller still gets the real content; only
 * the stored (replay) copy is redacted.
 */
function redactForStorage(result: ChatResult): ChatResult {
  if (!result.ok) return result;
  return {
    ...result,
    body: {
      ...result.body,
      message: { ...result.body.message, content: "" },
    },
  };
}
