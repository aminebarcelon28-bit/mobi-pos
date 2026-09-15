import React, { useEffect, useRef, useState, useCallback } from 'react';
import jsQR from 'jsqr';
import {
  Flashlight,
  FlashlightOff,
  SwitchCamera,
  AlertCircle,
  RefreshCw,
  Sparkles,
} from 'lucide-react';
import { soundEngine } from '../../utils/audioFeedback';

interface MobileCameraScannerProps {
  onScan: (data: string) => void;
  onError?: (err: string) => void;
  isActive?: boolean;
}

export const MobileCameraScanner: React.FC<MobileCameraScannerProps> = ({
  onScan,
  onError,
  isActive = true,
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const scanIntervalRef = useRef<number | null>(null);

  const [hasPermission, setHasPermission] = useState<boolean | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [facingMode, setFacingMode] = useState<'environment' | 'user'>('environment');
  const [hasTorch, setHasTorch] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [isScanningActive, setIsScanningActive] = useState(false);
  const [lastScannedCode, setLastScannedCode] = useState<string | null>(null);

  // Stop camera tracks cleanly
  const stopCamera = useCallback(() => {
    if (scanIntervalRef.current) {
      window.clearInterval(scanIntervalRef.current);
      scanIntervalRef.current = null;
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
  }, []);

  // Initialize and start camera
  const startCamera = useCallback(async () => {
    stopCamera();
    setErrorMessage(null);

    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      const err = 'La caméra n\'est pas supportée sur cet appareil ou ce navigateur.';
      setErrorMessage(err);
      setHasPermission(false);
      onError?.(err);
      return;
    }

    try {
      const constraints: MediaStreamConstraints = {
        video: {
          facingMode: { ideal: facingMode },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      };

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      streamRef.current = stream;

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.setAttribute('playsinline', 'true'); // Required for iOS WKWebView
        await videoRef.current.play();
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

      // Begin QR scanning loop
      const interval = window.setInterval(() => {
        const video = videoRef.current;
        const canvas = canvasRef.current;
        if (!video || !canvas || video.readyState !== video.HAVE_ENOUGH_DATA) {
          return;
        }

        const width = video.videoWidth;
        const height = video.videoHeight;
        if (width === 0 || height === 0) return;

        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return;

        ctx.drawImage(video, 0, 0, width, height);
        const imageData = ctx.getImageData(0, 0, width, height);

        const code = jsQR(imageData.data, imageData.width, imageData.height, {
          inversionAttempts: 'dontInvert',
        });

        if (code && code.data && code.data.trim().length > 0) {
          const content = code.data.trim();
          // Avoid duplicate triggers within 1 second
          if (content !== lastScannedCode) {
            setLastScannedCode(content);

            // Audio & Haptic feedback
            soundEngine.playScan();
            if (typeof navigator !== 'undefined' && navigator.vibrate) {
              try {
                navigator.vibrate([40, 30, 80]);
              } catch {
                // Ignore vibration failure
              }
            }

            onScan(content);
          }
        }
      }, 90); // ~11 FPS scanning rate: optimal balance between instantaneous recognition and battery efficiency

      scanIntervalRef.current = interval;
    } catch (err: unknown) {
      console.warn('Camera access error:', err);
      let message = 'Impossible d\'accéder à la caméra.';
      if (err instanceof Error) {
        if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
          message = 'Autorisation caméra refusée. Veuillez autoriser la caméra dans les paramètres de votre appareil.';
        } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
          message = 'Aucune caméra détectée sur votre appareil.';
        } else if (err.name === 'NotReadableError' || err.name === 'TrackStartError') {
          message = 'La caméra est déjà utilisée par une autre application.';
        }
      }
      setErrorMessage(message);
      setHasPermission(false);
      onError?.(message);
    }
  }, [facingMode, lastScannedCode, onError, onScan, stopCamera]);

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
    if (isActive) {
      startCamera();
    } else {
      stopCamera();
    }
    return () => {
      stopCamera();
    };
  }, [isActive, startCamera, stopCamera]);

  return (
    <div className="relative w-full h-full min-h-[300px] flex flex-col items-center justify-center bg-black rounded-2xl overflow-hidden shadow-2xl border border-pos-border">
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
          <div className="w-full flex items-center justify-center">
            {/* Left veil */}
            <div className="flex-1 h-64 bg-black/60 backdrop-blur-[1px]" />

            {/* Viewfinder Target Frame (256x256) */}
            <div className="relative w-64 h-64 rounded-2xl border-2 border-cyan-400/40 bg-transparent flex items-center justify-center overflow-hidden">
              {/* Corner Accents */}
              <div className="absolute top-0 left-0 w-6 h-6 border-t-4 border-l-4 border-cyan-400 rounded-tl-lg" />
              <div className="absolute top-0 right-0 w-6 h-6 border-t-4 border-r-4 border-cyan-400 rounded-tr-lg" />
              <div className="absolute bottom-0 left-0 w-6 h-6 border-b-4 border-l-4 border-cyan-400 rounded-bl-lg" />
              <div className="absolute bottom-0 right-0 w-6 h-6 border-b-4 border-r-4 border-cyan-400 rounded-br-lg" />

              {/* Animated Laser Scanning Beam */}
              <div className="absolute left-2 right-2 h-0.5 bg-gradient-to-r from-transparent via-emerald-400 to-transparent shadow-[0_0_12px_#34d399] animate-scan-beam" />

              {/* Center subtle reticle dot */}
              <div className="w-2 h-2 rounded-full bg-cyan-400/70" />
            </div>

            {/* Right veil */}
            <div className="flex-1 h-64 bg-black/60 backdrop-blur-[1px]" />
          </div>

          {/* Bottom dark veil with instruction hint */}
          <div className="w-full flex-1 bg-black/60 backdrop-blur-[1px] flex flex-col items-center justify-start pt-4 px-6 text-center">
            <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-slate-900/80 border border-cyan-500/40 text-cyan-300 text-[11px] font-bold shadow-lg">
              <Sparkles className="w-3.5 h-3.5 text-cyan-400" />
              <span>Cadrez le QR Code affiché sur la caisse PC</span>
            </div>
            <p className="text-[10px] text-slate-400 mt-2 max-w-xs">
              Sur le PC : <strong>Paramètres &gt; Lier Smartphone &gt; Étape 2</strong>
            </p>
          </div>
        </div>
      )}

      {/* Controls Overlay (Torch, Switch Camera) */}
      {isScanningActive && (
        <div className="absolute top-3 right-3 flex items-center gap-2 z-10">
          {hasTorch && (
            <button
              type="button"
              onClick={toggleTorch}
              className={`p-2.5 rounded-xl border backdrop-blur-md transition cursor-pointer ${
                torchOn
                  ? 'bg-amber-500 text-slate-950 border-amber-400 shadow-lg shadow-amber-500/20'
                  : 'bg-black/50 text-white border-white/20 hover:bg-black/70'
              }`}
              title={torchOn ? 'Éteindre la torche' : 'Allumer la torche'}
            >
              {torchOn ? <Flashlight className="w-4 h-4" /> : <FlashlightOff className="w-4 h-4" />}
            </button>
          )}

          <button
            type="button"
            onClick={flipCamera}
            className="p-2.5 rounded-xl bg-black/50 text-white border border-white/20 hover:bg-black/70 backdrop-blur-md transition cursor-pointer"
            title="Changer de caméra"
          >
            <SwitchCamera className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Permission / Error State Display */}
      {hasPermission === false && (
        <div className="absolute inset-0 bg-pos-card/95 backdrop-blur-md p-6 flex flex-col items-center justify-center text-center space-y-4 z-20">
          <div className="w-12 h-12 rounded-2xl bg-rose-500/20 text-rose-400 flex items-center justify-center">
            <AlertCircle className="w-6 h-6" />
          </div>
          <div className="space-y-1">
            <h4 className="text-sm font-black text-pos-text">Accès Caméra Requis</h4>
            <p className="text-xs text-pos-muted max-w-xs">{errorMessage}</p>
          </div>
          <button
            type="button"
            onClick={startCamera}
            className="px-4 py-2 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold text-xs flex items-center gap-2 transition cursor-pointer shadow-md shadow-cyan-500/20"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>Réessayer</span>
          </button>
        </div>
      )}

      {/* Loading state while camera opens */}
      {hasPermission === null && !errorMessage && (
        <div className="absolute inset-0 bg-slate-950 flex flex-col items-center justify-center text-pos-muted gap-3 z-20">
          <RefreshCw className="w-6 h-6 animate-spin text-cyan-400" />
          <span className="text-xs font-medium">Ouverture de la caméra...</span>
        </div>
      )}
    </div>
  );
};
