import {
  DocumentClientError,
  DocumentProviderError,
  type DocumentEntity,
  type DocumentExtractOptions,
  type DocumentField,
  type DocumentProviderAdapter,
  type DocumentResult,
  type DocumentSource,
  type DocumentTable,
} from "./types";
import { readJsonSafe, readTextSafe } from "./util";

const DEFAULT_MODEL = "prebuilt-read";

/** Common Azure DI models — a discovery/pricing hint, NOT an allowlist: any
 *  model id (including custom `{modelId}`) is accepted and Azure validates it
 *  (an unknown model 404s → DocumentClientError). */
export const AZURE_DI_MODELS = [
  "prebuilt-read",
  "prebuilt-layout",
  "prebuilt-invoice",
  "prebuilt-receipt",
  "prebuilt-idDocument",
  "prebuilt-businessCard",
  "prebuilt-bankStatement.us",
  "prebuilt-tax.us.w2",
  "prebuilt-contract",
] as const;

export interface AzureDiAdapterOptions {
  /** Azure Document Intelligence resource endpoint, e.g. https://x.cognitiveservices.azure.com */
  endpoint: string;
  /** Ocp-Apim-Subscription-Key. */
  key: string;
  /** USD per page for the default model. */
  perPageUsd: number;
  /** Per-model USD/page overrides (Azure prices layout, prebuilt-* and custom
   *  models higher than read); falls back to perPageUsd for models not listed. */
  perPageUsdByModel?: Record<string, number>;
  apiVersion?: string;
  fetchImpl?: typeof fetch;
  /** Overall wall-clock budget for submit + poll. */
  timeoutMs?: number;
  pollIntervalMs?: number;
  /** Injectable for tests; defaults to a real setTimeout delay. */
  sleepImpl?: (ms: number) => Promise<void>;
}

interface AzureField {
  content?: string;
  type?: string;
  valueString?: string;
  valueNumber?: number;
  valueInteger?: number;
  valueDate?: string;
  valueBoolean?: boolean;
  confidence?: number;
}

interface AnalyzeResult {
  status?: string;
  error?: { message?: string };
  analyzeResult?: {
    content?: string;
    pages?: unknown[];
    tables?: Array<{
      rowCount?: number;
      columnCount?: number;
      cells?: Array<{
        rowIndex?: number;
        columnIndex?: number;
        content?: string;
        rowSpan?: number;
        columnSpan?: number;
      }>;
    }>;
    keyValuePairs?: Array<{ key?: { content?: string }; value?: { content?: string }; confidence?: number }>;
    documents?: Array<{ docType?: string; confidence?: number; fields?: Record<string, AzureField> }>;
  };
}

function mapField(f: AzureField): DocumentField {
  const value =
    f.valueString ??
    f.valueNumber ??
    f.valueInteger ??
    f.valueBoolean ??
    f.valueDate ??
    undefined;
  return {
    ...(f.content !== undefined ? { content: f.content } : {}),
    ...(value !== undefined ? { value } : {}),
    ...(f.type !== undefined ? { type: f.type } : {}),
    ...(f.confidence !== undefined ? { confidence: f.confidence } : {}),
  };
}

function mapStructured(ar: NonNullable<AnalyzeResult["analyzeResult"]>): Pick<DocumentResult, "tables" | "fields" | "documents"> {
  const out: Pick<DocumentResult, "tables" | "fields" | "documents"> = {};
  if (ar.tables?.length) {
    out.tables = ar.tables.map<DocumentTable>((t) => ({
      rowCount: t.rowCount ?? 0,
      columnCount: t.columnCount ?? 0,
      cells: (t.cells ?? []).map((c) => ({
        rowIndex: c.rowIndex ?? 0,
        columnIndex: c.columnIndex ?? 0,
        content: c.content ?? "",
        ...(c.rowSpan !== undefined ? { rowSpan: c.rowSpan } : {}),
        ...(c.columnSpan !== undefined ? { columnSpan: c.columnSpan } : {}),
      })),
    }));
  }
  if (ar.keyValuePairs?.length) {
    const fields: Record<string, DocumentField> = {};
    for (const kv of ar.keyValuePairs) {
      const name = kv.key?.content;
      if (!name) continue;
      fields[name] = {
        ...(kv.value?.content !== undefined ? { content: kv.value.content } : {}),
        ...(kv.confidence !== undefined ? { confidence: kv.confidence } : {}),
      };
    }
    if (Object.keys(fields).length) out.fields = fields;
  }
  if (ar.documents?.length) {
    out.documents = ar.documents.map<DocumentEntity>((d) => ({
      ...(d.docType !== undefined ? { docType: d.docType } : {}),
      ...(d.confidence !== undefined ? { confidence: d.confidence } : {}),
      fields: Object.fromEntries(Object.entries(d.fields ?? {}).map(([k, v]) => [k, mapField(v)])),
    }));
  }
  return out;
}

/**
 * Azure Document Intelligence. The analyze API is async: submit returns 202 +
 * an `operation-location`, polled to completion. The caller-selected `model`
 * (default `prebuilt-read`) picks the analyzer — `prebuilt-layout` adds tables,
 * `prebuilt-invoice`/`prebuilt-bankStatement.us`/etc. add structured `documents`.
 * Input `base64` is inline (`base64Source`); a `url` is passed as `urlSource`
 * for Azure to pull; `s3` is unsupported.
 */
export function createAzureDiAdapter(opts: AzureDiAdapterOptions): DocumentProviderAdapter {
  const doFetch = opts.fetchImpl ?? fetch;
  const apiVersion = opts.apiVersion ?? "2024-11-30";
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 1_000;
  const sleep = opts.sleepImpl ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const endpoint = opts.endpoint.replace(/\/$/, "");

  return {
    slug: "azure-di",
    supportedInputs: ["base64", "url"],
    supportedModels: AZURE_DI_MODELS,
    perPageUsd: opts.perPageUsd,
    perPageUsdFor(model?: string): number {
      return opts.perPageUsdByModel?.[model ?? DEFAULT_MODEL] ?? opts.perPageUsd;
    },
    async extract(source: DocumentSource, extractOpts?: DocumentExtractOptions): Promise<DocumentResult> {
      const model = extractOpts?.model ?? DEFAULT_MODEL;
      const body =
        source.kind === "url"
          ? { urlSource: source.url }
          : source.kind === "base64"
            ? { base64Source: source.base64 }
            : null;
      if (!body) {
        throw new DocumentClientError("azure-di supports base64 or url sources only");
      }
      const analyzeUrl = `${endpoint}/documentintelligence/documentModels/${encodeURIComponent(model)}:analyze?api-version=${apiVersion}`;

      const deadline = Date.now() + timeoutMs;

      let submit: Response;
      try {
        submit = await doFetch(analyzeUrl, {
          method: "POST",
          headers: { "Ocp-Apim-Subscription-Key": opts.key, "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        throw new DocumentProviderError(`azure-di submit failed: ${(err as Error).message}`, { cause: err });
      }
      if (submit.status !== 202) {
        const detail = await readTextSafe(submit);
        // 4xx incl. 404 for an unknown model id → client error (not retryable).
        if (submit.status >= 400 && submit.status < 500) {
          throw new DocumentClientError(`azure-di rejected the request (${submit.status}, model '${model}'): ${detail}`);
        }
        throw new DocumentProviderError(`azure-di submit error ${submit.status}: ${detail}`);
      }
      const opLocation = submit.headers.get("operation-location");
      if (!opLocation) {
        throw new DocumentProviderError("azure-di did not return an operation-location");
      }

      // Poll until succeeded/failed or the wall-clock budget is exhausted.
      for (;;) {
        if (Date.now() >= deadline) {
          throw new DocumentProviderError("azure-di analysis timed out");
        }
        await sleep(pollIntervalMs);
        let poll: Response;
        try {
          poll = await doFetch(opLocation, {
            headers: { "Ocp-Apim-Subscription-Key": opts.key },
            signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
          });
        } catch (err) {
          throw new DocumentProviderError(`azure-di poll failed: ${(err as Error).message}`, { cause: err });
        }
        if (!poll.ok) {
          const detail = await readTextSafe(poll);
          if (poll.status >= 400 && poll.status < 500) {
            throw new DocumentClientError(`azure-di poll rejected (${poll.status}): ${detail}`);
          }
          throw new DocumentProviderError(`azure-di poll error ${poll.status}: ${detail}`);
        }
        const result = await readJsonSafe<AnalyzeResult>(poll);
        const status = result.status;
        if (status === "succeeded") {
          const ar = result.analyzeResult ?? {};
          const pages = Array.isArray(ar.pages) ? ar.pages.length : 1;
          return {
            text: ar.content ?? "",
            pages: Math.max(1, pages),
            model: `azure-di/${model}`,
            ...mapStructured(ar),
            raw: result,
          };
        }
        if (status === "failed") {
          throw new DocumentProviderError(`azure-di analysis failed: ${result.error?.message ?? "unknown error"}`);
        }
        // status running/notStarted → continue polling.
      }
    },
  };
}
