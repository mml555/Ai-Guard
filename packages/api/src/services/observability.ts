import type { TraceTags } from "@ai-guard/policy-engine";
import { Langfuse } from "langfuse";
import type { ChatMessage } from "../types";

// Optional observability. The engine/route stay clean: they always call
// recordChat(); a NoopObservability is used unless Langfuse is configured.

export interface ChatObservation {
  userId: string;
  feature: string;
  decision: string;
  status: "ok" | "blocked" | "safety_blocked" | "error";
  model?: string;
  input?: ChatMessage[];
  output?: string;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCostUsd?: number;
  actualCostUsd?: number;
  reason?: string;
  piiMasked?: boolean;
  injectionBlocked?: boolean;
  traceTags: TraceTags;
  projectId?: string;
  environment?: string;
  /** Host-app metadata (non-authoritative, for traces only). */
  hostMetadata?: Record<string, unknown>;
}

export interface Observability {
  recordChat(observation: ChatObservation): void;
  shutdown(): Promise<void>;
}

export class NoopObservability implements Observability {
  recordChat(_observation: ChatObservation): void {}
  async shutdown(): Promise<void> {}
}

export interface LangfuseOptions {
  publicKey: string;
  secretKey: string;
  baseUrl: string;
  captureContent: boolean;
}

export class LangfuseObservability implements Observability {
  private readonly client: Langfuse;
  private readonly captureContent: boolean;

  constructor(opts: LangfuseOptions) {
    this.captureContent = opts.captureContent;
    this.client = new Langfuse({
      publicKey: opts.publicKey,
      secretKey: opts.secretKey,
      baseUrl: opts.baseUrl,
    });
  }

  recordChat(o: ChatObservation): void {
    // Observability must never break a request: enqueue best-effort, swallow.
    try {
      const trace = this.client.trace({
        name: `chat:${o.feature}`,
        userId: o.userId,
        tags: [o.feature, o.decision, o.status],
        input: this.captureContent ? o.input : undefined,
        output: this.captureContent ? o.output : undefined,
        metadata: {
          environment: o.environment,
          projectId: o.projectId,
          modelClass: o.traceTags.modelClass,
          decision: o.decision,
          status: o.status,
          reason: o.reason,
          estimatedCostUsd: o.estimatedCostUsd,
          actualCostUsd: o.actualCostUsd,
          piiMasked: o.piiMasked,
          injectionBlocked: o.injectionBlocked,
          hostMetadata: o.hostMetadata,
        },
      });

      if (o.status === "ok" && o.model) {
        // Legacy `usage` object — populates promptTokens/completionTokens/cost
        // across both Langfuse v2 and v3.
        const usage: {
          input?: number;
          output?: number;
          unit: "TOKENS";
          totalCost?: number;
        } = { unit: "TOKENS" };
        if (typeof o.inputTokens === "number") usage.input = o.inputTokens;
        if (typeof o.outputTokens === "number") usage.output = o.outputTokens;
        if (typeof o.actualCostUsd === "number") usage.totalCost = o.actualCostUsd;

        trace.generation({
          name: "completion",
          model: o.model,
          input: this.captureContent ? o.input : undefined,
          output: this.captureContent ? o.output : undefined,
          usage,
          metadata: { estimatedCostUsd: o.estimatedCostUsd },
        });
      } else {
        trace.event({
          name: o.status,
          level: o.status === "error" ? "ERROR" : "WARNING",
          statusMessage: o.reason,
        });
      }
    } catch {
      // ignore — tracing is non-critical
    }
  }

  async shutdown(): Promise<void> {
    // Bound the final flush so a slow/unreachable Langfuse never hangs shutdown.
    try {
      await Promise.race([
        this.client.shutdownAsync(),
        new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 3000);
          t.unref?.();
        }),
      ]);
    } catch {
      // ignore
    }
  }
}

export function createObservability(opts: {
  provider: "none" | "langfuse";
  publicKey?: string;
  secretKey?: string;
  baseUrl?: string;
  captureContent?: boolean;
}): Observability {
  if (
    opts.provider === "langfuse" &&
    opts.publicKey &&
    opts.secretKey &&
    opts.baseUrl
  ) {
    return new LangfuseObservability({
      publicKey: opts.publicKey,
      secretKey: opts.secretKey,
      baseUrl: opts.baseUrl,
      captureContent: opts.captureContent ?? false,
    });
  }
  return new NoopObservability();
}
