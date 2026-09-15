import React, { useState, useEffect } from 'react';
import QRCode from 'qrcode';
import { QrCode as QrIcon } from 'lucide-react';

interface QRCodeImageProps {
  value: string;
  size?: number;
  className?: string;
  alt?: string;
}

export const QRCodeImage: React.FC<QRCodeImageProps> = ({
  value,
  size = 160,
  className = '',
  alt = 'Code QR',
}) => {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [error, setError] = useState<boolean>(false);

  useEffect(() => {
    let isCancelled = false;
    if (!value || !value.trim()) {
      setDataUrl(null);
      return;
    }

    QRCode.toDataURL(value, {
      width: size,
      margin: 1,
      color: {
        dark: '#0f172a',
        light: '#ffffff',
      },
      errorCorrectionLevel: 'M',
    })
      .then((url) => {
        if (!isCancelled) {
          setDataUrl(url);
          setError(false);
        }
      })
      .catch((err) => {
        if (!isCancelled) {
          console.warn('[QRCodeImage] Generation failed:', err);
          setError(true);
        }
      });

    return () => {
      isCancelled = true;
    };
  }, [value, size]);

  if (error || !value) {
    return (
      <div
        style={{ width: size, height: size }}
        className={`flex flex-col items-center justify-center bg-slate-100 dark:bg-slate-800 text-slate-400 rounded-xl border border-dashed border-slate-300 dark:border-slate-700 ${className}`}
      >
        <QrIcon className="w-8 h-8 opacity-40 mb-1" />
        <span className="text-[10px] font-medium">QR Indisponible</span>
      </div>
    );
  }

  if (!dataUrl) {
    return (
      <div
        style={{ width: size, height: size }}
        className={`flex items-center justify-center bg-white rounded-xl animate-pulse ${className}`}
      >
        <div className="w-8 h-8 rounded-full border-2 border-slate-300 border-t-cyan-500 animate-spin" />
      </div>
    );
  }

  return (
    <img
      src={dataUrl}
      alt={alt}
      width={size}
      height={size}
      className={`rounded-lg select-none ${className}`}
    />
  );
};
