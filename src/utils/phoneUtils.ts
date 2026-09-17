/**
 * Normalisation & Validation des Numéros de Téléphone Algériens (Mobilis, Djezzy, Ooredoo, Fixe)
 * Supports Arabic-Indic digits, full-width digits, RFC 3966 tel: URIs, and native WebView launchers.
 * Implements Bug Fix F-01 (v1.7.0).
 */

export interface NormalizedPhoneResult {
  raw: string;
  digitsOnly: string;
  local: string;           // ex: 0550123456
  international: string;   // ex: +213550123456
  whatsAppFormat: string;  // ex: 213550123456 (format requis pour wa.me)
  formattedDisplay: string;// ex: 0550 12 34 56
  isValid: boolean;
  operator: 'Mobilis' | 'Djezzy' | 'Ooredoo' | 'Fixe' | 'Inconnu';
}

/**
 * Convert any non-ASCII digit representations (Arabic-Indic, Persian, full-width) to standard 0-9.
 */
export function convertNonAsciiDigits(input: string): string {
  return input
    // Arabic-Indic digits (٠-٩)
    .replace(/[\u0660-\u0669]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x0660 + 0x30))
    // Eastern Arabic-Indic / Persian digits (۰-۹)
    .replace(/[\u06F0-\u06F9]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x06F0 + 0x30))
    // Full-width digits (０-９)
    .replace(/[\uFF10-\uFF19]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFF10 + 0x30));
}

export function normalizeAlgerianPhone(input: string | undefined | null): NormalizedPhoneResult {
  const raw = (input || '').trim();
  const converted = convertNonAsciiDigits(raw);
  const digitsOnly = converted.replace(/\D/g, '');

  if (!digitsOnly) {
    return {
      raw,
      digitsOnly: '',
      local: '',
      international: '',
      whatsAppFormat: '',
      formattedDisplay: '',
      isValid: false,
      operator: 'Inconnu',
    };
  }

  let nationalDigits = '';

  // Format 1: Starts with international prefix 00213 or 213
  if (digitsOnly.startsWith('00213')) {
    nationalDigits = digitsOnly.slice(5);
  } else if (digitsOnly.startsWith('213') && (digitsOnly.length === 11 || digitsOnly.length === 12)) {
    nationalDigits = digitsOnly.slice(3);
  } else if (digitsOnly.startsWith('0')) {
    // Format 2: Local with leading 0
    // Mobile: 0 + 9 digits = 10 digits (e.g. 0550123456)
    // Fixe: 0 + 8 digits = 9 digits (e.g. 021123456)
    if (digitsOnly.length === 10 || digitsOnly.length === 9) {
      nationalDigits = digitsOnly.slice(1);
    } else {
      nationalDigits = digitsOnly;
    }
  } else {
    // Format 3: Without leading 0 (9 digits for mobile, 8 digits for fixe)
    nationalDigits = digitsOnly;
  }

  // Operator detection & validation
  let operator: NormalizedPhoneResult['operator'] = 'Inconnu';
  let isValid = false;

  if (nationalDigits.length === 9) {
    if (nationalDigits.startsWith('5')) {
      operator = 'Ooredoo';
      isValid = true;
    } else if (nationalDigits.startsWith('6')) {
      operator = 'Mobilis';
      isValid = true;
    } else if (nationalDigits.startsWith('7')) {
      operator = 'Djezzy';
      isValid = true;
    }
  } else if (nationalDigits.length === 8) {
    if (
      nationalDigits.startsWith('2') ||
      nationalDigits.startsWith('3') ||
      nationalDigits.startsWith('4')
    ) {
      operator = 'Fixe';
      isValid = true;
    }
  }

  const local = isValid ? `0${nationalDigits}` : raw;
  const international = isValid ? `+213${nationalDigits}` : (raw.startsWith('+') ? raw : `+${digitsOnly}`);
  const whatsAppFormat = isValid ? `213${nationalDigits}` : digitsOnly;

  // Format for clean display:
  // Mobile: 0550 12 34 56
  // Fixe:   021 12 34 56
  let formattedDisplay = local;
  if (isValid) {
    if (nationalDigits.length === 9) {
      formattedDisplay = `0${nationalDigits.slice(0, 3)} ${nationalDigits.slice(3, 5)} ${nationalDigits.slice(5, 7)} ${nationalDigits.slice(7, 9)}`;
    } else if (nationalDigits.length === 8) {
      formattedDisplay = `0${nationalDigits.slice(0, 2)} ${nationalDigits.slice(2, 4)} ${nationalDigits.slice(4, 6)} ${nationalDigits.slice(6, 8)}`;
    }
  }

  return {
    raw,
    digitsOnly,
    local,
    international,
    whatsAppFormat,
    formattedDisplay,
    isValid,
    operator,
  };
}

/**
 * Builds an RFC 3966 compliant tel: URI
 */
export function buildTelUri(phoneNumber: string): string {
  const norm = normalizeAlgerianPhone(phoneNumber);
  if (norm.international && norm.isValid) {
    return `tel:${norm.international}`;
  }
  const digits = norm.digitsOnly || phoneNumber.replace(/\D/g, '');
  return `tel:${digits}`;
}

/**
 * Builds a direct WhatsApp chat URL with pre-filled message
 */
export function buildWhatsAppUrl(phoneNumber: string, message: string): string {
  const norm = normalizeAlgerianPhone(phoneNumber);
  const targetNumber = norm.whatsAppFormat || phoneNumber.replace(/\D/g, '');
  return `https://wa.me/${targetNumber}?text=${encodeURIComponent(message)}`;
}

/**
 * Helper to check if running inside a Tauri application environment
 */
export function isTauriEnvironment(): boolean {
  if (typeof window === 'undefined') return false;
  return Boolean(
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ ||
    (window as unknown as { __TAURI__?: unknown }).__TAURI__
  );
}

/**
 * Places a call through the native phone app.
 * On Android Tauri, the native bridge requests CALL_PHONE when needed and uses ACTION_CALL.
 * Other platforms keep the existing dialer-opening behavior.
 */
export async function openDialer(phoneNumber: string): Promise<boolean> {
  const normalized = normalizeAlgerianPhone(phoneNumber);
  if (!normalized.isValid) return false;
  const telUri = `tel:${normalized.international}`;

  if (isTauriEnvironment()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('launch_call', { phone: normalized.international });
      return true;
    } catch (error) {
      console.warn('[phoneUtils] Native call failed:', error);
      return false;
    }
  }

  // Browser / Webview fallback: synthetic link
  try {
    const a = document.createElement('a');
    a.href = telUri;
    a.target = '_self';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    return true;
  } catch {
    window.location.href = telUri;
    return true;
  }
}

/**
 * Opens WhatsApp with the chat and pre-filled message.
 * On mobile Tauri, invokes opener plugin or custom intent to bypass WebView target=_blank failure.
 */
export async function openWhatsApp(phoneNumber: string, message: string): Promise<boolean> {
  const normalized = normalizeAlgerianPhone(phoneNumber);
  if (!normalized.isValid) return false;
  const waUrl = buildWhatsAppUrl(phoneNumber, message);

  if (isTauriEnvironment()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('launch_whatsapp', { url: waUrl });
      return true;
    } catch (error) {
      console.warn('[phoneUtils] Native WhatsApp launch failed:', error);
      return false;
    }
  }

  // Browser fallback
  try {
    const a = document.createElement('a');
    a.href = waUrl;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    return true;
  } catch {
    window.open(waUrl, '_blank', 'noopener,noreferrer');
    return true;
  }
}

/**
 * Opens an external URL safely, checking against an internal allow-list when in Tauri.
 */
export async function openUrl(url: string): Promise<boolean> {
  if (!url) return false;

  if (isTauriEnvironment()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('launch_url', { url });
      return true;
    } catch {
      try {
        const opener = await import('@tauri-apps/plugin-opener');
        await opener.openUrl(url);
        return true;
      } catch (e) {
        console.warn('[phoneUtils] Tauri opener openUrl failed, falling back:', e);
      }
    }
  }

  // Browser fallback
  window.open(url, '_blank', 'noopener,noreferrer');
  return true;
}

/** Opens the platform print sheet for a plain-text business document. */
export async function openNativePrint(title: string, content: string): Promise<boolean> {
  if (!title.trim() || !content.trim()) return false;

  if (isTauriEnvironment()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('launch_print', { title, content });
      return true;
    } catch (error) {
      console.warn('[phoneUtils] Native print launch failed:', error);
    }
  }

  try {
    const printWindow = window.open('', '_blank', 'noopener,noreferrer');
    if (!printWindow) return false;
    printWindow.document.write(`<pre style="font: 12px monospace; white-space: pre-wrap;">${content.replace(/[&<>]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[char] || char))}</pre>`);
    printWindow.document.close();
    printWindow.focus();
    printWindow.print();
    printWindow.close();
    return true;
  } catch {
    return false;
  }
}
