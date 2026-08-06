import React, { useState, useEffect } from 'react';
import { X, Sliders, Check, Upload, Image, Trash2 } from 'lucide-react';
import { usePosStore } from '../../store/usePosStore';
import type { ReceiptSettings } from '../../types/pos';

export const ReceiptTemplateModal: React.FC = () => {
  const { activeModal, closeModal, receiptSettings, setReceiptSettings } = usePosStore();
  const [formData, setFormData] = useState<ReceiptSettings>(receiptSettings);

  useEffect(() => {
    if (activeModal === 'receipt_template') {
      setFormData(receiptSettings);
    }
  }, [activeModal, receiptSettings]);

  if (activeModal !== 'receipt_template') return null;

  const handleLogoFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => {
        if (reader.result) {
          setFormData(prev => ({ ...prev, logoUrl: reader.result as string }));
        }
      };
      reader.readAsDataURL(file);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setReceiptSettings(formData);
    closeModal();
  };

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4 select-none">
      <div className="bg-pos-panel border border-pos-border rounded-2xl w-full max-w-lg overflow-hidden shadow-2xl animate-in fade-in zoom-in-95">
        <div className="p-4 border-b border-pos-border flex items-center justify-between bg-pos-card">
          <div className="flex items-center gap-2 text-emerald-400">
            <Sliders className="w-5 h-5" />
            <h2 className="text-sm font-bold text-pos-text">
              Personnalisation du Ticket & Logo Magasin
            </h2>
          </div>
          <button onClick={closeModal} className="p-1 hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-lg">
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4 max-h-[80vh] overflow-y-auto">
          
          {/* Logo Upload Section */}
          <div className="bg-pos-card border border-pos-border p-3.5 rounded-xl space-y-3">
            <label className="text-xs text-pos-text font-bold flex items-center gap-1.5">
              <Image className="w-4 h-4 text-emerald-400" /> Logo du Magasin sur le Ticket
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
                  className="p-1.5 bg-red-950 text-red-400 hover:bg-red-900 rounded-lg transition"
                  title="Supprimer le logo"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="flex gap-2 items-center">
                  <label className="flex-1 cursor-pointer bg-pos-bg hover:bg-emerald-950/30 border border-dashed border-emerald-500/50 hover:border-emerald-400 p-3 rounded-lg flex items-center justify-center gap-2 text-xs font-semibold text-emerald-400 transition">
                    <Upload className="w-4 h-4" /> Choisir une Image Logo (PNG/JPG)
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
            <label className="text-xs text-pos-muted block mb-1 font-semibold">Nom du Magasin</label>
            <input
              type="text"
              value={formData.storeName}
              onChange={(e) => setFormData({ ...formData, storeName: e.target.value })}
              className="w-full bg-pos-bg border border-pos-border rounded-lg px-3 py-2 text-xs font-bold text-pos-text focus:border-emerald-400 focus:outline-none"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-pos-muted block mb-1 font-semibold">Adresse Physique</label>
              <input
                type="text"
                value={formData.address}
                onChange={(e) => setFormData({ ...formData, address: e.target.value })}
                className="w-full bg-pos-bg border border-pos-border rounded-lg px-3 py-2 text-xs text-pos-text focus:border-emerald-400 focus:outline-none"
              />
            </div>
            <div>
              <label className="text-xs text-pos-muted block mb-1 font-semibold">Téléphone / Contact</label>
              <input
                type="text"
                value={formData.phone}
                onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                className="w-full bg-pos-bg border border-pos-border rounded-lg px-3 py-2 text-xs text-pos-text focus:border-emerald-400 focus:outline-none"
              />
            </div>
          </div>

          <div>
            <label className="text-xs text-pos-muted block mb-1 font-semibold">Message de Pied de Page (Conditions de retour)</label>
            <input
              type="text"
              value={formData.customFooterMsg}
              onChange={(e) => setFormData({ ...formData, customFooterMsg: e.target.value })}
              className="w-full bg-pos-bg border border-pos-border rounded-lg px-3 py-2 text-xs text-pos-text focus:border-emerald-400 focus:outline-none"
            />
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

          {/* Ticket Header Live Preview */}
          <div className="bg-slate-950 p-3 rounded-xl border border-pos-border">
            <p className="text-[10px] text-pos-muted uppercase font-bold mb-2">Aperçu en-tête du ticket :</p>
            <div className="bg-white text-black p-3 rounded font-mono text-[10px] text-center leading-tight">
              {formData.logoUrl && (
                <img
                  src={formData.logoUrl}
                  alt="Aperçu Logo"
                  className="max-h-10 max-w-[140px] object-contain mx-auto mb-1 mix-blend-multiply"
                />
              )}
              <p className="font-extrabold uppercase">{formData.storeName || 'NOM MAGASIN'}</p>
              <p className="text-[9px] text-gray-600">{formData.address || 'Adresse'}</p>
              <p className="text-[9px] text-gray-600">Tél: {formData.phone || '0000000000'}</p>
            </div>
          </div>

          <div className="p-4 border-t border-pos-border bg-pos-card flex justify-end gap-2 -mx-5 -mb-4 mt-4">
            <button type="button" onClick={closeModal} className="px-4 py-2 rounded-xl text-xs font-semibold text-pos-muted hover:text-pos-text">
              Annuler
            </button>
            <button
              type="submit"
              className="px-5 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs flex items-center gap-1.5 shadow-lg shadow-emerald-500/20"
            >
              <Check className="w-4 h-4" /> Enregistrer le Modèle
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
