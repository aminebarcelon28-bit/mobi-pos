PRAGMA foreign_keys = ON;

-- 1. Licenses Table: Master record of issued licenses and encrypted BYODB credentials
CREATE TABLE IF NOT EXISTS licenses (
    id TEXT PRIMARY KEY,
    key_hash TEXT NOT NULL UNIQUE,                 -- Blind index: Hex HMAC-SHA256(LICENSE_PEPPER, normalized_key)
    customer_name TEXT NOT NULL,                   -- Business / Merchant name
    license_type TEXT NOT NULL CHECK (
        license_type IN ('24H', '90D', 'LIFETIME', 'TRIAL', 'CUSTOM')
    ),
    status TEXT NOT NULL DEFAULT 'active' CHECK (
        status IN ('active', 'suspended', 'revoked', 'expired')
    ),
    max_desktops INTEGER NOT NULL DEFAULT 1 CHECK (max_desktops >= 0),
    max_mobiles INTEGER NOT NULL DEFAULT 1 CHECK (max_mobiles >= 0),
    encrypted_turso_token TEXT NOT NULL,           -- Versioned ciphertext: 'v1:<base64(12B_iv + cipher + 16B_tag)>'
    turso_url TEXT NOT NULL,                       -- Dedicated client LibSQL URL: 'libsql://tenant.turso.io'
    created_at TEXT NOT NULL,                      -- ISO 8601 UTC
    updated_at TEXT NOT NULL,                      -- ISO 8601 UTC
    expires_at TEXT                                -- NULL for LIFETIME, ISO 8601 UTC for time-bounded licenses
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_licenses_key_hash ON licenses(key_hash);
CREATE INDEX IF NOT EXISTS idx_licenses_status_expires ON licenses(status, expires_at);

-- 2. License Activations Table: Tracks bound hardware seats
CREATE TABLE IF NOT EXISTS license_activations (
    id TEXT PRIMARY KEY,
    license_id TEXT NOT NULL REFERENCES licenses(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL,                       -- Hardware fingerprint or stable device UUID
    device_type TEXT NOT NULL CHECK (
        device_type IN ('desktop', 'mobile')
    ),
    hardware_hash TEXT NOT NULL,                   -- SHA-256 hash of device identity
    friendly_name TEXT NOT NULL DEFAULT '',        -- e.g. 'Caisse Principale', 'Tablette Vendeur'
    activated_at TEXT NOT NULL,                    -- ISO 8601 UTC
    last_ping_at TEXT NOT NULL,                    -- ISO 8601 UTC
    ip_hash TEXT NOT NULL,                         -- Pseudonymized HMAC-SHA256(IP_PEPPER, client_ip)
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    UNIQUE(license_id, device_id)                  -- Ensures 1 row per physical device per license
);

CREATE INDEX IF NOT EXISTS idx_activations_lic_type ON license_activations(license_id, device_type, is_active);
CREATE INDEX IF NOT EXISTS idx_activations_last_ping ON license_activations(last_ping_at);
CREATE INDEX IF NOT EXISTS idx_activations_hw_hash ON license_activations(hardware_hash);

-- Triggers for atomic seat quota enforcement inside SQLite write transactions
CREATE TRIGGER IF NOT EXISTS trg_enforce_desktop_quota_insert
BEFORE INSERT ON license_activations
FOR EACH ROW
WHEN NEW.device_type = 'desktop' AND NEW.is_active = 1
BEGIN
    SELECT CASE
        WHEN (
            NOT EXISTS (
                SELECT 1 FROM license_activations 
                WHERE license_id = NEW.license_id AND device_id = NEW.device_id
            )
            AND (
                SELECT COUNT(*) FROM license_activations 
                WHERE license_id = NEW.license_id AND device_type = 'desktop' AND is_active = 1
            ) >= (SELECT max_desktops FROM licenses WHERE id = NEW.license_id)
        )
        THEN RAISE(ABORT, 'QUOTA_EXCEEDED_DESKTOP: Limite de postes de caisse atteinte pour cette licence.')
    END;
END;

CREATE TRIGGER IF NOT EXISTS trg_enforce_desktop_quota_update
BEFORE UPDATE OF is_active, device_type ON license_activations
FOR EACH ROW
WHEN NEW.device_type = 'desktop' AND NEW.is_active = 1 AND OLD.is_active = 0
BEGIN
    SELECT CASE
        WHEN (
            SELECT COUNT(*) FROM license_activations 
            WHERE license_id = NEW.license_id 
              AND device_type = 'desktop' 
              AND is_active = 1 
              AND id != NEW.id
        ) >= (SELECT max_desktops FROM licenses WHERE id = NEW.license_id)
        THEN RAISE(ABORT, 'QUOTA_EXCEEDED_DESKTOP: Limite de postes de caisse atteinte pour cette licence.')
    END;
END;

CREATE TRIGGER IF NOT EXISTS trg_enforce_mobile_quota_insert
BEFORE INSERT ON license_activations
FOR EACH ROW
WHEN NEW.device_type = 'mobile' AND NEW.is_active = 1
BEGIN
    SELECT CASE
        WHEN (
            NOT EXISTS (
                SELECT 1 FROM license_activations 
                WHERE license_id = NEW.license_id AND device_id = NEW.device_id
            )
            AND (
                SELECT COUNT(*) FROM license_activations 
                WHERE license_id = NEW.license_id AND device_type = 'mobile' AND is_active = 1
            ) >= (SELECT max_mobiles FROM licenses WHERE id = NEW.license_id)
        )
        THEN RAISE(ABORT, 'QUOTA_EXCEEDED_MOBILE: Limite d''appareils mobiles atteinte pour cette licence.')
    END;
END;

CREATE TRIGGER IF NOT EXISTS trg_enforce_mobile_quota_update
BEFORE UPDATE OF is_active, device_type ON license_activations
FOR EACH ROW
WHEN NEW.device_type = 'mobile' AND NEW.is_active = 1 AND OLD.is_active = 0
BEGIN
    SELECT CASE
        WHEN (
            SELECT COUNT(*) FROM license_activations 
            WHERE license_id = NEW.license_id 
              AND device_type = 'mobile' 
              AND is_active = 1 
              AND id != NEW.id
        ) >= (SELECT max_mobiles FROM licenses WHERE id = NEW.license_id)
        THEN RAISE(ABORT, 'QUOTA_EXCEEDED_MOBILE: Limite d''appareils mobiles atteinte pour cette licence.')
    END;
END;

