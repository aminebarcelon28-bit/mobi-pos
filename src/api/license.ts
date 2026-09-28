import { invokeCommand } from '../platform/invoke';

export interface HardwareFingerprintResult {
  formatted: string; // e.g. "MOBI-7E28-A4F1-0B3C-9D82"
  hash: string;      // 64-character SHA-256 hex string
  platform: string;  // "windows" | "android" | "linux" | "macos" | "fallback"
}

export async function getHardwareFingerprint(): Promise<HardwareFingerprintResult> {
  return invokeCommand<HardwareFingerprintResult>('get_hardware_fingerprint');
}

export async function getLicenseToken(): Promise<string | null> {
  return invokeCommand<string | null>('get_license_token');
}

export async function setLicenseToken(token: string): Promise<void> {
  await invokeCommand('set_license_token', { token });
}

export async function deleteLicenseToken(): Promise<void> {
  await invokeCommand('delete_license_token');
}
