/** One-off diagnostics for the SAV photo pipeline (temporary, not part of the matrix). */
import fs from 'node:fs';
import { browser } from '@wdio/globals';
import { DB_PATH, DB_DIR } from '../lib/env';
import { waitForSchemaSettled } from '../lib/db';
import { installErrorTrap } from '../lib/pos';
import { bootUnlock } from '../lib/sav';

describe('PROBE native photo', () => {
  before(async () => {
    await installErrorTrap();
    await browser.waitUntil(() => fs.existsSync(DB_PATH), {
      timeout: 180000,
      interval: 1000,
      timeoutMsg: `live DB never appeared at ${DB_PATH}`,
    });
    await waitForSchemaSettled();
    await bootUnlock();
  });

  it('probes tauri env, native write, and canvas webp encode', async () => {
    const res = (await browser.execute(async () => {
      const w = window as unknown as {
        __TAURI_INTERNALS__?: unknown;
        __TAURI__?: unknown;
      };
      const out: Record<string, unknown> = {
        hasInternals: Boolean(w.__TAURI_INTERNALS__),
        hasTauri: Boolean(w.__TAURI__),
      };

      // Canvas WebP encode (the exact path saveSavPhoto uses).
      try {
        const c = document.createElement('canvas');
        c.width = 16;
        c.height = 16;
        const ctx = c.getContext('2d');
        ctx?.fillRect(0, 0, 16, 16);
        const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/webp', 0.72));
        out.webp = blob ? { size: blob.size, type: blob.type } : null;
      } catch (e) {
        out.webpErr = String(e);
      }

      // Tiny PNG decodes?
      try {
        const img = new Image();
        out.png = await new Promise((r) => {
          img.onload = () => r({ w: img.width, h: img.height });
          img.onerror = () => r(null);
          img.src =
            'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAABlBMVEX///+/v7+jQ3Y5AAAADklEQVQI12P4AIX8EAgALgAD/aNpbtEAAAAASUVORK5CYII=';
        });
      } catch (e) {
        out.pngErr = String(e);
      }

      // Native write with a known-good 1x1 WebP.
      try {
        const invoke = (
          w as unknown as {
            __TAURI_INTERNALS__: { invoke: (cmd: string, args: unknown) => Promise<unknown> };
          }
        ).__TAURI_INTERNALS__?.invoke;
        out.native = await invoke('sav_attachment_write', {
          request: {
            orderId: 'probe-native',
            index: 0,
            dataBase64: 'UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==',
            extension: 'webp',
            kind: 'intake',
          },
        });
      } catch (e) {
        out.nativeErr = String((e as Error)?.message ?? e);
      }
      return out;
    })) as Record<string, unknown>;
    console.log('[PHOTO-PROBE]', JSON.stringify(res, null, 2));
    const att = `${DB_DIR}\\sav_attachments`;
    console.log(
      '[PHOTO-PROBE] dir exists=',
      fs.existsSync(att),
      'files=',
      fs.existsSync(att) ? fs.readdirSync(att) : [],
    );
  });

  it('probes blob URL image loading + the full file→webp→native pipeline', async () => {
    const res = (await browser.execute(async () => {
      const out: Record<string, unknown> = {};
      const b64 =
        'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAABlBMVEX///+/v7+jQ3Y5AAAADklEQVQI12P4AIX8EAgALgAD/aNpbtEAAAAASUVORK5CYII=';
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const file = new File([bytes], 'probe.png', { type: 'image/png' });
      out.file = { size: file.size, type: file.type };

      const url = URL.createObjectURL(file);
      out.blobUrl = url.slice(0, 24);
      out.blobLoad = await new Promise((r) => {
        const img = new Image();
        img.onload = () => r({ w: img.width, h: img.height });
        img.onerror = () => r('ERROR');
        img.src = url;
      });
      try {
        const bmp = await createImageBitmap(file);
        out.bitmap = { w: bmp.width, h: bmp.height };
      } catch (e) {
        out.bitmapErr = String(e);
      }

      try {
        const img = new Image();
        await new Promise((resolve, reject) => {
          img.onload = resolve;
          img.onerror = () => reject(new Error('Image illisible'));
          img.src = url;
        });
        const c = document.createElement('canvas');
        c.width = img.width;
        c.height = img.height;
        c.getContext('2d')?.drawImage(img, 0, 0);
        const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/webp', 0.72));
        if (!blob) throw new Error('no webp blob');
        const buf = new Uint8Array(await blob.arrayBuffer());
        let binary = '';
        for (let i = 0; i < buf.length; i++) binary += String.fromCharCode(buf[i]);
        const dataBase64 = btoa(binary);
        const invoke = (
          window as unknown as {
            __TAURI_INTERNALS__: { invoke: (cmd: string, args: unknown) => Promise<unknown> };
          }
        ).__TAURI_INTERNALS__.invoke;
        out.pipeline = await invoke('sav_attachment_write', {
          request: {
            orderId: `draft_${Date.now()}`,
            index: 0,
            dataBase64,
            extension: 'webp',
            kind: 'intake',
          },
        });
      } catch (e) {
        out.pipelineErr = String((e as Error)?.message ?? e);
      }

      const csp = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
      out.csp = csp ? csp.getAttribute('content') : null;
      return out;
    })) as Record<string, unknown>;
    console.log('[PHOTO-PROBE-2]', JSON.stringify(res, null, 2));
  });
});
