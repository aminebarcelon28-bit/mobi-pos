import React, { useState, useEffect, useRef } from 'react';
import QRCode from 'qrcode';
import {
  X,
  MessageSquare,
  Copy,
  Check,
  ExternalLink,
  Smartphone,
} from 'lucide-react';
import { usePosStore } from '../../store/usePosStore';
import { RepairNotificationEngine } from '../../utils/repairNotificationEngine';
import { useToast } from '../ui/Toast';
import { openUrl } from '../../utils/phoneUtils';
import { WHATSAPP_QR } from '../../constants';

export const WhatsAppDispatchModal: React.FC = () => {
  const {
    activeModal,
    closeModal,
    selectedRepairOrderForNotification,
    receiptSettings,
  } = usePosStore();
  const { showToast } = useToast();
  const [copied, setCopied] = useState(false);
  const [qrError, setQrError] = useState(false);
  const qrCanvasRef = useRef<HTMLCanvasElement>(null);

  const order = selectedRepairOrderForNotification;
  // QR payload diet (message build happens here — the engine file is owned by
  // another agent): over-long problem descriptions bloat the wa.me URL past
  // reliable QR density, so the description is truncated to
  // WHATSAPP_QR.DESCRIPTION_MAX_CHARS before the body/URL are built.
  const qrOrder =
    order && (order.problemDescription || '').length > WHATSAPP_QR.DESCRIPTION_MAX_CHARS
      ? {
          ...order,
          problemDescription: (order.problemDescription || '').slice(
            0,
            WHATSAPP_QR.DESCRIPTION_MAX_CHARS
          ),
        }
      : order;
  const messageText = qrOrder
    ? RepairNotificationEngine.generateMessageBody(qrOrder, receiptSettings, 'READY_FOR_PICKUP')
    : '';
  const whatsAppUrl = qrOrder
    ? RepairNotificationEngine.buildWhatsAppUrl(qrOrder, receiptSettings, 'READY_FOR_PICKUP')
    : '';

  // SECURITY: the QR payload (customer phone + message inside whatsAppUrl) is
  // rendered LOCALLY via the bundled `qrcode` lib. The previous
  // https://api.qrserver.com call leaked customer PII in a remote URL and is
  // removed. Message content is unchanged — only the renderer changed.
  useEffect(() => {
    if (!whatsAppUrl || !qrCanvasRef.current) return;
    const canvas = qrCanvasRef.current;
    let cancelled = false;
    setQrError(false);
    // Error correction L: the payload is already shrunk above, so maximum
    // density headroom beats damage tolerance for a counter-top scan.
    QRCode.toDataURL(whatsAppUrl, { scale: 8, margin: 2, errorCorrectionLevel: 'L' })
      .then((dataUrl) => {
        if (cancelled) return;
        const img = new Image();
        img.src = dataUrl;
        img.onload = () => {
          if (cancelled) return;
          const ctx = canvas.getContext('2d');
          if (!ctx) return;
          const size = WHATSAPP_QR.SIZE_PX;
          ctx.clearRect(0, 0, size, size);
          ctx.drawImage(img, 0, 0, size, size);
        };
      })
      .catch((err) => {
        if (!cancelled) {
          console.warn('[WhatsAppDispatch] Local QR generation failed:', err);
          setQrError(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [whatsAppUrl]);

  if (activeModal !== 'whatsapp_dispatch' || !order) return null;

  const handleCopyText = async () => {
    try {
      await navigator.clipboard.writeText(messageText);
    } catch {
      // Non-secure contexts (plain-HTTP LAN access, older webviews): the
      // async clipboard API is unavailable — legacy execCommand fallback.
      try {
        const ta = document.createElement('textarea');
        ta.value = messageText;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        if (!ok) throw new Error('execCommand copy failed');
      } catch {
        showToast('Erreur lors de la copie du texte', 'error');
        return;
      }
    }
    setCopied(true);
    showToast('Texte du message copié dans le presse-papier !', 'success');
    setTimeout(() => setCopied(false), 2000);
  };

  const handleOpenDirect = async () => {
    const ok = await openUrl(whatsAppUrl);
    if (!ok) {
      showToast("Impossible d'ouvrir WhatsApp", 'error');
    }
  };

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 select-none animate-in fade-in">
      <div className="bg-pos-panel border-t sm:border border-pos-border rounded-t-3xl sm:rounded-2xl w-full max-w-2xl overflow-hidden shadow-2xl animate-in zoom-in-95 flex flex-col max-h-[92vh] pt-[max(0.5rem,var(--safe-top))] pb-[max(0.5rem,var(--safe-bottom))] sm:py-0">
        <div className="w-8 h-1 rounded-full bg-pos-muted/40 mx-auto mt-2.5 mb-1 sm:hidden shrink-0" />

        {/* Header */}
        <div className="p-3.5 sm:p-4 border-b border-pos-border bg-pos-card flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2 text-emerald-400 min-w-0">
            <MessageSquare className="w-5 h-5 shrink-0" />
            <div className="min-w-0">
              <h2 className="text-sm font-bold text-pos-text truncate">
                Notification Client WhatsApp
              </h2>
              <p className="text-[11px] text-pos-muted truncate">
                Ticket N° {order.ticketNumber} • {order.customerName} ({order.customerPhone})
              </p>
            </div>
          </div>
          <button
            onClick={closeModal}
            className="p-1.5 hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-lg transition min-h-[44px] min-w-[44px] flex items-center justify-center shrink-0"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content Body */}
        <div className="p-4 sm:p-5 space-y-4 overflow-y-auto flex-1">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Left Column: Message Preview */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-[11px] font-bold text-pos-muted uppercase tracking-wider">
                  Aperçu du Message Client
                </label>
                <button
                  type="button"
                  onClick={handleCopyText}
                  className="text-xs text-emerald-400 hover:text-emerald-300 flex items-center gap-1 font-semibold transition py-1 px-2 rounded-lg"
                >
                  {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  {copied ? 'Copié' : 'Copier'}
                </button>
              </div>
              <div className="bg-pos-bg border border-pos-border rounded-xl p-3.5 text-xs text-pos-text/90 font-sans leading-relaxed whitespace-pre-wrap max-h-56 overflow-y-auto">
                {messageText}
              </div>
            </div>

            {/* Right Column: QR Code Handshake */}
            <div className="bg-pos-bg border border-pos-border rounded-xl p-4 flex flex-col items-center justify-center text-center space-y-3">
              <div className="flex items-center gap-1.5 text-emerald-400 text-xs font-bold">
                <Smartphone className="w-4 h-4" />
                <span>Scan Caméra Smartphone Magasin</span>
              </div>

              {/* Canvas QR Container */}
              <div className="p-2 bg-white rounded-xl shadow-lg border border-slate-200">
                <canvas
                  ref={qrCanvasRef}
                  width={WHATSAPP_QR.SIZE_PX}
                  height={WHATSAPP_QR.SIZE_PX}
                  className="rounded-lg"
                />
              </div>
              {qrError && (
                <p className="text-[10px] text-rose-400 max-w-[200px] leading-tight">
                  QR indisponible — utilisez le bouton « Ouvrir WhatsApp » ci-dessous.
                </p>
              )}
              <p className="text-[10px] text-pos-muted max-w-[200px] leading-tight">
                Pointez la caméra du téléphone du magasin pour ouvrir le message instantanément dans
                WhatsApp.
              </p>
            </div>
          </div>
        </div>

        {/* Footer Actions */}
        <div className="p-3 sm:p-4 border-t border-pos-border bg-pos-card flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2 shrink-0">
          <button
            type="button"
            onClick={closeModal}
            className="px-4 py-2.5 rounded-xl text-xs font-semibold text-pos-muted hover:text-pos-text transition min-h-[44px] flex items-center justify-center active-press"
          >
            Fermer
          </button>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleOpenDirect}
              className="flex-1 sm:flex-initial px-5 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs flex items-center justify-center gap-1.5 shadow-lg shadow-emerald-500/20 transition min-h-[44px] active-press"
            >
              <ExternalLink className="w-4 h-4" />
              <span className="sm:hidden">Ouvrir WhatsApp</span>
              <span className="hidden sm:inline">Ouvrir WhatsApp Web / App</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
