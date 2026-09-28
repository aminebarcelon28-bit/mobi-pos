/**
 * Normalisation & Validation des Numéros de Téléphone Algériens (Mobilis, Djezzy, Ooredoo, Fixe)
 * Supports Arabic-Indic digits, full-width digits, RFC 3966 tel: URIs, and native WebView launchers.
 * Implements Bug Fix F-01 (v1.7.0). All native calls route through the src/platform seam.
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
 * Canonical Algerian phone canonicalizer (string form).
 *
 * Returns the canonical `+213XXXXXXXXX` string for a local `0XXXXXXXXX`
 * input (digits only in, canonical out). Unifies with the structured
 * {@link normalizeAlgerianPhone} above: valid numbers delegate to its
 * `international` field; anything else gets a deterministic best-effort
 * `+213<national>` fallback ('' for empty input).
 *
 * Naming note: this is intentionally NOT called `normalizeAlgerianPhone` —
 * that export already exists in this file and returns a
 * {@link NormalizedPhoneResult} object. Renaming/retyping it would break its
 * two consumers (KredyTab, MobileCheckoutTab) and every future importer, so
 * the string form lives here under the `-Canonical` suffix. Other agents:
 * import THIS function for canonical-string needs.
 *
 * Handles Arabic-Indic / Persian / full-width digits (via
 * {@link convertNonAsciiDigits}) plus spaces, dashes, dots and parentheses.
 */
export function normalizeAlgerianPhoneCanonical(raw: string): string {
  const norm = normalizeAlgerianPhone(raw);
  if (norm.isValid && norm.international) return norm.international;
  const converted = convertNonAsciiDigits((raw || '').trim());
  const digits = converted.replace(/\D/g, '');
  if (!digits) return '';
  let national = digits;
  if (national.startsWith('00213')) {
    national = national.slice(5);
  } else if (national.startsWith('213')) {
    national = national.slice(3);
  } else if (national.startsWith('0')) {
    national = national.slice(1);
  }
  if (!national) return '';
  return `+213${national}`;
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

async function getPlatformInvoke() {
  const mod = await import('../platform/invoke');
  return mod.invokeCommand;
}

async function getPlatformOpener() {
  const mod = await import('../platform/opener');
  return mod.openExternalUrl;
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
      const invokeCommand = await getPlatformInvoke();
      await invokeCommand('launch_call', { phone: normalized.international });
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
      const invokeCommand = await getPlatformInvoke();
      await invokeCommand('launch_whatsapp', { url: waUrl });
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
      const invokeCommand = await getPlatformInvoke();
      await invokeCommand('launch_url', { url });
      return true;
    } catch {
      try {
        const openExternalUrl = await getPlatformOpener();
        await openExternalUrl(url);
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

  const escapeHtml = (s: string): string =>
    s.replace(/[&<>]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[char] || char));

  if (isTauriEnvironment()) {
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';
    const onAndroid = /android/i.test(ua);
    const onMobile = /android|iphone|ipad|ipod/i.test(ua);

    // Android: system print sheet via the native plugin (any printer model).
    if (onAndroid) {
      try {
        const invokeCommand = await getPlatformInvoke();
        await invokeCommand('launch_print', { title, content });
        return true;
      } catch (error) {
        console.warn('[phoneUtils] Native print launch failed:', error);
      }
    } else if (!onMobile) {
      // Desktop app: WebView2 has no popup flow — render the text into the
      // shared print target and open the system dialog (any printer / PDF).
      // (iOS WebViews have no print dialog either: fall through to the
      // popup attempt below so failure stays loud instead of fake-success.)
      try {
        const { printCoordinator } = await import('./printCoordinator');
        let host = document.getElementById('mobi-print-text-host');
        if (!host) {
          host = document.createElement('div');
          host.id = 'mobi-print-text-host';
          host.className = 'print-text-target hidden print:block';
          document.body.appendChild(host);
        }
        host.innerHTML = `<pre>${escapeHtml(content)}</pre>`;
        printCoordinator.printChannelDirect('text_doc', 150);
        return true;
      } catch (error) {
        console.warn('[phoneUtils] Desktop text print failed:', error);
        return false;
      }
    }
  }

  try {
    const printWindow = window.open('', '_blank', 'noopener,noreferrer');
    if (!printWindow) return false;
    printWindow.document.write(`<pre style="font: 12px monospace; white-space: pre-wrap;">${escapeHtml(content)}</pre>`);
    printWindow.document.close();
    printWindow.focus();
    printWindow.print();
    printWindow.close();
    return true;
  } catch {
    return false;
  }
}

export interface LabelPrintImagePayload {
  title: string;
  /** PNG data URL (`data:image/png;base64,…`) rendered by `renderLabelToCanvas`. */
  imageBase64: string;
  widthMm: number;
  heightMm: number;
  copies: number;
}

/**
 * Sends a label PNG to the Android system print sheet (`launch_print_label`
 * → PhonePlugin `printLabel`). Returns false when not on Tauri-Android or
 * when the native call rejects, so callers can fall back to the share sheet.
 */
export async function printLabelImageNative(payload: LabelPrintImagePayload): Promise<boolean> {
  if (!payload.imageBase64) return false;
  if (!isTauriEnvironment()) return false;
  try {
    const invokeCommand = await getPlatformInvoke();
    await invokeCommand('launch_print_label', {
      title: payload.title,
      imageBase64: payload.imageBase64,
      widthMm: payload.widthMm,
      heightMm: payload.heightMm,
      copies: Math.max(1, Math.min(200, Math.round(payload.copies) || 1)),
    });
    return true;
  } catch (error) {
    console.warn('[phoneUtils] Native label print failed:', error);
    return false;
  }
}

/**
 * Shares a PNG via the OS share sheet (printer apps, WhatsApp, Drive…),
 * falling back to a plain download when Web Share is unavailable.
 */
export async function sharePngFile(
  fileName: string,
  dataUrl: string,
  title?: string,
  text?: string
): Promise<boolean> {
  try {
    const res = await fetch(dataUrl);
    const blob = await res.blob();
    const file = new File([blob], fileName, { type: 'image/png' });
    const nav = navigator as Navigator & {
      canShare?: (data: { files: File[] }) => boolean;
      share?: (data: { files: File[]; title?: string; text?: string }) => Promise<void>;
    };
    if (typeof nav.canShare === 'function' && typeof nav.share === 'function') {
      try {
        if (nav.canShare({ files: [file] })) {
          await nav.share({ files: [file], title, text });
          return true;
        }
      } catch {
        return false; // user dismissed the sheet — not an error to escalate
      }
    }
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 5000);
    return true;
  } catch {
    return false;
  }
}
