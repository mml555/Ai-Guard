import type { LiteLLMClient } from "../litellm";
import { CompositeGuard } from "./composite";
import type { SafetyGuard } from "./contracts";
import { LiteLLMInjectionDetector } from "./injection";
import { PresidioPiiGuard } from "./presidio";

export * from "./contracts";

// The Safety service ENFORCES the engine's resolved safetyPlan. It lives in the
// API layer (not the pure engine) because real PII masking / injection
// detection require I/O.

export interface CreateSafetyGuardOptions {
  presidio?: { analyzerUrl: string; anonymizerUrl: string; language?: string };
  injection?: { client: LiteLLMClient; model: string };
  fetchImpl?: typeof fetch;
}

/**
 * Build the guard from whatever backends are configured. The CompositeGuard
 * enforces the resolved plan and fails closed when a requested backend is
 * missing. Use NoopGuard only in tests or when a caller intentionally bypasses
 * safety.
 */
export function createSafetyGuard(
  options: CreateSafetyGuardOptions,
): SafetyGuard {
  const pii = options.presidio
    ? new PresidioPiiGuard({ ...options.presidio, fetchImpl: options.fetchImpl })
    : null;
  const injection = options.injection
    ? new LiteLLMInjectionDetector(options.injection.client, options.injection.model)
    : null;

  return new CompositeGuard(pii, injection);
}

export { CompositeGuard } from "./composite";
export { NoopGuard } from "./noop";
export { PresidioPiiGuard } from "./presidio";
export { LiteLLMInjectionDetector } from "./injection";
