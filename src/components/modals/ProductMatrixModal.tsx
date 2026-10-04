import React, { useState, useEffect } from 'react';
import {
  X,
  Layers,
  Sparkles,
  Check,
  Tag,
  Coins,
  ChevronLeft,
} from 'lucide-react';
import { usePosStore } from '../../store/usePosStore';
import { formatDZD } from '../../types/pos';
import type { BrandName, CategoryType, Product } from '../../types/pos';
import { generateUniqueEan13Barcode } from '../../utils/barcodeGenerator';
import { newId } from '../../utils/ids';
import { useToast } from '../ui/Toast';
import { soundEngine } from '../../utils/audioFeedback';
import { MoneyInput } from '../ui/MoneyInput';
import { toLegacyReal, dinarsToMinor } from '../../utils/money';

const BRANDS: BrandName[] = [
  'Apple',
  'Samsung',
  'Google',
  'ZAGG',
  'Belkin',
  'Anker',
  'Autre',
];

const CATEGORIES: CategoryType[] = [
  'Coques iPhone',
  'Coques Samsung',
  'Coques Google',
  'Protège-Écran',
  'Chargeurs',
  'Câbles',
  'Téléphones d\'Occasion (Reprise)',
];

const PRESET_MODELS: Record<string, string[]> = {
  Apple: [
    'iPhone 11',
    'iPhone 12',
    'iPhone 12 Pro',
    'iPhone 13',
    'iPhone 13 Pro',
    'iPhone 13 Pro Max',
    'iPhone 14',
    'iPhone 14 Plus',
    'iPhone 14 Pro',
    'iPhone 14 Pro Max',
    'iPhone 15',
    'iPhone 15 Plus',
    'iPhone 15 Pro',
    'iPhone 15 Pro Max',
    'iPhone 16',
    'iPhone 16 Pro',
    'iPhone 16 Pro Max',
  ],
  Samsung: [
    'Galaxy S23',
    'Galaxy S23 Ultra',
    'Galaxy S24',
    'Galaxy S24 Plus',
    'Galaxy S24 Ultra',
    'Galaxy A14',
    'Galaxy A15',
    'Galaxy A25',
    'Galaxy A35',
    'Galaxy A55',
  ],
  Google: [
    'Pixel 7',
    'Pixel 7 Pro',
    'Pixel 8',
    'Pixel 8 Pro',
    'Pixel 9',
    'Pixel 9 Pro',
  ],
  Autre: [
    'Redmi Note 12',
    'Redmi Note 13',
    'Redmi Note 13 Pro',
    'Universel',
  ],
};

const PRESET_COLORS = [
  { name: 'Noir Titane', bg: '#1c1c1e', border: '#3a3a3c' },
  { name: 'Transparent / Clair', bg: '#e5e5ea', border: '#8e8e93' },
  { name: 'Bleu Nuit', bg: '#162b48', border: '#2c4a75' },
  { name: 'Titane Naturel', bg: '#8e8d8a', border: '#aba8a2' },
  { name: 'Vert Alpin', bg: '#2b3d32', border: '#44604e' },
  { name: 'Rouge Vif', bg: '#d32f2f', border: '#ef5350' },
  { name: 'Rose Poudré', bg: '#f48fb1', border: '#f06292' },
  { name: 'Blanc Lunaire', bg: '#f5f5f7', border: '#d1d1d6' },
  { name: 'Violet Profond', bg: '#3e244d', border: '#603977' },
  { name: 'Doré / Or', bg: '#d4af37', border: '#e6c760' },
];

function abbreviateModel(model: string): string {
  return model
    .replace(/iPhone\s+/i, 'IP')
    .replace(/Galaxy\s+/i, 'SAM-')
    .replace(/Pixel\s+/i, 'PIX-')
    .replace(/Redmi\s+Note\s+/i, 'RN')
    .replace(/Pro\s+Max/i, 'PM')
    .replace(/Pro/i, 'P')
    .replace(/Ultra/i, 'U')
    .replace(/Plus/i, 'PL')
    .replace(/\s+/g, '')
    .toUpperCase();
}

function abbreviateColor(color: string): string {
  const c = color.toLowerCase();
  if (c.includes('noir')) return 'NOIR';
  if (c.includes('trans')) return 'TRNS';
  if (c.includes('bleu')) return 'BLEU';
  if (c.includes('titane')) return 'TITN';
  if (c.includes('vert')) return 'VERT';
  if (c.includes('rouge')) return 'ROUG';
  if (c.includes('rose')) return 'ROSE';
  if (c.includes('blanc')) return 'BLNC';
  if (c.includes('violet')) return 'VIOL';
  if (c.includes('doré') || c.includes('or')) return 'GOLD';
  return color.slice(0, 4).toUpperCase();
}

export const ProductMatrixModal: React.FC = () => {
  const { activeModal, closeModal, products, bulkSaveProducts } = usePosStore();
  const { showToast } = useToast();

  const [baseTitle, setBaseTitle] = useState('Coque Silicone Liquide MagSafe');
  const [brand, setBrand] = useState<BrandName>('Apple');
  const [category, setCategory] = useState<CategoryType>('Coques iPhone');
  const [selectedModels, setSelectedModels] = useState<string[]>([
    'iPhone 13',
    'iPhone 14',
    'iPhone 15',
    'iPhone 15 Pro',
    'iPhone 15 Pro Max',
  ]);
  const [customModelInput, setCustomModelInput] = useState('');
  const [selectedColors, setSelectedColors] = useState<string[]>([
    'Noir Titane',
    'Transparent / Clair',
    'Bleu Nuit',
  ]);
  const [customColorInput, setCustomColorInput] = useState('');

  const [price, setPrice] = useState<number>(1500);
  const [wholesalePrice, setWholesalePrice] = useState<number>(1000);
  const [costPrice, setCostPrice] = useState<number>(600);
  const [initialStock, setInitialStock] = useState<number>(10);
  const [isMagSafe, setIsMagSafe] = useState(true);
  const [vendorName, setVendorName] = useState('Grossiste Accessoires');

  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => { if (activeModal !== 'product_matrix') return; const h = (e: KeyboardEvent) => { if (e.key === 'Escape') closeModal(); }; document.addEventListener('keydown', h); return () => document.removeEventListener('keydown', h); }, [activeModal, closeModal]);

  if (activeModal !== 'product_matrix') return null;

  const availableModelsForBrand = PRESET_MODELS[brand] || PRESET_MODELS.Autre;

  const toggleModel = (model: string) => {
    setSelectedModels((prev) =>
      prev.includes(model) ? prev.filter((m) => m !== model) : [...prev, model]
    );
  };

  const toggleColor = (color: string) => {
    setSelectedColors((prev) =>
      prev.includes(color) ? prev.filter((c) => c !== color) : [...prev, color]
    );
  };

  const handleAddCustomModel = (e: React.FormEvent) => {
    e.preventDefault();
    const clean = customModelInput.trim();
    if (!clean) return;
    if (!selectedModels.includes(clean)) {
      setSelectedModels((prev) => [...prev, clean]);
    }
    setCustomModelInput('');
  };

  const handleAddCustomColor = (e: React.FormEvent) => {
    e.preventDefault();
    const clean = customColorInput.trim();
    if (!clean) return;
    if (!selectedColors.includes(clean)) {
      setSelectedColors((prev) => [...prev, clean]);
    }
    setCustomColorInput('');
  };

  const totalVariantsCount = selectedModels.length * selectedColors.length;
  const totalUnits = totalVariantsCount * initialStock;
  const totalCost = totalUnits * costPrice;
  const totalRetail = totalUnits * price;

  const handleSelectAllModels = () => {
    setSelectedModels([...availableModelsForBrand]);
  };

  const handleDeselectAllModels = () => {
    setSelectedModels([]);
  };

  const handleGenerateAndSave = async () => {
    if (!baseTitle.trim()) {
      showToast('Veuillez renseigner le nom de base du modèle.', 'error');
      return;
    }
    if (selectedModels.length === 0) {
      showToast('Veuillez sélectionner au moins un modèle de téléphone.', 'error');
      return;
    }
    if (selectedColors.length === 0) {
      showToast('Veuillez sélectionner au moins une couleur.', 'error');
      return;
    }

    setIsSubmitting(true);
    try {
      const parentId = newId('matrix');
      const generatedProducts: Product[] = [];
      const generatedBarcodesSet = new Set(
        products
          .map((p) => p.barcode?.trim())
          .filter((b): b is string => Boolean(b && b.length > 0))
      );

      let catPrefix = 'COQ';
      if (category.includes('Protège')) catPrefix = 'PRT';
      else if (category.includes('Charge')) catPrefix = 'CHG';
      else if (category.includes('Câble')) catPrefix = 'CAB';

      for (const model of selectedModels) {
        for (const color of selectedColors) {
          const mCode = abbreviateModel(model);
          const cCode = abbreviateColor(color);
          const baseSku = `${catPrefix}-${mCode}-${cCode}`;
          
          // Generate collision-free SKU
          let sku = baseSku;
          let counter = 1;
          const existingSkus = new Set(products.map((p) => p.sku.toLowerCase()));
          while (existingSkus.has(sku.toLowerCase())) {
            sku = `${baseSku}-${counter++}`;
          }

          // Generate collision-free EAN-13
          const tempProductList = Array.from(generatedBarcodesSet).map((b) => ({ barcode: b }));
          const barcode = generateUniqueEan13Barcode(tempProductList, '613');
          generatedBarcodesSet.add(barcode);

          const fullTitle = `${baseTitle} - ${model} (${color})`;

          const newProduct: Product = {
            id: newId('prod'),
            title: fullTitle,
            sku,
            barcode,
            brand,
            category,
            compatibleModel: model,
            color,
            price,
            wholesalePrice,
            costPrice,
            stock: initialStock,
            reorderPoint: 3,
            isMagSafe,
            vendorName,
            leadTimeDays: 7,
            dailySalesVelocity: 1.5,
            shelfLocation: 'Rayon Accessoires',
            isActive: true,
            parentProductId: parentId,
            variantName: `${model} / ${color}`,
            hasVariants: false,
          };

          generatedProducts.push(newProduct);
        }
      }

      await bulkSaveProducts(generatedProducts);
      soundEngine.playSuccess?.();
      showToast(
        `${generatedProducts.length} variantes générées et ajoutées au catalogue avec succès !`,
        'success'
      );
      closeModal();
    } catch (err) {
      console.error('Failed to generate variants:', err);
      soundEngine.playError?.();
      showToast('Erreur lors de la création des variantes.', 'error');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      onClick={closeModal}
      className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-0 sm:p-4 select-none cursor-pointer"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-pos-panel border-0 sm:border border-pos-border rounded-none sm:rounded-2xl w-full sm:max-w-4xl overflow-hidden shadow-2xl animate-in fade-in zoom-in-95 h-dvh-shell sm:h-[88dvh] flex flex-col cursor-default font-sans pt-[max(0.5rem,var(--safe-top))] sm:pt-0 pb-[max(0.5rem,var(--safe-bottom))] sm:pb-0"
      >
        {/* Header */}
        <div className="p-3 sm:p-4 border-b border-pos-border flex items-center justify-between bg-pos-card shrink-0">
          <div className="flex items-center gap-2 sm:gap-3 min-w-0">
            <button
              type="button"
              onClick={closeModal}
              className="sm:hidden p-1.5 rounded-lg bg-pos-panel border border-pos-border text-pos-muted hover:text-pos-text active:scale-95 transition"
              title="Retour"
            >
              <ChevronLeft className="w-5 h-5" />
            </button>
            <div className="w-8 h-8 rounded-lg bg-cyan-500/20 text-cyan-400 flex items-center justify-center shrink-0">
              <Layers className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <h2 className="text-xs sm:text-sm font-bold text-pos-text truncate">
                Générateur de Matrice & Variantes
              </h2>
              <p className="text-[10px] text-pos-muted truncate">
                Génération en masse : Modèles de téléphones × Couleurs
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={closeModal}
              className="p-1.5 hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-lg transition cursor-pointer"
              title="Fermer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Live Overview Bar */}
        <div className="p-2 sm:p-3 bg-pos-card/60 border-b border-pos-border grid grid-cols-2 sm:grid-cols-4 gap-2 shrink-0 text-center">
          <div className="bg-pos-bg border border-pos-border p-2 rounded-xl">
            <span className="text-[9px] font-bold text-pos-muted uppercase block">
              Variantes Dérivées
            </span>
            <span className="text-xs sm:text-sm font-black text-cyan-400 font-mono">
              {selectedModels.length} mod. × {selectedColors.length} coul. = {totalVariantsCount} réf.
            </span>
          </div>
          <div className="bg-pos-bg border border-pos-border p-2 rounded-xl">
            <span className="text-[9px] font-bold text-pos-muted uppercase block">
              Volume Pièces
            </span>
            <span className="text-xs sm:text-sm font-black text-amber-400 font-mono">
              {totalUnits} pièces
            </span>
          </div>
          <div className="bg-pos-bg border border-pos-border p-2 rounded-xl">
            <span className="text-[9px] font-bold text-pos-muted uppercase block">
              Investissement Coût
            </span>
            <span className="text-xs sm:text-sm font-black text-slate-300 font-mono">
              {formatDZD(totalCost)}
            </span>
          </div>
          <div className="bg-pos-bg border border-pos-border p-2 rounded-xl">
            <span className="text-[9px] font-bold text-pos-muted uppercase block">
              Valeur Vente
            </span>
            <span className="text-xs sm:text-sm font-black text-emerald-400 font-mono">
              {formatDZD(totalRetail)}
            </span>
          </div>
        </div>

        {/* Main Body (2 Columns on Desktop) */}
        <div className="flex-1 overflow-y-auto overscroll-contain p-3 sm:p-4 space-y-4 bg-pos-bg">
          {/* Base Attributes Card */}
          <div className="bg-pos-card border border-pos-border rounded-xl p-3 space-y-3">
            <span className="text-[10px] font-black text-pos-muted uppercase tracking-wider block">
              1. Base de l'Article Parent
            </span>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
              <div className="sm:col-span-2">
                <label className="text-[10px] font-bold text-pos-muted block mb-1">
                  Nom du Produit de Base *
                </label>
                <input
                  type="text"
                  value={baseTitle}
                  onChange={(e) => setBaseTitle(e.target.value)}
                  placeholder="ex: Coque Silicone Liquide MagSafe"
                  className="w-full h-9 bg-pos-bg border border-pos-border rounded-lg px-2.5 text-xs font-bold text-pos-text focus:border-cyan-400 focus:outline-none transition"
                />
              </div>

              <div>
                <label className="text-[10px] font-bold text-pos-muted block mb-1">
                  Marque
                </label>
                <select
                  value={brand}
                  onChange={(e) => {
                    const newBrand = e.target.value as BrandName;
                    setBrand(newBrand);
                    if (PRESET_MODELS[newBrand]) {
                      setSelectedModels(PRESET_MODELS[newBrand].slice(0, 5));
                    }
                  }}
                  className="w-full h-9 bg-pos-bg border border-pos-border rounded-lg px-2 text-xs font-semibold text-pos-text focus:border-cyan-400 focus:outline-none transition cursor-pointer"
                >
                  {BRANDS.map((b) => (
                    <option key={b} value={b}>{b}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              <div>
                <label className="text-[10px] font-bold text-pos-muted block mb-1">
                  Catégorie
                </label>
                <select
                  value={category}
                  onChange={(e) => setCategory(e.target.value as CategoryType)}
                  className="w-full h-9 bg-pos-bg border border-pos-border rounded-lg px-2 text-xs font-semibold text-pos-text focus:border-cyan-400 focus:outline-none transition cursor-pointer"
                >
                  {CATEGORIES.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="text-[10px] font-bold text-pos-muted block mb-1">
                  Fournisseur / Grossiste
                </label>
                <input
                  type="text"
                  value={vendorName}
                  onChange={(e) => setVendorName(e.target.value)}
                  className="w-full h-9 bg-pos-bg border border-pos-border rounded-lg px-2.5 text-xs font-semibold text-pos-text focus:border-cyan-400 focus:outline-none transition"
                />
              </div>
            </div>
          </div>

          {/* Phone Models Multi-Selector */}
          <div className="bg-pos-card border border-pos-border rounded-xl p-3 space-y-2.5">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <span className="text-[10px] font-black text-pos-muted uppercase tracking-wider flex items-center gap-1.5">
                <Tag className="w-3.5 h-3.5 text-cyan-400" />
                2. Modèles de Téléphones Compatibles ({selectedModels.length} sélectionnés)
              </span>
              <div className="flex items-center gap-1.5 text-xs">
                <button
                  type="button"
                  onClick={handleSelectAllModels}
                  className="text-[10px] text-cyan-400 hover:underline font-bold"
                >
                  Tout cocher
                </button>
                <span className="text-pos-muted">|</span>
                <button
                  type="button"
                  onClick={handleDeselectAllModels}
                  className="text-[10px] text-pos-muted hover:text-pos-text font-bold"
                >
                  Tout décocher
                </button>
              </div>
            </div>

            {/* Model chips */}
            <div className="flex flex-wrap gap-1.5 max-h-36 overflow-y-auto overscroll-contain p-1 bg-pos-bg rounded-lg border border-pos-border">
              {availableModelsForBrand.map((m) => {
                const isSelected = selectedModels.includes(m);
                return (
                  <button
                    key={m}
                    type="button"
                    onClick={() => toggleModel(m)}
                    className={`px-2 py-1 rounded-lg text-xs font-bold transition cursor-pointer flex items-center gap-1 ${
                      isSelected
                        ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500 shadow-xs'
                        : 'bg-pos-card text-pos-muted border border-pos-border hover:text-pos-text'
                    }`}
                  >
                    {isSelected && <Check className="w-3 h-3 stroke-[3]" />}
                    <span>{m}</span>
                  </button>
                );
              })}
            </div>

            {/* Custom Model Input */}
            <form onSubmit={handleAddCustomModel} className="flex gap-2">
              <input
                type="text"
                value={customModelInput}
                onChange={(e) => setCustomModelInput(e.target.value)}
                placeholder="+ Ajouter un modèle personnalisé (ex: Galaxy Z Flip 5)..."
                className="flex-1 h-8 bg-pos-bg border border-pos-border rounded-lg px-2.5 text-xs text-pos-text focus:outline-none focus:border-cyan-400"
              />
              <button
                type="submit"
                className="px-3 h-8 rounded-lg bg-pos-hover border border-pos-border text-pos-text text-xs font-bold hover:bg-pos-border transition cursor-pointer"
              >
                Ajouter
              </button>
            </form>
          </div>

          {/* Colors Multi-Selector */}
          <div className="bg-pos-card border border-pos-border rounded-xl p-3 space-y-2.5">
            <span className="text-[10px] font-black text-pos-muted uppercase tracking-wider flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5 text-purple-400" />
              3. Déclinaisons Couleurs ({selectedColors.length} sélectionnées)
            </span>

            <div className="flex flex-wrap gap-1.5 p-1 bg-pos-bg rounded-lg border border-pos-border">
              {PRESET_COLORS.map((c) => {
                const isSelected = selectedColors.includes(c.name);
                return (
                  <button
                    key={c.name}
                    type="button"
                    onClick={() => toggleColor(c.name)}
                    className={`px-2 py-1 rounded-lg text-xs font-bold transition cursor-pointer flex items-center gap-1.5 ${
                      isSelected
                        ? 'bg-purple-500/20 text-purple-200 border border-purple-500 shadow-xs'
                        : 'bg-pos-card text-pos-muted border border-pos-border hover:text-pos-text'
                    }`}
                  >
                    <span
                      className="w-2.5 h-2.5 rounded-full border shrink-0"
                      style={{ backgroundColor: c.bg, borderColor: c.border }}
                    />
                    <span>{c.name}</span>
                    {isSelected && <Check className="w-3 h-3 stroke-[3]" />}
                  </button>
                );
              })}
            </div>

            {/* Custom Color Input */}
            <form onSubmit={handleAddCustomColor} className="flex gap-2">
              <input
                type="text"
                value={customColorInput}
                onChange={(e) => setCustomColorInput(e.target.value)}
                placeholder="+ Ajouter une couleur personnalisée (ex: Camouflage, Jaune Fluo)..."
                className="flex-1 h-8 bg-pos-bg border border-pos-border rounded-lg px-2.5 text-xs text-pos-text focus:outline-none focus:border-purple-400"
              />
              <button
                type="submit"
                className="px-3 h-8 rounded-lg bg-pos-hover border border-pos-border text-pos-text text-xs font-bold hover:bg-pos-border transition cursor-pointer"
              >
                Ajouter
              </button>
            </form>
          </div>

          {/* Pricing & Stock Grid */}
          <div className="bg-pos-card border border-pos-border rounded-xl p-3 space-y-3">
            <span className="text-[10px] font-black text-pos-muted uppercase tracking-wider flex items-center gap-1.5">
              <Coins className="w-3.5 h-3.5 text-emerald-400" />
              4. Tarifs Communs & Stock Initial par Variante
            </span>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
              <div>
                <label className="text-[10px] font-bold text-pos-muted block mb-1">
                  Prix Achat Cost (DA)
                </label>
                <MoneyInput
                  label="Prix Achat Cost (DA)"
                  valueMinor={dinarsToMinor(costPrice || 0)}
                  onChangeMinor={(minor) => setCostPrice(toLegacyReal(minor))}
                  className="w-full h-9 bg-pos-bg border border-pos-border rounded-lg px-2.5 text-xs font-bold text-pos-text focus:border-cyan-400 focus:outline-none transition"
                />
              </div>

              <div>
                <label className="text-[10px] font-bold text-emerald-400 block mb-1">
                  Prix Vente Détail (DA) *
                </label>
                <MoneyInput
                  label="Prix Vente Détail (DA)"
                  valueMinor={dinarsToMinor(price || 0)}
                  onChangeMinor={(minor) => setPrice(toLegacyReal(minor))}
                  className="w-full h-9 bg-pos-bg border border-pos-border rounded-lg px-2.5 text-xs font-black text-emerald-400 focus:border-emerald-400 focus:outline-none transition"
                />
              </div>

              <div>
                <label className="text-[10px] font-bold text-amber-400 block mb-1">
                  Prix Vente Gros (DA)
                </label>
                <MoneyInput
                  label="Prix Vente Gros (DA)"
                  valueMinor={dinarsToMinor(wholesalePrice || 0)}
                  onChangeMinor={(minor) => setWholesalePrice(toLegacyReal(minor))}
                  className="w-full h-9 bg-pos-bg border border-pos-border rounded-lg px-2.5 text-xs font-black text-amber-400 focus:border-amber-400 focus:outline-none transition"
                />
              </div>

              <div>
                <label className="text-[10px] font-bold text-pos-text block mb-1">
                  Stock / Variante (un.) *
                </label>
                <input
                  type="number"
                  min="0"
                  value={initialStock}
                  onChange={(e) => setInitialStock(parseInt(e.target.value) || 0)}
                  className="w-full h-9 bg-pos-bg border border-pos-border rounded-lg px-2.5 text-xs font-black text-pos-text focus:border-cyan-400 focus:outline-none transition"
                />
              </div>
            </div>

            <div className="flex items-center gap-4 pt-1">
              <label className="flex items-center gap-2 cursor-pointer text-xs text-pos-muted hover:text-pos-text">
                <input
                  type="checkbox"
                  checked={isMagSafe}
                  onChange={(e) => setIsMagSafe(e.target.checked)}
                  className="w-4 h-4 rounded text-cyan-500 focus:ring-cyan-400 cursor-pointer"
                />
                <span>Compatible MagSafe</span>
              </label>
            </div>
          </div>
        </div>

        {/* Footer with Submit Button */}
        <div className="p-3 sm:p-4 border-t border-pos-border bg-pos-card flex items-center justify-between gap-3 shrink-0">
          <div className="text-xs text-pos-muted">
            <span className="font-bold text-pos-text">{totalVariantsCount}</span> références prêtes à être injectées dans le catalogue.
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={closeModal}
              disabled={isSubmitting}
              className="px-3 sm:px-4 py-2 rounded-xl bg-pos-hover text-pos-muted hover:text-pos-text font-bold text-xs transition cursor-pointer"
            >
              Annuler
            </button>
            <button
              type="button"
              onClick={handleGenerateAndSave}
              disabled={isSubmitting || totalVariantsCount === 0}
              className="px-4 sm:px-6 py-2 rounded-xl bg-cyan-500 hover:bg-cyan-400 disabled:opacity-50 text-slate-950 font-black text-xs flex items-center gap-2 shadow-lg shadow-cyan-500/20 active:scale-95 transition cursor-pointer"
            >
              <Layers className="w-4 h-4" />
              <span>
                {isSubmitting ? 'Génération en cours...' : `Générer les ${totalVariantsCount} Variantes`}
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
