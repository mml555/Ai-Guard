import { apiFetch } from "./client";

export type PolicyStatus = "proposed" | "approved" | "rejected";

/** Mirrors ConfigVersionRecord from the API (metadata only; YAML is not listed). */
export interface PolicyVersion {
  id: string;
  createdAt: string;
  activatedAt?: string;
  note?: string;
  author?: string;
  checksum: string;
  active: boolean;
  status: PolicyStatus;
  proposedBy?: string;
  reviewedBy?: string;
  reviewedAt?: string;
}

/** Mirrors DiffEntry from the policy diff. */
export interface DiffEntry {
  path: string;
  from?: unknown;
  to?: unknown;
}

export interface PreviewResult {
  valid: boolean;
  error?: string;
  activeVersion?: string | null;
  diff?: DiffEntry[];
}

export const listVersions = (): Promise<PolicyVersion[]> =>
  apiFetch<{ items: PolicyVersion[] }>("/v1/admin/policy/versions").then((r) => r.items);

export const getActive = (): Promise<PolicyVersion | null> =>
  apiFetch<PolicyVersion>("/v1/admin/policy/active").catch(() => null);

export const previewPolicy = (yaml: string): Promise<PreviewResult> =>
  apiFetch<PreviewResult>("/v1/admin/policy/preview", {
    method: "POST",
    body: JSON.stringify({ yaml }),
  });

export const saveVersion = (yaml: string, note?: string): Promise<PolicyVersion> =>
  apiFetch<PolicyVersion>("/v1/admin/policy/versions", {
    method: "POST",
    body: JSON.stringify({ yaml, note: note || undefined }),
  });

export const diffAgainstActive = (id: string): Promise<{ from: string | null; to: string; diff: DiffEntry[] }> =>
  apiFetch(`/v1/admin/policy/versions/${id}/diff`);

export const activateVersion = (id: string): Promise<PolicyVersion & { note?: string }> =>
  apiFetch(`/v1/admin/policy/versions/${id}/activate`, { method: "POST" });

export const approveVersion = (id: string): Promise<PolicyVersion> =>
  apiFetch(`/v1/admin/policy/versions/${id}/approve`, { method: "POST" });

export const rejectVersion = (id: string): Promise<PolicyVersion> =>
  apiFetch(`/v1/admin/policy/versions/${id}/reject`, { method: "POST" });
