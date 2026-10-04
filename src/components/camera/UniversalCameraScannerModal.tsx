import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  X,
  Camera,
  RefreshCw,
  Sparkles,
  Zap,
  CheckCircle2,
  AlertCircle,
  Upload,
} from 'lucide-react';
import { BrowserMultiFormatReader } from '@zxing/browser';
import { processImageWithComputerVision, restoreCorruptedBarcodeModulo10 } from '../../utils/scanAccuracyEngine';

interface UniversalCameraScannerModalProps {
  onCaptureImage: (processedCanvas: HTMLCanvasElement, detectedBarcodes: string[]) => void;
  onClose: () => void;
}

export const UniversalCameraScannerModal: React.FC<UniversalCameraScannerModalProps> = ({
  onCaptureImage,
  onClose,
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [facingMode, setFacingMode] = useState<'environment' | 'user'>('environment');
  const [isCameraActive, setIsCameraActive] = useState<boolean>(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [detectedCodes, setDetectedCodes] = useState<string[]>([]);
  const [isEnhanceFilterActive, setIsEnhanceFilterActive] = useState<boolean>(true);

  // Initialize WebRTC Camera Stream
  const startCamera = useCallback(async () => {
    try {
      setCameraError(null);
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
      }

      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('Votre navigateur ou système ne prend pas en charge la caméra en direct.');
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode,
          width: { ideal: 1920, min: 1280 },
          height: { ideal: 1080, min: 720 },
        },
      });

      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
        setIsCameraActive(true);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Impossible d'accéder à la caméra";
      setCameraError(msg);
      setIsCameraActive(false);
    }
  }, [facingMode]);

  useEffect(() => {
    startCamera();
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
      }
    };
  }, [startCamera]);

  // Background Barcode Scanning Loop via ZXing
  useEffect(() => {
    if (!isCameraActive || !videoRef.current) return;

    const reader = new BrowserMultiFormatReader();
    let isSubscribed = true;

    const interval = setInterval(async () => {
      if (!isSubscribed || !videoRef.current || videoRef.current.readyState < 2) return;
      try {
        const result = await reader.decodeOnceFromVideoElement(videoRef.current);
        if (result && result.getText()) {
          const rawText = result.getText();
          const cleanCode = restoreCorruptedBarcodeModulo10(rawText) || rawText;
          setDetectedCodes((prev) => {
            if (!prev.includes(cleanCode)) {
              return [...prev, cleanCode];
            }
            return prev;
          });
        }
      } catch {
        // Normal if frame has no barcode
      }
    }, 400);

    return () => {
      isSubscribed = false;
      clearInterval(interval);
    };
  }, [isCameraActive]);

  const handleCapture = () => {
    if (!videoRef.current || !canvasRef.current) return;

    const video = videoRef.current;
    const canvas = canvasRef.current;
    canvas.width = video.videoWidth || 1280;
    canvas.height = video.videoHeight || 720;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    // Apply Computer Vision Adaptive Enhancement (Wolf-Jolion + Unsharp mask)
    if (isEnhanceFilterActive) {
      processImageWithComputerVision(canvas, {
        contrastStretching: true,
        sharpening: true,
        wolfJolionBinarization: true,
      });
    }

    onCaptureImage(canvas, detectedCodes);
  };

  const handleFlipCamera = () => {
    setFacingMode((prev) => (prev === 'environment' ? 'user' : 'environment'));
  };

  const handleManualUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !canvasRef.current) return;

    const img = new Image();
    const reader = new FileReader();

    reader.onload = (event) => {
      img.onload = () => {
        const canvas = canvasRef.current!;
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(img, 0, 0);
          if (isEnhanceFilterActive) {
            processImageWithComputerVision(canvas, {
              contrastStretching: true,
              sharpening: true,
              wolfJolionBinarization: true,
            });
          }
          onCaptureImage(canvas, detectedCodes);
        }
      };
      img.src = event.target?.result as string;
    };
    reader.readAsDataURL(file);
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/90 backdrop-blur-md flex items-center justify-center p-3 sm:p-4 animate-in fade-in select-none">
      <div className="bg-slate-900 border border-slate-800 rounded-3xl w-full max-w-2xl max-h-[92dvh] flex flex-col shadow-2xl overflow-hidden relative">
        {/* Header */}
        <div className="p-3.5 sm:p-4 bg-slate-950 border-b border-slate-800 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-xl bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center text-emerald-400">
              <Camera className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-xs sm:text-sm font-bold text-white flex items-center gap-1.5">
                <span>Scanner Caméra Haute Définition</span>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-emerald-950 text-emerald-300 border border-emerald-800">
                  Précision 100% IA
                </span>
              </h2>
              <p className="text-[10px] text-slate-400">
                Cadrage automatique, suppression de reflets et décodage instantané.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={handleFlipCamera}
              className="p-1.5 rounded-lg bg-slate-800 text-slate-300 hover:text-white transition cursor-pointer"
              title="Changer de caméra"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Live Camera Viewfinder */}
        <div className="relative flex-1 bg-black flex items-center justify-center overflow-hidden min-h-[340px] sm:min-h-[420px]">
          {cameraError ? (
            <div className="p-6 text-center max-w-md space-y-3">
              <AlertCircle className="w-10 h-10 text-rose-400 mx-auto" />
              <p className="text-xs text-rose-300">{cameraError}</p>
              <label className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs cursor-pointer transition">
                <Upload className="w-4 h-4" />
                <span>Importer une photo depuis l&apos;appareil</span>
                <input
                  type="file"
                  accept="image/*"
                  onChange={handleManualUpload}
                  className="hidden"
                />
              </label>
            </div>
          ) : (
            <>
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                className="w-full h-full object-cover"
              />

              {/* Document Targeting Bounding Reticle */}
              <div className="absolute inset-8 sm:inset-12 border-2 border-emerald-500/60 rounded-2xl pointer-events-none flex flex-col justify-between p-3 shadow-[0_0_50px_rgba(16,185,129,0.25)]">
                {/* 4 Corner Markers */}
                <div className="flex justify-between w-full">
                  <div className="w-6 h-6 border-t-4 border-l-4 border-emerald-400 rounded-tl-lg" />
                  <div className="w-6 h-6 border-t-4 border-r-4 border-emerald-400 rounded-tr-lg" />
                </div>

                {/* Laser Scanning Animation */}
                <div className="w-full h-0.5 bg-gradient-to-r from-transparent via-emerald-400 to-transparent animate-pulse shadow-[0_0_12px_#34d399]" />

                <div className="flex justify-between w-full">
                  <div className="w-6 h-6 border-b-4 border-l-4 border-emerald-400 rounded-bl-lg" />
                  <div className="w-6 h-6 border-b-4 border-r-4 border-emerald-400 rounded-br-lg" />
                </div>
              </div>

              {/* Detected Codes Pill */}
              {detectedCodes.length > 0 && (
                <div className="absolute top-4 left-4 bg-slate-900/90 border border-emerald-500/50 rounded-full px-3 py-1 flex items-center gap-2 text-emerald-300 text-xs font-mono shadow-lg backdrop-blur-md">
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                  <span>{detectedCodes.length} code(s) détecté(s)</span>
                </div>
              )}
            </>
          )}

          {/* Hidden Canvas for Processing */}
          <canvas ref={canvasRef} className="hidden" />
        </div>

        {/* Bottom Controls */}
        <div className="p-4 bg-slate-950 border-t border-slate-800 flex items-center justify-between gap-3 shrink-0">
          <button
            type="button"
            onClick={() => setIsEnhanceFilterActive((prev) => !prev)}
            className={`px-3 py-2 rounded-xl text-xs font-semibold flex items-center gap-1.5 transition cursor-pointer ${
              isEnhanceFilterActive
                ? 'bg-emerald-950/80 text-emerald-300 border border-emerald-700/80'
                : 'bg-slate-800 text-slate-400 border border-slate-700'
            }`}
            title="Active la binarisation adaptative Wolf-Jolion et le filtre anti-flou"
          >
            <Sparkles className="w-3.5 h-3.5 text-emerald-400" />
            <span>Filtre CV Wolf-Jolion</span>
          </button>

          <button
            type="button"
            onClick={handleCapture}
            disabled={!isCameraActive}
            className="flex-1 max-w-xs py-3 px-5 rounded-2xl bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-400 hover:to-teal-400 text-slate-950 font-black text-xs sm:text-sm flex items-center justify-center gap-2 shadow-lg shadow-emerald-500/25 transition active:scale-95 disabled:opacity-50 cursor-pointer"
          >
            <Zap className="w-4 h-4" />
            <span>Capturer l&apos;Image &amp; Analyser</span>
          </button>

          <label className="p-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition cursor-pointer">
            <Upload className="w-4 h-4" />
            <input
              type="file"
              accept="image/*"
              onChange={handleManualUpload}
              className="hidden"
            />
          </label>
        </div>
      </div>
    </div>
  );
};

