-- M2 schema v2 — licensing worker master DB (Turso).
-- Applies on top of schema.sql. Idempotent (IF NOT EXISTS everywhere).
--
-- E-0265 (M2 security batch):
--   * rate_limits  — fixed-window counters backing EDGE-1 (seat-squatting DoS)
--                    and EDGE-2 (/verify key-existence oracle). Identities are
--                    PEPPERED hashes only (IP_PEPPER / LICENSE_PEPPER) — never
--                    raw IPs or keys.
--   * customers / trial_devices — M2 trial funnel storage (POST /trial/register
--                    lands separately; tables ship with the same migration so
--                    the deploy is one atomic step).

CREATE TABLE IF NOT EXISTS rate_limits (
    bucket        TEXT NOT NULL,      -- 'activate_ip' | 'activate_key' | 'verify_ip' | 'verify_key' | 'deactivate_ip' | 'deactivate_key' | 'trial_ip' | 'admin_ip'
    identity      TEXT NOT NULL,      -- peppered HMAC-SHA256 hex of the IP or normalized key
    window_start  INTEGER NOT NULL,   -- epoch seconds, aligned to the bucket's window size
    count         INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (bucket, identity, window_start)
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_sweep ON rate_limits(bucket, window_start);

-- Trial funnel (M2): one row per signup lead. `id` is client-supplied
-- Idempotency-Key so a retried POST cannot create a second lead.
CREATE TABLE IF NOT EXISTS customers (
    id            TEXT PRIMARY KEY,   -- Idempotency-Key (UUID from the client)
    full_name     TEXT NOT NULL,
    whatsapp      TEXT NOT NULL,      -- normalized digits, E.164-ish, validated app-side
    created_at    TEXT NOT NULL,      -- ISO 8601 UTC
    source        TEXT NOT NULL DEFAULT 'trial_screen',
    status        TEXT NOT NULL DEFAULT 'lead' CHECK (status IN ('lead','contacted','converted','lost'))
);

CREATE TABLE IF NOT EXISTS trial_devices (
    id            TEXT PRIMARY KEY,
    customer_id   TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    device_id     TEXT NOT NULL,      -- adopted device identity (SSAID/hwid hash)
    device_type   TEXT NOT NULL CHECK (device_type IN ('desktop','mobile')),
    license_id    TEXT,               -- set when the trial licence is minted
    registered_at TEXT NOT NULL,      -- ISO 8601 UTC
    UNIQUE(customer_id, device_id)
);

CREATE INDEX IF NOT EXISTS idx_trial_devices_customer ON trial_devices(customer_id);
