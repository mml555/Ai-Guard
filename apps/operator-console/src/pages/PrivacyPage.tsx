import { useState } from "react";
import { apiFetch } from "../api/client";

interface ErasureResult {
  requestLogs?: number;
  [k: string]: unknown;
}

export function PrivacyPage() {
  const [userId, setUserId] = useState("");
  const [confirm, setConfirm] = useState("");
  const [result, setResult] = useState<ErasureResult | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // Require the operator to retype the userId — erasure is irreversible.
  const armed = userId.length > 0 && confirm === userId;

  async function erase() {
    setError("");
    setResult(null);
    setBusy(true);
    try {
      setResult(await apiFetch<ErasureResult>("/v1/admin/erasure", {
        method: "POST",
        body: JSON.stringify({ userId }),
      }));
      setUserId("");
      setConfirm("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h1>Privacy — data erasure (DSAR)</h1>
      <p>
        Erase a user's request-linked data (GDPR/CCPA). Requires <code>data:erase</code>.
        This is <strong>irreversible</strong>.
      </p>
      {error && <p className="error">{error}</p>}
      {result && (
        <div className="card status-ok">
          Erasure complete. <pre className="mono">{JSON.stringify(result, null, 2)}</pre>
        </div>
      )}
      <div className="card">
        <input placeholder="userId to erase" value={userId} onChange={(e) => setUserId(e.target.value)} />
        <input placeholder="Retype userId to confirm" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        <button type="button" onClick={erase} disabled={!armed || busy}>
          Erase user data
        </button>
        {userId && !armed && <p className="hint">Retype the userId exactly to enable erasure.</p>}
      </div>
    </div>
  );
}
