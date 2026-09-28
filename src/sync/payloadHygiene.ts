// Payload-hygiene invariant (mobile freeze/crash fix, 2026-09-17).
//
// PURE MODULE — zero imports, so it runs in the webview, in Rust-adjacent
// tooling, and in plain-node test scripts alike.
//
// Forensics (`docs/sync/diagnostic-baseline-2026-09-17.md`): one product row
// carried 20,260,360 bytes of base64 image data in `json_payload` (56% of the
// cloud DB) and 26 transaction receipts embedding it added 14.6 MB more.
// Those blobs rode every push batch, pull page, boot scan and UI reload on
// the webview main thread → GC thrash, ANR (Android) / jetsam (iOS).
//
// Rule: synced payloads carry REFERENCES (url, hash), never BLOB bytes.
// - Known media keys are dropped; oversized image references are blanked.
// - Nested `json_payload`/`data_json` strings are parsed and cleaned
//   recursively (the 20 MB blob lived inside such a nested JSON string).
// - Money/relational scalars are NEVER dropped: the byte cap only removes
//   non-protected large fields, and residual oversize passes through rather
//   than corrupt financial data (push-side quarantine handles the rest).

export const MAX_SYNC_IMAGE_FIELD_BYTES = 2048;
export const MAX_SYNC_BLOB_STRING_BYTES = 16 * 1024;
export const MAX_SYNC_PAYLOAD_BYTES = 64 * 1024;

const SYNC_BLOB_KEYS = new Set([
  'photos', 'photo', 'receipt_image', 'scan_image', 'images', 'attachments',
  'image_data', 'imageData', 'thumbnail_data', 'thumbnailData',
]);

const SYNC_IMAGE_URL_KEYS = new Set([
  'imageUrl', 'image_url', 'imageurl', 'photo_url', 'photoUrl',
]);

const SYNC_NESTED_JSON_KEYS = new Set([
  'json_payload', 'data_json', 'payload_json', 'value_json', 'dataJson', 'jsonPayload',
]);

const SYNC_PROTECTED_KEYS = new Set([
  'id', 'transaction_id', 'product_id', 'customer_id', 'customer', 'items', 'lines',
  'tenders', 'payments', 'subtotal', 'tax', 'discount_total', 'total',
  'cost_total', 'costTotal', 'profit', 'profitMargin', 'ledgerCogsTotal',
  'ledger_cogs_total', 'quantity', 'applied_price', 'status',
  'idempotency_key', 'device_id', 'version',
]);

function isBlobLikeString(value: string): boolean {
  if (value.length < 1024) return false;
  const head = value.slice(0, 64);
  if (head.startsWith('data:image/') || head.startsWith('data:application/') || head.startsWith('data:video/')) return true;
  const sample = value.slice(0, 256).replace(/\s+/g, '');
  return sample.length > 0 && /^[A-Za-z0-9+/=]+$/.test(sample);
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return '{}';
  }
}

export function sanitizeSyncPayload<T>(value: T, depth = 0): T {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    if (value.length > MAX_SYNC_BLOB_STRING_BYTES && isBlobLikeString(value)) return '' as unknown as T;
    return value;
  }
  if (typeof value !== 'object') return value;
  if (depth > 6) return (Array.isArray(value) ? [] : {}) as unknown as T;
  if (Array.isArray(value)) {
    return value.map((v) => sanitizeSyncPayload(v, depth + 1)) as unknown as T;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SYNC_BLOB_KEYS.has(k)) continue;
    if (depth >= 1 && SYNC_NESTED_JSON_KEYS.has(k)) continue;
    if (SYNC_IMAGE_URL_KEYS.has(k) && typeof v === 'string' && v.length > MAX_SYNC_IMAGE_FIELD_BYTES) {
      out[k] = '';
      continue;
    }
    if (typeof v === 'string' && SYNC_NESTED_JSON_KEYS.has(k) && v.length > 1024) {
      try {
        out[k] = JSON.stringify(sanitizeSyncPayload(JSON.parse(v) as unknown, depth + 1));
        continue;
      } catch {
        // Not JSON after all — fall through to the generic string rule.
      }
    }
    out[k] = sanitizeSyncPayload(v, depth + 1);
  }
  return out as unknown as T;
}

/** Image references must stay references: anything bigger than a URL is blanked. */
export function sanitizeImageField(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return (value as string | null) ?? null;
  if (value.length > MAX_SYNC_IMAGE_FIELD_BYTES) return '';
  return value;
}

/** Serialize a sync payload with the hygiene invariant applied + byte budget. */
export function toBoundedSyncJson(payload: unknown, maxBytes = MAX_SYNC_PAYLOAD_BYTES): string {
  const clean = sanitizeSyncPayload(payload) as Record<string, unknown>;
  let json = safeJsonStringify(clean);
  if (json.length <= maxBytes) return json;
  if (clean === null || typeof clean !== 'object' || Array.isArray(clean)) return json;
  // Second pass: shed the largest non-protected large fields (never money keys).
  const obj: Record<string, unknown> = { ...(clean as Record<string, unknown>) };
  for (let i = 0; i < 25 && json.length > maxBytes; i++) {
    let biggest = '';
    let biggestLen = 0;
    for (const [k, v] of Object.entries(obj)) {
      if (SYNC_PROTECTED_KEYS.has(k)) continue;
      const len = typeof v === 'string' ? v.length : safeJsonStringify(v).length;
      if (len > biggestLen) {
        biggest = k;
        biggestLen = len;
      }
    }
    if (!biggest || biggestLen < 1024) break;
    delete obj[biggest];
    json = safeJsonStringify(obj);
  }
  if (json.length > maxBytes) {
    console.warn(`[sync:hygiene] payload still ${(json.length / 1024).toFixed(1)}KB after stripping; syncing intact (money fields protected).`);
  }
  return json;
}
