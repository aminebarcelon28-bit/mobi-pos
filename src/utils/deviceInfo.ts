let cachedDeviceId: string | null = null;
let cachedIpAddress: string | null = null;
let ipFetchPromise: Promise<string> | null = null;

export function generateDeviceId(): string {
  if (cachedDeviceId) return cachedDeviceId;

  let deviceId = localStorage.getItem('mobi:device-id');
  if (!deviceId) {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 10);
    deviceId = `TERM-${timestamp}-${random}`.toUpperCase();
    localStorage.setItem('mobi:device-id', deviceId);
  }
  cachedDeviceId = deviceId;
  return deviceId;
}

export function getDeviceId(): string {
  return cachedDeviceId || generateDeviceId();
}

export async function getIpAddress(): Promise<string> {
  if (cachedIpAddress) return cachedIpAddress;

  if (ipFetchPromise) return ipFetchPromise;

  ipFetchPromise = (async (): Promise<string> => {
    try {
      const response = await fetch('https://api.ipify.org?format=json', {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
      });
      if (response.ok) {
        const data = (await response.json()) as { ip?: string };
        const ip: string = data.ip || 'Inconnue';
        cachedIpAddress = ip;
        return ip;
      }
    } catch {
      // Silently fail
    }
    const fallback = 'Non détectée (hors-ligne)';
    cachedIpAddress = fallback;
    return fallback;
  })();

  return ipFetchPromise;
}

export function getDeviceInfo() {
  return {
    deviceId: getDeviceId(),
    ipAddress: cachedIpAddress || 'En cours...',
  };
}

export async function ensureDeviceInfoLoaded(): Promise<{ deviceId: string; ipAddress: string }> {
  const deviceId = getDeviceId();
  const ipAddress = await getIpAddress();
  return { deviceId, ipAddress };
}

if (typeof window !== 'undefined') {
  generateDeviceId();
  getIpAddress().catch(() => {});
}