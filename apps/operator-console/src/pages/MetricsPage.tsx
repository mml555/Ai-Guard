import { useState } from "react";
import { fetchMetricsText, getMetricsToken, setMetricsToken } from "../api/metrics";
import {
  familiesWithPrefix,
  familyTotal,
  parsePrometheus,
  type MetricFamily,
} from "../prometheus";
import { usePolling } from "../usePolling";

const POLL_MS = 15_000;

const KEY_METRICS: { name: string; label: string; fmt?: (n: number) => string }[] = [
  { name: "modelgov_chat_requests_total", label: "Chat requests" },
  { name: "modelgov_chat_cost_usd_total", label: "Cost (USD)", fmt: (n) => `$${n.toFixed(4)}` },
  { name: "modelgov_chat_fallbacks_total", label: "Fallbacks" },
  { name: "modelgov_budget_blocks_total", label: "Budget blocks" },
  { name: "modelgov_safety_blocks_total", label: "Safety blocks" },
];

function labelStr(labels: Record<string, string>): string {
  const entries = Object.entries(labels);
  return entries.length ? entries.map(([k, v]) => `${k}=${v}`).join(", ") : "—";
}

function FamilyTable({ family }: { family: MetricFamily }) {
  return (
    <div className="card">
      <h2 className="mono">{family.name}</h2>
      {family.help && <p className="muted">{family.help}</p>}
      <table>
        <thead><tr><th>Labels</th><th>Value</th></tr></thead>
        <tbody>
          {family.samples.map((s, i) => (
            <tr key={i}>
              <td className="mono">{labelStr(s.labels)}</td>
              <td className="num mono">{s.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function MetricsPage() {
  const [token, setToken] = useState(getMetricsToken());
  const [live, setLive] = useState(false);

  // Poll with the SAVED token (getMetricsToken), not the in-progress input, and
  // don't key on `token` — otherwise every keystroke refetches with the stale
  // saved value. A new token takes effect when saveToken() persists it and
  // explicitly refreshes.
  const metrics = usePolling<MetricFamily[]>(
    () => fetchMetricsText(getMetricsToken()).then(parsePrometheus),
    POLL_MS,
    live,
  );

  function saveToken() {
    setMetricsToken(token);
    void metrics.refresh();
  }

  const families = metrics.data ?? [];
  const domain = familiesWithPrefix(families, "modelgov_");

  return (
    <div>
      <h1>Metrics (Prometheus)</h1>
      <p className="muted">
        Deployment-wide counters scraped from <code>/metrics</code> — not tenant-scoped
        (that's the Overview). Requires the gateway's <code>METRICS_AUTH_TOKEN</code> if set.
      </p>

      <div className="card">
        <input
          type="password"
          placeholder="METRICS_AUTH_TOKEN (leave blank if /metrics is unauthenticated)"
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
        <div className="toolbar">
          <button type="button" onClick={saveToken}>Load</button>
          <button type="button" className={`chip ${live ? "active" : ""}`} onClick={() => setLive((v) => !v)}>
            {live ? "● live" : "paused"}
          </button>
        </div>
      </div>

      {metrics.error && <p className="error">{metrics.error}</p>}

      {domain.length > 0 && (
        <div className="card">
          <h2>Domain counters</h2>
          <div className="metrics-row">
            {KEY_METRICS.map((k) => {
              const total = familyTotal(families, k.name);
              return (
                <div className="metric" key={k.name}>
                  <div className="metric-label">{k.label}</div>
                  <div className="metric-value">{k.fmt ? k.fmt(total) : total}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {domain.map((f) => <FamilyTable key={f.name} family={f} />)}

      {metrics.data && domain.length === 0 && !metrics.error && (
        <p className="muted">No <code>modelgov_*</code> metrics found — has any traffic been served yet?</p>
      )}
    </div>
  );
}
