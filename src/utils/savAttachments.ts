/**
 * savAttachments — photo evidence for SAV intake.
 *
 * Bytes live on the local filesystem (written by the native
 * `sav_attachment_write` command); only a relative path + SHA-256 reach the
 * repair order. The checksum is what makes an intake photo usable as evidence
 * in a restitution dispute: any later modification changes it.
 *
 * FAIL CLOSED: there is deliberately no non-durable fallback. Off Tauri (web
 * preview, tests) `saveSavPhoto` refuses and returns `persisted: false` rather
 * than handing back a `session://` path that would look durable in the DB but
 * evaporate with the tab. A ticket whose photo bytes cannot be stored must not
 * claim the evidence exists.
 */
import type { IntakePhotoRef } from '../types/pos';
import { isTauriEnv } from '../db/adapters/base';

export interface SavAttachmentResult extends IntakePhotoRef {
  /** False when the bytes could not be persisted (web preview / native down). */
  persisted: boolean;
}

/** Longest edge after downscale — intake photos only need to refute a dispute. */
const MAX_EDGE = 1600;
const JPEG_QUALITY = 0.72;

function loadImage(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Image illisible'));
    };
    img.src = url;
  });
}

/**
 * Downscale + re-encode to WebP in the browser. Keeps an 8MP phone capture
 * under ~200 KB so the filesystem stays small and the SQLite row stays tiny.
 */
async function toWebpBase64(file: Blob): Promise<{ dataBase64: string; byteSize: number }> {
  const img = await loadImage(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas indisponible');
  ctx.drawImage(img, 0, 0, w, h);
  const blob: Blob | null = await new Promise((resolve) =>
    canvas.toBlob((b) => resolve(b), 'image/webp', JPEG_QUALITY)
  );
  if (!blob) throw new Error('Compression WebP indisponible');
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return { dataBase64: btoa(binary), byteSize: bytes.length };
}

async function sha256Hex(dataBase64: string): Promise<string> {
  const binary = atob(dataBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export interface SaveSavPhotoArgs {
  orderId: string;
  index: number;
  file: Blob;
  label?: string;
}

/**
 * Persist one intake photo. Requires the native filesystem command: without a
 * Tauri runtime there is nowhere durable to put the bytes, so the photo is
 * refused and reported as not persisted. The caller must surface that instead
 * of attaching a phantom evidence row.
 */
export async function saveSavPhoto({
  orderId,
  index,
  file,
  label,
}: SaveSavPhotoArgs): Promise<SavAttachmentResult> {
  const capturedAt = new Date().toISOString();
  const { dataBase64, byteSize } = await toWebpBase64(file);

  if (!isTauriEnv()) {
    return {
      relativePath: '',
      sha256: await sha256Hex(dataBase64),
      byteSize,
      capturedAt,
      ...(label ? { label } : {}),
      persisted: false,
    };
  }

  const { invokeCommand } = await import('../platform/invoke');
  const res = await invokeCommand<{ relative_path: string; sha256: string; byte_size: number }>(
    'sav_attachment_write',
    { request: { orderId, index, dataBase64, extension: 'webp' } }
  );
  return {
    relativePath: res.relative_path,
    sha256: res.sha256,
    byteSize: res.byte_size,
    capturedAt,
    ...(label ? { label } : {}),
    persisted: true,
  };
}

/** Read a photo back (native, checksum re-verified against the stored row). */
export async function readSavPhoto(
  relativePath: string
): Promise<{ dataUrl: string; sha256: string } | null> {
  if (!isTauriEnv()) return null;
  const { invokeCommand } = await import('../platform/invoke');
  const res = await invokeCommand<{ sha256: string; data_base64: string }>('sav_attachment_read', {
    relativePath,
  });
  return {
    dataUrl: `data:image/webp;base64,${res.data_base64}`,
    sha256: res.sha256,
  };
}

/** Compare a stored checksum with a freshly-read one (dispute verification). */
export async function verifySavPhoto(photo: IntakePhotoRef): Promise<boolean> {
  if (!isTauriEnv() || !photo.relativePath.startsWith('sav_attachments/')) return false;
  try {
    const { invokeCommand } = await import('../platform/invoke');
    const res = await invokeCommand<{ sha256: string }>('sav_attachment_read', {
      relativePath: photo.relativePath,
    });
    return res.sha256 === photo.sha256;
  } catch {
    return false;
  }
}

/** Remove every attachment of an order (order deleted). */
export async function purgeSavPhotos(orderId: string): Promise<void> {
  if (!isTauriEnv()) return;
  const { invokeCommand } = await import('../platform/invoke');
  await invokeCommand<number>('sav_attachment_purge', { orderId });
}

/**
 * Sweep intake photos orphaned by a crash or hard kill.
 *
 * `RepairWorkOrderModal` already purges an uncommitted `draft_*` staging set on
 * every close path (Escape, header X, reset, till switch). That path cannot run
 * if the process dies mid-intake — a power cut, force-quit or crash leaves the
 * staged bytes on disk forever, and `purgeSavPhotos` can never reach them
 * because no order owns the `draft_` prefix.
 *
 * The native side owns the age gate (>24 h) and the filename allowlist, so
 * this call cannot delete committed evidence and cannot sweep an in-progress
 * or crash-recovered intake. Returns the number of files removed.
 *
 * Best-effort: never throws, so a cleanup failure can never block boot.
 */
export async function sweepStaleSavDrafts(): Promise<number> {
  if (!isTauriEnv()) return 0;
  try {
    const { invokeCommand } = await import('../platform/invoke');
    return await invokeCommand<number>('sav_attachment_sweep_stale_drafts', {});
  } catch {
    // Housekeeping must never surface as a boot error.
    return 0;
  }
}