import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../api/client";

interface AuditRecord {
  id: string;
  createdAt: string;
  actor: string;
  action: string;
  target?: string;
  tenantId?: string;
  metadata?: Record<string, unknown>;
}

interface VerifyResult {
  ok: boolean;
  /** id of the first tampered row (matches the API's `brokenAtId`). */
  brokenAtId?: string;
  /** number of rows walked (matches the API's `rows`). */
  rows?: number;
}

export function AuditPage() {
  const [items, setItems] = useState<AuditRecord[]>([]);
  const [error, setError] = useState("");
  const [action, setAction] = useState("");
  const [actor, setActor] = useState("");
  const [verify, setVerify] = useState<VerifyResult | null>(null);

  const reload = useCallback(() => {
    const params = new URLSearchParams();
    if (action) params.set("action", action);
    if (actor) params.set("actor", actor);
    const qs = params.toString();
    apiFetch<{ items: AuditRecord[] }>(`/v1/admin/audit${qs ? `?${qs}` : ""}`)
      .then((r) => setItems(r.items))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [action, actor]);

  useEffect(() => { reload(); }, [reload]);

  async function verifyChain() {
    setError("");
    setVerify(null);
    try {
      setVerify(await apiFetch<VerifyResult>("/v1/admin/audit/verify"));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div>
      <h1>Audit log</h1>
      <p>Tamper-evident admin action log. Requires <code>audit:read</code>.</p>
      {error && <p className="error">{error}</p>}

      <div className="card">
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "flex-start" }}>
          <input placeholder="Filter action (e.g. policy.activate)" value={action} onChange={(e) => setAction(e.target.value)} />
          <input placeholder="Filter actor" value={actor} onChange={(e) => setActor(e.target.value)} />
          <button type="button" onClick={verifyChain}>Verify chain</button>
        </div>
        {verify && (
          <p className={verify.ok ? "status-ok" : "status-fail"}>
            {verify.ok
              ? `Chain intact${typeof verify.rows === "number" ? ` (${verify.rows} entries)` : ""}.`
              : `Chain BROKEN${verify.brokenAtId ? ` at #${verify.brokenAtId}` : ""}.`}
          </p>
        )}
      </div>

      <div className="card">
        <table>
          <thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Target</th><th>Tenant</th></tr></thead>
          <tbody>
            {items.map((a) => (
              <tr key={a.id}>
                <td>{new Date(a.createdAt).toLocaleString()}</td>
                <td>{a.actor}</td>
                <td className="mono">{a.action}</td>
                <td className="mono">{a.target || "—"}</td>
                <td>{a.tenantId || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
