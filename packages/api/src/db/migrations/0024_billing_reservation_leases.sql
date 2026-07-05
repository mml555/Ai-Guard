-- Per-request leases for prepaid-credit reservations, mirroring
-- budget_reservation_leases for the internal ledger: if a worker crashes (or a
-- settle write fails) between reserve and settle/release, the stranded
-- credits_reserved_usd would otherwise shrink the wallet's available balance
-- forever. The maintenance sweep releases leases older than
-- RESERVATION_STALE_MS by decrementing the wallet's reserved amount.
--
-- hold_id groups the leases of one request: the base reservation plus any
-- fallback top-ups. Settle deletes the whole hold; a targeted release deletes
-- one amount-matched lease (top-up rollback). Rows with the same
-- (hold_id, amount) are fungible.

CREATE TABLE IF NOT EXISTS billing_reservation_leases (
  id         bigserial      PRIMARY KEY,
  hold_id    text           NOT NULL,
  tenant_id  text           NOT NULL DEFAULT '',
  user_id    text           NOT NULL,
  amount_usd numeric(14, 6) NOT NULL,
  created_at timestamptz    NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS billing_reservation_leases_hold_idx
  ON billing_reservation_leases (hold_id);

CREATE INDEX IF NOT EXISTS billing_reservation_leases_created_at_idx
  ON billing_reservation_leases (created_at);
