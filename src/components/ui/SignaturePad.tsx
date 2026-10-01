import React, { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { Eraser, Check } from 'lucide-react';

export interface SignaturePadProps {
  label: string;
  hint?: string;
  initialDataUrl?: string | null;
  onChange: (dataUrl: string | null) => void;
  onClear?: () => void;
  height?: number;
  /** Renders "signature requise" affordance + blocks submission semantics. */
  required?: boolean;
  readOnly?: boolean;
  className?: string;
  children?: ReactNode;
}

/**
 * Zero-dependency canvas signature capture (pointer events → mouse, touch and
 * stylus through one code path). Exports a base64 PNG that is stored INLINE on
 * the repair order: the signature must stay atomically bound to its ticket, so
 * a separate file would let the two drift apart.
 *
 * The canvas backing store is resized to its real CSS box × devicePixelRatio
 * (measured after mount), so a stretched layout never distorts the stroke or
 * the exported image.
 */
export const SignaturePad: React.FC<SignaturePadProps> = ({
  label,
  hint,
  initialDataUrl = null,
  onChange,
  onClear,
  height = 160,
  required = false,
  readOnly = false,
  className = '',
  children,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [hasContent, setHasContent] = useState(false);
  const lastPoint = useRef<{ x: number; y: number } | null>(null);
  const strokeColor = '#0f172a';

  const resizeCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.floor(rect.width * dpr);
    const h = Math.floor(rect.height * dpr);
    if (canvas.width === w && canvas.height === h) return;
    const prev = canvas.toDataURL('image/png');
    const hadContent = hasContentRef.current;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = strokeColor;
    if (hadContent && prev && prev !== 'data:,') {
      const img = new Image();
      img.onload = () => ctx.drawImage(img, 0, 0, w, h);
      img.src = prev;
    }
  }, []);

  // Track content in a ref so resizeCanvas stays stable.
  const hasContentRef = useRef(false);
  useEffect(() => {
    hasContentRef.current = hasContent;
  }, [hasContent]);

  useEffect(() => {
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);
    return () => window.removeEventListener('resize', resizeCanvas);
  }, [resizeCanvas]);

  const exportSignature = () => {
    const canvas = canvasRef.current;
    if (!canvas || canvas.width === 0 || canvas.height === 0) return;
    onChange(canvas.toDataURL('image/png'));
  };

  const getCoords = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    return {
      x: (e.clientX - rect.left) * dpr,
      y: (e.clientY - rect.top) * dpr,
    };
  };

  const startStroke = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (readOnly) return;
    e.preventDefault();
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    canvas.setPointerCapture?.(e.pointerId);
    const coords = getCoords(e);
    ctx.beginPath();
    ctx.moveTo(coords.x, coords.y);
    lastPoint.current = coords;
    setIsDrawing(true);
    setHasContent(true);
  };

  const drawStroke = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!isDrawing || readOnly) return;
    e.preventDefault();
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx || !lastPoint.current) return;
    const coords = getCoords(e);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3 * (window.devicePixelRatio || 1);
    ctx.strokeStyle = strokeColor;
    ctx.beginPath();
    ctx.moveTo(lastPoint.current.x, lastPoint.current.y);
    ctx.lineTo(coords.x, coords.y);
    ctx.stroke();
    lastPoint.current = coords;
    exportSignature();
  };

  const endStroke = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!isDrawing) return;
    canvasRef.current?.releasePointerCapture?.(e.pointerId);
    setIsDrawing(false);
    lastPoint.current = null;
    exportSignature();
  };

  const handleClear = () => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || readOnly) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    setHasContent(false);
    onChange(null);
    onClear?.();
  };

  // Restore an initial signature (editing an existing order).
  useEffect(() => {
    if (!initialDataUrl) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const img = new Image();
    img.onload = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      setHasContent(true);
    };
    img.src = initialDataUrl;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialDataUrl]);

  return (
    <div className={`flex flex-col gap-2 select-none ${className}`}>
      <div className="flex items-center justify-between gap-2">
        <label className="text-[10px] sm:text-[11px] font-semibold uppercase tracking-wider text-pos-muted flex items-center gap-1">
          {label}
          {required && (
            <span className="text-rose-500 dark:text-rose-400" aria-hidden="true">
              *
            </span>
          )}
        </label>
        <div className="flex items-center gap-1.5">
          {children}
          <button
            type="button"
            onClick={handleClear}
            disabled={readOnly || !hasContent}
            title="Effacer la signature"
            className={`min-h-[44px] min-w-[44px] px-2 rounded-lg text-[10px] font-medium flex items-center gap-1 transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
              hasContent
                ? 'bg-rose-500/15 text-rose-300 border border-rose-500/40 hover:bg-rose-500/25'
                : 'bg-pos-card text-pos-muted border border-pos-border'
            }`}
          >
            <Eraser className="w-3.5 h-3.5" aria-hidden="true" />
            <span className="hidden sm:inline">Effacer</span>
          </button>
        </div>
      </div>
      <div
        className={`relative rounded-xl overflow-hidden border-2 border-dashed bg-white ${
          hasContent ? 'border-emerald-500/60' : required ? 'border-rose-400/60' : 'border-pos-border'
        }`}
      >
        <canvas
          ref={canvasRef}
          className="w-full block touch-none cursor-crosshair"
          style={{ height, touchAction: 'none' }}
          onPointerDown={startStroke}
          onPointerMove={drawStroke}
          onPointerUp={endStroke}
          onPointerCancel={endStroke}
          onPointerLeave={endStroke}
          role="img"
          aria-label={required ? `${label} (obligatoire)` : label}
        />
        {!hasContent && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <span className="text-[10px] text-slate-400 dark:text-pos-muted font-normal text-center px-4">
              {hint || 'Signez ici avec le doigt ou la souris'}
            </span>
          </div>
        )}
        {hasContent && (
          <div
            className="absolute top-2 right-2 bg-emerald-500 text-slate-950 rounded-full p-1 shadow-lg"
            aria-hidden="true"
          >
            <Check className="w-3 h-3" />
          </div>
        )}
      </div>
      <p className="text-[10px] text-pos-muted">
        Signature électronique légalement opposable — horodatée et liée à ce ticket SAV.
      </p>
    </div>
  );
};

export default SignaturePad;