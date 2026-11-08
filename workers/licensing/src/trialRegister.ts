/**
 * M2 trial funnel — POST /trial/register backend (D1–D14 decisions).
 *
 * SECURITY POSTURE (S-tier, fail-closed):
 *  - NO license is minted here. Money stays on the manual rail (D-rail):
 *    the lead lands in `customers`, the owner gets a Telegram ping, contact
 *    and payment happen on WhatsApp, the owner mints the trial licence with
 *    the admin tooling. The automated path never touches licensing.
 *  - Exactly-once: `customers.id` IS the client-supplied Idempotency-Key, so
 *    a retried POST cannot create a second lead — a replay returns the same
 *    verdict with `already_registered: true`.
 *  - Rate limiting: `trial_ip` window (see rateLimit.ts) runs BEFORE any
 *    insert, so lead-table flooding dies at the wall.
 *  - Input validation is strict and self-contained: the DB never sees a
 *    byte this module did not normalize first.
 *  - Responses are minimal and uniform: no field echoes more than the client
 *    sent, no enumeration surface.
 */

export interface TrialRegistrationRequest {
  full_name: unknown;
  whatsapp: unknown;
  idempotency_key: unknown;
  device_id?: unknown;
}

export interface NormalizedTrialRegistration {
  idempotency_key: string;
  full_name: string;
  whatsapp: string;
  device_id: string | null;
}

export type TrialValidationResult =
  | { ok: true; value: NormalizedTrialRegistration }
  | { ok: false; error: string; message: string };

/** Idempotency-Key: 8–64 chars of URL-safe token space (UUIDs qualify). */
const IDEMPOTENCY_RE = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * Normalize a WhatsApp contact to bare digits with an optional leading '+'.
 * Accepts the formats humans actually type: '+213 555 12 34 56',
 * '0550 00 33 33', '0550003333'. Rejects letters, too-short and too-long
 * values — a malformed contact is useless to the owner and a spam vector.
 */
export function normalizeWhatsApp(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/[^0-9]/g, '');
  if (digits.length < 8 || digits.length > 15) return null;
  // A leading 0 (national trunk format) is fine; a leading + is fine; what
  // must NOT happen is a '+' glued after digits ('0550+123').
  if (hasPlus && trimmed.lastIndexOf('+') !== 0) return null;
  return (hasPlus ? '+' : '') + digits;
}

/** Name: 2–80 visible chars, at least one letter, no control characters. */
export function normalizeFullName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  if (collapsed.length < 2 || collapsed.length > 80) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(collapsed)) return null;
  if (!/\p{L}/u.test(collapsed)) return null;
  return collapsed;
}

export function validateTrialRegistration(body: TrialRegistrationRequest): TrialValidationResult {
  const name = normalizeFullName(body.full_name);
  if (!name) {
    return {
      ok: false,
      error: 'INVALID_NAME',
      message: 'Nom invalide (2 à 80 caractères, au moins une lettre).',
    };
  }
  const whatsapp = normalizeWhatsApp(body.whatsapp);
  if (!whatsapp) {
    return {
      ok: false,
      error: 'INVALID_WHATSAPP',
      message: 'Numéro WhatsApp invalide (8 à 15 chiffres).',
    };
  }
  const idem =
    typeof body.idempotency_key === 'string' && IDEMPOTENCY_RE.test(body.idempotency_key)
      ? body.idempotency_key
      : null;
  if (!idem) {
    return {
      ok: false,
      error: 'INVALID_IDEMPOTENCY_KEY',
      message: 'Clé d’idempotence invalide (8 à 64 caractères alphanumériques).',
    };
  }
  // device_id is optional at registration (the device binds at activation);
  // when present it must be a sane identifier, never a free-form payload.
  let deviceId: string | null = null;
  if (typeof body.device_id === 'string' && body.device_id.trim()) {
    const d = body.device_id.trim();
    if (d.length > 128 || !/^[A-Za-z0-9:_\-.]+$/.test(d)) {
      return {
        ok: false,
        error: 'INVALID_DEVICE_ID',
        message: 'Identifiant d’appareil invalide.',
      };
    }
    deviceId = d;
  }
  return { ok: true, value: { idempotency_key: idem, full_name: name, whatsapp, device_id: deviceId } };
}

export interface TrialRegisterDb {
  execute(sql: { sql: string; args: Record<string, unknown> }): Promise<{
    rows: ArrayLike<Record<string, unknown>>;
    rowsAffected: number;
  }>;
}

// --- Lead status transitions (console « Clients ») -------------------------

export const LEAD_STATUSES = ['lead', 'contacted', 'converted', 'lost'] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export function isValidLeadStatus(value: unknown): value is LeadStatus {
  return typeof value === 'string' && (LEAD_STATUSES as readonly string[]).includes(value);
}

export type LeadStatusOutcome =
  | { status: 'updated' }
  | { status: 'not_found' }
  | { status: 'rejected'; reason: string };

/**
 * Owner-only status transition. The id must match the idempotency-key shape
 * (it IS the row PK), the status must be one of the four canonical values —
 * anything else fails closed before the DB sees it.
 */
export async function updateLeadStatus(
  db: TrialRegisterDb,
  id: string,
  leadStatus: LeadStatus
): Promise<LeadStatusOutcome> {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) {
    return { status: 'rejected', reason: 'invalid_lead_id' };
  }
  try {
    const res = await db.execute({
      sql: `UPDATE customers SET status = :status WHERE id = :id`,
      args: { status: leadStatus, id },
    });
    if (res.rowsAffected === 0) return { status: 'not_found' };
    return { status: 'updated' };
  } catch (err) {
    return { status: 'rejected', reason: `lead_update_failed: ${(err as Error).message}` };
  }
}

export type TrialRegisterOutcome =
  | { status: 'registered'; leadId: string }
  | { status: 'already_registered'; leadId: string }
  | { status: 'rejected'; reason: string };

/**
 * Exactly-once lead insert. The PK conflict on a replay is mapped to
 * `already_registered` (idempotent success), everything else fails closed.
 */
export async function registerTrialLead(
  db: TrialRegisterDb,
  value: NormalizedTrialRegistration,
  nowIso: string
): Promise<TrialRegisterOutcome> {
  try {
    await db.execute({
      sql: `INSERT INTO customers (id, full_name, whatsapp, created_at, source, status)
            VALUES (:id, :full_name, :whatsapp, :now, 'trial_screen', 'lead')`,
      args: {
        id: value.idempotency_key,
        full_name: value.full_name,
        whatsapp: value.whatsapp,
        now: nowIso,
      },
    });
    return { status: 'registered', leadId: value.idempotency_key };
  } catch (err) {
    const message = (err as Error).message ?? '';
    if (/ALREADY|UNIQUE|constraint/i.test(message)) {
      // Idempotent replay — same lead, no second row, no error to the client.
      return { status: 'already_registered', leadId: value.idempotency_key };
    }
    return { status: 'rejected', reason: `lead_insert_failed: ${message}` };
  }
}
