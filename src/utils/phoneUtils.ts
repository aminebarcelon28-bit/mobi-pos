/**
 * Normalisation & Validation des Numéros de Téléphone Algériens (Mobilis, Djezzy, Ooredoo, Fixe)
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

export function normalizeAlgerianPhone(input: string | undefined | null): NormalizedPhoneResult {
  const raw = (input || '').trim();
  const digitsOnly = raw.replace(/\D/g, '');

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

  let standard9Digits = '';

  // Format 1: Starts with country code 213 (e.g. 213550123456 or 00213550123456)
  if (digitsOnly.startsWith('00213') && digitsOnly.length === 14) {
    standard9Digits = digitsOnly.slice(5);
  } else if (digitsOnly.startsWith('213') && digitsOnly.length === 12) {
    standard9Digits = digitsOnly.slice(3);
  } else if (digitsOnly.startsWith('0') && digitsOnly.length === 10) {
    // Format 2: Local 10 digits (e.g. 0550123456)
    standard9Digits = digitsOnly.slice(1);
  } else if (digitsOnly.length === 9) {
    // Format 3: 9 digits without leading 0 (e.g. 550123456)
    standard9Digits = digitsOnly;
  } else {
    standard9Digits = digitsOnly;
  }

  const local = standard9Digits.length === 9 ? `0${standard9Digits}` : raw;
  const international = standard9Digits.length === 9 ? `+213${standard9Digits}` : raw;
  const whatsAppFormat = standard9Digits.length === 9 ? `213${standard9Digits}` : digitsOnly;

  // Identify Algerian mobile operator prefix
  let operator: NormalizedPhoneResult['operator'] = 'Inconnu';
  if (standard9Digits.startsWith('6')) {
    operator = 'Mobilis';
  } else if (standard9Digits.startsWith('7')) {
    operator = 'Djezzy';
  } else if (standard9Digits.startsWith('5')) {
    operator = 'Ooredoo';
  } else if (standard9Digits.startsWith('2') || standard9Digits.startsWith('3') || standard9Digits.startsWith('4')) {
    operator = 'Fixe';
  }

  const isValid = standard9Digits.length === 9 && ['5', '6', '7', '2', '3', '4'].includes(standard9Digits[0]);

  // Format for clean display: 0550 12 34 56
  let formattedDisplay = local;
  if (local.length === 10 && local.startsWith('0')) {
    formattedDisplay = `${local.slice(0, 4)} ${local.slice(4, 6)} ${local.slice(6, 8)} ${local.slice(8, 10)}`;
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
 * Builds a direct WhatsApp chat URL with pre-filled message
 */
export function buildWhatsAppUrl(phoneNumber: string, message: string): string {
  const norm = normalizeAlgerianPhone(phoneNumber);
  const targetNumber = norm.whatsAppFormat || phoneNumber.replace(/\D/g, '');
  return `https://wa.me/${targetNumber}?text=${encodeURIComponent(message)}`;
}

