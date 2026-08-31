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

  const handleOpenDirect = () => {
    window.open(whatsAppUrl, '_blank', 'noopener,noreferrer');
  };

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4 select-none animate-in fade-in">
      <div className="bg-pos-panel border border-pos-border rounded-2xl w-full max-w-2xl overflow-hidden shadow-2xl animate-in zoom-in-95 flex flex-col">
        {/* Header */}
        <div className="p-4 border-b border-pos-border bg-pos-card flex items-center justify-between">
          <div className="flex items-center gap-2 text-emerald-400">
            <MessageSquare className="w-5 h-5" />
            <div>
              <h2 className="text-sm font-bold text-pos-text">
                Notification Client WhatsApp — Appareil Prêt
              </h2>
              <p className="text-[11px] text-pos-muted">
                Ticket N° {order.ticketNumber} • {order.customerName} ({order.customerPhone})
              </p>
            </div>
          </div>
          <button
            onClick={closeModal}
            className="p-1.5 hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-lg transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content Body */}
        <div className="p-5 space-y-4">
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
                  className="text-xs text-emerald-400 hover:text-emerald-300 flex items-center gap-1 font-semibold transition"
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
        <div className="p-4 border-t border-pos-border bg-pos-card flex items-center justify-between">
          <button
            type="button"
            onClick={closeModal}
            className="px-4 py-2 rounded-xl text-xs font-semibold text-pos-muted hover:text-pos-text transition"
          >
            Fermer
          </button>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleOpenDirect}
              className="px-5 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs flex items-center gap-1.5 shadow-lg shadow-emerald-500/20 transition active:scale-[0.98]"
            >
              <ExternalLink className="w-4 h-4" /> Ouvrir WhatsApp Web / Bureau
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
