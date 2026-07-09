// Document-AI provider client — the SECOND egress. Unlike LLM traffic (which the
// gateway hands to the LiteLLM proxy), OCR / document-extraction services
// (Tesseract, Azure Document Intelligence, and later Textract) are not LLM-chat,
// so the gateway calls them directly through these adapters. Mirrors the shape of
// services/litellm.ts: an interface + injected implementation + a test mock.

/** A document to extract text from. Exactly one source kind per request. */
export type DocumentSource =
  | { kind: "base64"; base64: string }
  | { kind: "url"; url: string }
  | { kind: "s3"; s3: string };

export type DocumentInputKind = DocumentSource["kind"];

/** One cell of an extracted table (0-indexed row/column). */
export interface DocumentTableCell {
  rowIndex: number;
  columnIndex: number;
  content: string;
  rowSpan?: number;
  columnSpan?: number;
}

/** A table extracted by a structure-aware model (e.g. Azure DI prebuilt-layout). */
export interface DocumentTable {
  rowCount: number;
  columnCount: number;
  cells: DocumentTableCell[];
}

/** A key/value or prebuilt-model field. */
export interface DocumentField {
  content?: string;
  /** Typed value when the model provides one (string/number/date/…). */
  value?: string | number | boolean | null;
  type?: string;
  confidence?: number;
}

/** A prebuilt-model document result (e.g. one bank statement / invoice). */
export interface DocumentEntity {
  docType?: string;
  confidence?: number;
  fields: Record<string, DocumentField>;
}

export interface DocumentResult {
  /** Extracted plain text (concatenated across pages). */
  text: string;
  /** Pages the provider actually processed — the billing quantity. */
  pages: number;
  /** Provider/model identifier stamped on the audit row's resolved_model. */
  model?: string;
  /** Structured tables (structure-aware models only). */
  tables?: DocumentTable[];
  /** Flat key/value fields (Azure DI keyValuePairs + prebuilt document fields). */
  fields?: Record<string, DocumentField>;
  /** Full prebuilt-model document results (docType + fields). */
  documents?: DocumentEntity[];
  raw?: unknown;
}

/** Per-request options threaded from the caller to the provider adapter. */
export interface DocumentExtractOptions {
  /** Provider-specific model, e.g. Azure DI "prebuilt-layout" / "prebuilt-bankStatement". */
  model?: string;
}

export interface DocumentProviderAdapter {
  /** Provider slug, e.g. "tesseract", "azure-di". */
  readonly slug: string;
  /** Which document source kinds this provider accepts. */
  readonly supportedInputs: readonly DocumentInputKind[];
  /** Models this provider accepts. Absent/empty ⇒ no model selection (the caller
   *  must not pass a `model`); the service rejects an unsupported model. */
  readonly supportedModels?: readonly string[];
  /** USD per page for the default model — the reserve/settle cost basis. */
  readonly perPageUsd: number;
  /** USD per page for a specific model (Azure DI prices vary by model). Falls
   *  back to {@link perPageUsd} when unset. */
  perPageUsdFor?(model?: string): number;
  extract(source: DocumentSource, opts?: DocumentExtractOptions): Promise<DocumentResult>;
}

/** The set of enabled document providers, selected by env config. */
export interface DocumentAiClient {
  /** Enabled provider slugs. */
  providers(): string[];
  /** The adapter for a slug, or undefined when the provider is not configured. */
  get(provider: string): DocumentProviderAdapter | undefined;
}

/**
 * A transient provider failure (5xx / network) — retryable. Mirrors
 * litellm's `ProviderError` so the service maps it the same way (502, retryable).
 */
export class DocumentProviderError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DocumentProviderError";
  }
}

/**
 * A 4xx from the provider (bad document / config) — NOT retryable. Mirrors
 * litellm's `LiteLLMClientError`.
 */
export class DocumentClientError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DocumentClientError";
  }
}
