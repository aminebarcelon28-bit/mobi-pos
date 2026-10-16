import React from 'react';
import {
  Sun, Moon, CheckCircle2, Store, CreditCard,
  Building, MapPin, Phone, Mail, Hash, ShieldCheck, Printer, Zap
} from 'lucide-react';
import type { ReceiptSettings } from '../../../types/pos';

interface GeneralSettingsTabProps {
  themeMode: 'dark' | 'light';
  toggleTheme: () => void;
  receiptDraft: ReceiptSettings;
  scheduleReceiptSave: (next: ReceiptSettings) => void;
}

export const GeneralSettingsTab: React.FC<GeneralSettingsTabProps> = ({
  themeMode,
  toggleTheme,
  receiptDraft,
  scheduleReceiptSave,
}) => {
  return (
    <div className="space-y-4 max-w-3xl">
      {/* Theme Selector Card */}
      <div className="bg-pos-card border border-pos-border rounded-xl p-4 space-y-3 shadow-md">
        <div className="flex items-center gap-2">
          <Sun className="w-4 h-4 text-amber-400" />
          <h4 className="text-xs font-bold text-pos-text">Thème & Apparence de l'Application</h4>
        </div>
        <p className="text-xs text-pos-muted">
          Personnalisez l'ambiance visuelle du logiciel pour un confort optimal en caisse.
        </p>

        <div className="grid grid-cols-2 gap-3 pt-2">
          <button
            type="button"
            onClick={() => {
              if (themeMode !== 'dark') toggleTheme();
            }}
            className={`p-4 rounded-xl border-2 text-left transition cursor-pointer flex flex-col justify-between h-28 ${
              themeMode === 'dark'
                ? 'border-cyan-400 bg-slate-900 text-white shadow-md'
                : 'border-pos-border bg-slate-900/40 text-pos-muted hover:border-pos-border/80'
            }`}
          >
            <div className="flex items-center justify-between w-full">
              <div className="flex items-center gap-2">
                <Moon className="w-5 h-5 text-indigo-400" />
                <span className="font-bold text-sm">Mode Sombre (Dark)</span>
              </div>
              {themeMode === 'dark' && <CheckCircle2 className="w-4 h-4 text-cyan-400" />}
            </div>
            <p className="text-[11px] text-slate-400">Recommandé en caisse pour réduire la fatigue oculaire et sublimer les contrastes.</p>
          </button>

          <button
            type="button"
            onClick={() => {
              if (themeMode !== 'light') toggleTheme();
            }}
            className={`p-4 rounded-xl border-2 text-left transition cursor-pointer flex flex-col justify-between h-28 ${
              themeMode === 'light'
                ? 'border-amber-400 bg-white text-slate-950 shadow-md'
                : 'border-pos-border bg-white/40 text-pos-muted hover:border-pos-border/80'
            }`}
          >
            <div className="flex items-center justify-between w-full">
              <div className="flex items-center gap-2">
                <Sun className="w-5 h-5 text-amber-500" />
                <span className="font-bold text-sm">Mode Clair (Light)</span>
              </div>
              {themeMode === 'light' && <CheckCircle2 className="w-4 h-4 text-amber-500" />}
            </div>
            <p className="text-[11px] text-slate-500">Contraste élevé pour les environnements de boutique très éclairés.</p>
          </button>
        </div>
      </div>

      {/* Store Identity & Profile Card */}
      <div className="bg-pos-card border border-pos-border rounded-xl p-4 space-y-3 shadow-md">
        <div className="flex items-center gap-2">
          <Store className="w-4 h-4 text-cyan-400" />
          <h4 className="text-xs font-bold text-pos-text">Profil du Magasin & En-tête</h4>
        </div>
        
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="text-[11px] font-bold text-pos-muted block mb-1">Nom de l'Enseigne / Boutique :</label>
            <input
              type="text"
              value={receiptDraft.storeName || ''}
              onChange={(e) => scheduleReceiptSave({ ...receiptDraft, storeName: e.target.value })}
              placeholder="ex: MOBI PHONE ACCESS"
              className="w-full bg-pos-bg border border-pos-border rounded-xl px-3 py-2 text-xs text-pos-text font-bold focus:border-cyan-400 focus:outline-none"
            />
          </div>

          <div>
            <label className="text-[11px] font-bold text-pos-muted block mb-1">Sous-titre / Activité :</label>
            <input
              type="text"
              value={receiptDraft.storeSubheader || ''}
              onChange={(e) => scheduleReceiptSave({ ...receiptDraft, storeSubheader: e.target.value })}
              placeholder="ex: Vente Téléphonie, Accessoires & Réparations"
              className="w-full bg-pos-bg border border-pos-border rounded-xl px-3 py-2 text-xs text-pos-text focus:border-cyan-400 focus:outline-none"
            />
          </div>

          <div>
            <label className="text-[11px] font-bold text-pos-muted block mb-1 flex items-center gap-1">
              <MapPin className="w-3 h-3 text-pos-muted" /> Adresse physique :
            </label>
            <input
              type="text"
              value={receiptDraft.address || ''}
              onChange={(e) => scheduleReceiptSave({ ...receiptDraft, address: e.target.value })}
              placeholder="ex: Rue Didouche Mourad, Alger Centre"
              className="w-full bg-pos-bg border border-pos-border rounded-xl px-3 py-2 text-xs text-pos-text focus:border-cyan-400 focus:outline-none"
            />
          </div>

          <div>
            <label className="text-[11px] font-bold text-pos-muted block mb-1 flex items-center gap-1">
              <Phone className="w-3 h-3 text-pos-muted" /> Numéro de Téléphone :
            </label>
            <input
              type="text"
              value={receiptDraft.phone || ''}
              onChange={(e) => scheduleReceiptSave({ ...receiptDraft, phone: e.target.value })}
              placeholder="ex: 0550 12 34 56"
              className="w-full bg-pos-bg border border-pos-border rounded-xl px-3 py-2 text-xs text-pos-text focus:border-cyan-400 focus:outline-none"
            />
          </div>

          <div>
            <label className="text-[11px] font-bold text-pos-muted block mb-1 flex items-center gap-1">
              <Mail className="w-3 h-3 text-pos-muted" /> Email Contact :
            </label>
            <input
              type="email"
              value={receiptDraft.email || ''}
              onChange={(e) => scheduleReceiptSave({ ...receiptDraft, email: e.target.value })}
              placeholder="ex: contact@mobiphone.dz"
              className="w-full bg-pos-bg border border-pos-border rounded-xl px-3 py-2 text-xs text-pos-text focus:border-cyan-400 focus:outline-none"
            />
          </div>

          <div>
            <label className="text-[11px] font-bold text-pos-muted block mb-1">Ville :</label>
            <input
              type="text"
              value={receiptDraft.city || ''}
              onChange={(e) => scheduleReceiptSave({ ...receiptDraft, city: e.target.value })}
              placeholder="ex: Alger, Oran, Mascara..."
              className="w-full bg-pos-bg border border-pos-border rounded-xl px-3 py-2 text-xs text-pos-text focus:border-cyan-400 focus:outline-none"
            />
          </div>
        </div>
      </div>

      {/* Algerian Fiscal Identifiers Card */}
      <div className="bg-pos-card border border-pos-border rounded-xl p-4 space-y-3 shadow-md">
        <div className="flex items-center gap-2">
          <Building className="w-4 h-4 text-emerald-400" />
          <h4 className="text-xs font-bold text-pos-text">Identifiants Fiscaux Algériens</h4>
        </div>
        <p className="text-[11px] text-pos-muted">
          Mentions légales obligatoires figurant sur les reçus, factures et bons de livraison.
        </p>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 pt-1">
          <div>
            <label className="text-[10px] font-bold text-pos-muted block mb-1">Registre Comm. (RC) :</label>
            <input
              type="text"
              value={receiptDraft.rc || ''}
              onChange={(e) => scheduleReceiptSave({ ...receiptDraft, rc: e.target.value })}
              placeholder="ex: 16/00-1234567B18"
              className="w-full bg-pos-bg border border-pos-border rounded-lg px-2.5 py-1.5 text-xs text-pos-text font-mono focus:border-emerald-400 focus:outline-none"
            />
          </div>

          <div>
            <label className="text-[10px] font-bold text-pos-muted block mb-1">NIF :</label>
            <input
              type="text"
              value={receiptDraft.nif || ''}
              onChange={(e) => scheduleReceiptSave({ ...receiptDraft, nif: e.target.value })}
              placeholder="15 chiffres"
              className="w-full bg-pos-bg border border-pos-border rounded-lg px-2.5 py-1.5 text-xs text-pos-text font-mono focus:border-emerald-400 focus:outline-none"
            />
          </div>

          <div>
            <label className="text-[10px] font-bold text-pos-muted block mb-1">NIS :</label>
            <input
              type="text"
              value={receiptDraft.nis || ''}
              onChange={(e) => scheduleReceiptSave({ ...receiptDraft, nis: e.target.value })}
              placeholder="ex: 001234567890123"
              className="w-full bg-pos-bg border border-pos-border rounded-lg px-2.5 py-1.5 text-xs text-pos-text font-mono focus:border-emerald-400 focus:outline-none"
            />
          </div>

          <div>
            <label className="text-[10px] font-bold text-pos-muted block mb-1">Article Impos. (ART) :</label>
            <input
              type="text"
              value={receiptDraft.art || ''}
              onChange={(e) => scheduleReceiptSave({ ...receiptDraft, art: e.target.value })}
              placeholder="ex: 16012345678"
              className="w-full bg-pos-bg border border-pos-border rounded-lg px-2.5 py-1.5 text-xs text-pos-text font-mono focus:border-emerald-400 focus:outline-none"
            />
          </div>
        </div>
      </div>

      {/* Ticket Format & Thermal Paper Width Card */}
      <div className="bg-pos-card border border-pos-border rounded-xl p-4 space-y-3 shadow-md">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Printer className="w-4 h-4 text-purple-400" />
            <h4 className="text-xs font-bold text-pos-text">Format du Ticket & Impression Thermique</h4>
          </div>
          <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-purple-500/10 text-purple-400 border border-purple-500/20">
            {receiptDraft.paperWidth || '80mm'}
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
          <div>
            <label className="text-[11px] font-bold text-pos-muted block mb-1">Largeur du Papier Rouleau :</label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => scheduleReceiptSave({ ...receiptDraft, paperWidth: '80mm' })}
                className={`py-2 px-3 rounded-xl border text-xs font-bold transition flex items-center justify-center gap-1.5 cursor-pointer ${
                  (receiptDraft.paperWidth || '80mm') === '80mm'
                    ? 'bg-purple-500/20 border-purple-500 text-purple-300 shadow-sm'
                    : 'bg-pos-bg border-pos-border text-pos-muted hover:text-pos-text'
                }`}
              >
                <span>80 mm (Standard)</span>
              </button>
              <button
                type="button"
                onClick={() => scheduleReceiptSave({ ...receiptDraft, paperWidth: '58mm' })}
                className={`py-2 px-3 rounded-xl border text-xs font-bold transition flex items-center justify-center gap-1.5 cursor-pointer ${
                  receiptDraft.paperWidth === '58mm'
                    ? 'bg-purple-500/20 border-purple-500 text-purple-300 shadow-sm'
                    : 'bg-pos-bg border-pos-border text-pos-muted hover:text-pos-text'
                }`}
              >
                <span>58 mm (Compact)</span>
              </button>
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-[11px] font-bold text-pos-muted block">Options d'Encaissement :</label>
            <div className="flex flex-col gap-2">
              <label className="flex items-center gap-2 text-xs text-pos-text cursor-pointer">
                <input
                  type="checkbox"
                  checked={receiptDraft.autoPrintEnabled ?? true}
                  onChange={(e) => scheduleReceiptSave({ ...receiptDraft, autoPrintEnabled: e.target.checked })}
                  className="rounded border-pos-border text-emerald-500 focus:ring-0"
                />
                <span>Impression automatique du ticket à la validation de la vente</span>
              </label>

              <label className="flex items-center gap-2 text-xs text-pos-text cursor-pointer">
                <input
                  type="checkbox"
                  checked={receiptDraft.kickCashDrawerOnCash ?? true}
                  onChange={(e) => scheduleReceiptSave({ ...receiptDraft, kickCashDrawerOnCash: e.target.checked })}
                  className="rounded border-pos-border text-emerald-500 focus:ring-0"
                />
                <span className="flex items-center gap-1">
                  <Zap className="w-3.5 h-3.5 text-amber-400" />
                  <span>Ouvrir automatiquement le tiroir-caisse sur règlement espèces</span>
                </span>
              </label>

              <label className="flex items-center gap-2 text-xs text-pos-text cursor-pointer">
                <input
                  type="checkbox"
                  checked={receiptDraft.showBarcode ?? true}
                  onChange={(e) => scheduleReceiptSave({ ...receiptDraft, showBarcode: e.target.checked })}
                  className="rounded border-pos-border text-emerald-500 focus:ring-0"
                />
                <span>Afficher le code-barres scannable du reçu</span>
              </label>
            </div>
          </div>
        </div>

        {/* Custom Header & Footer Messages */}
        <div className="space-y-2 pt-2 border-t border-pos-border">
          <div>
            <label className="text-[11px] font-bold text-pos-muted block mb-1">Message d'En-tête Personnalisé :</label>
            <input
              type="text"
              value={receiptDraft.customHeaderMsg || ''}
              onChange={(e) => scheduleReceiptSave({ ...receiptDraft, customHeaderMsg: e.target.value })}
              placeholder="ex: Bienvenue chez Mobi Phone — Merci de votre visite !"
              className="w-full bg-pos-bg border border-pos-border rounded-xl px-3 py-2 text-xs text-pos-text focus:border-purple-400 focus:outline-none"
            />
          </div>

          <div>
            <label className="text-[11px] font-bold text-pos-muted block mb-1">Message de Pied de Page / Politique d'Échange :</label>
            <textarea
              rows={2}
              value={receiptDraft.footerMessage ?? receiptDraft.customFooterMsg ?? ''}
              onChange={(e) => {
                const val = e.target.value;
                scheduleReceiptSave({ ...receiptDraft, footerMessage: val, customFooterMsg: val });
              }}
              placeholder="ex: Les articles vendus sont échangeables sous 48h avec ticket et emballage d'origine. Aucun remboursement en espèces."
              className="w-full bg-pos-bg border border-pos-border rounded-xl px-3 py-2 text-xs text-pos-text focus:border-purple-400 focus:outline-none"
            />
          </div>
        </div>
      </div>

      {/* BaridiMob & Algerian Bank Settlement Details Card */}
      <div className="bg-pos-card border border-pos-border rounded-xl p-4 space-y-3 shadow-md">
        <div className="flex items-center gap-2">
          <CreditCard className="w-4 h-4 text-emerald-400" />
          <h4 className="text-xs font-bold text-pos-text">Coordonnées BaridiMob & Règlement Dettes</h4>
        </div>
        <p className="text-[11px] text-pos-muted">
          Coordonnées bancaires transmises automatiquement aux clients lors de l'envoi de rappels de dettes par WhatsApp ou SMS.
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-1">
          <div>
            <label className="text-[10px] font-bold text-pos-muted block mb-1 flex items-center gap-1">
              <Hash className="w-3 h-3 text-pos-muted" /> RIP BaridiMob (16 ou 20 chiffres) :
            </label>
            <input
              type="text"
              value={receiptDraft.baridimobRip || ''}
              onChange={(e) => scheduleReceiptSave({ ...receiptDraft, baridimobRip: e.target.value.replace(/\s+/g, '') })}
              placeholder="ex: 00799999000123456789"
              className="w-full bg-pos-bg border border-pos-border rounded-xl px-3 py-2 text-xs text-pos-text font-mono font-bold focus:border-emerald-400 focus:outline-none"
            />
          </div>

          <div>
            <label className="text-[10px] font-bold text-pos-muted block mb-1 flex items-center gap-1">
              <Building className="w-3 h-3 text-pos-muted" /> Compte CCP (+ Clé) :
            </label>
            <input
              type="text"
              value={receiptDraft.ccpAccount || ''}
              onChange={(e) => scheduleReceiptSave({ ...receiptDraft, ccpAccount: e.target.value })}
              placeholder="ex: 12345678 Clé 99"
              className="w-full bg-pos-bg border border-pos-border rounded-xl px-3 py-2 text-xs text-pos-text font-mono focus:border-emerald-400 focus:outline-none"
            />
          </div>

          <div>
            <label className="text-[10px] font-bold text-pos-muted block mb-1 flex items-center gap-1">
              <ShieldCheck className="w-3 h-3 text-pos-muted" /> Titulaire du Compte :
            </label>
            <input
              type="text"
              value={receiptDraft.bankBeneficiaryName || ''}
              onChange={(e) => scheduleReceiptSave({ ...receiptDraft, bankBeneficiaryName: e.target.value })}
              placeholder="ex: SARL MOBI POS / BENALI KARIM"
              className="w-full bg-pos-bg border border-pos-border rounded-xl px-3 py-2 text-xs text-pos-text focus:border-emerald-400 focus:outline-none"
            />
          </div>
        </div>
      </div>
    </div>
  );
};

