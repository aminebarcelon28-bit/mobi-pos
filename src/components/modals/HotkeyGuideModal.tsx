import React from 'react';
import { usePosStore } from '../../store/usePosStore';
import { X, Keyboard } from 'lucide-react';

export const HotkeyGuideModal: React.FC = () => {
  const { activeModal, closeModal } = usePosStore();

  if (activeModal !== 'hotkey_guide') return null;

  const hotkeys = [
    { key: 'F1', label: 'Nouveau Panier' },
    { key: 'F2', label: 'Recherche Produit' },
    { key: 'F3', label: 'Encaisser / Paiement' },
    { key: 'F4', label: 'Reprendre Ventes en Attente' },
    { key: 'F5', label: 'Fichier Clients' },
    { key: 'F6', label: 'Appliquer Remise' },
    { key: 'F7', label: 'Mettre la Vente en Attente' },
    { key: 'F9', label: 'Dernier Reçu / Ticket' },
    { key: 'F10', label: 'Rapports & Ventes' },
    { key: 'F11', label: 'Gestion de Stock' },
    { key: 'F12', label: 'Paramètres Caisse' },
    { key: 'Esc', label: 'Fermer / Annuler' },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="w-full max-w-2xl bg-pos-panel border-pos-border border rounded-2xl shadow-2xl p-6">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-2">
            <Keyboard className="w-6 h-6 text-emerald-500" />
            <h2 className="text-xl font-semibold text-pos-text">Raccourcis Clavier</h2>
          </div>
          <button
            onClick={closeModal}
            className="p-2 rounded-lg hover:bg-pos-hover text-pos-muted hover:text-pos-text transition-colors"
          >
            <X className="w-6 h-6" />
          </button>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
          {hotkeys.map((hotkey) => (
            <div
              key={hotkey.key}
              className="flex items-center gap-3 p-3 rounded-xl bg-pos-bg border border-pos-border"
            >
              <kbd className="px-2.5 py-1.5 text-sm font-semibold text-pos-text bg-pos-panel border border-pos-border rounded-lg shadow-sm">
                {hotkey.key}
              </kbd>
              <span className="text-sm font-medium text-pos-muted">{hotkey.label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
