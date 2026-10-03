import React, { useState, useEffect } from 'react';
import { X, Sliders, Check, Upload, Image, Trash2 } from 'lucide-react';
import { usePosStore } from '../../store/usePosStore';
import type { ReceiptSettings } from '../../types/pos';
import { STORE_RETURN_POLICY } from '../../utils/receiptViewModel';

const FOOTER_MAX = 280;

/** 42-col ASCII fold for the live ticket preview (mirrors foldThermal). */
function fold42(text: string, width = 42): string[] {
  const words = (text || '').split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if ((cur + (cur ? ' ' : '') + w).length > width) {
      if (cur) lines.push(cur);
      cur = w.length > width ? w.slice(0, width) : w;
    } else {
      cur = cur ? `${cur} ${w}` : w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

function center42(text: string, width = 42): string {
  const s = (text || '').slice(0, width);
  const pad = Math.max(0, width - s.length);
  const left = Math.floor(pad / 2);
  return ' '.repeat(left) + s + ' '.repeat(pad - left);
}

export const ReceiptTemplateModal: React.FC = () => {
  const { activeModal, closeModal, receiptSettings, setReceiptSettings } = usePosStore();
  const [formData, setFormData] = useState<ReceiptSettings>(receiptSettings);

  useEffect(() => {
    if (activeModal === 'receipt_template') {
      // Migrate legacy customFooterMsg into the primary footerMessage field
      // once (never blank the merchant's existing policy text).
      setFormData({
        ...receiptSettings,
        footerMessage: receiptSettings.footerMessage || receiptSettings.customFooterMsg || '',
      });
    }
  }, [activeModal, receiptSettings]);

  useEffect(() => { if (activeModal !== 'receipt_template') return; const h = (e: KeyboardEvent) => { if (e.key === 'Escape') closeModal(); }; document.addEventListener('keydown', h); return () => document.removeEventListener('keydown', h); }, [activeModal, closeModal]);

  if (activeModal !== 'receipt_template') return null;

  const handleLogoFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // Reject oversized uploads before they bloat IndexedDB/localStorage.
    if (file.size > 500 * 1024) {
      e.target.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onloadend = () => {
      const raw = reader.result as string | null;
      if (!raw) return;
      const img = new window.Image();
      img.onload = () => {
        try {
          const maxW = 400;
          const w = img.naturalWidth || img.width;
          const h = img.naturalHeight || img.height;
          if (!w || !h || w <= maxW) {
            setFormData((prev) => ({ ...prev, logoUrl: raw }));
            return;
          }
          const scale = maxW / w;
          const canvas = document.createElement('canvas');
          canvas.width = maxW;
          canvas.height = Math.max(1, Math.round(h * scale));
          const ctx = canvas.getContext('2d');
          if (!ctx) {
            setFormData((prev) => ({ ...prev, logoUrl: raw }));
            return;
          }
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          const downscaled = canvas.toDataURL('image/png');
          setFormData((prev) => ({ ...prev, logoUrl: downscaled }));
        } catch {
          setFormData((prev) => ({ ...prev, logoUrl: raw }));
        }
      };
      img.onerror = () => {
        setFormData((prev) => ({ ...prev, logoUrl: raw }));
      };
      img.src = raw;
    };
    reader.readAsDataURL(file);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // Mirror the primary footer into the legacy field so every reader
    // (current view-model chain + older synced peers) sees one message.
    const footer = (formData.footerMessage || '').trim();
    setReceiptSettings({ ...formData, footerMessage: footer, customFooterMsg: footer });
    closeModal();
  };

  // Live 42-col ticket preview: header + footer update as the merchant types.
  // Optional lines (address/phone/email/footer) vanish when blank — the same
  // omission rule the three print engines apply, so the preview never lies.
  const previewHeader: string[] = [
    center42((formData.storeName || 'NOM MAGASIN').toUpperCase()),
    ...((formData.storeSubheader || formData.customHeaderMsg || '').trim()
      ? [center42((formData.storeSubheader || formData.customHeaderMsg || '').trim())]
      : []),
    ...((formData.address || '').trim() ? fold42((formData.address || '').trim()).map((l) => center42(l)) : []),
    ...((formData.phone || '').trim() ? [center42(`Tél: ${(formData.phone || '').trim()}`)] : []),
    ...((formData.email || '').trim() ? [center42(`Email: ${(formData.email || '').trim()}`.slice(0, 42))] : []),
  ];
  const footerText = (formData.footerMessage || '').trim();
  const previewFooter: string[] = footerText ? fold42(footerText) : fold42(STORE_RETURN_POLICY);

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 select-none">
      <div className="bg-pos-panel border-t sm:border border-pos-border rounded-t-2xl sm:rounded-2xl w-full max-w-lg overflow-hidden shadow-2xl animate-in fade-in zoom-in-95 flex flex-col max-h-[92dvh] pt-[max(0.5rem,var(--safe-top))] pb-[max(0.5rem,var(--safe-bottom))] sm:py-0">
        <div className="w-8 h-1 rounded-full bg-pos-muted/40 mx-auto mt-2.5 mb-1 sm:hidden shrink-0" />

        <div className="p-4 border-b border-pos-border flex items-center justify-between bg-pos-card shrink-0">
          <div className="flex items-center gap-2 text-emerald-400 min-w-0">
            <Sliders className="w-5 h-5 shrink-0" aria-hidden="true" />
            <h2 className="text-sm font-bold text-pos-text truncate">
              Personnalisation du Ticket & Logo Magasin
            </h2>
          </div>
          <button
            type="button"
            onClick={closeModal}
            aria-label="Fermer — fermer la personnalisation du ticket"
            title="Fermer"
            className="p-1.5 hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-lg min-h-[44px] min-w-[44px] flex items-center justify-center shrink-0"
          >
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex-1 p-4 sm:p-5 space-y-4 overflow-y-auto overscroll-contain">
          
          {/* Logo Upload Section */}
          <div className="bg-pos-card border border-pos-border p-3.5 rounded-xl space-y-3">
            <label className="text-xs text-pos-text font-bold flex items-center gap-1.5">
              <Image className="w-4 h-4 text-emerald-400" aria-hidden="true" /> Logo du Magasin sur le Ticket
            </label>

            {formData.logoUrl ? (
              <div className="flex items-center justify-between bg-pos-bg p-3 rounded-lg border border-emerald-500/30">
                <div className="flex items-center gap-3">
                  <img
                    src={formData.logoUrl}
                    alt="Logo Aperçu"
                    className="h-12 w-24 object-contain bg-white p-1 rounded border border-pos-border"
                  />
                  <div>
                    <p className="text-xs font-bold text-emerald-400">Logo Configuré</p>
                    <p className="text-[10px] text-pos-muted">Sera imprimé en en-tête du ticket</p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setFormData({ ...formData, logoUrl: '' })}
                  aria-label="Supprimer le logo — retirer le logo du ticket"
                  className="p-1.5 bg-red-950 text-red-400 hover:bg-red-900 rounded-lg transition min-h-[44px] min-w-[44px] flex items-center justify-center"
                  title="Supprimer le logo"
                >
                  <Trash2 className="w-4 h-4" aria-hidden="true" />
                </button>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="flex gap-2 items-center">
                  <label className="flex-1 cursor-pointer bg-pos-bg hover:bg-emerald-950/30 border border-dashed border-emerald-500/50 hover:border-emerald-400 p-3 rounded-lg flex items-center justify-center gap-2 text-xs font-semibold text-emerald-400 transition">
                    <Upload className="w-4 h-4" aria-hidden="true" /> Choisir une Image Logo (PNG/JPG)
                    <input
                      type="file"
                      accept="image/*"
                      onChange={handleLogoFileUpload}
                      className="hidden"
                    />
                  </label>
                </div>
                <p className="text-[10px] text-pos-muted text-center">
                  Ou saisissez l'URL directe d'une image ci-dessous:
                </p>
                <input
                  type="text"
                  placeholder="https://domaine.com/logo.png"
                  value={formData.logoUrl}
                  onChange={(e) => setFormData({ ...formData, logoUrl: e.target.value })}
                  className="w-full bg-pos-bg border border-pos-border rounded-lg px-3 py-1.5 text-xs text-pos-text focus:border-emerald-400 focus:outline-none"
                />
              </div>
            )}
          </div>

          <div>
            <label htmlFor="receipt-storename" className="text-xs text-pos-muted block mb-1 font-semibold">Nom du Magasin</label>
            <input
              id="receipt-storename"
              type="text"
              value={formData.storeName}
              onChange={(e) => setFormData({ ...formData, storeName: e.target.value })}
              className="w-full bg-pos-bg border border-pos-border rounded-lg px-3 py-2 text-xs font-bold text-pos-text focus:border-emerald-400 focus:outline-none"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="receipt-address" className="text-xs text-pos-muted block mb-1 font-semibold">Adresse Physique</label>
              <input
                id="receipt-address"
                type="text"
                value={formData.address ?? ''}
                onChange={(e) => setFormData({ ...formData, address: e.target.value })}
                placeholder="Optionnel — omis du ticket si vide"
                className="w-full bg-pos-bg border border-pos-border rounded-lg px-3 py-2 text-xs text-pos-text focus:border-emerald-400 focus:outline-none"
              />
            </div>
            <div>
              <label htmlFor="receipt-phone" className="text-xs text-pos-muted block mb-1 font-semibold">Téléphone / Contact</label>
              <input
                id="receipt-phone"
                type="text"
                value={formData.phone ?? ''}
                onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                placeholder="Optionnel"
                className="w-full bg-pos-bg border border-pos-border rounded-lg px-3 py-2 text-xs text-pos-text focus:border-emerald-400 focus:outline-none"
              />
            </div>
          </div>

          <div>
            <label htmlFor="receipt-email" className="text-xs text-pos-muted block mb-1 font-semibold">Email du Magasin (optionnel)</label>
            <input
              id="receipt-email"
              type="email"
              value={formData.email ?? ''}
              onChange={(e) => setFormData({ ...formData, email: e.target.value })}
              placeholder="Ex: contact@boutique.dz"
              className="w-full bg-pos-bg border border-pos-border rounded-lg px-3 py-2 text-xs text-pos-text focus:border-emerald-400 focus:outline-none"
            />
            <p className="text-[10px] text-pos-muted mt-1">Imprimé comme « Email: … » — ligne totalement omise si vide.</p>
          </div>

          <div>
            <label className="text-xs text-pos-muted block mb-1 font-semibold">Identifiants Fiscaux (RC / NIF / NIS / ART — imprimés sur tickets)</label>
            <div className="grid grid-cols-2 gap-3">
              {([
                ['rc', 'RC N°'],
                ['nif', 'NIF'],
                ['nis', 'NIS'],
                ['art', 'Article d’Imposition'],
              ] as const).map(([key, label]) => (
                <div key={key}>
                  <label className="text-xs text-pos-muted block mb-1 font-semibold">{label}</label>
                  <input
                    type="text"
                    value={formData[key] || ''}
                    onChange={(e) => setFormData({ ...formData, [key]: e.target.value })}
                    placeholder="—"
                    className="w-full bg-pos-bg border border-pos-border rounded-lg px-3 py-2 text-xs font-mono text-pos-text focus:border-emerald-400 focus:outline-none"
                  />
                </div>
              ))}
            </div>
          </div>

          <div>
            <div className="flex items-baseline justify-between mb-1">
              <label htmlFor="receipt-footer" className="text-xs text-pos-muted font-semibold">Message de Pied de Page (politique / note gérant)</label>
              <span className="text-[10px] text-pos-muted font-mono" aria-live="polite">
                {(formData.footerMessage || '').length}/{FOOTER_MAX}
              </span>
            </div>
            <textarea
              id="receipt-footer"
              rows={3}
              maxLength={FOOTER_MAX}
              value={formData.footerMessage ?? ''}
              onChange={(e) => setFormData({ ...formData, footerMessage: e.target.value })}
              placeholder="Ex: Garantie 3 mois sur les réparations. Aucun remboursement sans ticket."
              className="w-full bg-pos-bg border border-pos-border rounded-lg px-3 py-2 text-xs text-pos-text focus:border-emerald-400 focus:outline-none resize-y"
            />
            <p className="text-[10px] text-pos-muted mt-1">Prioritaire sur le texte par défaut. Vide = politique de retour standard.</p>
          </div>

          {/* Auto-Print Toggle */}
          <div className="bg-pos-card border border-pos-border p-3.5 rounded-xl flex items-center justify-between">
            <div>
              <p className="text-xs font-bold text-pos-text">Impression Automatique au Paiement</p>
              <p className="text-[10px] text-pos-muted">Ouvre automatiquement la fenêtre d'impression à la validation de vente</p>
            </div>
            <button
              type="button"
              onClick={() => setFormData({ ...formData, autoPrintEnabled: formData.autoPrintEnabled === false ? true : false })}
              aria-label="Impression Automatique — activer ou désactiver l'impression au paiement"
              aria-pressed={formData.autoPrintEnabled !== false}
              className={`w-12 h-6 rounded-full transition-colors relative flex items-center px-0.5 ${
                formData.autoPrintEnabled !== false ? 'bg-emerald-500' : 'bg-slate-700'
              }`}
            >
              <span
                className={`w-5 h-5 rounded-full bg-white transition-transform ${
                  formData.autoPrintEnabled !== false ? 'translate-x-6' : 'translate-x-0'
                }`}
              />
            </button>
          </div>

          {/* Ticket Live 42-Column Preview (header + footer, same omission rules as print) */}
          <div className="bg-slate-950 p-3 rounded-xl border border-pos-border">
            <p className="text-[10px] text-pos-muted uppercase font-bold mb-2">Aperçu ticket 42 colonnes :</p>
            <div className="bg-white text-black p-3 rounded font-mono text-[10px] leading-tight">
              {formData.logoUrl && (
                <img
                  src={formData.logoUrl}
                  alt="Aperçu Logo"
                  className="max-h-10 max-w-[140px] object-contain mx-auto mb-1 mix-blend-multiply"
                />
              )}
              <pre className="whitespace-pre-wrap text-center" aria-label="Aperçu en-tête du ticket">
                {['='.repeat(42), ...previewHeader, '='.repeat(42)].join('\n')}
              </pre>
              <pre className="whitespace-pre-wrap text-center mt-2" aria-label="Aperçu pied de page du ticket">
                {[...previewFooter, 'Merci de votre visite et à bientôt !'].join('\n')}
              </pre>
            </div>
          </div>

          <div className="p-3 sm:p-4 border-t border-pos-border bg-pos-card flex flex-col sm:flex-row justify-end gap-2 -mx-4 sm:-mx-5 -mb-4 mt-4 shrink-0">
            <button
              type="button"
              onClick={closeModal}
              aria-label="Annuler — fermer sans enregistrer le modèle"
              className="px-4 py-2.5 rounded-xl text-xs font-semibold text-pos-muted hover:text-pos-text transition min-h-[44px] flex items-center justify-center active-press"
            >
              Annuler
            </button>
            <button
              type="submit"
              aria-label="Enregistrer le Modèle — sauvegarder le ticket magasin"
              className="px-5 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs flex items-center justify-center gap-1.5 shadow-lg shadow-emerald-500/20 min-h-[44px] active-press"
            >
              <Check className="w-4 h-4" aria-hidden="true" /> Enregistrer le Modèle
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
