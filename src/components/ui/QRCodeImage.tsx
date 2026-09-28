import React, { useState, useEffect } from 'react';
import { QrCode as QrIcon } from 'lucide-react';

interface QRCodeImageProps {
  value: string;
  /** Display size in CSS px (backing image is rendered at integer scale for crisp modules). */
  size?: number;
  className?: string;
  alt?: string;
  /** Quiet-zone width in modules. QR spec requires 4; anything less hurts camera scanning. */
  margin?: number;
  errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H';
}

export const QRCodeImage: React.FC<QRCodeImageProps> = ({
  value,
  size = 160,
  className = '',
  alt = 'Code QR',
  margin = 4,
  errorCorrectionLevel = 'M',
}) => {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [error, setError] = useState<boolean>(false);

  useEffect(() => {
    let isCancelled = false;
    if (!value || !value.trim()) {
      setDataUrl(null);
      return;
    }

    // Dynamic import: the qrcode lib rides its own chunk instead of the
    // entry bundle. Rendered output is identical (same options, same scale).
    const render = async () => {
      try {
        const mod = await import('qrcode');
        if (isCancelled) return;
        const lib = (mod as unknown as { default?: typeof mod }).default ?? mod;
        // Integer scale (not `width: size`) keeps module edges razor-sharp:
        // a 1:1 render turns dense payloads into an unscannable blur.
        const url = await lib.toDataURL(value, {
          scale: 8,
          margin,
          color: {
            dark: '#0f172a',
            light: '#ffffff',
          },
          errorCorrectionLevel,
        });
        if (!isCancelled) {
          setDataUrl(url);
          setError(false);
        }
      } catch (err) {
        if (!isCancelled) {
          console.warn('[QRCodeImage] Generation failed:', err);
          setError(true);
        }
      }
    };
    void render();

    return () => {
      isCancelled = true;
    };
  }, [value, size, margin, errorCorrectionLevel]);

  if (error || !value) {
    return (
      <div
        role="img"
        aria-label="Code QR indisponible"
        style={{ width: size, height: size }}
        className={`flex flex-col items-center justify-center bg-slate-100 dark:bg-slate-800 text-slate-400 rounded-xl border border-dashed border-slate-300 dark:border-slate-700 ${className}`}
      >
        <QrIcon className="w-8 h-8 opacity-40 mb-1" aria-hidden="true" />
        <span className="text-[10px] font-medium">QR Indisponible</span>
      </div>
    );
  }

  if (!dataUrl) {
    return (
      <div
        role="status"
        aria-label="Chargement du code QR"
        style={{ width: size, height: size }}
        className={`flex items-center justify-center bg-white rounded-xl animate-pulse ${className}`}
      >
        <div className="w-8 h-8 rounded-full border-2 border-slate-300 border-t-cyan-500 animate-spin" aria-hidden="true" />
      </div>
    );
  }

  return (
    <img
      src={dataUrl}
      alt={alt}
      width={size}
      height={size}
      style={{ width: size, height: size, imageRendering: 'pixelated' }}
      className={`rounded-lg select-none ${className}`}
    />
  );
};
