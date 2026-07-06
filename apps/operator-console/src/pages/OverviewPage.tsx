import { useEffect, useState } from "react";
import { fetchBudgetCounters, fetchUsageSummary, type UsageSummary } from "../api/usage";
import { usePolling } from "../usePolling";
import { agoLabel, fmtUsd, outcomeBars, spendVsCap, type SpendVsCap } from "../usageView";

const WINDOWS = ["24h", "7d", "30d"] as const;
const POLL_MS = 15_000;

function levelClass(level: SpendVsCap["level"]): string {
  return level === "crit" ? "status-fail" : level === "warn" ? "status-warn" : "status-ok";
}

function SpendGauge({ spend }: { spend: SpendVsCap }) {
  return (
    <div className="card">
      <h2>Global spend {spend.hasCap ? "vs cap" : "(this month)"}</h2>
      <div className="metrics-row">
        <div className="metric">
          <div className="metric-label">Used</div>
          <div className="metric-value">{fmtUsd(spend.usedUsd)}</div>
        </div>
        <div className="metric">
          <div className="metric-label">Reserved (in flight)</div>
          <div className="metric-value">{fmtUsd(spend.reservedUsd)}</div>
        </div>
        {spend.hasCap && (
          <div className="metric">
            <div className="metric-label">Monthly cap</div>
            <div className="metric-value">{fmtUsd(spend.capUsd ?? 0)}</div>
          </div>
        )}
      </div>
      {spend.hasCap ? (
        <>
          <div className="bar-track" style={{ marginTop: "0.7rem" }}>
            <span className={`bar-fill ${levelClass(spend.level)}`} style={{ width: `${spend.pct}%` }} />
          </div>
          <p className="muted">
            {spend.pct.toFixed(1)}% of cap — {fmtUsd(spend.committedUsd)} of {fmtUsd(spend.capUsd ?? 0)} committed
          </p>
        </>
      ) : (
        <p className="muted">No global monthly cap configured — showing spend only.</p>
      )}
    </div>
  );
}

function OutcomeChart({ summary }: { summary: UsageSummary }) {
  const bars = outcomeBars(summary);
  return (
    <div className="card">
      <h2>Request outcomes ({summary.requests} requests)</h2>
      {summary.requests === 0 ? (
        <p className="muted">No requests in this window.</p>
      ) : (
        bars.map((b) => (
          <div className="bar-row" key={b.key}>
            <span>{b.label}</span>
            <span className="bar-track">
              <span className={`bar-fill ${b.cls}`} style={{ width: `${b.pct}%` }} />
            </span>
            <span className="num">
              {b.count} ({b.pct.toFixed(1)}%)
            </span>
          </div>
        ))
      )}
    </div>
  );
}

export function OverviewPage() {
  const [since, setSince] = useState<(typeof WINDOWS)[number]>("7d");
  const [live, setLive] = useState(true);
  // Ticks once a second while live so the "updated Ns ago" label counts up.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [live]);

  const summary = usePolling<UsageSummary>(() => fetchUsageSummary(since), POLL_MS, live, [since]);
  const counters = usePolling(fetchBudgetCounters, POLL_MS, live);

  const spend = spendVsCap(counters.data?.globalMonthly);
  const error = summary.error || counters.error;
  const updatedAt = summary.updatedAt ?? counters.updatedAt;

  return (
    <div>
      <h1>Overview</h1>
      <div className="toolbar">
        {WINDOWS.map((w) => (
          <button
            type="button"
            key={w}
            className={`chip ${since === w ? "active" : ""}`}
            onClick={() => setSince(w)}
          >
            {w}
          </button>
        ))}
        <span className="spacer" />
        {updatedAt && <span className="muted">updated {agoLabel(updatedAt, now)}</span>}
        <button type="button" className={`chip ${live ? "active" : ""}`} onClick={() => setLive((v) => !v)}>
          {live ? "● live" : "paused"}
        </button>
        <button type="button" className="chip" onClick={() => { void summary.refresh(); void counters.refresh(); }}>
          refresh
        </button>
      </div>

      <p className="muted">Tenant-scoped to your key. Auto-refreshes every {POLL_MS / 1000}s while live.</p>
      {error && <p className="error">{error}</p>}

      {counters.data && <SpendGauge spend={spend} />}
      {summary.data && <OutcomeChart summary={summary.data} />}

      {summary.data && (summary.data.topReasonCode || summary.data.topModel) && (
        <div className="card">
          <h2>Top ({since})</h2>
          <div className="metrics-row">
            <div className="metric">
              <div className="metric-label">Actual cost</div>
              <div className="metric-value">{fmtUsd(summary.data.actualCostUsd)}</div>
            </div>
            <div className="metric">
              <div className="metric-label">Estimated cost</div>
              <div className="metric-value">{fmtUsd(summary.data.estimatedCostUsd)}</div>
            </div>
          </div>
          {summary.data.topReasonCode && (
            <p>Top block reason: <strong>{summary.data.topReasonCode.code}</strong> ({summary.data.topReasonCode.count})</p>
          )}
          {summary.data.topModel && (
            <p>Top model: <strong>{summary.data.topModel.model}</strong> ({summary.data.topModel.count})</p>
          )}
        </div>
      )}
    </div>
  );
}
