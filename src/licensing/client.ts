/**
 * High-Security Licensing Client Engine
 * Coordinates activation, cryptographic validation, anti-clock-tampering, and heartbeat.
 */

import { sanitizeLicenseKey } from './keyFormat';
import { verifyLicenseToken, type LicenseTokenPayload } from './token';
import { resolveDeviceFingerprint } from './hwid';
import { LicenseClockGuard } from './clockGuard';
import {
  loadStoredLicenseToken,
  persistLicenseToken,
  clearStoredLicenseToken,
  loadClockGuardState,
  saveClockGuardState,
  emitLicenseRevoked,
  loadSuspensionState,
  saveSuspensionState,
  clearSuspensionState,
  saveLastActiveLicenseKey,
  getLastActiveLicenseKey,
} from './store';
import { setCloudCredentials, deleteCloudCredentials } from '../sync/keychain';
import { isMobileDevice, isAndroid, isIOS } from '../utils/platform';

export const DEFAULT_LICENSING_ENDPOINT =
  typeof window !== 'undefined' && (window as any).__MOBI_LICENSING_URL__
    ? (window as any).__MOBI_LICENSING_URL__
    : 'https://mobi-licensing.aminebarcelon28.workers.dev';

export interface LicenseValidationResult {
  licensed: boolean;
  status: 'ACTIVE' | 'UNLICENSED' | 'SUSPENDED' | 'EXPIRED' | 'GRACE_EXCEEDED' | 'TAMPERED_CLOCK' | 'DEVICE_MISMATCH';
  message?: string;
  payload?: LicenseTokenPayload;
  daysRemainingGrace?: number;
  customerName?: string;
}

/**
 * Executes a network fetch with strict timeout.
 */
async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    return res;
  } catch (err) {
    clearTimeout(id);
    throw err;
  }
}

/**
 * Activates a new license key on this device.
 */
export async function activateLicense(params: {
  licenseKey: string;
  friendlyName?: string;
  deviceType?: 'desktop' | 'mobile';
  serverUrl?: string;
}): Promise<{ success: boolean; message?: string; payload?: LicenseTokenPayload }> {
  const normalizedKey = sanitizeLicenseKey(params.licenseKey);
  if (!normalizedKey) {
    return { success: false, message: 'Veuillez saisir une clé de licence valide.' };
  }

  const endpoint = params.serverUrl || DEFAULT_LICENSING_ENDPOINT;
  const hwid = await resolveDeviceFingerprint();
  const isMobile = hwid.platform === 'android' || hwid.platform === 'ios' || isMobileDevice() || isAndroid() || isIOS();
  const deviceType = params.deviceType || (isMobile ? 'mobile' : 'desktop');

  // Generate 16-byte random client nonce for replay prevention
  const nonceBytes = new Uint8Array(16);
  crypto.getRandomValues(nonceBytes);
  const clientNonce = Array.from(nonceBytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  try {
    let response: Response;
    try {
      response = await fetchWithTimeout(
        `${endpoint}/api/v1/license/activate`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            license_key: normalizedKey,
            device_id: hwid.hash,
            device_type: deviceType,
            hardware_hash: hwid.hash,
            friendly_name: params.friendlyName || hwid.formatted,
            client_nonce: clientNonce,
          }),
        },
        params.serverUrl ? 8000 : 3500
      );
    } catch (primaryErr: any) {
      if (!params.serverUrl && endpoint !== 'http://127.0.0.1:8787') {
        try {
          response = await fetchWithTimeout(
            `http://127.0.0.1:8787/api/v1/license/activate`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                license_key: normalizedKey,
                device_id: hwid.hash,
                device_type: deviceType,
                hardware_hash: hwid.hash,
                friendly_name: params.friendlyName || hwid.formatted,
                client_nonce: clientNonce,
              }),
            },
            3000
          );
        } catch {
          throw new Error(
            `Serveur de licence distant injoignable (${endpoint}). Lancez 'npm run license:server' pour activer en local, ou activez par jeton hors-ligne.`
          );
        }
      } else {
        throw primaryErr;
      }
    }

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      const errMsg = data.message || `Échec d’activation (Code HTTP ${response.status}).`;
      return { success: false, message: errMsg };
    }

    if (!data.token) {
      return { success: false, message: 'Le serveur n’a pas renvoyé de jeton signé.' };
    }

    // 1. Verify Ed25519 cryptographic signature on received token
    const verification = await verifyLicenseToken(data.token);
    if (!verification.valid || !verification.payload) {
      return {
        success: false,
        message: `Vérification cryptographique échouée: ${verification.error || 'Signature invalide.'}`,
      };
    }

    const payload = verification.payload;

    // 2. Verify Challenge-Response Nonce
    if (payload.nonce && payload.nonce !== clientNonce) {
      return {
        success: false,
        message: 'Alerte de sécurité: Le nonce cryptographique ne correspond pas à la requête.',
      };
    }

    // 3. Verify Hardware Device Binding
    if (payload.device_id !== hwid.hash) {
      return {
        success: false,
        message: 'Alerte de sécurité: La licence n’est pas liée à l’empreinte de cet appareil.',
      };
    }

    const isMobileNow = hwid.platform === 'android' || hwid.platform === 'ios' || isMobileDevice() || isAndroid() || isIOS();
    const expectedDeviceType = isMobileNow ? 'mobile' : 'desktop';
    if (payload.device_type && payload.device_type !== expectedDeviceType) {
      return {
        success: false,
        message: `Type d'appareil non autorisé : cette licence a été enregistrée pour un appareil ${payload.device_type === 'mobile' ? 'mobile (smartphone)' : 'ordinateur (PC)'}.`,
      };
    }

    // 4. Save License Token in OS Keychain / Vault
    await persistLicenseToken(data.token);
    saveLastActiveLicenseKey(normalizedKey);
    clearSuspensionState();

    // 5. Store BYODB Turso Credentials in OS Keychain
    if (data.turso_url && data.turso_token) {
      await setCloudCredentials(data.turso_url, data.turso_token);
    }

    // 6. Anchor Monotonic Clock Guard
    const now = Date.now();
    saveClockGuardState({
      lastKnownTimestamp: now,
      lastVerifiedAt: now,
    });

    return {
      success: true,
      payload,
      message: 'Licence activée avec succès !',
    };
  } catch (err: any) {
    const isAbort = err.name === 'AbortError';
    return {
      success: false,
      message: isAbort
        ? 'Délai d’attente réseau dépassé lors de la connexion au serveur de licence.'
        : `Impossible d'activer la licence: ${err.message || 'Erreur de connexion.'}`,
    };
  }
}

/**
 * Activates the application directly using an Ed25519 signed offline license token.
 * Zero network requests required.
 */
export async function activateWithOfflineToken(
  token: string
): Promise<{ success: boolean; message?: string; payload?: LicenseTokenPayload }> {
  const cleanToken = token.trim();
  if (!cleanToken) {
    return { success: false, message: 'Veuillez saisir ou coller un jeton de licence valide.' };
  }

  const hwid = await resolveDeviceFingerprint();

  // 1. Cryptographic Ed25519 signature verification against embedded root public key
  const verification = await verifyLicenseToken(cleanToken);
  if (!verification.valid || !verification.payload) {
    return {
      success: false,
      message: `Jeton invalide : ${verification.error || 'Signature cryptographique non reconnue.'}`,
    };
  }

  const payload = verification.payload;

  // 2. Hardware binding verification (unless wildcard '*' for demo/dev)
  if (payload.device_id && payload.device_id !== '*' && payload.device_id !== hwid.hash) {
    return {
      success: false,
      message: `Ce jeton est verrouillé pour un autre appareil (${payload.device_id.slice(0, 8)}...).`,
    };
  }

  // 3. Persist validated token in OS Keychain / Vault
  await persistLicenseToken(cleanToken);
  if (payload.lic_key) {
    saveLastActiveLicenseKey(payload.lic_key);
  }
  clearSuspensionState();

  // 4. Save Turso credentials if bundled in token
  const anyPayload = payload as any;
  if (anyPayload.turso_url && anyPayload.turso_token) {
    await setCloudCredentials(anyPayload.turso_url, anyPayload.turso_token);
  }

  // 5. Monotonic Clock Guard Anchor
  const now = Date.now();
  saveClockGuardState({
    lastKnownTimestamp: now,
    lastVerifiedAt: now,
  });

  return {
    success: true,
    payload,
    message: 'Licence validée et activée avec succès en mode hors-ligne !',
  };
}

/**
 * Evaluates license state at application boot.
 * Enforces suspended state across reboots and offline modes.
 */
export async function checkBootLicense(options?: {
  highestDbTimestampMs?: number;
  serverUrl?: string;
  bootTimeoutMs?: number;
}): Promise<LicenseValidationResult> {
  // 1. Immediate Enforcement of Persisted Suspension (prevents offline bypass)
  const suspension = loadSuspensionState();
  if (suspension && suspension.suspended) {
    return {
      licensed: false,
      status: 'SUSPENDED',
      message: suspension.reason || 'Cette licence a été suspendue par le gestionnaire.',
      customerName: suspension.licenseKey,
    };
  }

  const token = await loadStoredLicenseToken();
  if (!token) {
    return {
      licensed: false,
      status: 'UNLICENSED',
      message: 'Aucune licence trouvée sur cet appareil.',
    };
  }

  // 2. Offline Ed25519 signature verification
  const verification = await verifyLicenseToken(token);
  if (!verification.valid || !verification.payload) {
    return {
      licensed: false,
      status: 'UNLICENSED',
      message: `Jeton de licence corrompu ou falsifié: ${verification.error}`,
    };
  }

  const payload = verification.payload;
  saveLastActiveLicenseKey(payload.lic_key);

  // 3. Hardware Device Match check
  const hwid = await resolveDeviceFingerprint();
  if (payload.device_id !== hwid.hash) {
    return {
      licensed: false,
      status: 'DEVICE_MISMATCH',
      message: 'Cette licence est liée à un autre terminal matériel.',
      payload,
    };
  }

  const isMobileNow = hwid.platform === 'android' || hwid.platform === 'ios' || isMobileDevice() || isAndroid() || isIOS();
  const expectedDeviceType = isMobileNow ? 'mobile' : 'desktop';
  if (payload.device_type && payload.device_type !== expectedDeviceType) {
    return {
      licensed: false,
      status: 'DEVICE_MISMATCH',
      message: `Ce jeton est destiné à un ${payload.device_type === 'mobile' ? 'smartphone (Android)' : 'ordinateur (PC)'}.`,
      payload,
    };
  }

  // 4. Anti-Clock-Tampering & Grace Period check
  const clockState = loadClockGuardState();
  const isLifetime = payload.lic_type === 'LIFETIME';
  const guard = new LicenseClockGuard(
    clockState,
    payload.exp,
    payload.grace_days || 7,
    isLifetime
  );

  const evalResult = guard.evaluate(Date.now(), options?.highestDbTimestampMs || 0);
  saveClockGuardState(evalResult.nextState);

  if (evalResult.result.status !== 'ACTIVE') {
    return {
      licensed: false,
      status: evalResult.result.status,
      message: evalResult.result.message,
      payload,
    };
  }

  // 5. Online Verification with Server
  const timeoutMs = options?.bootTimeoutMs ?? 2500;
  const endpoint = options?.serverUrl || DEFAULT_LICENSING_ENDPOINT;

  try {
    const pingRes = await fetchWithTimeout(
      `${endpoint}/api/v1/license/verify`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          license_key: payload.lic_key,
          device_id: hwid.hash,
        }),
      },
      timeoutMs
    );

    const data = await pingRes.json().catch(() => ({}));

    // Server says suspended or revoked
    if (pingRes.status === 403 || pingRes.status === 404 || data.active === false) {
      const reason =
        data.message ||
        (data.error === 'LICENSE_SUSPENDED'
          ? 'Cette licence a été suspendue par l’administrateur.'
          : 'Licence non active ou révoquée sur le serveur central.');

      // Lock locally so airplane mode or app reload cannot bypass suspension
      saveSuspensionState({
        suspended: true,
        reason,
        suspendedAt: Date.now(),
        licenseKey: payload.lic_key,
      });

      await clearStoredLicenseToken();
      await deleteCloudCredentials();
      emitLicenseRevoked(reason);

      return {
        licensed: false,
        status: 'SUSPENDED',
        message: reason,
        payload,
      };
    }

    if (pingRes.ok && data.active !== false) {
      clearSuspensionState();
      const current = loadClockGuardState();
      saveClockGuardState({
        ...current,
        lastVerifiedAt: Date.now(),
      });
    }
  } catch {
    // Silent fallback to offline token within grace period if network unreachable
  }

  return {
    licensed: true,
    status: 'ACTIVE',
    payload,
    daysRemainingGrace: evalResult.result.daysRemainingGrace,
  };
}

/**
 * Mid-Session Background Heartbeat Engine.
 * Periodically checks license status online and locks immediately if suspended.
 */
let activeHeartbeatInterval: number | null = null;
let activeVisibilityListener: (() => void) | null = null;
let activeOnlineListener: (() => void) | null = null;

export function startLicenseHeartbeat(options?: {
  intervalMs?: number;
  serverUrl?: string;
  onRevoked?: (reason: string) => void;
}): () => void {
  if (typeof window === 'undefined') return () => {};

  if (activeHeartbeatInterval !== null) {
    clearInterval(activeHeartbeatInterval);
    activeHeartbeatInterval = null;
  }
  if (activeVisibilityListener) {
    document.removeEventListener('visibilitychange', activeVisibilityListener);
    activeVisibilityListener = null;
  }
  if (activeOnlineListener) {
    window.removeEventListener('online', activeOnlineListener);
    activeOnlineListener = null;
  }

  const endpoint = options?.serverUrl || DEFAULT_LICENSING_ENDPOINT;
  const intervalMs = options?.intervalMs || 120000; // 120s (2 minutes) heartbeat (~360 req/day per device)

  const checkStatus = async () => {
    try {
      const token = await loadStoredLicenseToken();
      if (!token) return;

      const v = await verifyLicenseToken(token);
      if (!v.valid || !v.payload) return;

      const hwid = await resolveDeviceFingerprint();

      const pingRes = await fetchWithTimeout(
        `${endpoint}/api/v1/license/verify`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            license_key: v.payload.lic_key,
            device_id: hwid.hash,
          }),
        },
        4500
      );

      const data = await pingRes.json().catch(() => ({}));

      if (pingRes.status === 403 || pingRes.status === 404 || data.active === false) {
        const reason =
          data.message ||
          (data.error === 'LICENSE_SUSPENDED'
            ? 'Cette licence a été suspendue par l’administrateur.'
            : 'Licence révoquée ou introuvable sur le serveur.');

        // Durably mark suspension
        saveSuspensionState({
          suspended: true,
          reason,
          suspendedAt: Date.now(),
          licenseKey: v.payload.lic_key,
        });

        // Wipe cached tokens & cloud credentials
        await clearStoredLicenseToken();
        await deleteCloudCredentials();

        // Emit revocation to drop screen to suspension wall
        emitLicenseRevoked(reason);
        if (options?.onRevoked) options.onRevoked(reason);
      } else if (pingRes.ok && data.active !== false) {
        clearSuspensionState();
        const current = loadClockGuardState();
        saveClockGuardState({
          ...current,
          lastVerifiedAt: Date.now(),
        });
      }
    } catch {
      // Offline fallback: normal operation tolerated within grace period
    }
  };

  activeHeartbeatInterval = window.setInterval(checkStatus, intervalMs);

  activeVisibilityListener = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
      void checkStatus();
    }
  };
  document.addEventListener('visibilitychange', activeVisibilityListener);

  activeOnlineListener = () => {
    void checkStatus();
  };
  window.addEventListener('online', activeOnlineListener);

  // Trigger non-blocking ping after 2 seconds
  setTimeout(() => {
    void checkStatus();
  }, 2000);

  return () => {
    if (activeHeartbeatInterval !== null) {
      clearInterval(activeHeartbeatInterval);
      activeHeartbeatInterval = null;
    }
    if (activeVisibilityListener) {
      document.removeEventListener('visibilitychange', activeVisibilityListener);
      activeVisibilityListener = null;
    }
    if (activeOnlineListener) {
      window.removeEventListener('online', activeOnlineListener);
      activeOnlineListener = null;
    }
  };
}

/**
 * Manually re-checks license status against the server (e.g. after manager reactivated license).
 */
export async function recheckLicenseStatus(
  licenseKey?: string,
  serverUrl?: string
): Promise<{ success: boolean; message: string; payload?: LicenseTokenPayload }> {
  const keyToUse = sanitizeLicenseKey(
    licenseKey || getLastActiveLicenseKey() || ''
  );

  if (!keyToUse) {
    return {
      success: false,
      message: 'Aucune clé de licence enregistrée à vérifier. Veuillez saisir votre clé manuellement.',
    };
  }

  const endpoint = serverUrl || DEFAULT_LICENSING_ENDPOINT;
  const hwid = await resolveDeviceFingerprint();
  const isMobile = hwid.platform === 'android' || hwid.platform === 'ios' || isMobileDevice() || isAndroid() || isIOS();
  const deviceType = isMobile ? 'mobile' : 'desktop';

  try {
    const res = await activateLicense({
      licenseKey: keyToUse,
      friendlyName: isMobile ? 'Mobile Vendeur' : 'Caisse Principale',
      deviceType,
      serverUrl: endpoint,
    });

    if (res.success && res.payload) {
      clearSuspensionState();
      return {
        success: true,
        message: 'Licence réactivée avec succès ! Bon retour sur MobiPOS.',
        payload: res.payload,
      };
    } else {
      return {
        success: false,
        message: res.message || 'La licence est toujours suspendue ou inaccessible.',
      };
    }
  } catch (err: any) {
    return {
      success: false,
      message: `Erreur de connexion : ${err.message || 'Serveur injoignable.'}`,
    };
  }
}

/**
 * Disconnects and unlinks this device from the active license.
 */
export async function unlinkLicense(serverUrl?: string): Promise<void> {
  const token = await loadStoredLicenseToken();
  if (token) {
    try {
      const v = await verifyLicenseToken(token);
      if (v.valid && v.payload) {
        const endpoint = serverUrl || DEFAULT_LICENSING_ENDPOINT;
        await fetchWithTimeout(
          `${endpoint}/api/v1/license/deactivate`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              license_key: v.payload.lic_key,
              device_id: v.payload.device_id,
            }),
          },
          3000
        ).catch(() => {});
      }
    } catch {
      // Best effort
    }
  }

  clearSuspensionState();
  await clearStoredLicenseToken();
  await deleteCloudCredentials();
}
