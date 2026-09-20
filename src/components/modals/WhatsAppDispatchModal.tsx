import React, { useState, useEffect, useRef } from 'react';
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

export const WhatsAppDispatchModal: React.FC = () => {
  const {
    activeModal,
    closeModal,
    selectedRepairOrderForNotification,
    receiptSettings,
  } = usePosStore();
  const { showToast } = useToast();
  const [copied, setCopied] = useState(false);
  const qrCanvasRef = useRef<HTMLCanvasElement>(null);

  const order = selectedRepairOrderForNotification;
  const messageText = order
    ? RepairNotificationEngine.generateMessageBody(order, receiptSettings, 'READY_FOR_PICKUP')
    : '';
  const whatsAppUrl = order
    ? RepairNotificationEngine.buildWhatsAppUrl(order, receiptSettings, 'READY_FOR_PICKUP')
    : '';

  useEffect(() => {
    if (!whatsAppUrl || !qrCanvasRef.current) return;
    const canvas = qrCanvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(
      whatsAppUrl
    )}`;
    img.onload = () => {
      ctx.clearRect(0, 0, 180, 180);
      ctx.drawImage(img, 0, 0, 180, 180);
    };
  }, [whatsAppUrl]);

  if (activeModal !== 'whatsapp_dispatch' || !order) return null;

  const handleCopyText = async () => {
    try {
      await navigator.clipboard.writeText(messageText);
      setCopied(true);
      showToast('Texte du message copié dans le presse-papier !', 'success');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      showToast('Erreur lors de la copie du texte', 'error');
    }
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
                <canvas ref={qrCanvasRef} width={180} height={180} className="rounded-lg" />
              </div>
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
