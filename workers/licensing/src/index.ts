import { createClient } from '@libsql/client/web';
import {
  hashHmac,
  decryptTursoToken,
  signLicenseJwt,
  signCanonicalLicense,
  generateLicenseKey,
  type LicenseTokenClaims,
} from './crypto';
import { notifyOwner } from './notify';
import { pickSigningKey, verifyLicenseJwt } from './crypto';
import { enforceRateLimit, type RateLimitDb } from './rateLimit';
import { findLicenseByNormalizedKey } from './licenseLookup';
import {
  validateTrialRegistration,
  registerTrialLead,
  updateLeadStatus,
  isValidLeadStatus,
  type TrialRegistrationRequest,
} from './trialRegister.ts';

export interface Env {
  MASTER_TURSO_URL: string;
  MASTER_TURSO_TOKEN: string;
  MASTER_ENCRYPTION_KEY: string;
  /** S-tier: dedicated admin bearer. When set, MASTER_ENCRYPTION_KEY is no
   *  longer accepted for admin routes (no dual-purpose secret). */
  ADMIN_TOKEN?: string;
  LICENSE_PEPPER: string;
  /** M2/F3 pepper rotation: the previous pepper during a rotation window.
   *  Lookups fall back to it and lazily re-hash rows to the current pepper. */
  LICENSE_PEPPER_PREVIOUS?: string;
  IP_PEPPER: string;
  LICENSE_ED25519_PRIVATE_JWK: string;
  /** Current signing root (k2, SEC-ROT-02). New activations only. */
  LICENSE_ED25519_PRIVATE_JWK_K2?: string;
  /** KV namespace anchoring audit checkpoints, one JSON doc per client_id. */
  AUDIT_KV: KVNamespace;
  /** Owner doorbell (fail-open, optional — see src/notify.ts). */
  TELEGRAM_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
}

interface SignLicenseRequest {
  customer: string;
  formula: 'LIFETIME' | 'TRIAL_30D' | 'TRIAL_90D' | 'DEMO' | 'ANNUAL';
  seats_pos: number;
  seats_desk: number;
  /** ISO 8601 UTC string, or null for a lifetime licence. */
  expires_at: string | null;
  hwid_bindings: string[];
}

interface AuditCheckpointRequest {
  client_id: string;
  sequence_number: number;
  head_audit_hash: string;
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
  /** RT-3: proof of possession of this device's activation token. */
  token?: string;
}

function jsonResponse(data: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, Idempotency-Key',
      ...(extraHeaders ?? {}),
    },
  });
}

/**
 * M2 (EDGE-1/EDGE-2): count one hit against `bucket` for the peppered
 * `identity` and answer 429 when the fixed window is exhausted. Returns null
 * when allowed. `identity` MUST already be a peppered hash — never a raw IP
 * or license key.
 */
async function rateGate(
  db: RateLimitDb,
  bucket: Parameters<typeof enforceRateLimit>[1],
  identity: string,
  clientIp: string
): Promise<Response | null> {
  const verdict = await enforceRateLimit(db, bucket, identity, Math.floor(Date.now() / 1000));
  if (verdict.degraded) {
    console.error(
      JSON.stringify({ event: 'rate_limit_degraded', bucket, identity_prefix: identity.slice(0, 12), detail: verdict.degraded })
    );
  }
  if (verdict.ok) return null;
  console.warn(
    JSON.stringify({ event: 'rate_limited', bucket, identity_prefix: identity.slice(0, 12), count: verdict.count, limit: verdict.limit })
  );
  void clientIp;
  return jsonResponse(
    {
      error: 'RATE_LIMITED',
      message: `Trop de requêtes. Réessayez dans ${Math.max(1, Math.ceil(verdict.retryAfter / 60))} minute(s).`,
    },
    429,
    { 'Retry-After': String(Math.max(1, verdict.retryAfter)) }
  );
}

function normalizeLicenseKey(rawKey: string): string {
  return rawKey.trim().toUpperCase().replace(/[^0-9A-Z]/g, '');
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

const DUMMY_CIPHERTEXT =
  'v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Fail closed on missing peppers (SEC-ROT-02/F8): a default pepper would
    // make blind indexes guessable. Never fall back.
    if (!env.LICENSE_PEPPER || !env.IP_PEPPER) {
      return jsonResponse(
        { error: 'MISCONFIGURED', message: 'Peppers de hachage manquants sur le worker.' },
        503
      );
    }
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, Idempotency-Key',
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

      const { license_key, device_id, device_type, hardware_hash, friendly_name = '', client_nonce, app_version } = body;

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
      const keyHash = await hashHmac(normalizedKey, env.LICENSE_PEPPER);
      const ipHash = await hashHmac(clientIp, env.IP_PEPPER);

      const db = createClient({
        url: env.MASTER_TURSO_URL,
        authToken: env.MASTER_TURSO_TOKEN,
      });

      // M2 (EDGE-1): bound activation attempts per IP and per key before any
      // seat lookup. A squatter hammering activate to hold the last seat (or
      // an attacker brute-forcing keys) hits the wall here.
      const limited =
        (await rateGate(db, 'activate_ip', ipHash, clientIp)) ??
        (await rateGate(db, 'activate_key', keyHash, clientIp));
      if (limited) return limited;

      // Lookup License — pepper-rotation aware (M2/F3): tries the current
      // pepper, falls back to LICENSE_PEPPER_PREVIOUS and lazily re-hashes
      // the row so a pepper rotation converges without downtime.
      const found = await findLicenseByNormalizedKey(db, env, normalizedKey);

      if (!found) {
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

      const lic = found.row;

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
        // SEC-ROT-02 + M2 sunset: k2 is unconditional when configured (see
        // crypto.ts). app_version is accepted in the body for telemetry only.
        const signing = pickSigningKey(env);
        token = await signLicenseJwt(claims, signing.jwk, signing.kid);
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

    // Helper for Admin Authentication (declared before all routes that use it).
    // S-tier hardening: (1) constant-time comparison — a plain `===` leaks
    // match length through timing; (2) a DEDICATED ADMIN_TOKEN secret when
    // configured, so compromising the admin path never yields the AES master
    // key (and vice versa). MASTER_ENCRYPTION_KEY remains the fallback only
    // while ADMIN_TOKEN is unset — the deploy runbook sets ADMIN_TOKEN and
    // the fallback is then dead code.
    const isAuthorizedAdmin = async (req: Request): Promise<boolean> => {
      const auth = req.headers.get('Authorization');
      if (!auth || !auth.startsWith('Bearer ')) return false;
      const token = auth.slice(7).trim();
      if (!token) return false;
      const { constantTimeEqual } = await import('./crypto.ts');
      if (env.ADMIN_TOKEN) {
        return constantTimeEqual(token, env.ADMIN_TOKEN);
      }
      return Boolean(env.MASTER_ENCRYPTION_KEY) && (await constantTimeEqual(token, env.MASTER_ENCRYPTION_KEY));
    };

    // Admin gate: per-IP ATTEMPT limit before the bearer check, then auth.
    // Stops brute-force probing of the admin secret at network speed while
    // keeping the rate-limit fail-open contract (a Turso outage must not
    // lock the owner out of their own console). 30/h is generous for a human
    // working the console and nothing for a script.
    const adminDeny = async (): Promise<Response | null> => {
      const db = createClient({
        url: env.MASTER_TURSO_URL,
        authToken: env.MASTER_TURSO_TOKEN,
      });
      const adminIpHash = await hashHmac(clientIp, env.IP_PEPPER);
      const limited = await rateGate(db, 'admin_ip', adminIpHash, clientIp);
      if (limited) return limited;
      if (!(await isAuthorizedAdmin(request))) {
        return jsonResponse({ error: 'UNAUTHORIZED', message: 'Accès administrateur non autorisé.' }, 401);
      }
      return null;
    };

    // 2b. Trial Registration (M2 trial funnel — D1/D3/D4). No licence is
    // minted here: the lead is stored, the owner is pinged on Telegram, and
    // contact + payment happen on the manual WhatsApp rail. Rate-limited
    // (trial_ip) BEFORE any insert so lead flooding dies at the wall.
    if (request.method === 'POST' && (path === '/api/v1/trial/register' || path === '/api/trial/register')) {
      let body: TrialRegistrationRequest & { _idem_header?: string };
      const idemHeader = request.headers.get('Idempotency-Key');
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: 'INVALID_JSON', message: 'Payload JSON invalide.' }, 400);
      }
      // Standard idempotency semantics: the header wins, the body field is the
      // compatibility path. Both must satisfy the same strict pattern.
      if (!body.idempotency_key && idemHeader) {
        body.idempotency_key = idemHeader;
      }

      const ipHashTrial = await hashHmac(clientIp, env.IP_PEPPER);
      const db = createClient({
        url: env.MASTER_TURSO_URL,
        authToken: env.MASTER_TURSO_TOKEN,
      });
      const limitedTrial = await rateGate(db, 'trial_ip', ipHashTrial, clientIp);
      if (limitedTrial) return limitedTrial;

      const verdict = validateTrialRegistration(body);
      if (!verdict.ok) {
        return jsonResponse({ error: verdict.error, message: verdict.message }, 400);
      }

      const outcome = await registerTrialLead(db, verdict.value, new Date().toISOString());
      if (outcome.status === 'rejected') {
        console.error(JSON.stringify({ event: 'trial_register_failed', reason: outcome.reason }));
        return jsonResponse({ error: 'DATABASE_ERROR', message: 'Enregistrement temporairement indisponible.' }, 500);
      }

      // Owner doorbell — fail-open by design (notify.ts): a Telegram hiccup
      // must never lose the lead or fail the signup.
      void notifyOwner(env, {
        headline: `🆕 Essai MobiPOS — ${verdict.value.full_name}`,
        lines: [`WhatsApp : ${verdict.value.whatsapp}`],
      });

      return jsonResponse(
        { status: outcome.status },
        outcome.status === 'registered' ? 201 : 200
      );
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
      const keyHash = await hashHmac(normalizedKey, env.LICENSE_PEPPER);

      const db = createClient({
        url: env.MASTER_TURSO_URL,
        authToken: env.MASTER_TURSO_TOKEN,
      });

      // M2 (EDGE-2): /verify distinguishes key-exists from key-absent by
      // design (the client needs the verdict), which makes it an enumeration
      // oracle. The per-IP/per-key windows make enumeration at 32^8 key
      // space geological while legitimate boot pings (~30/hour/device) pass
      // untouched.
      const ipHashVerify = await hashHmac(clientIp, env.IP_PEPPER);
      const limitedVerify =
        (await rateGate(db, 'verify_ip', ipHashVerify, clientIp)) ??
        (await rateGate(db, 'verify_key', keyHash, clientIp));
      if (limitedVerify) return limitedVerify;

      // Pepper-rotation aware lookup (M2/F3) — see activate.
      const foundVerify = await findLicenseByNormalizedKey(db, env, normalizedKey);
      if (!foundVerify) {
        // Timing uniformity with /activate: burn the same dummy-decrypt work
        // on the not-found path so response time cannot leak key existence
        // ahead of the rate-limit wall.
        if (env.MASTER_ENCRYPTION_KEY) {
          try {
            await decryptTursoToken(DUMMY_CIPHERTEXT, env.MASTER_ENCRYPTION_KEY);
          } catch {
            // Expected dummy catch
          }
        }
        return jsonResponse({ active: false, error: 'NOT_FOUND', message: 'Licence introuvable.' }, 404);
      }

      const lic = foundVerify.row;
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
    // RT-3 (red-team, CONFIRMED live): this route previously accepted a bare
    // (license_key, device_id) pair with NO authentication — anyone who
    // learned both values could unbind a victim's device. Now the caller must
    // either be the admin (Bearer) or present the device's own activation
    // token, verified against the worker's signing keys with matching
    // lic_key + device_id claims.
    if (request.method === 'POST' && (path === '/api/v1/license/deactivate' || path === '/api/license/deactivate')) {
      let body: DeactivateRequestBody;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: 'INVALID_JSON', message: 'Payload JSON invalide.' }, 400);
      }

      const { license_key, device_id, token } = body;
      const normalizedKey = normalizeLicenseKey(license_key);

      if (!(await isAuthorizedAdmin(request))) {
        if (!token) {
          return jsonResponse(
            { error: 'TOKEN_REQUIRED', message: 'Jeton d’activation requis pour désactiver un appareil.' },
            401
          );
        }
        const verdict = await verifyLicenseJwt(token, [
          env.LICENSE_ED25519_PRIVATE_JWK,
          env.LICENSE_ED25519_PRIVATE_JWK_K2,
        ]);
        if (!verdict.valid || !verdict.payload) {
          return jsonResponse(
            { error: 'INVALID_TOKEN', message: 'Jeton d’activation invalide.' },
            401
          );
        }
        const claimsOk =
          verdict.payload.lic_key === normalizedKey && verdict.payload.device_id === device_id;
        if (!claimsOk) {
          return jsonResponse(
            { error: 'TOKEN_MISMATCH', message: 'Le jeton ne correspond pas à cette licence/appareil.' },
            403
          );
        }
      }
      const keyHash = await hashHmac(normalizedKey, env.LICENSE_PEPPER);

      const db = createClient({
        url: env.MASTER_TURSO_URL,
        authToken: env.MASTER_TURSO_TOKEN,
      });

      // M2 (EDGE-1): bound unbind attempts per IP and per key. The route is
      // authenticated (RT-3), but the token proof is offline-verifiable — the
      // wall bounds token-replay hammering and admin-path abuse alike.
      const ipHashDeactivate = await hashHmac(clientIp, env.IP_PEPPER);
      const limitedDeactivate =
        (await rateGate(db, 'deactivate_ip', ipHashDeactivate, clientIp)) ??
        (await rateGate(db, 'deactivate_key', keyHash, clientIp));
      if (limitedDeactivate) return limitedDeactivate;

      // Pepper-rotation aware lookup (M2/F3) — see activate.
      const foundDeactivate = await findLicenseByNormalizedKey(db, env, normalizedKey);
      if (!foundDeactivate) {
        return jsonResponse({ error: 'NOT_FOUND', message: 'Licence introuvable.' }, 404);
      }

      const licId = foundDeactivate.row.id as string;
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

    // Admin authentication helper moved above the routes that use it.

    // 5. Admin: Sync License(s) to Cloud Master DB
    if (request.method === 'POST' && path === '/api/v1/admin/sync') {
      const denied = await adminDeny();
      if (denied) return denied;

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
          keyHash = await hashHmac(norm, env.LICENSE_PEPPER);
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

    // 6b. Admin: Trial Leads (M2 funnel — console « Clients » feed)
    if (request.method === 'GET' && path === '/api/v1/admin/leads') {
      const denied = await adminDeny();
      if (denied) return denied;
      const db = createClient({
        url: env.MASTER_TURSO_URL,
        authToken: env.MASTER_TURSO_TOKEN,
      });
      const leads = await db.execute({
        sql: `SELECT id, full_name, whatsapp, created_at, source, status
              FROM customers ORDER BY created_at DESC LIMIT 100`,
        args: {},
      });
      return jsonResponse({ status: 'success', leads: leads.rows });
    }

    // 6c. Admin: Lead Status Transition (console « Clients »). Strict enum,
    // strict id shape, admin bearer required — fail closed on anything else.
    if (request.method === 'PATCH' && path === '/api/v1/admin/leads/status') {
      const denied = await adminDeny();
      if (denied) return denied;
      let body: { id?: unknown; status?: unknown };
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: 'INVALID_JSON', message: 'Payload JSON invalide.' }, 400);
      }
      if (typeof body.id !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(body.id)) {
        return jsonResponse({ error: 'INVALID_ID', message: 'Identifiant de lead invalide.' }, 400);
      }
      if (!isValidLeadStatus(body.status)) {
        return jsonResponse({ error: 'INVALID_STATUS', message: 'Statut invalide.' }, 400);
      }
      const db = createClient({
        url: env.MASTER_TURSO_URL,
        authToken: env.MASTER_TURSO_TOKEN,
      });
      const outcome = await updateLeadStatus(db, body.id, body.status);
      if (outcome.status === 'not_found') {
        return jsonResponse({ error: 'LEAD_NOT_FOUND', message: 'Lead introuvable.' }, 404);
      }
      if (outcome.status === 'rejected') {
        console.error(JSON.stringify({ event: 'lead_status_failed', reason: outcome.reason }));
        return jsonResponse({ error: 'DATABASE_ERROR', message: 'Mise à jour temporairement indisponible.' }, 500);
      }
      return jsonResponse({ status: 'success', id: body.id, lead_status: body.status });
    }

    // 7. Admin: Reset Seats
    if (request.method === 'POST' && path === '/api/v1/admin/reset-seats') {
      const denied = await adminDeny();
      if (denied) return denied;

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
      const keyHash = await hashHmac(normalizedKey, env.LICENSE_PEPPER);

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
      const denied = await adminDeny();
      if (denied) return denied;

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
      const keyHash = await hashHmac(normalizedKey, env.LICENSE_PEPPER);

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
      const denied = await adminDeny();
      if (denied) return denied;

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

      // Attach any escrowed ciphertext. Only licences that have one pay the
      // extra KV read; the audit namespace is shared, so each lookup is an
      // exact key rather than a list-then-filter.
      const licenses = await Promise.all(
        licRes.rows.map(async (row: any) => {
          if (!row?.id) return row;
          const escrow = await env.AUDIT_KV.get(`escrow:${await sha256Hex(String(row.id))}`);
          return escrow ? { ...row, encrypted_key_escrow: escrow } : row;
        })
      );

      return jsonResponse({
        status: 'success',
        licenses,
      });
    }

    // 9. Admin: Get Active Devices for a License
    if (request.method === 'POST' && path === '/api/v1/admin/devices') {
      const denied = await adminDeny();
      if (denied) return denied;

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
      const keyHash = await hashHmac(normalizedKey, env.LICENSE_PEPPER);

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
      const denied = await adminDeny();
      if (denied) return denied;

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
      const keyHash = await hashHmac(normalizedKey, env.LICENSE_PEPPER);

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

    // 11. Admin: Remote License Signing (vendor Ed25519)
    if (request.method === 'POST' && path === '/api/v1/admin/licenses/sign') {
      const denied = await adminDeny();
      if (denied) return denied;
      if (!env.LICENSE_ED25519_PRIVATE_JWK) {
        return jsonResponse(
          { error: 'SIGNING_UNAVAILABLE', message: 'Aucune clé de signature configurée sur le worker.' },
          503
        );
      }

      let body: any;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: 'INVALID_JSON', message: 'Payload JSON invalide.' }, 400);
      }

      const {
        customer,
        formula,
        seats_pos,
        seats_desk,
        expires_at = null,
        hwid_bindings = [],
      } = body ?? {};

      if (typeof customer !== 'string' || customer.trim().length === 0) {
        return jsonResponse({ error: 'MISSING_FIELDS', message: 'customer requis.' }, 400);
      }
      const allowedFormulas = ['LIFETIME', 'TRIAL_30D', 'TRIAL_90D', 'DEMO', 'ANNUAL'];
      if (typeof formula !== 'string' || !allowedFormulas.includes(formula.toUpperCase())) {
        return jsonResponse(
          { error: 'INVALID_FORMULA', message: `formula doit être l'un de: ${allowedFormulas.join(', ')}.` },
          400
        );
      }
      if (!Array.isArray(hwid_bindings)) {
        return jsonResponse({ error: 'INVALID_HWIDS', message: 'hwid_bindings doit être un tableau.' }, 400);
      }
      if (expires_at !== null && typeof expires_at !== 'string') {
        return jsonResponse({ error: 'INVALID_EXPIRY', message: 'expires_at doit être une chaîne ISO ou null.' }, 400);
      }
      if (expires_at !== null && Number.isNaN(Date.parse(expires_at))) {
        return jsonResponse({ error: 'INVALID_EXPIRY', message: 'expires_at n’est pas une date ISO 8601 valide.' }, 400);
      }

      const seatsPos = Number.isInteger(seats_pos) ? seats_pos : 0;
      const seatsDesk = Number.isInteger(seats_desk) ? seats_desk : 0;
      if (seatsPos < 0 || seatsDesk < 0 || seatsPos > 500 || seatsDesk > 500) {
        return jsonResponse({ error: 'INVALID_SEATS', message: 'Nombre de postes hors limites (0-500).' }, 400);
      }

      // Sorted so that binding order cannot change the signature, and so the
      // same license always produces the same canonical string.
      const canonicalHwid = [...hwid_bindings]
        .filter((h): h is string => typeof h === 'string' && h.length > 0)
        .sort()
        .join(',');
      const canonicalData =
        `${customer.trim()}|${formula.toUpperCase()}|${seatsPos}|${seatsDesk}|` +
        `${expires_at ?? 'NONE'}|${canonicalHwid}`;

      try {
        const licenseKey = generateLicenseKey(formula.toUpperCase());
        // Canonical signature: minted artifacts have no verifier in the app yet;
        // sign with the current root (k2) when available and name it in the
        // response so any future verifier can pin the right key.
        const canonicalKid: 'k1' | 'k2' = env.LICENSE_ED25519_PRIVATE_JWK_K2 ? 'k2' : 'k1';
        const canonicalJwk = canonicalKid === 'k2' ? env.LICENSE_ED25519_PRIVATE_JWK_K2! : env.LICENSE_ED25519_PRIVATE_JWK;
        const signature = await signCanonicalLicense(canonicalJwk, canonicalData);
        // Owner doorbell (§11.5): every issued licence pings the owner's phone
        // with the customer name. Fail-open — never blocks or fails the mint.
        await notifyOwner(env, {
          headline: `🔑 Licence émise : ${customer.trim()} · ${formula.toUpperCase()}`,
          lines: [
            `Clé : ${licenseKey}`,
            seatsPos || seatsDesk ? `Postes : ${seatsDesk} PC · ${seatsPos} mobile(s)` : '',
            expires_at ? `Expire : ${expires_at}` : 'Durée : à vie',
          ].filter(Boolean),
        });
        return jsonResponse({
          status: 'success',
          license_key: licenseKey,
          token_signature: signature,
          canonical_data: canonicalData,
          signed_with_kid: canonicalKid,
          issued_at: new Date().toISOString(),
        });
      } catch (err) {
        return jsonResponse(
          { error: 'SIGNING_FAILED', message: `Signature impossible: ${(err as Error).message}` },
          500
        );
      }
    }

    // 12. Admin: Key Escrow (encrypted plaintext key recovery)
    //
    // Licences live in Turso, whose schema the desktop client does not own, and
    // the signing endpoint is stateless. Escrow is therefore kept in KV under a
    // distinct "escrow:" prefix so it never collides with the audit documents
    // in the same namespace, and never has to migrate the shared database.
    //
    // The payload is an opaque AES-256-GCM envelope produced with the vendor
    // master key. The worker can neither read nor validate it; it is storage.
    if (request.method === 'POST' && path === '/api/v1/admin/key-escrow') {
      const denied = await adminDeny();
      if (denied) return denied;
      let body: any;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: 'INVALID_JSON', message: 'Payload JSON invalide.' }, 400);
      }
      const licenseId = typeof body?.license_id === 'string' ? body.license_id.trim() : '';
      const envelope = typeof body?.encrypted_key_escrow === 'string'
        ? body.encrypted_key_escrow.trim()
        : '';
      if (!licenseId || !envelope) {
        return jsonResponse(
          { error: 'MISSING_FIELDS', message: 'license_id et encrypted_key_escrow requis.' },
          400
        );
      }
      if (envelope.length > 8192) {
        return jsonResponse({ error: 'PAYLOAD_TOO_LARGE', message: 'Enveloppe trop volumineuse.' }, 413);
      }
      // Keyed on a hash of the id so a hostile licence_id cannot be crafted to
      // collide with (or enumerate) an audit document key in the same namespace.
      const escrowKey = `escrow:${await sha256Hex(licenseId)}`;
      await env.AUDIT_KV.put(escrowKey, envelope);
      return jsonResponse({ status: 'stored' });
    }

    // 13. Admin: Audit Checkpoint (detects ledger head truncation)
    if (request.method === 'POST' && path === '/api/v1/admin/audit/checkpoint') {
      const denied = await adminDeny();
      if (denied) return denied;
      if (!env.AUDIT_KV) {
        return jsonResponse(
          { error: 'KV_UNBOUND', message: 'Namespace KV AUDIT_KV non lié sur ce worker.' },
          503
        );
      }

      let body: any;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: 'INVALID_JSON', message: 'Payload JSON invalide.' }, 400);
      }

      const { client_id, sequence_number, head_audit_hash } = body ?? {};
      if (typeof client_id !== 'string' || client_id.length === 0) {
        return jsonResponse({ error: 'MISSING_FIELDS', message: 'client_id requis.' }, 400);
      }
      if (!Number.isInteger(sequence_number) || sequence_number < 0) {
        return jsonResponse({ error: 'INVALID_SEQUENCE', message: 'sequence_number doit être un entier >= 0.' }, 400);
      }
      if (typeof head_audit_hash !== 'string' || !/^[0-9a-f]{64}$/i.test(head_audit_hash)) {
        return jsonResponse(
          { error: 'INVALID_HASH', message: 'head_audit_hash doit être un SHA-256 hexadécimal (64 caractères).' },
          400
        );
      }

      const prev = (await env.AUDIT_KV.get(client_id, 'json')) as
        | { sequence_number: number; head_audit_hash: string }
        | null;

      // A regression means the local ledger lost records relative to what the
      // server already anchored -- the exact signature of a truncation attack.
      if (prev && sequence_number < prev.sequence_number) {
        return jsonResponse(
          {
            error: 'Security Alert: Sequence regression detected. Possible ledger truncation attack.',
            server_sequence: prev.sequence_number,
            client_sequence: sequence_number,
          },
          409
        );
      }

      // A same-sequence checkpoint with a different head hash means the
      // history was rewritten without being truncated.
      if (
        prev &&
        sequence_number === prev.sequence_number &&
        prev.head_audit_hash.toLowerCase() !== head_audit_hash.toLowerCase()
      ) {
        return jsonResponse(
          {
            error: 'Security Alert: Head hash mismatch at identical sequence number. Ledger was rewritten.',
            server_sequence: prev.sequence_number,
          },
          409
        );
      }

      const checkpoint = JSON.stringify({
        sequence_number,
        head_audit_hash: head_audit_hash.toLowerCase(),
        synced_at: new Date().toISOString(),
      });

      // Automated runs use an ephemeral client id so they can never collide
      // with a real installation. Such records self-expire so a test run does
      // not leave permanent state behind, and -- more importantly -- so a
      // stray test sequence can never become a baseline that locks out a real
      // client later.
      if (client_id.startsWith('test_ephemeral_')) {
        await env.AUDIT_KV.put(client_id, checkpoint, { expirationTtl: 60 });
      } else {
        await env.AUDIT_KV.put(client_id, checkpoint);
      }

      return jsonResponse({ status: 'anchored', server_time: new Date().toISOString() });
    }

    // 14. Admin: Audit Anchor Reset (recovers a client from a false lockout)
    //
    // A 409 regression normally means a real truncation attack and must never
    // be waved away. But there is one legitimate cause: the local ledger was
    // lost (wiped machine, restored backup, reinstall) while the anchor
    // survived. The client can then never make progress, because every
    // legitimate sequence it proposes is "lower" than the server baseline.
    //
    // This endpoint is the deliberate, audited escape hatch. It requires the
    // same admin auth as every other admin route, takes an explicit
    // `confirm` token so it cannot be triggered by a stray or replayed call,
    // and records the previous checkpoint in the response so an operator has
    // the discarded evidence in hand.
    if (request.method === 'POST' && path === '/api/v1/admin/audit/reset') {
      const denied = await adminDeny();
      if (denied) return denied;
      if (!env.AUDIT_KV) {
        return jsonResponse(
          { error: 'KV_UNBOUND', message: 'Namespace KV AUDIT_KV non lié sur ce worker.' },
          503
        );
      }

      let body: any;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: 'INVALID_JSON', message: 'Payload JSON invalide.' }, 400);
      }

      const { client_id, confirm } = body ?? {};
      if (typeof client_id !== 'string' || client_id.length === 0) {
        return jsonResponse({ error: 'MISSING_FIELDS', message: 'client_id requis.' }, 400);
      }
      // Ephemeral test ids are already disposable, but they get a weaker
      // token so that a stray harness call can never reset a real
      // installation's anchor by reusing a familiar-looking client id.
      const isEphemeral = client_id.startsWith('test_ephemeral_');
      const expected = isEphemeral ? 'RESET_EPHEMERAL' : 'RESET_AUDIT_ANCHOR';
      if (confirm !== expected) {
        return jsonResponse(
          {
            error: 'CONFIRMATION_REQUIRED',
            message: `Confirmation explicite "${expected}" requise.`,
          },
          400
        );
      }

      const previous = (await env.AUDIT_KV.get(client_id, 'json')) as
        | { sequence_number: number; head_audit_hash: string; synced_at?: string }
        | null;

      if (previous) {
        await env.AUDIT_KV.delete(client_id);
      }

      return jsonResponse({
        status: 'reset',
        client_id,
        discarded_checkpoint: previous,
        had_checkpoint: previous !== null,
        server_time: new Date().toISOString(),
      });
    }

    return jsonResponse({ error: 'NOT_FOUND', message: 'Route non trouvée.' }, 404);
  },
};

