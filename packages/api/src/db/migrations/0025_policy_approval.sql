-- Two-person approval for policy versions (see docs/design/dynamic-policy.md).
--
-- Opt-in via POLICY_APPROVAL_REQUIRED. When on, a saved version is `proposed`
-- and cannot be activated until a DIFFERENT operator (holding policy:approve)
-- approves it. When off, versions are saved `approved` and the flow is unchanged.
--
-- Existing rows default to `approved` so nothing that was activatable before this
-- migration becomes un-activatable after it.

ALTER TABLE config_versions
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'approved',
  ADD COLUMN IF NOT EXISTS proposed_by text,
  ADD COLUMN IF NOT EXISTS reviewed_by text,
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;

-- The state machine: proposed -> approved | rejected. `approved` is the only
-- status that may be activated (enforced in the repo). A CHECK keeps out typos.
ALTER TABLE config_versions
  DROP CONSTRAINT IF EXISTS config_versions_status_check;
ALTER TABLE config_versions
  ADD CONSTRAINT config_versions_status_check
  CHECK (status IN ('proposed', 'approved', 'rejected'));

-- List/filter proposed versions (the approver's queue) without a full scan.
CREATE INDEX IF NOT EXISTS config_versions_tenant_status_idx
  ON config_versions (tenant_id, status);
