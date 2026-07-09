import { lookup } from "node:dns/promises";
import { assertPublicHttpUrl, isPrivateHttpHost } from "../../util/httpUrlGuard";
import { DocumentClientError, DocumentProviderError, type DocumentSource } from "./types";

/** Cap on a gateway-fetched document (`url` source) — inline base64 is already
 *  bounded by the request body limit; a fetched URL is not, so bound it here. */
export const DEFAULT_URL_MAX_BYTES = 25 * 1024 * 1024;

/** Read a response body as text, tolerating a broken/empty body (error paths). */
export async function readTextSafe(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

/** Parse a response body as JSON, tolerating a non-JSON/empty body. */
export async function readJsonSafe<T>(res: Response): Promise<T> {
  try {
    return (await res.json()) as T;
  } catch {
    return {} as T;
  }
}

/**
 * Validate a caller-supplied document URL before the gateway fetches it. Unlike
 * the operator-configured webhook URLs `assertPublicHttpUrl` was built for, this
 * URL is UNTRUSTED caller input, so the syntactic host check is not enough (a
 * public hostname can resolve to a private/metadata address). We therefore also
 * resolve the host and reject if ANY resolved address is private/link-local —
 * the upgrade `httpUrlGuard`'s own comment calls for. Returns the validated URL.
 *
 * Residual TOCTOU (the host could re-resolve differently when fetch connects) is
 * further contained by refusing to follow redirects in {@link fetchDocumentBytes}.
 */
export async function assertFetchableDocumentUrl(rawUrl: string): Promise<URL> {
  let target: URL;
  try {
    target = assertPublicHttpUrl(rawUrl);
  } catch (err) {
    throw new DocumentClientError((err as Error).message);
  }
  if (target.protocol !== "https:") {
    throw new DocumentClientError("document url must be https");
  }
  let resolved: Array<{ address: string }>;
  try {
    resolved = await lookup(target.hostname, { all: true });
  } catch (err) {
    throw new DocumentClientError(`could not resolve document url host: ${(err as Error).message}`);
  }
  for (const { address } of resolved) {
    if (isPrivateHttpHost(address)) {
      throw new DocumentClientError(
        `document url host '${target.hostname}' resolves to a private/link-local address (SSRF guard)`,
      );
    }
  }
  return target;
}

/**
 * Resolve a document source to raw base64 for adapters that must send bytes
 * (Tesseract, Textract inline). `base64` passes through; `url` is SSRF-validated
 * (DNS-checked) and streamed by the gateway with an incremental size cap so an
 * unbounded/chunked body can't be buffered whole; `s3` cannot be materialized
 * here (only a provider that pulls it — Textract — supports it) and is rejected.
 */
export async function sourceToBase64(
  source: DocumentSource,
  fetchImpl: typeof fetch,
  opts: { timeoutMs: number; maxBytes?: number },
): Promise<string> {
  if (source.kind === "base64") return source.base64;
  if (source.kind === "s3") {
    throw new DocumentClientError("this provider cannot fetch an s3 source; supply base64 or a url");
  }
  const target = await assertFetchableDocumentUrl(source.url);
  const maxBytes = opts.maxBytes ?? DEFAULT_URL_MAX_BYTES;

  let res: Response;
  try {
    // redirect:"manual" — never follow a 3xx to a fresh (unvalidated) host; that
    // is the SSRF-via-redirect vector (mirrors budgetAlerts/webhookOutbox).
    res = await fetchImpl(target.href, { redirect: "manual", signal: AbortSignal.timeout(opts.timeoutMs) });
  } catch (err) {
    throw new DocumentProviderError(`failed to fetch document url: ${(err as Error).message}`, { cause: err });
  }
  if (res.status >= 300 && res.status < 400) {
    throw new DocumentClientError("document url returned a redirect; redirects are not followed (SSRF guard)");
  }
  if (!res.ok) {
    throw new DocumentClientError(`document url returned ${res.status}`);
  }
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared && declared > maxBytes) {
    throw new DocumentClientError(`document exceeds ${maxBytes} bytes`);
  }

  // Stream with a running byte cap so a chunked / undeclared-length body can't be
  // buffered whole into memory before the size check.
  const body = res.body;
  if (!body) throw new DocumentProviderError("document url returned no body");
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new DocumentClientError(`document exceeds ${maxBytes} bytes`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("base64");
}
