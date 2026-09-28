import React, { useState, useEffect, useRef } from 'react';
import { X, Zap, Plus, RotateCcw, Trash2, Edit3, Check, Sparkles, RefreshCw } from 'lucide-react';
import { usePosStore } from '../../store/usePosStore';
import { formatDZD } from '../../types/pos';
import type { Product } from '../../types/pos';
import { soundEngine } from '../../utils/audioFeedback';
import { newId } from '../../utils/ids';
import { parseLocalizedAmount } from '../../utils/moneyInput';
import {
  getQuickTouches,
  saveQuickTouch,
  deleteQuickTouch,
  resetQuickTouches,
  createServiceProductFromTouch,
  type QuickTouchItem,
} from '../../utils/quickTouchStorage';

const AVAILABLE_ICONS = ['⚡', '🛡️', '📱', '🔄', '🔓', '🧹', '🔧', '🔌', '🎧', '📦', '🏷️', '✨'];

const AVAILABLE_COLORS = [
  { label: 'Cyan / Bleu', value: 'from-cyan-500/20 to-blue-500/20 border-cyan-500/40 text-cyan-300' },
  { label: 'Émeraude / Vert', value: 'from-emerald-500/20 to-teal-500/20 border-emerald-500/40 text-emerald-300' },
  { label: 'Violet / Indigo', value: 'from-purple-500/20 to-indigo-500/20 border-purple-500/40 text-purple-300' },
  { label: 'Rose / Rouge', value: 'from-rose-500/20 to-pink-500/20 border-rose-500/40 text-rose-300' },
  { label: 'Ambre / Jaune', value: 'from-amber-500/20 to-yellow-500/20 border-amber-500/40 text-amber-300' },
  { label: 'Orange / Cuivre', value: 'from-orange-500/20 to-amber-500/20 border-orange-500/40 text-orange-300' },
];

export const CustomItemModal: React.FC = () => {
  const { activeModal, closeModal, addToCart } = usePosStore();

  const [quickTouches, setQuickTouches] = useState<QuickTouchItem[]>(() => getQuickTouches());
  const [activeTab, setActiveTab] = useState<'quick' | 'custom'>('quick');

  // Free-form item state
  const [title, setTitle] = useState('');
  const [priceInput, setPriceInput] = useState('');
  const [costInput, setCostInput] = useState('');
  const [quantityInput, setQuantityInput] = useState('1');
  const [isReturn, setIsReturn] = useState(false);
  const [saveAsQuickTouch, setSaveAsQuickTouch] = useState(false);
  const titleInputRef = useRef<HTMLInputElement>(null);

  // New/Edit Quick Touch Drawer State
  const [isEditingTouch, setIsEditingTouch] = useState(false);
  const [editingTouchId, setEditingTouchId] = useState<string | null>(null);
  const [touchTitle, setTouchTitle] = useState('');
  const [touchPrice, setTouchPrice] = useState('');
  const [touchCost, setTouchCost] = useState('');
  const [touchIcon, setTouchIcon] = useState('⚡');
  const [touchColor, setTouchColor] = useState(AVAILABLE_COLORS[0].value);
  const [touchError, setTouchError] = useState('');

  // Reload quick touches on modal open or storage event
  useEffect(() => {
    if (activeModal === 'custom_item') {
      setQuickTouches(getQuickTouches());
      setTitle('');
      setPriceInput('');
      setCostInput('');
      setQuantityInput('1');
      setIsReturn(false);
      setSaveAsQuickTouch(false);
      setIsEditingTouch(false);
      setEditingTouchId(null);
      setTouchError('');
      setTimeout(() => {
        titleInputRef.current?.focus();
      }, 60);
    }
  }, [activeModal]);

  useEffect(() => {
    const handleStorageChange = () => {
      setQuickTouches(getQuickTouches());
    };
    window.addEventListener('mobi:quicktouches-change', handleStorageChange);
    return () => window.removeEventListener('mobi:quicktouches-change', handleStorageChange);
  }, []);

  if (activeModal !== 'custom_item') return null;

  // 1-Click direct add to cart for quick touch items
  const handleQuickTouchClick = (item: QuickTouchItem) => {
    const serviceProduct = createServiceProductFromTouch(item);
    addToCart(serviceProduct, true, 1, false);
    soundEngine.playScan?.();
    closeModal();
  };

  // Open creation or edit form for a quick touch
  const handleOpenTouchEditor = (touch?: QuickTouchItem) => {
    if (touch) {
      setEditingTouchId(touch.id);
      setTouchTitle(touch.title);
      setTouchPrice(touch.price.toString());
      setTouchCost((touch.costPrice || 0).toString());
      setTouchIcon(touch.icon || '⚡');
      setTouchColor(touch.color || AVAILABLE_COLORS[0].value);
    } else {
      setEditingTouchId(null);
      setTouchTitle('');
      setTouchPrice('');
      setTouchCost('0');
      setTouchIcon('⚡');
      setTouchColor(AVAILABLE_COLORS[0].value);
    }
    setTouchError('');
    setIsEditingTouch(true);
  };

  const handleSaveTouch = () => {
    const trimmed = touchTitle.trim();
    // Localized parsing: parseFloat("12,50") silently yields 12 (FR decimals).
    const price = parseLocalizedAmount(touchPrice);
    const cost = parseLocalizedAmount(touchCost) || 0;

    if (!trimmed) {
      setTouchError('Veuillez entrer un titre pour la touche rapide.');
      return;
    }
    if (isNaN(price) || price < 0) {
      setTouchError('Veuillez entrer un tarif valide en DA.');
      return;
    }

    // Collision-safe id (same-ms double clicks used to overwrite each other
    // via the upsert persistence layer).
    const id = editingTouchId || newId('qt');
    const newTouch: QuickTouchItem = {
      id,
      title: trimmed,
      price: Math.round(price),
      costPrice: Math.round(cost),
      category: 'Services',
      icon: touchIcon,
      color: touchColor,
    };

    const updated = saveQuickTouch(newTouch);
    setQuickTouches(updated);
    setIsEditingTouch(false);
    soundEngine.playSuccess?.();
  };

  const handleDeleteTouch = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirm('Voulez-vous vraiment supprimer cette touche rapide ?')) {
      const updated = deleteQuickTouch(id);
      setQuickTouches(updated);
      soundEngine.playKeyBeep?.();
    }
  };

  const handleResetDefaults = () => {
    if (confirm('Restaurer la liste par défaut des touches rapides ?')) {
      const reset = resetQuickTouches();
      setQuickTouches(reset);
      soundEngine.playKeyBeep?.();
    }
  };

  // Adding freeform ad-hoc item/service
  const handleAddCustomItem = () => {
    const trimmedTitle = title.trim();
    // Localized parsing: parseFloat("12,50") silently yields 12 (FR decimals).
    const price = parseLocalizedAmount(priceInput);
    const cost = parseLocalizedAmount(costInput) || 0;
    const qty = parseInt(quantityInput, 10) || 1;

    if (!trimmedTitle) {
      alert('Veuillez saisir un nom ou une description pour l\'article.');
      return;
    }
    if (isNaN(price) || price <= 0) {
      alert('Veuillez saisir un prix de vente valide.');
      return;
    }

    // Collision-safe identity: product id via newId (monotonic + entropy);
    // SKU keeps its short printable MISC-NNNN shape with a crypto-random
    // suffix (same pattern as generateUniqueSku's fallback) so label printing
    // is unaffected while same-millisecond collisions are gone.
    const uniqueStamp =
      typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function'
        ? String(1000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000)).padStart(6, '0')
        : String(Math.floor(100000 + Math.random() * 900000));
    const customProduct: Product = {
      id: newId('prod-misc'),
      sku: `MISC-${uniqueStamp}`,
      barcode: '',
      title: trimmedTitle,
      brand: 'Autre',
      compatibleModel: 'Tous modèles',
      category: 'Services',
      price: Math.round(price),
      wholesalePrice: Math.round(price * 0.8),
      costPrice: Math.round(cost),
      stock: 999999, // Infinite stock: services/custom items never run out
      isService: true, // Non-stock service invariant
      vendorName: 'Service / Divers',
      leadTimeDays: 0,
      dailySalesVelocity: 0,
      reorderPoint: 0,
    };

    addToCart(customProduct, true, qty, isReturn);

    // Save as permanent quick touch if merchant requested
    if (saveAsQuickTouch) {
      const newTouch: QuickTouchItem = {
        id: newId('qt'),
        title: trimmedTitle,
        price: Math.round(price),
        costPrice: Math.round(cost),
        category: 'Services',
        icon: '🏷️',
        color: AVAILABLE_COLORS[4].value, // Amber default
      };
      saveQuickTouch(newTouch);
    }

    soundEngine.playScan?.();
    closeModal();
  };

  return (
    <div
      className="fixed inset-0 bg-black/85 backdrop-blur-sm z-50 flex items-center justify-center p-3 select-none animate-in fade-in"
      onClick={closeModal}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          if (isEditingTouch) {
            setIsEditingTouch(false);
          } else {
            closeModal();
          }
        }
      }}
    >
      <div
        className="bg-pos-panel border border-pos-border rounded-2xl w-full max-w-2xl overflow-hidden shadow-2xl animate-in zoom-in-95 flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div className="p-4 border-b border-pos-border flex items-center justify-between bg-pos-card">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-amber-500/25 to-yellow-500/10 border border-amber-500/30 text-amber-400 flex items-center justify-center font-black shadow-xs">
              <Zap className="w-5 h-5 fill-amber-400 text-amber-400" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-black text-pos-text">Touches Rapides & Article Divers</h2>
                <span className="text-[10px] bg-amber-500/20 text-amber-400 border border-amber-500/30 px-1.5 py-0.5 rounded font-mono font-bold">
                  F9
                </span>
                <span className="text-[10px] bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 px-1.5 py-0.5 rounded font-bold">
                  Stock Illimité
                </span>
              </div>
              <p className="text-[11px] text-pos-muted mt-0.5">
                Prestations sans code-barres, services et articles hors catalogue en 1 clic
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={closeModal}
            className="p-1.5 hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-lg transition cursor-pointer"
            title="Fermer (Échap)"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Navigation Tabs */}
        <div className="flex items-center justify-between px-4 pt-3 pb-2 border-b border-pos-border/50 bg-pos-panel/60">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setActiveTab('quick');
                setIsEditingTouch(false);
              }}
              className={`px-3 py-1.5 rounded-xl text-xs font-bold transition cursor-pointer flex items-center gap-1.5 ${
                activeTab === 'quick'
                  ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40 shadow-xs'
                  : 'text-pos-muted hover:text-pos-text hover:bg-pos-hover'
              }`}
            >
              <Zap className="w-3.5 h-3.5 fill-current" />
              <span>Touches Rapides 1-Clic ({quickTouches.length})</span>
            </button>

            <button
              type="button"
              onClick={() => {
                setActiveTab('custom');
                setIsEditingTouch(false);
                setTimeout(() => titleInputRef.current?.focus(), 60);
              }}
              className={`px-3 py-1.5 rounded-xl text-xs font-bold transition cursor-pointer flex items-center gap-1.5 ${
                activeTab === 'custom'
                  ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 shadow-xs'
                  : 'text-pos-muted hover:text-pos-text hover:bg-pos-hover'
              }`}
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Saisie Libre Hors Catalogue</span>
            </button>
          </div>

          {activeTab === 'quick' && !isEditingTouch && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleResetDefaults}
                className="text-[10px] text-pos-muted hover:text-pos-text flex items-center gap-1 transition cursor-pointer"
                title="Restaurer les touches par défaut"
              >
                <RefreshCw className="w-3 h-3" />
                <span className="hidden sm:inline">Défauts</span>
              </button>

              <button
                type="button"
                onClick={() => handleOpenTouchEditor()}
                className="px-2.5 py-1 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/40 text-emerald-300 text-xs font-black flex items-center gap-1 transition cursor-pointer active:scale-95"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>+ Ajouter une Touche</span>
              </button>
            </div>
          )}
        </div>

        {/* Modal Main Scrollable Content */}
        <div className="p-4 space-y-4 overflow-y-auto flex-1">
          {/* TAB 1: QUICK TOUCHES MATRIX */}
          {activeTab === 'quick' && (
            <div>
              {isEditingTouch ? (
                /* Edit / Add Touch Inline Form */
                <div className="bg-pos-card border border-pos-border rounded-2xl p-4 space-y-3.5 animate-in fade-in">
                  <div className="flex items-center justify-between border-b border-pos-border/60 pb-2">
                    <span className="text-xs font-black text-pos-text flex items-center gap-1.5">
                      <Sparkles className="w-4 h-4 text-amber-400" />
                      {editingTouchId ? 'Modifier la Touche Rapide' : 'Créer une Nouvelle Touche Rapide'}
                    </span>
                    <button
                      type="button"
                      onClick={() => setIsEditingTouch(false)}
                      className="text-xs text-pos-muted hover:text-pos-text cursor-pointer"
                    >
                      Annuler
                    </button>
                  </div>

                  {touchError && (
                    <div className="p-2 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-400 text-xs font-bold">
                      {touchError}
                    </div>
                  )}

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs font-bold text-pos-text block mb-1">
                        Intitulé de la Touche *
                      </label>
                      <input
                        type="text"
                        value={touchTitle}
                        onChange={(e) => setTouchTitle(e.target.value)}
                        placeholder="Ex: Pose Film Arrière, Déblocage..."
                        className="w-full bg-pos-bg border border-pos-border rounded-xl px-3 py-2 text-xs font-bold text-pos-text focus:outline-none focus:border-amber-400"
                      />
                    </div>

                    <div>
                      <label className="text-xs font-bold text-pos-text block mb-1">
                        Tarif de Vente (DA) *
                      </label>
                      <input
                        type="number"
                        min="0"
                        step="any"
                        value={touchPrice}
                        onChange={(e) => setTouchPrice(e.target.value)}
                        placeholder="Ex: 1200"
                        className="w-full bg-pos-bg border border-pos-border rounded-xl px-3 py-2 text-xs font-mono font-black text-emerald-400 focus:outline-none focus:border-emerald-400"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs font-bold text-pos-muted block mb-1">
                        Coût Fournisseur (DA) optionnel
                      </label>
                      <input
                        type="number"
                        min="0"
                        step="any"
                        value={touchCost}
                        onChange={(e) => setTouchCost(e.target.value)}
                        placeholder="Ex: 300"
                        className="w-full bg-pos-bg border border-pos-border rounded-xl px-3 py-2 text-xs font-mono font-bold text-pos-muted focus:outline-none focus:border-pos-border"
                      />
                    </div>

                    <div>
                      <label className="text-xs font-bold text-pos-text block mb-1">
                        Icône
                      </label>
                      <div className="flex items-center gap-1.5 flex-wrap">
                        {AVAILABLE_ICONS.map((ic) => (
                          <button
                            key={ic}
                            type="button"
                            onClick={() => setTouchIcon(ic)}
                            className={`w-7 h-7 rounded-lg text-sm flex items-center justify-center border transition cursor-pointer ${
                              touchIcon === ic
                                ? 'bg-amber-500/20 border-amber-400 scale-110 shadow-xs'
                                : 'bg-pos-bg border-pos-border hover:bg-pos-hover'
                            }`}
                          >
                            {ic}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* Color Selector */}
                  <div>
                    <label className="text-xs font-bold text-pos-text block mb-1">
                      Thème Couleur
                    </label>
                    <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
                      {AVAILABLE_COLORS.map((c) => (
                        <button
                          key={c.label}
                          type="button"
                          onClick={() => setTouchColor(c.value)}
                          className={`p-2 rounded-xl border text-[11px] font-bold transition cursor-pointer text-center bg-gradient-to-br ${c.value} ${
                            touchColor === c.value ? 'ring-2 ring-amber-400' : ''
                          }`}
                        >
                          {c.label.split('/')[0]}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Save Button */}
                  <div className="flex justify-end gap-2 pt-2">
                    <button
                      type="button"
                      onClick={() => setIsEditingTouch(false)}
                      className="px-3 py-1.5 rounded-xl text-xs font-semibold text-pos-muted hover:text-pos-text cursor-pointer"
                    >
                      Annuler
                    </button>
                    <button
                      type="button"
                      onClick={handleSaveTouch}
                      className="px-4 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-black text-xs flex items-center gap-1.5 transition cursor-pointer shadow-md shadow-amber-500/20 active:scale-95"
                    >
                      <Check className="w-4 h-4" />
                      <span>{editingTouchId ? 'Enregistrer les Modifications' : 'Créer la Touche'}</span>
                    </button>
                  </div>
                </div>
              ) : (
                /* Touches Grid */
                <div className="space-y-3">
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2.5">
                    {quickTouches.map((touch) => (
                      <div
                        key={touch.id}
                        onClick={() => handleQuickTouchClick(touch)}
                        role="button"
                        tabIndex={0}
                        className={`group relative p-3 rounded-2xl bg-gradient-to-br ${touch.color} border hover:scale-[1.02] active:scale-95 transition-all text-left flex flex-col justify-between shadow-sm cursor-pointer min-h-[78px] overflow-hidden`}
                      >
                        <div className="flex items-center justify-between w-full">
                          <span className="text-xl">{touch.icon}</span>
                          <span className="text-[11px] font-mono font-black px-1.5 py-0.5 rounded-md bg-slate-950/60 text-white shadow-xs">
                            {formatDZD(touch.price)}
                          </span>
                        </div>

                        <div className="mt-2">
                          <span className="text-xs font-black leading-tight text-pos-text group-hover:text-white line-clamp-2">
                            {touch.title}
                          </span>
                        </div>

                        {/* Quick edit / delete actions on hover */}
                        <div className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 transition flex items-center gap-1 bg-slate-950/80 p-0.5 rounded-lg">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleOpenTouchEditor(touch);
                            }}
                            className="p-1 rounded text-cyan-300 hover:text-white hover:bg-white/20 transition cursor-pointer"
                            title="Modifier cette touche"
                          >
                            <Edit3 className="w-3 h-3" />
                          </button>
                          <button
                            type="button"
                            onClick={(e) => handleDeleteTouch(touch.id, e)}
                            className="p-1 rounded text-rose-400 hover:text-white hover:bg-rose-600 transition cursor-pointer"
                            title="Supprimer cette touche"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                      </div>
                    ))}

                    {/* Add Tile Button */}
                    <button
                      type="button"
                      onClick={() => handleOpenTouchEditor()}
                      className="p-3 rounded-2xl border-2 border-dashed border-pos-border hover:border-emerald-500/50 hover:bg-emerald-500/5 transition-all flex flex-col items-center justify-center gap-1.5 text-pos-muted hover:text-emerald-400 cursor-pointer min-h-[78px]"
                    >
                      <Plus className="w-5 h-5" />
                      <span className="text-[11px] font-bold">Nouvelle Touche</span>
                    </button>
                  </div>

                  <p className="text-[11px] text-pos-muted italic text-center pt-2">
                    💡 Cliquez sur n'importe quelle touche pour l'ajouter instantanément au panier sans rupture de stock.
                  </p>
                </div>
              )}
            </div>
          )}

          {/* TAB 2: FREE-FORM AD-HOC ITEM */}
          {activeTab === 'custom' && (
            <div
              className="space-y-4"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleAddCustomItem();
                }
              }}
            >
              <div>
                <label className="text-xs font-bold text-pos-text block mb-1">
                  Désignation de l'Article ou Prestation *
                </label>
                <input
                  ref={titleInputRef}
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Ex: Pose film hydrogel personnalisé, Réparation bouton, Câble spécifique..."
                  className="w-full bg-pos-card border border-pos-border rounded-xl px-3.5 py-2.5 text-sm font-bold text-pos-text focus:outline-none focus:border-cyan-500 transition"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-bold text-pos-text block mb-1">
                    Prix de Vente Net (DA) *
                  </label>
                  <input
                    type="number"
                    min="0"
                    step="any"
                    value={priceInput}
                    onChange={(e) => setPriceInput(e.target.value)}
                    placeholder="Ex: 1500"
                    className="w-full bg-pos-card border border-pos-border rounded-xl px-3.5 py-2.5 text-base font-black font-mono text-emerald-400 focus:outline-none focus:border-emerald-500 transition"
                  />
                </div>

                <div>
                  <label className="text-xs font-bold text-pos-muted block mb-1">
                    Coût d'Achat Estimé (DA)
                  </label>
                  <input
                    type="number"
                    min="0"
                    step="any"
                    value={costInput}
                    onChange={(e) => setCostInput(e.target.value)}
                    placeholder="Ex: 500 (pour calcul marge)"
                    className="w-full bg-pos-card border border-pos-border rounded-xl px-3.5 py-2.5 text-sm font-bold font-mono text-pos-muted focus:outline-none focus:border-pos-border transition"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3 items-center">
                <div>
                  <label className="text-xs font-bold text-pos-text block mb-1">
                    Quantité
                  </label>
                  <input
                    type="number"
                    min="1"
                    max="999"
                    value={quantityInput}
                    onChange={(e) => setQuantityInput(e.target.value)}
                    className="w-full bg-pos-card border border-pos-border rounded-xl px-3.5 py-2 text-sm font-black font-mono text-pos-text focus:outline-none focus:border-cyan-500 transition"
                  />
                </div>

                <div className="pt-5">
                  <button
                    type="button"
                    onClick={() => setIsReturn(!isReturn)}
                    className={`w-full py-2.5 px-3 rounded-xl border font-bold text-xs flex items-center justify-center gap-1.5 transition cursor-pointer ${
                      isReturn
                        ? 'bg-rose-500/20 border-rose-500/50 text-rose-300'
                        : 'bg-pos-card border-pos-border text-pos-muted hover:text-pos-text'
                    }`}
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    <span>{isReturn ? 'Retour / Déduction (-)' : 'Vente Normale (+)'}</span>
                  </button>
                </div>
              </div>

              {/* Checkbox: Save also as Quick Touch */}
              <div className="pt-2">
                <label className="flex items-center gap-2 cursor-pointer p-2.5 rounded-xl bg-pos-card/70 border border-pos-border hover:border-amber-500/40 transition">
                  <input
                    type="checkbox"
                    checked={saveAsQuickTouch}
                    onChange={(e) => setSaveAsQuickTouch(e.target.checked)}
                    className="w-4 h-4 rounded text-amber-500 focus:ring-amber-400 cursor-pointer"
                  />
                  <span className="text-xs font-bold text-pos-text flex items-center gap-1.5">
                    <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                    Enregistrer également comme Touche Rapide permanente pour les prochaines ventes
                  </span>
                </label>
              </div>
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="p-3.5 border-t border-pos-border flex items-center justify-between bg-pos-card">
          <button
            type="button"
            onClick={closeModal}
            className="px-4 py-2 rounded-xl text-xs font-semibold text-pos-muted hover:text-pos-text transition cursor-pointer"
          >
            Fermer
          </button>

          {activeTab === 'custom' ? (
            <button
              type="button"
              onClick={handleAddCustomItem}
              className="px-5 py-2.5 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-black text-xs flex items-center gap-1.5 shadow-lg shadow-cyan-500/20 active:scale-95 transition cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              <span>Ajouter au Panier (Entrée)</span>
            </button>
          ) : (
            <span className="text-[11px] text-pos-muted font-medium">
              💡 Touche rapide ou <kbd className="font-mono bg-pos-bg px-1 py-0.5 rounded border border-pos-border text-pos-text">Échap</kbd> pour quitter
            </span>
          )}
        </div>
      </div>
    </div>
  );
};
