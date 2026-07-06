import { apiBase } from "./client";

const METRICS_TOKEN_KEY = "modelgov-console-metrics-token";

export function getMetricsToken(): string {
  return sessionStorage.getItem(METRICS_TOKEN_KEY) ?? "";
}

export function setMetricsToken(token: string): void {
  if (token) sessionStorage.setItem(METRICS_TOKEN_KEY, token);
  else sessionStorage.removeItem(METRICS_TOKEN_KEY);
}

export class MetricsError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

/**
 * Fetch the raw Prometheus `/metrics` text. This is a separate path from
 * `apiFetch`: /metrics has its own bearer (METRICS_AUTH_TOKEN, not the operator
 * JWT), and a 401 here must not log the operator out. Returns the body text;
 * throws MetricsError with the status on failure so the page can guide setup.
 */
export async function fetchMetricsText(token: string): Promise<string> {
  const headers = new Headers();
  if (token) headers.set("authorization", `Bearer ${token}`);
  let res: Response;
  try {
    res = await fetch(`${apiBase()}/metrics`, { headers });
  } catch {
    throw new MetricsError(
      "Could not reach /metrics — check the API URL, that METRICS_ENABLED=true, and that this origin is in CORS_ALLOW_ORIGINS.",
    );
  }
  if (res.status === 401) {
    throw new MetricsError("Metrics token required or invalid (METRICS_AUTH_TOKEN).", 401);
  }
  if (res.status === 404) {
    throw new MetricsError("No /metrics endpoint — the gateway was started with METRICS_ENABLED off.", 404);
  }
  if (!res.ok) {
    throw new MetricsError(`/metrics returned HTTP ${res.status}`, res.status);
  }
  return res.text();
}
