import type { ChatMessage } from "../../types";
import { SafetyServiceError, type PiiGuard, type SafetyFinding } from "./index";

interface PresidioEntity {
  entity_type: string;
  start: number;
  end: number;
  score: number;
}

export interface PresidioOptions {
  analyzerUrl: string;
  anonymizerUrl: string;
  language?: string;
  /** Per-call timeout; a hung Presidio must not stall the whole request. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * PII detection + masking via Microsoft Presidio (analyzer + anonymizer
 * services). Masking replaces every detected entity with "[REDACTED]".
 */
export class PresidioPiiGuard implements PiiGuard {
  private readonly analyzerUrl: string;
  private readonly anonymizerUrl: string;
  private readonly language: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: PresidioOptions) {
    this.analyzerUrl = opts.analyzerUrl.replace(/\/$/, "");
    this.anonymizerUrl = opts.anonymizerUrl.replace(/\/$/, "");
    this.language = opts.language ?? "en";
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async process(
    messages: ChatMessage[],
  ): Promise<{ messages: ChatMessage[]; findings: SafetyFinding[] }> {
    // Screen messages concurrently: a long conversation would otherwise incur
    // 2N sequential Presidio round-trips on the request hot path. Promise.all
    // preserves order, so masked messages stay aligned with their originals.
    const processed = await Promise.all(
      messages.map(async (message) => {
        if (!message.content) return { message, findings: [] as SafetyFinding[] };
        const entities = await this.analyze(message.content);
        if (entities.length === 0) return { message, findings: [] as SafetyFinding[] };
        const findings: SafetyFinding[] = entities.map((e) => ({
          type: "pii",
          detail: e.entity_type,
        }));
        const anonymized = await this.anonymize(message.content, entities);
        return { message: { ...message, content: anonymized }, findings };
      }),
    );

    return {
      messages: processed.map((p) => p.message),
      findings: processed.flatMap((p) => p.findings),
    };
  }

  private async analyze(text: string): Promise<PresidioEntity[]> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.analyzerUrl}/analyze`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, language: this.language }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new SafetyServiceError("Presidio analyzer unreachable", { cause: err });
    }
    if (!res.ok) {
      throw new SafetyServiceError(`Presidio analyzer returned ${res.status}`);
    }
    const body = await res.json().catch(() => null);
    // Fail closed on an off-shape response: a non-array body must not fall
    // through to `.length`/`.map` (which would throw a raw 500 rather than the
    // intended fail-closed 503) or be silently treated as "no PII".
    if (!Array.isArray(body)) {
      throw new SafetyServiceError(
        "Presidio analyzer returned an unexpected (non-array) response",
      );
    }
    return body as PresidioEntity[];
  }

  private async anonymize(
    text: string,
    entities: PresidioEntity[],
  ): Promise<string> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.anonymizerUrl}/anonymize`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text,
          analyzer_results: entities.map((e) => ({
            entity_type: e.entity_type,
            start: e.start,
            end: e.end,
            score: e.score,
          })),
          anonymizers: {
            DEFAULT: { type: "replace", new_value: "[REDACTED]" },
          },
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new SafetyServiceError("Presidio anonymizer unreachable", { cause: err });
    }
    if (!res.ok) {
      throw new SafetyServiceError(`Presidio anonymizer returned ${res.status}`);
    }
    const json = (await res.json().catch(() => null)) as { text?: unknown } | null;
    // Fail closed: if the anonymizer response lacks masked text, we must NOT
    // fall back to the original (which still contains the PII we were asked to
    // redact) — that would leak PII while reporting it as masked.
    if (!json || typeof json.text !== "string") {
      throw new SafetyServiceError(
        "Presidio anonymizer returned no masked text",
      );
    }
    return json.text;
  }
}
