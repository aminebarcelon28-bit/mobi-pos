import { createClient } from '@libsql/client/web';
import {
  hashHmac,
  decryptTursoToken,
  signLicenseJwt,
  type LicenseTokenClaims,
} from './crypto';

export interface Env {
  MASTER_TURSO_URL: string;
  MASTER_TURSO_TOKEN: string;
  MASTER_ENCRYPTION_KEY: string;
  LICENSE_PEPPER: string;
  IP_PEPPER: string;
  LICENSE_ED25519_PRIVATE_JWK: string;
}

interface ActivationRequestBody {
  license_key: string;
  device_id: string;
  device_type: 'desktop' | 'mobile';
  hardware_hash?: string;
  friendly_name?: string;
  client_nonce?: string;
}

interface VerifyRequestBody {
  license_key: string;
  device_id: string;
}

interface DeactivateRequestBody {
  license_key: string;
  device_id: string;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}

function normalizeLicenseKey(rawKey: string): string {
  return rawKey.trim().toUpperCase().replace(/[^0-9A-Z]/g, '');
}

const DUMMY_CIPHERTEXT =
  'v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // 1. Health Probe
    if (path === '/health' || path === '/') {
      return jsonResponse({
        status: 'ok',
        service: 'mobi-licensing',
        timestamp: new Date().toISOString(),
      });
    }

    const clientIp = request.headers.get('CF-Connecting-IP') || '127.0.0.1';

    // 2. Activation Route
    if (request.method === 'POST' && (path === '/api/v1/license/activate' || path === '/api/license/activate')) {
      let body: ActivationRequestBody;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: 'INVALID_JSON', message: 'Payload JSON invalide.' }, 400);
      }

      const { license_key, device_id, device_type, hardware_hash, friendly_name = '', client_nonce } = body;

      if (!license_key || !device_id || !device_type) {
        return jsonResponse(
          { error: 'MISSING_FIELDS', message: 'Champs requis manquants (license_key, device_id, device_type).' },
          400
        );
      }

      if (device_type !== 'desktop' && device_type !== 'mobile') {
        return jsonResponse({ error: 'INVALID_DEVICE_TYPE', message: 'Type d’appareil invalide.' }, 400);
      }

      const normalizedKey = normalizeLicenseKey(license_key);
      const keyHash = await hashHmac(normalizedKey, env.LICENSE_PEPPER || 'default-pepper');
      const ipHash = await hashHmac(clientIp, env.IP_PEPPER || 'default-ip-pepper');

      const db = createClient({
        url: env.MASTER_TURSO_URL,
        authToken: env.MASTER_TURSO_TOKEN,
      });

      // Lookup License
      const licRes = await db.execute({
        sql: `SELECT id, customer_name, license_type, status, max_desktops, max_mobiles,
                     encrypted_turso_token, turso_url, expires_at
              FROM licenses WHERE key_hash = :key_hash LIMIT 1`,
        args: { key_hash: keyHash },
      });

      if (licRes.rows.length === 0) {
        // Dummy decryption to neutralize timing attacks
        if (env.MASTER_ENCRYPTION_KEY) {
          try {
            await decryptTursoToken(DUMMY_CIPHERTEXT, env.MASTER_ENCRYPTION_KEY);
          } catch {
            // Expected dummy catch
          }
        }
        return jsonResponse(
          { error: 'INVALID_LICENSE', message: 'Clé de licence invalide ou introuvable.' },
          404
        );
      }

      const lic = licRes.rows[0];

      if (lic.status !== 'active') {
        return jsonResponse(
          { error: 'LICENSE_SUSPENDED', message: `Licence ${lic.status === 'revoked' ? 'révoquée' : 'suspendue'}.` },
          403
        );
      }

      const now = new Date();
      if (lic.expires_at) {
        const expTime = new Date(lic.expires_at as string).getTime();
        if (expTime < now.getTime()) {
          return jsonResponse({ error: 'LICENSE_EXPIRED', message: 'Cette licence a expiré.' }, 403);
        }
      }

      // Atomic Seat Allocation via Conditional UPSERT
      const nowIso = now.toISOString();
      const actId = `act_${crypto.randomUUID()}`;
      const hwHash = hardware_hash || device_id;

      const upsertSql = `
        INSERT INTO license_activations (
          id, license_id, device_id, device_type, hardware_hash, friendly_name, activated_at, last_ping_at, ip_hash, is_active
        )
        SELECT
          :id, :license_id, :device_id, :device_type, :hardware_hash, :friendly_name, :now, :now, :ip_hash, 1
        WHERE (
          EXISTS (
            SELECT 1 FROM license_activations
            WHERE license_id = :license_id AND device_id = :device_id AND is_active = 1
          )
          OR
          (
            (SELECT COUNT(*) FROM license_activations WHERE license_id = :license_id AND device_type = :device_type AND is_active = 1)
            <
            (SELECT CASE :device_type WHEN 'desktop' THEN max_desktops WHEN 'mobile' THEN max_mobiles END FROM licenses WHERE id = :license_id)
          )
        )
        ON CONFLICT(license_id, device_id) DO UPDATE SET
          hardware_hash = excluded.hardware_hash,
          friendly_name = excluded.friendly_name,
          last_ping_at = excluded.last_ping_at,
          ip_hash = excluded.ip_hash,
          device_type = excluded.device_type,
          is_active = 1;
      `;

      try {
        const actRes = await db.execute({
          sql: upsertSql,
          args: {
            id: actId,
            license_id: lic.id,
            device_id,
            device_type,
            hardware_hash: hwHash,
            friendly_name,
            now: nowIso,
            ip_hash: ipHash,
          },
        });

        if (actRes.rowsAffected === 0) {
          return jsonResponse(
            {
              error: 'QUOTA_EXCEEDED',
              message: `Limite d'appareils atteinte pour ce type (${device_type}).`,
            },
            409
          );
        }
      } catch (dbErr: any) {
        if (dbErr.message && dbErr.message.includes('QUOTA_EXCEEDED')) {
          return jsonResponse({ error: 'QUOTA_EXCEEDED', message: dbErr.message }, 409);
        }
        return jsonResponse(
          { error: 'DATABASE_ERROR', message: `Erreur d'allocation de siège: ${dbErr.message}` },
          500
        );
      }

      // Decrypt Client Turso Token (Optional BYODB credentials)
      let clientTursoToken = '';
      if (
        lic.encrypted_turso_token &&
        lic.encrypted_turso_token !== 'NONE' &&
        typeof lic.encrypted_turso_token === 'string' &&
        lic.encrypted_turso_token.startsWith('v1:')
      ) {
        try {
          clientTursoToken = await decryptTursoToken(
            lic.encrypted_turso_token,
            env.MASTER_ENCRYPTION_KEY
          );
        } catch {
          clientTursoToken = '';
        }
      }

      // Sign Ed25519 JWT
      const iat = Math.floor(now.getTime() / 1000);
      let exp = 0;
      if (lic.expires_at) {
        exp = Math.floor(new Date(lic.expires_at as string).getTime() / 1000);
      } else {
        // Lifetime: 2099-01-01
        exp = Math.floor(new Date('2099-01-01T00:00:00Z').getTime() / 1000);
      }

      const claims: LicenseTokenClaims = {
        iss: 'https://mobi-licensing.workers.dev',
        sub: lic.id as string,
        iat,
        nbf: iat - 60, // 60s clock skew tolerance
        exp,
        jti: `tok_${crypto.randomUUID()}`,
        lic_key: normalizedKey,
        lic_type: lic.license_type as any,
        device_id,
        device_type,
        max_desktops: Number(lic.max_desktops),
        max_mobiles: Number(lic.max_mobiles),
        grace_days: 7,
        nonce: client_nonce,
        server_ts: iat,
      };

      let token: string;
      try {
        token = await signLicenseJwt(claims, env.LICENSE_ED25519_PRIVATE_JWK);
      } catch (signErr: any) {
        return jsonResponse(
          { error: 'SIGNING_FAILED', message: `Échec de signature de la licence: ${signErr.message}` },
          500
        );
      }

      return jsonResponse({
        status: 'success',
        token,
        turso_url: lic.turso_url,
        turso_token: clientTursoToken,
        license: {
          customer_name: lic.customer_name,
          license_type: lic.license_type,
          expires_at: lic.expires_at,
          max_desktops: lic.max_desktops,
          max_mobiles: lic.max_mobiles,
          activated_at: nowIso,
        },
      });
    }

    // 3. Heartbeat & Verification Route
    if (request.method === 'POST' && (path === '/api/v1/license/verify' || path === '/api/license/verify')) {
      let body: VerifyRequestBody;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: 'INVALID_JSON', message: 'Payload JSON invalide.' }, 400);
      }

      const { license_key, device_id } = body;
      if (!license_key || !device_id) {
        return jsonResponse({ error: 'MISSING_FIELDS', message: 'license_key et device_id requis.' }, 400);
      }

      const normalizedKey = normalizeLicenseKey(license_key);
      const keyHash = await hashHmac(normalizedKey, env.LICENSE_PEPPER || 'default-pepper');

      const db = createClient({
        url: env.MASTER_TURSO_URL,
        authToken: env.MASTER_TURSO_TOKEN,
      });

      const licRes = await db.execute({
        sql: `SELECT id, customer_name, license_type, status, max_desktops, max_mobiles, expires_at
              FROM licenses WHERE key_hash = :key_hash LIMIT 1`,
        args: { key_hash: keyHash },
      });

      if (licRes.rows.length === 0) {
        return jsonResponse({ active: false, error: 'NOT_FOUND', message: 'Licence introuvable.' }, 404);
      }

      const lic = licRes.rows[0];
      if (lic.status !== 'active') {
        return jsonResponse(
          { active: false, error: 'LICENSE_SUSPENDED', message: `Licence ${lic.status}.` },
          403
        );
      }

      const now = new Date();
      if (lic.expires_at && new Date(lic.expires_at as string).getTime() < now.getTime()) {
        return jsonResponse({ active: false, error: 'LICENSE_EXPIRED', message: 'Licence expirée.' }, 403);
      }

      // Touch last_ping_at for this device
      const nowIso = now.toISOString();
      await db.execute({
        sql: `UPDATE license_activations SET last_ping_at = :now
              WHERE license_id = :lic_id AND device_id = :dev_id AND is_active = 1`,
        args: { now: nowIso, lic_id: lic.id, dev_id: device_id },
      });

      // Per-device revocation: a deactivated (or never-bound) device must
      // NOT verify as active just because the license itself is. Without
      // this, unbinding a stolen terminal changes the admin list but the
      // terminal keeps selling as ACTIVE (online immediately, offline until
      // grace expiry). The client locks on 403 DEVICE_REVOKED.
      const bindRes = await db.execute({
        sql: `SELECT is_active FROM license_activations
              WHERE license_id = :lic_id AND device_id = :dev_id LIMIT 1`,
        args: { lic_id: lic.id, dev_id: device_id },
      });
      const bindRow = bindRes.rows[0] as unknown as { is_active?: number } | undefined;
      if (!bindRow || Number(bindRow.is_active ?? 0) !== 1) {
        return jsonResponse(
          { active: false, error: 'DEVICE_REVOKED', message: 'Terminal révoqué ou non rattaché.' },
          403
        );
      }

      // Get Seat Counts
      const countRes = await db.execute({
        sql: `SELECT device_type, COUNT(*) as cnt
              FROM license_activations
              WHERE license_id = :lic_id AND is_active = 1
              GROUP BY device_type`,
        args: { lic_id: lic.id },
      });

      let usedDesktops = 0;
      let usedMobiles = 0;
      for (const row of countRes.rows) {
        if (row.device_type === 'desktop') usedDesktops = Number(row.cnt);
        if (row.device_type === 'mobile') usedMobiles = Number(row.cnt);
      }

      return jsonResponse({
        active: true,
        license_type: lic.license_type,
        expires_at: lic.expires_at,
        customer_name: lic.customer_name,
        devices: {
          desktop: { used: usedDesktops, max: Number(lic.max_desktops) },
          mobile: { used: usedMobiles, max: Number(lic.max_mobiles) },
        },
      });
    }

    // 4. Deactivate / Unbind Route
    if (request.method === 'POST' && (path === '/api/v1/license/deactivate' || path === '/api/license/deactivate')) {
      let body: DeactivateRequestBody;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: 'INVALID_JSON', message: 'Payload JSON invalide.' }, 400);
      }

      const { license_key, device_id } = body;
      const normalizedKey = normalizeLicenseKey(license_key);
      const keyHash = await hashHmac(normalizedKey, env.LICENSE_PEPPER || 'default-pepper');

      const db = createClient({
        url: env.MASTER_TURSO_URL,
        authToken: env.MASTER_TURSO_TOKEN,
      });

      const licRes = await db.execute({
        sql: `SELECT id FROM licenses WHERE key_hash = :key_hash LIMIT 1`,
        args: { key_hash: keyHash },
      });

      if (licRes.rows.length === 0) {
        return jsonResponse({ error: 'NOT_FOUND', message: 'Licence introuvable.' }, 404);
      }

      const licId = licRes.rows[0].id;
      const unbindRes = await db.execute({
        sql: `UPDATE license_activations SET is_active = 0
              WHERE license_id = :lic_id AND device_id = :dev_id`,
        args: { lic_id: licId, dev_id: device_id },
      });

      return jsonResponse({
        status: 'success',
        unlinked: unbindRes.rowsAffected > 0,
      });
    }

    // Helper for Admin Authentication
    const isAuthorizedAdmin = (req: Request): boolean => {
      const auth = req.headers.get('Authorization');
      if (!auth || !auth.startsWith('Bearer ')) return false;
      const token = auth.slice(7).trim();
      return Boolean(env.MASTER_ENCRYPTION_KEY && token === env.MASTER_ENCRYPTION_KEY);
    };

    // 5. Admin: Sync License(s) to Cloud Master DB
    if (request.method === 'POST' && path === '/api/v1/admin/sync') {
      if (!isAuthorizedAdmin(request)) {
        return jsonResponse({ error: 'UNAUTHORIZED', message: 'Accès administrateur non autorisé.' }, 401);
      }

      let body: any;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: 'INVALID_JSON', message: 'Payload JSON invalide.' }, 400);
      }

      const licenses: any[] = Array.isArray(body.licenses) ? body.licenses : [body];
      const db = createClient({
        url: env.MASTER_TURSO_URL,
        authToken: env.MASTER_TURSO_TOKEN,
      });

      let syncedCount = 0;
      for (const lic of licenses) {
        if (!lic.customer_name) continue;
        let keyHash = lic.key_hash;
        if (!keyHash && lic.license_key) {
          const norm = normalizeLicenseKey(lic.license_key);
          keyHash = await hashHmac(norm, env.LICENSE_PEPPER || 'default-pepper');
        }
        if (!keyHash) continue;

        await db.execute({
          sql: `
            INSERT INTO licenses (
              id, key_hash, customer_name, license_type, status,
              max_desktops, max_mobiles, encrypted_turso_token, turso_url,
              created_at, updated_at, expires_at
            ) VALUES (
              :id, :key_hash, :customer_name, :license_type, :status,
              :max_desktops, :max_mobiles, :encrypted_turso_token, :turso_url,
              :created_at, :updated_at, :expires_at
            )
            ON CONFLICT(key_hash) DO UPDATE SET
              customer_name = excluded.customer_name,
              license_type = excluded.license_type,
              status = excluded.status,
              max_desktops = excluded.max_desktops,
              max_mobiles = excluded.max_mobiles,
              encrypted_turso_token = excluded.encrypted_turso_token,
              turso_url = excluded.turso_url,
              updated_at = excluded.updated_at,
              expires_at = excluded.expires_at;
          `,
          args: {
            id: lic.id || `lic_${crypto.randomUUID()}`,
            key_hash: keyHash,
            customer_name: lic.customer_name,
            license_type: lic.license_type || 'LIFETIME',
            status: lic.status || 'active',
            max_desktops: lic.max_desktops ?? 1,
            max_mobiles: lic.max_mobiles ?? 1,
            encrypted_turso_token: lic.encrypted_turso_token || 'NONE',
            turso_url: lic.turso_url || '',
            created_at: lic.created_at || new Date().toISOString(),
            updated_at: new Date().toISOString(),
            expires_at: lic.expires_at || null,
          },
        });
        syncedCount++;
      }

      return jsonResponse({ status: 'success', synced: syncedCount });
    }

    // 6. Admin: Reset Seats
    if (request.method === 'POST' && path === '/api/v1/admin/reset-seats') {
      if (!isAuthorizedAdmin(request)) {
        return jsonResponse({ error: 'UNAUTHORIZED', message: 'Accès administrateur non autorisé.' }, 401);
      }

      let body: any;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: 'INVALID_JSON', message: 'Payload JSON invalide.' }, 400);
      }

      const { license_key } = body;
      if (!license_key) {
        return jsonResponse({ error: 'MISSING_FIELDS', message: 'license_key requis.' }, 400);
      }

      const normalizedKey = normalizeLicenseKey(license_key);
      const keyHash = await hashHmac(normalizedKey, env.LICENSE_PEPPER || 'default-pepper');

      const db = createClient({
        url: env.MASTER_TURSO_URL,
        authToken: env.MASTER_TURSO_TOKEN,
      });

      const licRes = await db.execute({
        sql: `SELECT id FROM licenses WHERE key_hash = :key_hash LIMIT 1`,
        args: { key_hash: keyHash },
      });

      if (licRes.rows.length === 0) {
        return jsonResponse({ error: 'NOT_FOUND', message: 'Licence introuvable.' }, 404);
      }

      const licId = licRes.rows[0].id;
      const resetRes = await db.execute({
        sql: `UPDATE license_activations SET is_active = 0 WHERE license_id = :lic_id`,
        args: { lic_id: licId },
      });

      return jsonResponse({
        status: 'success',
        license_key: normalizedKey,
        seats_cleared: resetRes.rowsAffected,
      });
    }

    // 7. Admin: Update Seats Quota
    if (request.method === 'POST' && path === '/api/v1/admin/update-seats') {
      if (!isAuthorizedAdmin(request)) {
        return jsonResponse({ error: 'UNAUTHORIZED', message: 'Accès administrateur non autorisé.' }, 401);
      }

      let body: any;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: 'INVALID_JSON', message: 'Payload JSON invalide.' }, 400);
      }

      const { license_key, max_desktops, max_mobiles } = body;
      if (!license_key || (max_desktops === undefined && max_mobiles === undefined)) {
        return jsonResponse({ error: 'MISSING_FIELDS', message: 'license_key et quotas requis.' }, 400);
      }

      const normalizedKey = normalizeLicenseKey(license_key);
      const keyHash = await hashHmac(normalizedKey, env.LICENSE_PEPPER || 'default-pepper');

      const db = createClient({
        url: env.MASTER_TURSO_URL,
        authToken: env.MASTER_TURSO_TOKEN,
      });

      const licRes = await db.execute({
        sql: `SELECT id, max_desktops, max_mobiles FROM licenses WHERE key_hash = :key_hash LIMIT 1`,
        args: { key_hash: keyHash },
      });

      if (licRes.rows.length === 0) {
        return jsonResponse({ error: 'NOT_FOUND', message: 'Licence introuvable.' }, 404);
      }

      const newDesktops = max_desktops !== undefined ? Number(max_desktops) : licRes.rows[0].max_desktops;
      const newMobiles = max_mobiles !== undefined ? Number(max_mobiles) : licRes.rows[0].max_mobiles;

      await db.execute({
        sql: `UPDATE licenses SET max_desktops = :desktops, max_mobiles = :mobiles, updated_at = :now WHERE id = :id`,
        args: {
          desktops: newDesktops,
          mobiles: newMobiles,
          now: new Date().toISOString(),
          id: licRes.rows[0].id,
        },
      });

      return jsonResponse({
        status: 'success',
        license_key: normalizedKey,
        max_desktops: newDesktops,
        max_mobiles: newMobiles,
      });
    }

    // 8. Admin: List Cloud Licenses & Active Devices
    if ((request.method === 'GET' || request.method === 'POST') && path === '/api/v1/admin/list') {
      if (!isAuthorizedAdmin(request)) {
        return jsonResponse({ error: 'UNAUTHORIZED', message: 'Accès administrateur non autorisé.' }, 401);
      }

      const db = createClient({
        url: env.MASTER_TURSO_URL,
        authToken: env.MASTER_TURSO_TOKEN,
      });

      const licRes = await db.execute({
        sql: `SELECT l.id, l.customer_name, l.license_type, l.status, l.max_desktops, l.max_mobiles,
                     l.turso_url, l.created_at, l.expires_at,
                     COUNT(CASE WHEN a.is_active = 1 AND a.device_type = 'desktop' THEN 1 END) as active_desktops,
                     COUNT(CASE WHEN a.is_active = 1 AND a.device_type = 'mobile' THEN 1 END) as active_mobiles
              FROM licenses l
              LEFT JOIN license_activations a ON l.id = a.license_id
              GROUP BY l.id
              ORDER BY l.created_at DESC`,
      });

      return jsonResponse({
        status: 'success',
        licenses: licRes.rows,
      });
    }

    // 9. Admin: Get Active Devices for a License
    if (request.method === 'POST' && path === '/api/v1/admin/devices') {
      if (!isAuthorizedAdmin(request)) {
        return jsonResponse({ error: 'UNAUTHORIZED', message: 'Accès administrateur non autorisé.' }, 401);
      }

      let body: any;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: 'INVALID_JSON', message: 'Payload JSON invalide.' }, 400);
      }

      const { license_key } = body;
      if (!license_key) {
        return jsonResponse({ error: 'MISSING_FIELDS', message: 'license_key requis.' }, 400);
      }

      const normalizedKey = normalizeLicenseKey(license_key);
      const keyHash = await hashHmac(normalizedKey, env.LICENSE_PEPPER || 'default-pepper');

      const db = createClient({
        url: env.MASTER_TURSO_URL,
        authToken: env.MASTER_TURSO_TOKEN,
      });

      const licRes = await db.execute({
        sql: `SELECT id, customer_name FROM licenses WHERE key_hash = :key_hash LIMIT 1`,
        args: { key_hash: keyHash },
      });

      if (licRes.rows.length === 0) {
        return jsonResponse({ error: 'NOT_FOUND', message: 'Licence introuvable.' }, 404);
      }

      const licId = licRes.rows[0].id;
      const devRes = await db.execute({
        sql: `SELECT id, device_id, device_type, hardware_hash, friendly_name, activated_at, last_ping_at, is_active
              FROM license_activations
              WHERE license_id = :lic_id AND is_active = 1
              ORDER BY activated_at DESC`,
        args: { lic_id: licId },
      });

      return jsonResponse({
        status: 'success',
        devices: devRes.rows,
      });
    }

    // 10. Admin: Update License Status (active / suspended / revoked)
    if (request.method === 'POST' && path === '/api/v1/admin/set-status') {
      if (!isAuthorizedAdmin(request)) {
        return jsonResponse({ error: 'UNAUTHORIZED', message: 'Accès administrateur non autorisé.' }, 401);
      }

      let body: any;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: 'INVALID_JSON', message: 'Payload JSON invalide.' }, 400);
      }

      const { license_key, status } = body;
      if (!license_key || !status) {
        return jsonResponse({ error: 'MISSING_FIELDS', message: 'license_key et status requis.' }, 400);
      }

      const normalizedKey = normalizeLicenseKey(license_key);
      const keyHash = await hashHmac(normalizedKey, env.LICENSE_PEPPER || 'default-pepper');

      const db = createClient({
        url: env.MASTER_TURSO_URL,
        authToken: env.MASTER_TURSO_TOKEN,
      });

      const updateRes = await db.execute({
        sql: `UPDATE licenses SET status = :status, updated_at = :now WHERE key_hash = :key_hash`,
        args: { status, now: new Date().toISOString(), key_hash: keyHash },
      });

      return jsonResponse({
        status: 'success',
        updated: updateRes.rowsAffected > 0,
      });
    }

    return jsonResponse({ error: 'NOT_FOUND', message: 'Route non trouvée.' }, 404);
  },
};

