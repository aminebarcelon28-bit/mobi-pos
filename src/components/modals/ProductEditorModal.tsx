import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  X,
  Sparkles,
  Check,
  Trash2,
  Zap,
  TrendingUp,
  RefreshCw,
  Barcode as BarcodeIcon,
  AlertTriangle,
  Shield,
  Printer,
  CheckCircle2,
  Package,
  Copy,
  Coins,
} from 'lucide-react';
import { usePosStore } from '../../store/usePosStore';
import { formatDZD } from '../../types/pos';
import type { BrandName, CategoryType, ProductInput } from '../../types/pos';
import {
  generateUniqueEan13Barcode,
  generateUniqueSku,
  findBarcodeDuplicate,
  findSkuDuplicate,
  renderBarcodeToCanvas,
  isValidBarcode,
} from '../../utils/barcodeGenerator';
import { useToast } from '../ui/Toast';

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
  'Chargeurs',
  'Câbles',
  'Protège-Écran',
  'Téléphones d\'Occasion (Reprise)',
];

/**
 * Intelligent Title Casing utility preserving acronyms, tech specs & brands
 */
function formatSmartTitleCase(input: string): string {
  if (!input || !input.trim()) return '';

  const EXACT_TOKENS: Record<string, string> = {
    iphone: 'iPhone',
    ipad: 'iPad',
    imac: 'iMac',
    macbook: 'MacBook',
    airpods: 'AirPods',
    applewatch: 'AppleWatch',
    magsafe: 'MagSafe',
    'usb-c': 'USB-C',
    'type-c': 'Type-C',
    'usb-a': 'USB-A',
    usb: 'USB',
    pd: 'PD',
    gan: 'GaN',
    qc: 'QC',
    '5g': '5G',
    '4g': '4G',
    lte: 'LTE',
    nfc: 'NFC',
    oled: 'OLED',
    amoled: 'AMOLED',
    lcd: 'LCD',
    led: 'LED',
    rgb: 'RGB',
    zagg: 'ZAGG',
    tpu: 'TPU',
    abs: 'ABS',
    pc: 'PC',
    pet: 'PET',
    dzd: 'DZD',
    da: 'DA',
    sav: 'SAV',
    imei: 'IMEI',
    ean: 'EAN',
    sku: 'SKU',
    '9h': '9H',
    fastcharge: 'FastCharge',
    quickcharge: 'QuickCharge',
    invisibleshield: 'InvisibleShield',
  };

  const LOWERCASE_WORDS = new Set([
    'de', 'du', 'des', 'pour', 'et', 'en', 'vers', 'sans', 'avec', 'à', 'au', 'aux',
  ]);

  const words = input.trim().split(/\s+/);

  const formatted = words.map((word, index) => {
    if (word.includes('/') || word.includes('-')) {
      const parts = word.split(/([/-])/);
      return parts
        .map((part) => {
          if (part === '/' || part === '-') return part;
          const lowerPart = part.toLowerCase();
          if (EXACT_TOKENS[lowerPart]) return EXACT_TOKENS[lowerPart];
          if (/^\d+(?:w|v|a|mah|gb|tb|mb|mm|cm|m)$/i.test(part)) {
            return part.toUpperCase();
          }
          if (part.length === 0) return '';
          return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
        })
        .join('');
    }

    const lower = word.toLowerCase();

    if (EXACT_TOKENS[lower]) {
      return EXACT_TOKENS[lower];
    }

    if (/^\d+(?:w|v|a|mah|gb|tb|mb|mm|cm|m)$/i.test(word)) {
      return word.toUpperCase();
    }

    if (index > 0 && LOWERCASE_WORDS.has(lower)) {
      return lower;
    }

    if (lower.startsWith("d'") || lower.startsWith("l'")) {
      const prefix = lower.slice(0, 2);
      const rest = word.slice(2);
      const lowerRest = rest.toLowerCase();
      const restFormatted = EXACT_TOKENS[lowerRest]
        ? EXACT_TOKENS[lowerRest]
        : rest.charAt(0).toUpperCase() + rest.slice(1).toLowerCase();
      return prefix + restFormatted;
    }

    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  });

  return formatted.join(' ');
}

export const ProductEditorModal: React.FC = () => {
  const {
    activeModal,
    closeModal,
    editingProduct,
    saveProduct,
    deleteProduct,
    products,
    openModal,
  } = usePosStore();

  const { showToast } = useToast();
  const barcodeCanvasRef = useRef<HTMLCanvasElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);

  const [formData, setFormData] = useState<ProductInput>({
    sku: '',
    barcode: '',
    title: '',
    brand: 'Apple',
    compatibleModel: '',
    category: 'Coques iPhone',
    price: 3500,
    wholesalePrice: 2400,
    costPrice: 1500,
    stock: 20,
    imageUrl: '',
    color: 'Noir Titane',
    material: 'Silicone Liquide Soft-Touch',
    isMagSafe: false,
    isSerialized: false,
    imeiNumber: '',
    vendorName: '',
    leadTimeDays: 7,
    dailySalesVelocity: 2.0,
    reorderPoint: 5,
    warrantyMonths: 0,
    shelfLocation: 'Rayon A1',
    minPrice: 2000,
    isActive: true,
  });

  const [autoPrintLabel, setAutoPrintLabel] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Generate 100% collision-free EAN-13
  const handleGenerateFreshEan13 = () => {
    const freshBarcode = generateUniqueEan13Barcode(products, '613');
    setFormData((prev) => ({ ...prev, barcode: freshBarcode }));
    showToast(`Code EAN-13 certifié généré : ${freshBarcode} (Algérie 613)`, 'info');
  };

  // Generate unique SKU
  const handleGenerateFreshSku = () => {
    const freshSku = generateUniqueSku(products, formData.category, formData.brand);
    setFormData((prev) => ({ ...prev, sku: freshSku }));
    showToast(`Référence SKU générée : ${freshSku}`, 'info');
  };

  // Dynamic Price Calculator via Markup Multipliers
  const applyMarginPreset = (multiplier: number) => {
    const cost = formData.costPrice || 0;
    if (cost <= 0) {
      showToast("Renseignez d'abord le prix d'achat coûtant pour calculer les marges.", 'info');
      return;
    }
    const retail = Math.ceil((cost * multiplier) / 50) * 50;
    const wholesaleMult = 1 + (multiplier - 1) * 0.6;
    const wholesale = Math.max(cost, Math.ceil((cost * wholesaleMult) / 50) * 50);
    const floor = Math.max(cost, Math.ceil((cost * 1.1) / 50) * 50);

    setFormData((prev) => ({
      ...prev,
      price: retail,
      wholesalePrice: wholesale,
      minPrice: floor,
    }));
    showToast(`Prix calculés automatiquement (+${Math.round((multiplier - 1) * 100)}% marge)`, 'success');
  };

  // Round prices to clean 100 DA steps
  const roundTo100DA = () => {
    setFormData((prev) => ({
      ...prev,
      price: Math.ceil(prev.price / 100) * 100,
      wholesalePrice: Math.ceil(prev.wholesalePrice / 100) * 100,
      minPrice: Math.ceil((prev.minPrice || 0) / 100) * 100,
    }));
    showToast('Prix arrondis au palier supérieur de 100 DA', 'info');
  };

  // Duplicate attributes from existing catalog item
  const handleDuplicateFromProduct = (productId: string) => {
    const source = products.find((p) => p.id === productId);
    if (!source) return;

    const freshBarcode = generateUniqueEan13Barcode(products, '613');
    const freshSku = generateUniqueSku(products, source.category, source.brand);

    setFormData({
      ...source,
      id: undefined,
      title: `${source.title} (Copie)`,
      barcode: freshBarcode,
      sku: freshSku,
      imageUrl: '',
      stock: 10,
      isActive: true,
    });

    showToast(`Fiche copiée depuis "${source.title}" (nouveaux EAN & SKU générés)`, 'success');
    titleInputRef.current?.focus();
  };

  // Global Esc key listener
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && activeModal === 'product_editor') {
        closeModal();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeModal, closeModal]);

  // Sync state on modal open
  useEffect(() => {
    if (activeModal === 'product_editor') {
      if (editingProduct) {
        setFormData({
          ...editingProduct,
          warrantyMonths: editingProduct.warrantyMonths || 0,
          shelfLocation: editingProduct.shelfLocation || 'Rayon A1',
          minPrice: editingProduct.minPrice || Math.round(editingProduct.price * 0.8),
          isActive: editingProduct.isActive !== false,
          imageUrl: '',
        });
      } else {
        const freshBarcode = generateUniqueEan13Barcode(products, '613');
        const freshSku = generateUniqueSku(products, 'Coques iPhone', 'Apple');
        setFormData({
          sku: freshSku,
          barcode: freshBarcode,
          title: '',
          brand: 'Apple',
          compatibleModel: '',
          category: 'Coques iPhone',
          price: 3500,
          wholesalePrice: 2400,
          costPrice: 1500,
          stock: 20,
          imageUrl: '',
          color: 'Noir Titane',
          material: 'Silicone Liquide Soft-Touch',
          isMagSafe: false,
          isSerialized: false,
          imeiNumber: '',
          vendorName: '',
          leadTimeDays: 7,
          dailySalesVelocity: 2.0,
          reorderPoint: 5,
          warrantyMonths: 0,
          shelfLocation: 'Rayon A1',
          minPrice: 2000,
          isActive: true,
        });
      }
      setTimeout(() => titleInputRef.current?.focus(), 80);
    }
  }, [editingProduct, activeModal, products]);

  // Live Barcode Canvas Rendering
  useEffect(() => {
    if (barcodeCanvasRef.current && formData.barcode) {
      try {
        const type = isValidBarcode(formData.barcode, 'ean13') ? 'ean13' : 'code128';
        renderBarcodeToCanvas(barcodeCanvasRef.current, formData.barcode, type, {
          width: 200,
          height: 38,
          fontSize: 9,
          showText: true,
        });
      } catch {
        // Fallback handled by generator
      }
    }
  }, [formData.barcode]);

  // Real-time Duplicate Detection
  const duplicateBarcodeProduct = useMemo(() => {
    return findBarcodeDuplicate(formData.barcode, editingProduct?.id, products);
  }, [formData.barcode, editingProduct, products]);

  const duplicateSkuProduct = useMemo(() => {
    return findSkuDuplicate(formData.sku, editingProduct?.id, products);
  }, [formData.sku, editingProduct, products]);

  // Shared validation and save routine
  const executeSave = async (options?: { keepModalOpen?: boolean }): Promise<boolean> => {
    const formattedTitle = formatSmartTitleCase(formData.title);

    if (!formattedTitle.trim()) {
      showToast('Veuillez renseigner la désignation commerciale du produit.', 'error');
      titleInputRef.current?.focus();
      return false;
    }

    if (duplicateBarcodeProduct) {
      showToast(
        `Erreur : Le code-barres "${formData.barcode}" est déjà attribué à "${duplicateBarcodeProduct.title}".`,
        'error'
      );
      return false;
    }

    if (duplicateSkuProduct) {
      showToast(
        `Erreur : La référence SKU "${formData.sku}" est déjà utilisée par "${duplicateSkuProduct.title}".`,
        'error'
      );
      return false;
    }

    if (formData.price <= 0) {
      showToast('Le prix de vente au détail doit être strictement supérieur à 0 DA.', 'error');
      return false;
    }

    if (formData.costPrice && formData.price < formData.costPrice) {
      if (
        !window.confirm(
          `⚠️ Attention : Le prix de vente (${formData.price} DA) est inférieur au prix coûtant (${formData.costPrice} DA). Confirmez-vous la vente à perte ?`
        )
      ) {
        return false;
      }
    }

    setIsSubmitting(true);
    const savePayload: ProductInput = {
      ...formData,
      title: formattedTitle,
      imageUrl: '',
    };
    const saveResult = await saveProduct(savePayload, { keepModalOpen: options?.keepModalOpen });
    setIsSubmitting(false);

    if (saveResult.success) {
      showToast(
        editingProduct
          ? `Produit "${formattedTitle}" mis à jour avec succès.`
          : `Produit "${formattedTitle}" enregistré au catalogue !`,
        'success'
      );

      if (autoPrintLabel) {
        openModal('label_printer');
      }
      return true;
    } else {
      showToast(`Erreur lors de l'enregistrement : ${saveResult.reason}`, 'error');
      return false;
    }
  };

  // Form submit (triggered by pressing Enter from ANY input or clicking primary submit)
  const handleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const success = await executeSave({ keepModalOpen: false });
    if (success) {
      closeModal();
    }
  };

  // "Enregistrer & Nouveau" button handler
  const handleSaveAndNew = async () => {
    const success = await executeSave({ keepModalOpen: true });
    if (success) {
      const freshBarcode = generateUniqueEan13Barcode(products, '613');
      const freshSku = generateUniqueSku(products, formData.category, formData.brand);
      setFormData({
        sku: freshSku,
        barcode: freshBarcode,
        title: '',
        brand: formData.brand,
        compatibleModel: '',
        category: formData.category,
        price: formData.price,
        wholesalePrice: formData.wholesalePrice,
        costPrice: formData.costPrice,
        stock: 20,
        imageUrl: '',
        color: 'Noir Titane',
        material: 'Silicone Liquide Soft-Touch',
        isMagSafe: false,
        isSerialized: false,
        imeiNumber: '',
        vendorName: formData.vendorName,
        leadTimeDays: 7,
        dailySalesVelocity: 2.0,
        reorderPoint: 5,
        warrantyMonths: 0,
        shelfLocation: formData.shelfLocation || 'Rayon A1',
        minPrice: formData.minPrice || Math.round(formData.price * 0.8),
        isActive: true,
      });
      titleInputRef.current?.focus();
    }
  };

  if (activeModal !== 'product_editor') return null;

  // Real-Time Commercial Margin Calculations
  const grossProfit = Math.max(0, formData.price - (formData.costPrice || 0));
  const profitMarginPercent =
    formData.price > 0 ? ((grossProfit / formData.price) * 100).toFixed(1) : '0';
  const wholesaleProfit = Math.max(0, formData.wholesalePrice - (formData.costPrice || 0));
  const wholesaleMarginPercent =
    formData.wholesalePrice > 0
      ? ((wholesaleProfit / formData.wholesalePrice) * 100).toFixed(1)
      : '0';

  const isLossPrice = (formData.costPrice || 0) > 0 && formData.price <= (formData.costPrice || 0);
  const isWholesaleLoss =
    (formData.costPrice || 0) > 0 && formData.wholesalePrice <= (formData.costPrice || 0);
  const isLowStock = (formData.stock || 0) <= (formData.reorderPoint || 0);

  // Stock Financial Valuation
  const totalCostInvestment = (formData.stock || 0) * (formData.costPrice || 0);
  const totalRetailValuation = (formData.stock || 0) * (formData.price || 0);
  const totalExpectedGain = Math.max(0, totalRetailValuation - totalCostInvestment);

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-3 select-none">
      <div className="bg-pos-panel border border-pos-border rounded-2xl w-full max-w-5xl shadow-2xl flex flex-col max-h-[92vh] h-[700px] overflow-hidden animate-in fade-in zoom-in-95">
        
        {/* ========================================================================= */}
        {/* 1. STICKY HEADER (Top Bar)                                               */}
        {/* ========================================================================= */}
        <div className="px-5 py-3 border-b border-pos-border flex items-center justify-between bg-pos-card shrink-0 gap-4">
          
          {/* Header Left: Title + Enterprise V2 Badge + Actif/Inactif Toggle */}
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center text-slate-950 font-bold shadow-md shadow-emerald-500/20 shrink-0">
              <Sparkles className="w-4 h-4 stroke-[2.5]" />
            </div>
            <div className="flex items-center gap-2.5 flex-wrap">
              <h2 className="text-sm font-black text-pos-text tracking-wide whitespace-nowrap">
                {editingProduct ? 'MODIFICATION FICHE PRODUIT' : 'CRÉATION FICHE PRODUIT'}
              </h2>
              <span className="text-[10px] bg-emerald-500/10 text-emerald-400 font-black px-2 py-0.5 rounded border border-emerald-500/30 uppercase tracking-wider shrink-0">
                ENTERPRISE V2
              </span>
              
              {/* Actif / Inactif Toggle Switch */}
              <button
                type="button"
                onClick={() => setFormData((prev) => ({ ...prev, isActive: prev.isActive === false }))}
                className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-pos-bg border border-pos-border hover:border-emerald-500/40 transition cursor-pointer shrink-0"
                title="Statut d'activation du produit dans le catalogue"
              >
                <div
                  className={`w-6 h-3.5 rounded-full transition-colors relative flex items-center ${
                    formData.isActive !== false ? 'bg-emerald-500' : 'bg-slate-700'
                  }`}
                >
                  <div
                    className={`w-2.5 h-2.5 rounded-full bg-white transition-transform absolute ${
                      formData.isActive !== false ? 'left-3' : 'left-0.5'
                    }`}
                  />
                </div>
                <span
                  className={`text-[11px] font-bold ${
                    formData.isActive !== false ? 'text-emerald-400' : 'text-slate-400'
                  }`}
                >
                  {formData.isActive !== false ? 'Actif' : 'Inactif'}
                </span>
              </button>
            </div>
          </div>

          {/* Header Right: Dupliquer un Article Existant + Close Button */}
          <div className="flex items-center gap-2.5 shrink-0">
            {!editingProduct && products.length > 0 && (
              <div className="relative">
                <select
                  defaultValue=""
                  onChange={(e) => {
                    if (e.target.value) {
                      handleDuplicateFromProduct(e.target.value);
                      e.target.value = '';
                    }
                  }}
                  className="h-8 bg-pos-bg border border-pos-border hover:border-emerald-500/40 text-pos-text text-xs rounded-lg px-2.5 pr-7 font-semibold focus:border-emerald-400 focus:outline-none cursor-pointer appearance-none transition"
                >
                  <option value="" disabled>
                    📋 Dupliquer depuis le catalogue...
                  </option>
                  {products.slice(0, 30).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.title} ({p.brand})
                    </option>
                  ))}
                </select>
                <div className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-pos-muted text-[10px]">
                  <Copy className="w-3 h-3 text-emerald-400" />
                </div>
              </div>
            )}

            <button
              type="button"
              onClick={closeModal}
              className="p-1.5 hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-lg transition cursor-pointer"
              title="Fermer (Échap)"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

        </div>

        {/* ========================================================================= */}
        {/* FORM CONTAINER (Supports Enter key from any field)                       */}
        {/* ========================================================================= */}
        <form onSubmit={handleFormSubmit} className="flex flex-col flex-1 min-h-0 bg-pos-bg">
          
          {/* ======================================================================= */}
          {/* MAIN 2-COLUMN BODY (Zero Scroll Guaranteed on 1080p/768p)               */}
          {/* ======================================================================= */}
          <div className="flex-1 min-h-0 overflow-y-auto lg:overflow-y-hidden p-4 sm:p-5 flex flex-col lg:flex-row gap-5">
            
            {/* --------------------------------------------------------------------- */}
            {/* 2. LEFT COLUMN (50% Width) — Identification & Attributes              */}
            {/* --------------------------------------------------------------------- */}
            <div className="w-full lg:w-1/2 flex flex-col justify-between gap-3 shrink-0">
              
              {/* Conflict Warnings (Compact inline banners) */}
              {duplicateBarcodeProduct && (
                <div className="p-2 bg-red-500/10 border border-red-500/40 rounded-xl flex items-center justify-between gap-2 text-red-400 text-xs animate-in fade-in">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                    <span className="truncate">
                      Code <strong className="font-mono">{formData.barcode}</strong> déjà attribué à "{duplicateBarcodeProduct.title}"
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={handleGenerateFreshEan13}
                    className="px-2 py-0.5 bg-red-500 text-slate-950 font-black text-[10px] rounded hover:bg-red-400 shrink-0 cursor-pointer"
                  >
                    Nouveau Code
                  </button>
                </div>
              )}

              {duplicateSkuProduct && (
                <div className="p-2 bg-amber-500/10 border border-amber-500/40 rounded-xl flex items-center justify-between gap-2 text-amber-400 text-xs animate-in fade-in">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                    <span className="truncate">
                      SKU <strong className="font-mono">{formData.sku}</strong> déjà utilisé par "{duplicateSkuProduct.title}"
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={handleGenerateFreshSku}
                    className="px-2 py-0.5 bg-amber-500 text-slate-950 font-black text-[10px] rounded hover:bg-amber-400 shrink-0 cursor-pointer"
                  >
                    Nouveau SKU
                  </button>
                </div>
              )}

              {/* Product Title Input (Clean Full-Width Input) */}
              <div className="space-y-1">
                <label className="text-[11px] font-bold text-pos-text flex items-center gap-1">
                  Désignation Commerciale du Produit <span className="text-emerald-400 font-bold">*</span>
                </label>
                <input
                  ref={titleInputRef}
                  type="text"
                  required
                  value={formData.title}
                  onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                  onBlur={(e) => {
                    const formatted = formatSmartTitleCase(e.target.value);
                    if (formatted !== formData.title) {
                      setFormData((prev) => ({ ...prev, title: formatted }));
                    }
                  }}
                  placeholder="ex: Coque Silicone MagSafe iPhone 15 Pro Max - Noir Titane"
                  className="w-full h-9 bg-pos-card border border-pos-border rounded-lg px-3 text-xs font-bold text-pos-text focus:border-emerald-400 focus:outline-none transition shadow-sm"
                />
              </div>

              {/* Row 1 (3-column grid): Marque, Catégorie, Modèle */}
              <div className="grid grid-cols-3 gap-2.5">
                <div>
                  <label className="text-[10px] font-bold text-pos-muted block mb-1">
                    Marque / Fabricant
                  </label>
                  <select
                    value={formData.brand}
                    onChange={(e) => setFormData({ ...formData, brand: e.target.value as BrandName })}
                    className="w-full h-9 bg-pos-card border border-pos-border rounded-lg px-2 text-xs font-semibold text-pos-text focus:border-emerald-400 focus:outline-none cursor-pointer transition"
                  >
                    {BRANDS.map((b) => (
                      <option key={b} value={b}>
                        {b}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="text-[10px] font-bold text-pos-muted block mb-1">
                    Catégorie Article
                  </label>
                  <select
                    value={formData.category}
                    onChange={(e) =>
                      setFormData({ ...formData, category: e.target.value as CategoryType })
                    }
                    className="w-full h-9 bg-pos-card border border-pos-border rounded-lg px-2 text-xs font-semibold text-pos-text focus:border-emerald-400 focus:outline-none cursor-pointer transition"
                  >
                    {CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="text-[10px] font-bold text-pos-muted block mb-1">
                    Modèle Compatible
                  </label>
                  <input
                    type="text"
                    value={formData.compatibleModel}
                    onChange={(e) => setFormData({ ...formData, compatibleModel: e.target.value })}
                    placeholder="ex: iPhone 15 Pro Max"
                    className="w-full h-9 bg-pos-card border border-pos-border rounded-lg px-2.5 text-xs font-semibold text-pos-text focus:border-emerald-400 focus:outline-none transition"
                  />
                </div>
              </div>

              {/* Row 2 (2-column grid): Fournisseur, SKU avec bouton Auto */}
              <div className="grid grid-cols-2 gap-2.5">
                <div>
                  <label className="text-[10px] font-bold text-pos-muted block mb-1">
                    Fournisseur / Grossiste
                  </label>
                  <input
                    type="text"
                    value={formData.vendorName}
                    onChange={(e) => setFormData({ ...formData, vendorName: e.target.value })}
                    placeholder="ex: Distributeur Officiel Apple Algérie"
                    className="w-full h-9 bg-pos-card border border-pos-border rounded-lg px-2.5 text-xs font-semibold text-pos-text focus:border-emerald-400 focus:outline-none transition"
                  />
                </div>

                <div>
                  <label className="text-[10px] font-bold text-pos-muted block mb-1">
                    Référence SKU Interne
                  </label>
                  <div className="relative flex items-center">
                    <input
                      type="text"
                      value={formData.sku}
                      onChange={(e) => setFormData({ ...formData, sku: e.target.value })}
                      placeholder="ex: COQ-APP-5735"
                      className={`w-full h-9 bg-pos-card border rounded-lg pl-2.5 pr-14 text-xs font-mono font-bold text-pos-text focus:outline-none transition ${
                        duplicateSkuProduct
                          ? 'border-amber-500 focus:border-amber-400'
                          : 'border-pos-border focus:border-emerald-400'
                      }`}
                    />
                    <button
                      type="button"
                      onClick={handleGenerateFreshSku}
                      className="absolute right-1 top-1 bottom-1 px-2 rounded bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 text-[10px] font-bold transition cursor-pointer"
                      title="Générer un SKU unique"
                    >
                      Auto
                    </button>
                  </div>
                </div>
              </div>

              {/* Row 3 — Unified Barcode Card */}
              <div className="p-3 bg-pos-card/60 border border-pos-border rounded-xl space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-black text-pos-muted uppercase tracking-wider flex items-center gap-1.5">
                    <BarcodeIcon className="w-3.5 h-3.5 text-emerald-400" />
                    Code-Barres EAN-13 Certifié
                  </span>
                  {isValidBarcode(formData.barcode, 'ean13') && !duplicateBarcodeProduct && (
                    <span className="text-[10px] text-emerald-400 font-bold flex items-center gap-1">
                      <CheckCircle2 className="w-3 h-3" /> Conforme GS1
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-2.5">
                  {/* Inline Barcode Input */}
                  <input
                    type="text"
                    value={formData.barcode}
                    onChange={(e) => setFormData({ ...formData, barcode: e.target.value })}
                    placeholder="ex: 6138318449885"
                    className={`flex-1 h-9 bg-pos-bg border rounded-lg px-2.5 text-xs font-mono font-bold focus:outline-none transition ${
                      duplicateBarcodeProduct
                        ? 'border-red-500 text-red-400 focus:border-red-400'
                        : 'border-pos-border text-emerald-400 focus:border-emerald-400'
                    }`}
                  />

                  {/* Générer EAN-13 Button */}
                  <button
                    type="button"
                    onClick={handleGenerateFreshEan13}
                    className="h-9 px-3 rounded-lg bg-emerald-500/10 hover:bg-emerald-500 text-emerald-400 hover:text-slate-950 border border-emerald-500/30 text-xs font-bold flex items-center gap-1.5 shrink-0 transition cursor-pointer"
                  >
                    <RefreshCw className="w-3 h-3" />
                    Générer EAN-13
                  </button>

                  {/* Compact Live Barcode Canvas Preview */}
                  <div className="h-9 w-32 bg-white rounded-lg border border-pos-border px-1 flex items-center justify-center shrink-0 shadow-sm overflow-hidden">
                    <canvas ref={barcodeCanvasRef} className="h-7 w-full mix-blend-multiply" />
                  </div>
                </div>
              </div>

              {/* Secondary Attribute Strip (MagSafe, IMEI, Auto-Print) */}
              <div className="flex items-center justify-between gap-3 px-2 py-1.5 bg-pos-card/30 border border-pos-border/40 rounded-lg text-xs font-bold text-pos-text">
                <label className="flex items-center gap-1.5 cursor-pointer hover:text-emerald-400 transition">
                  <input
                    type="checkbox"
                    checked={formData.isMagSafe || false}
                    onChange={(e) => setFormData({ ...formData, isMagSafe: e.target.checked })}
                    className="w-3.5 h-3.5 rounded text-emerald-500 focus:ring-emerald-400 cursor-pointer"
                  />
                  <span className="flex items-center gap-1 text-[11px]">
                    <Zap className="w-3 h-3 text-emerald-400" /> MagSafe
                  </span>
                </label>

                <label className="flex items-center gap-1.5 cursor-pointer hover:text-cyan-400 transition">
                  <input
                    type="checkbox"
                    checked={formData.isSerialized || false}
                    onChange={(e) => setFormData({ ...formData, isSerialized: e.target.checked })}
                    className="w-3.5 h-3.5 rounded text-emerald-500 focus:ring-emerald-400 cursor-pointer"
                  />
                  <span className="flex items-center gap-1 text-[11px]">
                    <Shield className="w-3 h-3 text-cyan-400" /> Sérialisé IMEI
                  </span>
                </label>

                <label className="flex items-center gap-1.5 cursor-pointer hover:text-emerald-400 transition">
                  <input
                    type="checkbox"
                    checked={autoPrintLabel}
                    onChange={(e) => setAutoPrintLabel(e.target.checked)}
                    className="w-3.5 h-3.5 rounded text-emerald-500 focus:ring-emerald-400 cursor-pointer"
                  />
                  <span className="flex items-center gap-1 text-[11px] text-emerald-400">
                    <Printer className="w-3 h-3" /> Imprimer Étiquette
                  </span>
                </label>
              </div>

            </div>

            {/* --------------------------------------------------------------------- */}
            {/* 3. RIGHT COLUMN (50% Width) — Tarification & Valorisation Stock       */}
            {/* --------------------------------------------------------------------- */}
            <div className="w-full lg:w-1/2 flex flex-col justify-between gap-3 shrink-0">
              
              {/* Top Section: Stock Initial & Financial Valuation Dashboard */}
              <div className="p-3 bg-pos-card/60 border border-pos-border rounded-xl space-y-2.5">
                <div className="grid grid-cols-2 gap-2.5">
                  <div>
                    <label className="text-[10px] font-bold text-pos-text block mb-1">
                      Stock Initial *
                    </label>
                    <input
                      type="number"
                      required
                      min="0"
                      value={formData.stock}
                      onChange={(e) =>
                        setFormData({ ...formData, stock: parseInt(e.target.value) || 0 })
                      }
                      className={`w-full h-9 bg-pos-bg border rounded-lg px-2.5 text-xs font-black text-pos-text focus:outline-none transition ${
                        isLowStock
                          ? 'border-amber-500/60 focus:border-amber-400'
                          : 'border-pos-border focus:border-emerald-400'
                      }`}
                    />
                  </div>

                  <div>
                    <label className="text-[10px] font-bold text-pos-muted block mb-1">
                      Seuil d'Alerte Minimum
                    </label>
                    <input
                      type="number"
                      min="0"
                      value={formData.reorderPoint}
                      onChange={(e) =>
                        setFormData({ ...formData, reorderPoint: parseInt(e.target.value) || 0 })
                      }
                      className="w-full h-9 bg-pos-bg border border-pos-border rounded-lg px-2.5 text-xs font-bold text-pos-muted focus:border-emerald-400 focus:outline-none transition"
                    />
                  </div>
                </div>

                {/* Valorisation Financière du Stock (High-Value Retail Dashboard) */}
                <div className="grid grid-cols-3 gap-2 pt-1 border-t border-pos-border/50">
                  <div className="bg-pos-bg px-2 py-1 rounded-lg border border-pos-border text-center">
                    <span className="text-[8px] text-pos-muted font-bold block uppercase tracking-wider">
                      Coût Total Lot
                    </span>
                    <span className="text-xs font-bold text-slate-300">
                      {formatDZD(totalCostInvestment)}
                    </span>
                  </div>

                  <div className="bg-pos-bg px-2 py-1 rounded-lg border border-pos-border text-center">
                    <span className="text-[8px] text-pos-muted font-bold block uppercase tracking-wider">
                      Vente Estimée
                    </span>
                    <span className="text-xs font-bold text-emerald-400">
                      {formatDZD(totalRetailValuation)}
                    </span>
                  </div>

                  <div className="bg-pos-bg px-2 py-1 rounded-lg border border-pos-border text-center">
                    <span className="text-[8px] text-pos-muted font-bold block uppercase tracking-wider">
                      Plus-Value Lot
                    </span>
                    <span className="text-xs font-black text-emerald-400">
                      +{formatDZD(totalExpectedGain)}
                    </span>
                  </div>
                </div>
              </div>

              {/* Pricing Grid & Automated Margin Calculator */}
              <div className="p-3 bg-pos-card/60 border border-pos-border rounded-xl space-y-2.5">
                
                {/* Header with Quick Margin Calculator Presets */}
                <div className="flex items-center justify-between flex-wrap gap-1">
                  <span className="text-[10px] font-black text-pos-muted uppercase tracking-wider flex items-center gap-1">
                    <TrendingUp className="w-3.5 h-3.5 text-emerald-400" />
                    Grille Tarifaire (DA)
                  </span>

                  {/* Smart Margin Helper Buttons */}
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => applyMarginPreset(1.3)}
                      className="px-1.5 py-0.5 rounded bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 text-[9px] font-bold transition cursor-pointer"
                      title="Calculer automatiquement avec +30% de marge"
                    >
                      +30%
                    </button>
                    <button
                      type="button"
                      onClick={() => applyMarginPreset(1.5)}
                      className="px-1.5 py-0.5 rounded bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 text-[9px] font-bold transition cursor-pointer"
                      title="Calculer automatiquement avec +50% de marge"
                    >
                      +50%
                    </button>
                    <button
                      type="button"
                      onClick={() => applyMarginPreset(2.0)}
                      className="px-1.5 py-0.5 rounded bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 text-[9px] font-bold transition cursor-pointer"
                      title="Calculer avec coefficient x2 (Coques / Verres)"
                    >
                      x2.0
                    </button>
                    <button
                      type="button"
                      onClick={roundTo100DA}
                      className="px-1.5 py-0.5 rounded bg-pos-bg hover:bg-pos-hover text-pos-muted hover:text-pos-text border border-pos-border text-[9px] font-bold transition cursor-pointer flex items-center gap-0.5"
                      title="Arrondir tous les prix aux 100 DA supérieurs"
                    >
                      <Coins className="w-2.5 h-2.5 text-amber-400" />
                      100 DA
                    </button>
                  </div>
                </div>

                {/* 2x2 Price Inputs */}
                <div className="grid grid-cols-2 gap-2.5">
                  {/* Prix Achat (Cost) */}
                  <div>
                    <label className="text-[10px] font-bold text-pos-muted block mb-1">
                      Prix Achat Cost (DA)
                    </label>
                    <input
                      type="number"
                      step="50"
                      min="0"
                      value={formData.costPrice}
                      onChange={(e) =>
                        setFormData({ ...formData, costPrice: parseFloat(e.target.value) || 0 })
                      }
                      className="w-full h-9 bg-pos-bg border border-pos-border rounded-lg px-2.5 text-xs font-bold text-pos-text focus:border-emerald-400 focus:outline-none transition"
                    />
                  </div>

                  {/* Prix Vente Détail */}
                  <div>
                    <label className="text-[10px] font-bold text-emerald-400 block mb-1">
                      Prix Vente Détail (DA) *
                    </label>
                    <input
                      type="number"
                      step="50"
                      required
                      min="0"
                      value={formData.price}
                      onChange={(e) =>
                        setFormData({ ...formData, price: parseFloat(e.target.value) || 0 })
                      }
                      className={`w-full h-9 bg-pos-bg border rounded-lg px-2.5 text-xs font-black text-emerald-400 focus:outline-none transition ${
                        isLossPrice ? 'border-red-500' : 'border-pos-border focus:border-emerald-400'
                      }`}
                    />
                  </div>

                  {/* Prix Vente Gros */}
                  <div>
                    <label className="text-[10px] font-bold text-amber-400 block mb-1">
                      Prix Vente Gros (DA) *
                    </label>
                    <input
                      type="number"
                      step="50"
                      required
                      min="0"
                      value={formData.wholesalePrice}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          wholesalePrice: parseFloat(e.target.value) || 0,
                        })
                      }
                      className={`w-full h-9 bg-pos-bg border rounded-lg px-2.5 text-xs font-black text-amber-400 focus:outline-none transition ${
                        isWholesaleLoss
                          ? 'border-red-500'
                          : 'border-pos-border focus:border-amber-400'
                      }`}
                    />
                  </div>

                  {/* Prix Plancher Min */}
                  <div>
                    <label className="text-[10px] font-bold text-pos-muted block mb-1">
                      Prix Plancher Min (DA)
                    </label>
                    <input
                      type="number"
                      step="50"
                      min="0"
                      value={formData.minPrice || 0}
                      onChange={(e) =>
                        setFormData({ ...formData, minPrice: parseFloat(e.target.value) || 0 })
                      }
                      className="w-full h-9 bg-pos-bg border border-pos-border rounded-lg px-2.5 text-xs font-bold text-pos-muted focus:border-emerald-400 focus:outline-none transition"
                    />
                  </div>
                </div>

                {/* Real-Time Margin Badges */}
                <div className="grid grid-cols-3 gap-2 pt-1">
                  <div className="bg-pos-bg px-2 py-1 rounded-lg border border-pos-border flex flex-col items-center justify-center text-center">
                    <span className="text-[9px] text-pos-muted font-bold">Bénéfice Détail</span>
                    <span
                      className={`font-black text-xs truncate ${
                        isLossPrice ? 'text-red-400' : 'text-emerald-400'
                      }`}
                    >
                      {isLossPrice ? 'Perte !' : `+${formatDZD(grossProfit)}`}
                    </span>
                  </div>

                  <div className="bg-pos-bg px-2 py-1 rounded-lg border border-pos-border flex flex-col items-center justify-center text-center">
                    <span className="text-[9px] text-pos-muted font-bold">Marge Détail</span>
                    <span
                      className={`font-black text-xs ${
                        isLossPrice ? 'text-red-400' : 'text-emerald-400'
                      }`}
                    >
                      {profitMarginPercent}%
                    </span>
                  </div>

                  <div className="bg-pos-bg px-2 py-1 rounded-lg border border-pos-border flex flex-col items-center justify-center text-center">
                    <span className="text-[9px] text-pos-muted font-bold">Marge Gros</span>
                    <span
                      className={`font-black text-xs ${
                        isWholesaleLoss ? 'text-red-400' : 'text-amber-400'
                      }`}
                    >
                      {wholesaleMarginPercent}%
                    </span>
                  </div>
                </div>

              </div>

              {/* Additional Logistics / Rayon Row */}
              <div className="grid grid-cols-2 gap-2.5">
                <div>
                  <label className="text-[10px] font-bold text-pos-muted block mb-1">
                    Emplacement Rayon
                  </label>
                  <input
                    type="text"
                    value={formData.shelfLocation || 'Rayon A1'}
                    onChange={(e) => setFormData({ ...formData, shelfLocation: e.target.value })}
                    placeholder="ex: Rayon A2 - Vitrine 1"
                    className="w-full h-9 bg-pos-card border border-pos-border rounded-lg px-2.5 text-xs font-semibold text-pos-text focus:border-emerald-400 focus:outline-none transition"
                  />
                </div>

                <div>
                  <label className="text-[10px] font-bold text-pos-muted block mb-1">
                    Garantie Magasin
                  </label>
                  <select
                    value={formData.warrantyMonths || 0}
                    onChange={(e) =>
                      setFormData({ ...formData, warrantyMonths: parseInt(e.target.value) || 0 })
                    }
                    className="w-full h-9 bg-pos-card border border-pos-border rounded-lg px-2.5 text-xs font-semibold text-pos-text focus:border-emerald-400 focus:outline-none cursor-pointer transition"
                  >
                    <option value={0}>Sans Garantie</option>
                    <option value={1}>1 Mois Garantie SAV</option>
                    <option value={3}>3 Mois Garantie SAV</option>
                    <option value={6}>6 Mois Garantie SAV</option>
                    <option value={12}>1 An Garantie Constructeur</option>
                    <option value={24}>2 Ans Garantie Officielle</option>
                  </select>
                </div>
              </div>

            </div>

          </div>

          {/* ======================================================================= */}
          {/* 4. PINNED ACTION FOOTER (Bottom Bar)                                    */}
          {/* ======================================================================= */}
          <div className="px-5 py-3 border-t border-pos-border bg-pos-card flex items-center justify-between shrink-0 gap-3">
            
            {/* Footer Left: Keyboard Shortcut Hints */}
            <div className="flex items-center gap-3 text-[11px] text-pos-muted font-medium">
              <span className="inline-flex items-center gap-1">
                <kbd className="px-1.5 py-0.5 rounded bg-pos-bg border border-pos-border font-mono text-[10px] font-bold text-pos-text shadow-xs">
                  Échap
                </kbd>
                <span>Annuler</span>
              </span>
              <span className="inline-flex items-center gap-1">
                <kbd className="px-1.5 py-0.5 rounded bg-pos-bg border border-pos-border font-mono text-[10px] font-bold text-pos-text shadow-xs">
                  ↵ Entrée
                </kbd>
                <span>Enregistrer</span>
              </span>
            </div>

            {/* Footer Right: Action Buttons */}
            <div className="flex items-center gap-2">
              {editingProduct && (
                <button
                  type="button"
                  onClick={() => {
                    if (
                      confirm(
                        `Voulez-vous vraiment supprimer le produit "${editingProduct.title}" du catalogue ?`
                      )
                    ) {
                      deleteProduct(editingProduct.id);
                      showToast(`Produit "${editingProduct.title}" supprimé du catalogue.`, 'info');
                      closeModal();
                    }
                  }}
                  className="h-9 px-3 rounded-lg bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 text-xs font-bold flex items-center gap-1.5 transition border border-rose-500/30 cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Supprimer
                </button>
              )}

              {/* Annuler */}
              <button
                type="button"
                onClick={closeModal}
                className="h-9 px-4 rounded-lg text-xs font-bold text-pos-muted hover:text-pos-text hover:bg-pos-hover transition cursor-pointer"
              >
                Annuler
              </button>

              {/* Enregistrer & Nouveau */}
              {!editingProduct && (
                <button
                  type="button"
                  disabled={
                    isSubmitting ||
                    Boolean(duplicateBarcodeProduct) ||
                    Boolean(duplicateSkuProduct)
                  }
                  onClick={handleSaveAndNew}
                  className="h-9 px-4 rounded-lg bg-pos-card hover:bg-pos-hover text-pos-text border border-pos-border hover:border-emerald-500/50 text-xs font-bold flex items-center gap-1.5 transition cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Package className="w-3.5 h-3.5 text-emerald-400" />
                  Enregistrer & Nouveau
                </button>
              )}

              {/* Enregistrer le Produit (Primary Submit button, triggers on Enter) */}
              <button
                type="submit"
                disabled={
                  isSubmitting ||
                  Boolean(duplicateBarcodeProduct) ||
                  Boolean(duplicateSkuProduct)
                }
                className={`h-9 px-5 rounded-lg text-slate-950 font-black text-xs shadow-md flex items-center gap-1.5 transition cursor-pointer focus:ring-2 focus:ring-emerald-400 focus:outline-none ${
                  duplicateBarcodeProduct || duplicateSkuProduct
                    ? 'bg-gray-600 text-gray-400 cursor-not-allowed'
                    : 'bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-400 hover:to-teal-400 shadow-emerald-500/20'
                }`}
              >
                <Check className="w-4 h-4 stroke-[3]" />
                {isSubmitting
                  ? 'Enregistrement...'
                  : editingProduct
                  ? 'Mettre à Jour la Fiche'
                  : 'Enregistrer le Produit'}
              </button>
            </div>

          </div>

        </form>

      </div>
    </div>
  );
};
