import { invokeCommand } from '../platform/invoke';

export interface NativeDeviceCredentials {
  deviceId: string;
  publicKeyHex: string;
}

/**
 * TIER-B boot handshake: fetch the natively enrolled device credentials.
 * Returns ONLY the id + public key — the seed never crosses IPC (the Rust
 * struct cannot even serialize it). Throws fail-closed when the keystore is
 * uninitialized; callers treat that as "identity unknown", never as a
 * fallback id (a fallback here would re-open the spoofing residual).
 */
export async function getDeviceIdentityInfo(): Promise<NativeDeviceCredentials> {
  return invokeCommand<NativeDeviceCredentials>('get_device_identity_info', {});
}

let cached: NativeDeviceCredentials | null = null;
let inflight: Promise<NativeDeviceCredentials> | null = null;

/** Cached handshake (one IPC per boot; concurrent callers share it). */
export function getCachedDeviceIdentity(): Promise<NativeDeviceCredentials> {
  if (cached) return Promise.resolve(cached);
  if (!inflight) {
    inflight = getDeviceIdentityInfo().then(
      (creds) => {
        cached = creds;
        return creds;
      },
      (err) => {
        inflight = null;
        throw err;
      }
    );
  }
  return inflight;
}

/**
 * Boot consistency proof: the native enrolled id MUST equal the stable sync
 * authorship id (the keystore adopts it at enrollment). A mismatch is
 * tamper evidence — logged loudly, surfaced to diagnostics, never
 * auto-healed (healing would bless whichever side the attacker controls).
 * Returns true when consistent, false otherwise (or when either side is
 * unreadable — unknown is not proof).
 */
export async function verifyDeviceIdentityConsistency(): Promise<boolean> {
  try {
    const [{ getStableDeviceId }, creds] = await Promise.all([
      import('../sync/device'),
      getCachedDeviceIdentity(),
    ]);
    const stable = await getStableDeviceId().catch(() => '');
    const nativeId = String(creds?.deviceId ?? '').trim();
    if (!stable || !nativeId) {
      console.warn('[device-identity] Consistency UNPROVEN (missing side): skipping.');
      return false;
    }
    if (stable !== nativeId) {
      console.error(
        `[device-identity] MISMATCH: sync authorship=${stable} native enrolled=${nativeId} — possible clone/restore; refunds stay available but attribution is suspect.`
      );
      return false;
    }
    return true;
  } catch (e) {
    console.warn('[device-identity] Handshake failed (fail-closed, no fallback id):', e);
    return false;
  }
}
