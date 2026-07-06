import { useCallback, useEffect, useState } from "react";
import {
  activateVersion,
  approveVersion,
  diffAgainstActive,
  getActive,
  listVersions,
  previewPolicy,
  rejectVersion,
  saveVersion,
  type DiffEntry,
  type PolicyVersion,
} from "../api/policy";
import { can } from "../permissions";
import { usePermissions } from "../whoami-context";
import { diffLine, statusClass } from "../policyView";

export function PolicyPage() {
  const perms = usePermissions();
  const canWrite = can(perms, "policy:write");
  const canApprove = can(perms, "policy:approve");

  const [versions, setVersions] = useState<PolicyVersion[]>([]);
  const [active, setActive] = useState<PolicyVersion | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  // Editor state.
  const [yaml, setYaml] = useState("");
  const [note, setNote] = useState("");
  const [preview, setPreview] = useState<{ valid: boolean; error?: string; diff?: DiffEntry[] } | null>(null);
  const [busy, setBusy] = useState(false);

  // Row diff panel.
  const [diffFor, setDiffFor] = useState<{ id: string; diff: DiffEntry[] } | null>(null);

  const reload = useCallback(() => {
    Promise.all([listVersions().catch(() => []), getActive()])
      .then(([v, a]) => {
        setVersions(v);
        setActive(a);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => { reload(); }, [reload]);

  function run(action: () => Promise<unknown>, okMsg: string) {
    setError("");
    setNotice("");
    setBusy(true);
    action()
      .then((r) => {
        const withNote = r as { note?: string };
        setNotice(withNote?.note ? `${okMsg} — ${withNote.note}` : okMsg);
        reload();
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  }

  async function onValidate() {
    setError("");
    setNotice("");
    setPreview(null);
    try {
      const res = await previewPolicy(yaml);
      setPreview({ valid: res.valid, error: res.error, diff: res.diff });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function onShowDiff(id: string) {
    setError("");
    try {
      const res = await diffAgainstActive(id);
      setDiffFor({ id, diff: res.diff });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div>
      <h1>Policy</h1>
      <p>
        Versioned <code>modelgov.yaml</code>. Requires <code>policy:read</code>;
        editing needs <code>policy:write</code>
        {canApprove ? "; you can approve proposals" : ""}.
      </p>
      {error && <p className="error">{error}</p>}
      {notice && <p className="status-ok">{notice}</p>}

      {active && (
        <div className="card">
          <h2>Active version</h2>
          <p className="mono">
            #{active.id} · saved {new Date(active.createdAt).toLocaleString()}
            {active.activatedAt ? ` · activated ${new Date(active.activatedAt).toLocaleString()}` : ""}
          </p>
          {active.note && <p>{active.note}</p>}
        </div>
      )}

      {canWrite && (
        <div className="card">
          <h2>New version</h2>
          <textarea
            rows={12}
            className="mono"
            placeholder="Paste modelgov.yaml…"
            value={yaml}
            onChange={(e) => setYaml(e.target.value)}
          />
          <input placeholder="Change note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button type="button" className="secondary" onClick={onValidate} disabled={!yaml || busy}>
              Validate &amp; diff
            </button>
            <button
              type="button"
              onClick={() => run(() => saveVersion(yaml, note), "Version saved")}
              disabled={!yaml || busy}
            >
              Save version
            </button>
          </div>
          {preview && (
            <div className={`card ${preview.valid ? "status-ok" : "status-fail"}`} style={{ marginTop: "0.75rem" }}>
              {preview.valid ? (
                <>
                  <strong>Valid.</strong>
                  {preview.diff && preview.diff.length > 0 ? (
                    <ul className="mono">{preview.diff.map((d) => <li key={d.path}>{diffLine(d)}</li>)}</ul>
                  ) : (
                    <p>No changes vs the active version.</p>
                  )}
                </>
              ) : (
                <><strong>Invalid:</strong> <span className="mono">{preview.error}</span></>
              )}
            </div>
          )}
        </div>
      )}

      <div className="card">
        <h2>Version history</h2>
        <table>
          <thead>
            <tr><th>ID</th><th>Status</th><th>Note</th><th>Proposed by</th><th>Reviewed by</th><th>Created</th><th /></tr>
          </thead>
          <tbody>
            {versions.map((v) => (
              <tr key={v.id}>
                <td className="mono">#{v.id}{v.active && <span className="status-ok"> ● active</span>}</td>
                <td className={statusClass(v.status)}>{v.status}</td>
                <td>{v.note ?? "—"}</td>
                <td>{v.proposedBy ?? "—"}</td>
                <td>{v.reviewedBy ?? "—"}</td>
                <td>{new Date(v.createdAt).toLocaleString()}</td>
                <td style={{ display: "flex", gap: "0.35rem", flexWrap: "wrap" }}>
                  <button type="button" className="secondary" onClick={() => onShowDiff(v.id)}>Diff</button>
                  {canApprove && v.status === "proposed" && (
                    <>
                      <button type="button" onClick={() => run(() => approveVersion(v.id), `Approved #${v.id}`)} disabled={busy}>Approve</button>
                      <button type="button" className="secondary" onClick={() => run(() => rejectVersion(v.id), `Rejected #${v.id}`)} disabled={busy}>Reject</button>
                    </>
                  )}
                  {canWrite && v.status === "approved" && !v.active && (
                    <button type="button" onClick={() => run(() => activateVersion(v.id), `Activated #${v.id}`)} disabled={busy}>
                      {active ? "Activate / rollback" : "Activate"}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {diffFor && (
          <div className="card" style={{ marginTop: "0.75rem" }}>
            <strong>Diff of #{diffFor.id} vs active</strong>
            {diffFor.diff.length > 0 ? (
              <ul className="mono">{diffFor.diff.map((d) => <li key={d.path}>{diffLine(d)}</li>)}</ul>
            ) : (
              <p>No differences.</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
