/**
 * License Key Normalization & Formatting Utilities
 * Standardizes user input across desktop and mobile entry fields.
 */

/**
 * Strips whitespace, dashes, and invalid characters, converting to uppercase.
 * Example: "mobi - life - 4hnp - 85hg" -> "MOBILIFE4HNP85HG"
 */
export function sanitizeLicenseKey(raw: string): string {
  if (!raw) return '';
  return raw.trim().toUpperCase().replace(/[^0-9A-Z]/g, '');
}

/**
 * Formats a clean or raw license key with standardized dashes for readable presentation.
 * Example: "MOBILIFE4HNP85HG" -> "MOBI-LIFE-4HNP-85HG"
 */
export function formatLicenseKeyForDisplay(raw: string): string {
  const clean = sanitizeLicenseKey(raw);
  if (!clean) return '';

  // If already prefixed with MOBI
  if (clean.startsWith('MOBI')) {
    const rest = clean.slice(4);
    const chunks: string[] = ['MOBI'];
    // Look for type tag (LIFE, 90D, 24H, etc.)
    if (rest.startsWith('LIFE')) {
      chunks.push('LIFE');
      const tail = rest.slice(4);
      for (let i = 0; i < tail.length; i += 4) {
        chunks.push(tail.slice(i, i + 4));
      }
    } else if (rest.startsWith('90D') || rest.startsWith('24H')) {
      const tag = rest.slice(0, 3);
      chunks.push(tag);
      const tail = rest.slice(3);
      for (let i = 0; i < tail.length; i += 4) {
        chunks.push(tail.slice(i, i + 4));
      }
    } else {
      for (let i = 0; i < rest.length; i += 4) {
        chunks.push(rest.slice(i, i + 4));
      }
    }
    return chunks.join('-');
  }

  // Generic chunking in groups of 4
  const chunks: string[] = [];
  for (let i = 0; i < clean.length; i += 4) {
    chunks.push(clean.slice(i, i + 4));
  }
  return chunks.join('-');
}

/**
 * Quick client-side format validity check before network transmission.
 */
export function isValidKeyFormat(raw: string): boolean {
  const clean = sanitizeLicenseKey(raw);
  // Minimum length: MOBI (4) + TYPE (3-4) + 8 entropy chars = 15-16+ chars
  return clean.startsWith('MOBI') && clean.length >= 12;
}
