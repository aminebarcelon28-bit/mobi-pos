import React, { useEffect, useRef, useState, useCallback } from 'react';
// ZXing is intentionally lazy-loaded to keep the cold-start bundle small.
import {
  Flashlight,
  FlashlightOff,
  SwitchCamera,
  AlertCircle,
  RefreshCw,
  Sparkles,
  X,
} from 'lucide-react';
import { soundEngine } from '../../utils/audioFeedback';
import { useTranslation } from '../../i18n';

interface MobileCameraScannerProps {
  onScan: (data: string) => void;
  onError?: (err: string) => void;
  onClose?: () => void;
  isActive?: boolean;
  /**
   * `barcode` / `qr` frame the viewfinder for product labels and pairing.
   * `stocktake` (UPGRADE-12) is the floor-counting mode: same wide 1D
   * viewfinder as `barcode`, continuous emits — the consumer keeps the
   * scanner open and accumulates counts. The same code is suppressed for 2 s
   * as a double-read guard, so deliberate re-scans after 2 s still count.
   */
  mode?: 'barcode' | 'qr' | 'stocktake';
  hintText?: string;
}

export const MobileCameraScanner: React.FC<MobileCameraScannerProps> = ({
  onScan,
  onError,
  onClose,
  isActive = true,
  mode = 'qr',
  hintText,
}) => {
  const { t } = useTranslation();
  // `stocktake` (UPGRADE-12) decodes product labels exactly like `barcode` —
  // same ZXing/native decoder, same wide viewfinder — but lets a consumer
  // pass count-specific copy and keep the loop open for many items.
  const isWideViewfinder = mode === 'barcode' || mode === 'stocktake';
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const scanIntervalRef = useRef<number | null>(null);
  // Generation guard: unmount-during-start (or facingMode flip) must not orphan
  // the camera stream or the scan interval. Every startCamera run captures its
  // generation; stale continuations stop their own tracks + clear any interval
  // they created instead of publishing to refs/state.
  const generationRef = useRef(0);

  const [hasPermission, setHasPermission] = useState<boolean | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [facingMode, setFacingMode] = useState<'environment' | 'user'>('environment');
  const [hasTorch, setHasTorch] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [isScanningActive, setIsScanningActive] = useState(false);
  const [isSuccessPulsing, setIsSuccessPulsing] = useState(false);
  const pulseTimeoutRef = useRef<number | null>(null);

  // Refs (not state/deps): re-creating startCamera tears down getUserMedia
  // and blinds the scanner for ~1s — the main cause of flaky screen-QR reads.
  const onScanRef = useRef(onScan);
  const onErrorRef = useRef(onError);
  const busyRef = useRef(false);
  const lastScanRef = useRef<{ data: string; at: number } | null>(null);

  // Decode success handler: triggers visual reticle pulse, soundEngine beep,
  // and medium haptic vibration with time-based duplicate suppression.
  const emitScan = useCallback((content: string) => {
    const trimmed = (content || '').trim();
    if (!trimmed) return;

    const now = Date.now();
    const last = lastScanRef.current;
    if (!last || last.data !== trimmed || now - last.at > 2000) {
      lastScanRef.current = { data: trimmed, at: now };

      // 1. Visual scan reticle pulse confirmation
      setIsSuccessPulsing(true);
      if (pulseTimeoutRef.current) {
        window.clearTimeout(pulseTimeoutRef.current);
      }
      pulseTimeoutRef.current = window.setTimeout(() => {
        setIsSuccessPulsing(false);
      }, 900);

      // 2. Audio & Haptic feedback: instant beep via soundEngine + medium haptic vibration
      soundEngine.playScan();
      soundEngine.triggerHaptic('medium');

      // 3. Emit decoded payload to consumer
      onScanRef.current(trimmed);
    }
  }, []);

  const emitScanRef = useRef(emitScan);

  useEffect(() => {
    onScanRef.current = onScan;
    onErrorRef.current = onError;
    emitScanRef.current = emitScan;
  }, [onScan, onError, emitScan]);

  // Keep the multi-format decoder out of the eager boot chunk. Product labels
  // are 1D EAN/UPC or Code 128; QR is still needed for mobile pairing.
  const decodeFrameRef = useRef<null | ((canvas: HTMLCanvasElement) => string | null)>(null);
  // Native barcode detector (Shape Detection API): EAN-13/UPC/Code128/QR in
  // one pass where the browser supports it (Chrome/Android). jsQR below stays
  // the fallback (QR only) so unsupported browsers keep working. Structural
  // typing on purpose — lib.dom coverage of BarcodeDetector varies.
  type NativeDetector = {
    detect(source: unknown): Promise<Array<{ rawValue?: string }>>;
  };
  const barcodeDetectorRef = useRef<null | NativeDetector>(null);

  // Stop camera tracks cleanly
  const stopCamera = useCallback(() => {
    if (scanIntervalRef.current) {
      window.clearInterval(scanIntervalRef.current);
      scanIntervalRef.current = null;
    }
    if (pulseTimeoutRef.current) {
      window.clearTimeout(pulseTimeoutRef.current);
      pulseTimeoutRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch {
          // ignore
        }
      });
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setTorchOn(false);
    setHasTorch(false);
    setIsScanningActive(false);
    setIsSuccessPulsing(false);
  }, []);

  // Initialize and start camera
  const startCamera = useCallback(async () => {
    const myGen = ++generationRef.current;
    const isStale = () => myGen !== generationRef.current;
    stopCamera();
    setErrorMessage(null);

    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      const err = "La caméra n'est pas supportée sur cet appareil ou ce navigateur.";
      setErrorMessage(err);
      setHasPermission(false);
      onErrorRef.current?.(err);
      return;
    }

    try {
      // 1080p ideal (graceful fallback on low-end): dense screen QR codes
      // need pixels — 720p often can't resolve a version-16 code at distance.
      const constraints: MediaStreamConstraints = {
        video: {
          facingMode: { ideal: facingMode },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      };

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      if (isStale()) {
        // Unmounted or superseded while getUserMedia was in flight: stop the
        // orphan tracks immediately, never publish to refs/state.
        stream.getTracks().forEach((track) => {
          try {
            track.stop();
          } catch {
            // ignore
          }
        });
        return;
      }
      streamRef.current = stream;

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.setAttribute('playsinline', 'true'); // Required for iOS WKWebView
        await videoRef.current.play();
      }
      if (isStale()) {
        stream.getTracks().forEach((track) => {
          try {
            track.stop();
          } catch {
            // ignore
          }
        });
        if (streamRef.current === stream) streamRef.current = null;
        return;
      }

      setHasPermission(true);
      setIsScanningActive(true);

      // Check if torch/flashlight is supported
      const track = stream.getVideoTracks()[0];
      if (track) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const capabilities = (track.getCapabilities?.() || {}) as any;
        if (capabilities.torch) {
          setHasTorch(true);
        }
      }

      // Begin dual-decoder scanning loop: native 1D/2D detector where
      // available (real product barcodes), jsQR fallback (QR only). Both
      // decoders load in parallel with the camera.
      try {
        const BD = (
          window as unknown as {
            BarcodeDetector?: new (opts?: unknown) => NativeDetector;
          }
        ).BarcodeDetector;
        if (typeof BD === 'function') {
          try {
            barcodeDetectorRef.current = new BD({
              formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'qr_code'],
            });
          } catch {
            try {
              barcodeDetectorRef.current = new BD();
            } catch {
              barcodeDetectorRef.current = null;
            }
          }
        }
      } catch {
        barcodeDetectorRef.current = null;
      }
      try {
        const zxing = await import('@zxing/library');
        if (isStale()) {
          // Owner went away while the decoder chunk loaded: release the stream.
          stream.getTracks().forEach((track) => {
            try {
              track.stop();
            } catch {
              // ignore
            }
          });
          if (streamRef.current === stream) streamRef.current = null;
          return;
        }
        const reader = new zxing.MultiFormatReader();
        const hints = new Map();
        hints.set(zxing.DecodeHintType.POSSIBLE_FORMATS, [
          zxing.BarcodeFormat.EAN_13,
          zxing.BarcodeFormat.EAN_8,
          zxing.BarcodeFormat.UPC_A,
          zxing.BarcodeFormat.UPC_E,
          zxing.BarcodeFormat.CODE_128,
          zxing.BarcodeFormat.CODE_39,
          zxing.BarcodeFormat.QR_CODE,
        ]);
        hints.set(zxing.DecodeHintType.TRY_HARDER, true);
        reader.setHints(hints);
        decodeFrameRef.current = (canvas) => {
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          if (!ctx) return null;
          const { width, height } = canvas;
          const { data } = ctx.getImageData(0, 0, width, height);
          const luminances = new Uint8ClampedArray(width * height);
          for (let source = 0, target = 0; source < data.length; source += 4, target++) {
            luminances[target] = (306 * data[source] + 601 * data[source + 1] + 117 * data[source + 2] + 0x200) >> 10;
          }
          const luminanceSource = new zxing.RGBLuminanceSource(luminances, width, height);
          const bitmap = new zxing.BinaryBitmap(new zxing.HybridBinarizer(luminanceSource));
          try {
            return reader.decodeWithState(bitmap).getText();
          } catch {
            // No barcode in this frame is the normal scanning state.
            return null;
          }
        };
      } catch {
        // Decoder unavailable — frames are skipped, camera preview still works.
        if (isStale()) {
          stream.getTracks().forEach((track) => {
            try {
              track.stop();
            } catch {
              // ignore
            }
          });
          if (streamRef.current === stream) streamRef.current = null;
          return;
        }
      }
      if (isStale()) {
        stream.getTracks().forEach((track) => {
          try {
            track.stop();
          } catch {
            // ignore
          }
        });
        if (streamRef.current === stream) streamRef.current = null;
        return;
      }
      const interval = window.setInterval(() => {
        // Skip while a frame is still decoding: overlapping runs jank
        // mid-range phones and delay the very detection we wait for.
        if (busyRef.current) return;
        busyRef.current = true;
        void (async () => {
          try {
            const video = videoRef.current;
            if (!video || video.readyState !== video.HAVE_ENOUGH_DATA) return;

            // Native detector first: resolves EAN-13/UPC/Code128/QR straight
            // off the video element (no canvas round-trip).
            const native = barcodeDetectorRef.current;
            if (native) {
              try {
                const codes = await native.detect(video);
                const raw = (codes ?? [])
                  .map((c) => c?.rawValue)
                  .find((v) => v && v.trim().length > 0);
                if (raw) {
                  emitScanRef.current(raw.trim());
                  return;
                }
              } catch {
                // Fall through to the multi-format decoder below.
              }
            }

            // Multi-format fallback: skipped until loaded and on frames the
            // native detector already claimed.
            if (!decodeFrameRef.current) return;
            const canvas = canvasRef.current;
            if (!canvas) return;

            const width = video.videoWidth;
            const height = video.videoHeight;
            if (width === 0 || height === 0) return;

            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            if (!ctx) return;

            ctx.drawImage(video, 0, 0, width, height);
            const content = decodeFrameRef.current(canvas)?.trim() || '';


            if (content.length > 0) {
              emitScanRef.current(content);
            }
          } finally {
            busyRef.current = false;
          }
        })();
      }, 90); // ~11 FPS scanning rate: optimal balance between instantaneous recognition and battery efficiency

      if (isStale()) {
        // Superseded between decoder load and interval creation: clear the
        // just-created interval and stop the orphan stream.
        window.clearInterval(interval);
        stream.getTracks().forEach((track) => {
          try {
            track.stop();
          } catch {
            // ignore
          }
        });
        if (streamRef.current === stream) streamRef.current = null;
        return;
      }
      scanIntervalRef.current = interval;
    } catch (err: unknown) {
      if (isStale()) return;
      console.warn('Camera access error:', err);
      let message = "Impossible d'accéder à la caméra.";
      if (err instanceof Error) {
        if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
          message =
            'Autorisation caméra refusée. Veuillez autoriser la caméra dans les paramètres de votre appareil.';
        } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
          message = 'Aucune caméra détectée sur votre appareil.';
        } else if (err.name === 'NotReadableError' || err.name === 'TrackStartError') {
          message = 'La caméra est déjà utilisée par une autre application.';
        }
      }
      setErrorMessage(message);
      setHasPermission(false);
      onErrorRef.current?.(message);
    }
  }, [facingMode, stopCamera]);

  // Torch Toggle
  const toggleTorch = async () => {
    if (!streamRef.current) return;
    const track = streamRef.current.getVideoTracks()[0];
    if (!track) return;

    try {
      const nextState = !torchOn;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (track as any).applyConstraints({
        advanced: [{ torch: nextState }],
      });
      setTorchOn(nextState);
    } catch (e) {
      console.warn('Torch toggle failed:', e);
    }
  };

  // Flip Camera
  const flipCamera = () => {
    setFacingMode((prev) => (prev === 'environment' ? 'user' : 'environment'));
  };

  useEffect(() => {
    const gen = generationRef;
    let cancelled = false;
    if (isActive) {
      void Promise.resolve().then(() => {
        if (!cancelled) void startCamera();
      });
    } else {
      gen.current++;
      void Promise.resolve().then(() => {
        if (!cancelled) stopCamera();
      });
    }
    return () => {
      cancelled = true;
      gen.current++;
      stopCamera();
    };
  }, [isActive, startCamera, stopCamera]);

  // Display-only error title/hint (copy only — interval/stream logic untouched).
  // Scan-success feedback already exists in the scan loop: soundEngine.playScan()
  // + navigator.vibrate([40, 30, 80]) on every accepted decode.
  const isNoCamera = errorMessage?.includes('Aucune caméra') ?? false;
  const errorTitle = isNoCamera
    ? t.scanner.noCameraDetectedTitle
    : errorMessage?.includes('déjà utilisée')
    ? t.scanner.cameraBusyTitle
    : t.scanner.permissionDeniedTitle;

  return (
    <div className="relative w-full h-full min-h-[280px] flex flex-col items-center justify-center bg-black rounded-2xl overflow-hidden shadow-2xl border border-pos-border">
      {/* Hidden processing canvas */}
      <canvas ref={canvasRef} className="hidden" />

      {/* Live Video Stream */}
      <video
        ref={videoRef}
        playsInline
        muted
        autoPlay
        className="absolute inset-0 w-full h-full object-cover"
      />

      {/* Darkened Reticle Mask Overlay */}
      {isScanningActive && (
        <div className="absolute inset-0 pointer-events-none flex flex-col items-center justify-center">
          {/* Top dark veil */}
          <div className="w-full flex-1 bg-black/60 backdrop-blur-[1px]" />

          {/* Center scan row */}
          <div className="w-full flex items-center justify-center" dir="ltr">
            {/* Inline-start veil */}
            <div className={`flex-1 ${isWideViewfinder ? 'h-40' : 'h-64'} bg-black/60 backdrop-blur-[1px]`} />

            {/* Viewfinder Target Frame (wide 288x160 for barcode, 256x256 for QR) */}
            <div
              className={`relative rounded-2xl border-2 flex items-center justify-center overflow-hidden transition-all duration-300 ${
                isSuccessPulsing
                  ? 'border-emerald-400 bg-emerald-500/20 scale-105 shadow-[0_0_24px_#34d399]'
                  : 'border-cyan-400/40 bg-transparent scale-100'
              } ${isWideViewfinder ? 'w-72 h-40' : 'w-64 h-64'}`}
            >
              {/* Logical Corner Accents */}
              <div className="absolute top-0 start-0 w-6 h-6 border-t-4 border-s-4 border-cyan-400 rounded-ss-lg" />
              <div className="absolute top-0 end-0 w-6 h-6 border-t-4 border-e-4 border-cyan-400 rounded-se-lg" />
              <div className="absolute bottom-0 start-0 w-6 h-6 border-b-4 border-s-4 border-cyan-400 rounded-es-lg" />
              <div className="absolute bottom-0 end-0 w-6 h-6 border-b-4 border-e-4 border-cyan-400 rounded-ee-lg" />

              {/* Animated Laser Scanning Beam */}
              <div className="absolute inset-x-2 h-0.5 bg-gradient-to-r from-transparent via-emerald-400 to-transparent shadow-[0_0_12px_#34d399] animate-scan-beam" />

              {/* Center subtle reticle dot / guide */}
              <div className="w-2 h-2 rounded-full bg-cyan-400/70" />
            </div>

            {/* Inline-end veil */}
            <div className={`flex-1 ${isWideViewfinder ? 'h-40' : 'h-64'} bg-black/60 backdrop-blur-[1px]`} />
          </div>

          {/* Bottom dark veil with instruction hint */}
          <div className="w-full flex-1 bg-black/60 backdrop-blur-[1px] flex flex-col items-center justify-start pt-4 px-6 text-center">
            <div className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full bg-pos-panel/90 border border-cyan-500/40 text-cyan-700 dark:text-cyan-300 text-xs font-bold shadow-lg">
              <Sparkles className="w-3.5 h-3.5 text-cyan-600 dark:text-cyan-400 shrink-0" aria-hidden="true" />
              <span>
                {hintText ||
                  (isWideViewfinder
                    ? t.scanner.alignBarcodeHint
                    : t.scanner.alignQrHint)}
              </span>
            </div>
            <p className="text-[11px] text-slate-200 mt-2 max-w-xs">
              {isWideViewfinder
                ? t.scanner.barcodeFormatsHint
                : t.scanner.pcPairingHint}
            </p>
          </div>
        </div>
      )}

      {/* Controls Overlay (Torch, Switch Camera, Close) — strict 48x48dp hitboxes, Close always accessible */}
      <div className="absolute top-3 end-3 flex items-center gap-2 z-30">
        {isScanningActive && hasTorch && (
          <button
            type="button"
            onClick={toggleTorch}
            aria-label={torchOn ? t.scanner.torchOnAria : t.scanner.torchOffAria}
            className={`min-h-[48px] min-w-[48px] flex items-center justify-center p-2.5 rounded-xl border backdrop-blur-md transition active-press cursor-pointer ${
              torchOn
                ? 'bg-amber-500 text-slate-950 border-amber-400 shadow-lg shadow-amber-500/20'
                : 'bg-black/60 text-white border-white/25 hover:bg-black/80'
            }`}
            title={torchOn ? t.scanner.torchOnAria : t.scanner.torchOffAria}
          >
            {torchOn ? (
              <Flashlight className="w-5 h-5" aria-hidden="true" />
            ) : (
              <FlashlightOff className="w-5 h-5" aria-hidden="true" />
            )}
          </button>
        )}

        {isScanningActive && (
          <button
            type="button"
            onClick={flipCamera}
            aria-label={t.scanner.switchCameraAria}
            className="min-h-[48px] min-w-[48px] flex items-center justify-center p-2.5 rounded-xl bg-black/60 text-white border border-white/25 hover:bg-black/80 backdrop-blur-md transition active-press cursor-pointer"
            title={t.scanner.switchCameraAria}
          >
            <SwitchCamera className="w-5 h-5" aria-hidden="true" />
          </button>
        )}

        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label={t.scanner.closeScannerAria}
            className="min-h-[48px] min-w-[48px] flex items-center justify-center p-2.5 rounded-xl bg-black/60 text-white border border-white/25 hover:bg-black/80 backdrop-blur-md transition active-press cursor-pointer"
            title={t.scanner.closeScannerAria}
          >
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        )}
      </div>

      {/* Permission / Error State Display */}
      {hasPermission === false && (
        <div className="absolute inset-0 bg-pos-card/95 backdrop-blur-md p-6 flex flex-col items-center justify-center text-center space-y-3.5 z-20 overflow-y-auto">
          <div className="w-12 h-12 rounded-2xl pos-status-danger border flex items-center justify-center shrink-0 shadow-lg">
            <AlertCircle className="w-6 h-6" aria-hidden="true" />
          </div>
          <div className="space-y-1">
            <h4 className="text-sm font-black text-pos-text">{errorTitle}</h4>
            <p className="text-xs text-rose-700 dark:text-rose-300 font-medium max-w-xs">{errorMessage}</p>
          </div>
          {isNoCamera ? (
            <div className="bg-pos-bg/80 border border-pos-border rounded-xl p-3 text-[11px] text-pos-muted max-w-xs text-start space-y-1.5">
              <p className="font-bold text-pos-text">Sans caméra, pas de blocage :</p>
              <p>
                Utilisez le mode <strong>« Coller »</strong> pour saisir le code d’appairage copié depuis votre caisse PC.
              </p>
            </div>
          ) : (
            <div className="bg-pos-bg/80 border border-pos-border rounded-xl p-3 text-[11px] text-pos-muted max-w-xs text-start space-y-1.5">
              <p className="font-bold text-pos-text flex items-center gap-1.5">
                <span aria-hidden="true">💡</span> Comment activer la caméra :
              </p>
              <p>
                • <strong>Android :</strong> Paramètres &gt; Applis &gt; MobiPOS &gt; Autorisations &gt; Caméra &gt; Autoriser
              </p>
              <p>
                • <strong>iOS / iPhone :</strong> Réglages &gt; Safari ou MobiPOS &gt; Caméra &gt; Demander ou Autoriser
              </p>
            </div>
          )}
          <button
            type="button"
            onClick={startCamera}
            className="min-h-[48px] px-5 py-2.5 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold text-xs flex items-center justify-center gap-2 transition cursor-pointer shadow-md shadow-cyan-500/20 active-press"
          >
            <RefreshCw className="w-4 h-4" aria-hidden="true" />
            <span>{t.scanner.retryAccessButton}</span>
          </button>
        </div>
      )}

      {/* Loading state while camera opens */}
      {hasPermission === null && !errorMessage && (
        <div className="absolute inset-0 bg-pos-panel flex flex-col items-center justify-center text-pos-muted gap-3 z-20">
          <RefreshCw className="w-6 h-6 animate-spin text-cyan-600 dark:text-cyan-400" aria-hidden="true" />
          <span className="text-xs font-medium">{t.scanner.openingCamera}</span>
        </div>
      )}
    </div>
  );
};

