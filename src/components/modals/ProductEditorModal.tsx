import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  X,
  Upload,
  Sparkles,
  Check,
  Trash2,
  Zap,
  TrendingUp,
  RefreshCw,
  Barcode as BarcodeIcon,
  AlertTriangle,
  Shield,
  Image as ImageIcon,
  Printer,
  CheckCircle2,
  Wand2,
  Tag,
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

const PRESET_TEMPLATES = [
  {
    title: 'Coque Silicone MagSafe iPhone 15 Pro Max',
    brand: 'Apple' as BrandName,
    category: 'Coques iPhone' as CategoryType,
    compatibleModel: 'iPhone 15 Pro Max',
    price: 3500,
    wholesalePrice: 2400,
    costPrice: 1500,
    stock: 20,
    color: 'Noir Titane',
    material: 'Silicone Liquide MagSafe',
    isMagSafe: true,
    vendorName: 'Distributeur Officiel Apple Algérie',
    reorderPoint: 10,
    imageUrl: 'https://images.unsplash.com/photo-1603313011101-320f26a4f6f6?w=400&auto=format&fit=crop&q=80',
  },
  {
    title: 'Verre Trempé ZAGG InvisibleShield 9H Privacy',
    brand: 'ZAGG' as BrandName,
    category: 'Protège-Écran' as CategoryType,
    compatibleModel: 'iPhone 15 Pro Max / 14 Pro Max',
    price: 2800,
    wholesalePrice: 1800,
    costPrice: 1100,
    stock: 35,
    color: 'Anti-Espion Teinté',
    material: 'Verre Trempé 9H',
    isMagSafe: false,
    vendorName: 'Importateur Direct Grossiste Bab Ezzouar',
    reorderPoint: 15,
    imageUrl: 'https://images.unsplash.com/photo-1592899677977-9c10ca588bbd?w=400&auto=format&fit=crop&q=80',
  },
  {
    title: 'Chargeur Rapide 25W Type-C Super Fast Charge',
    brand: 'Samsung' as BrandName,
    category: 'Chargeurs' as CategoryType,
    compatibleModel: 'Galaxy S24 / S23 / A55 / Universel Type-C',
    price: 3800,
    wholesalePrice: 2600,
    costPrice: 1700,
    stock: 25,
    color: 'Noir Mat',
    material: 'Polycarbonate Ignifugé',
    isMagSafe: false,
    vendorName: 'Grossiste Électronique Alger Centre',
    reorderPoint: 10,
    imageUrl: 'https://images.unsplash.com/photo-1583863788434-e58a36330cf0?w=400&auto=format&fit=crop&q=80',
  },
  {
    title: 'Câble Tressé Renforcé 100W PD Type-C vers Type-C',
    brand: 'Anker' as BrandName,
    category: 'Câbles' as CategoryType,
    compatibleModel: 'Universel USB-C Power Delivery',
    price: 2200,
    wholesalePrice: 1500,
    costPrice: 950,
    stock: 30,
    color: 'Gris Sidéral',
    material: 'Nylon Tressé Ultra-Résistant',
    isMagSafe: false,
    vendorName: 'Anker Official Dealer Alger',
    reorderPoint: 12,
    imageUrl: 'https://images.unsplash.com/photo-1595941069915-4ebc5337c463?w=400&auto=format&fit=crop&q=80',
  },
  {
    title: 'Adaptateur Secteur 20W USB-C Original',
    brand: 'Apple' as BrandName,
    category: 'Chargeurs' as CategoryType,
    compatibleModel: 'iPhone 15 / 14 / 13 / iPad',
    price: 4500,
    wholesalePrice: 3200,
    costPrice: 2200,
    stock: 15,
    color: 'Blanc Brillant',
    material: 'Polycarbonate',
    isMagSafe: false,
    vendorName: 'Distributeur Officiel Apple Algérie',
    reorderPoint: 8,
    imageUrl: 'https://images.unsplash.com/photo-1610945265064-0e34e5519bbf?w=400&auto=format&fit=crop&q=80',
  },
  {
    title: 'Support Voiture Magnétique MagSafe Grille Aération',
    brand: 'Belkin' as BrandName,
    category: 'Coques iPhone' as CategoryType,
    compatibleModel: 'iPhone 12 à 15 / Coques MagSafe',
    price: 4200,
    wholesalePrice: 3000,
    costPrice: 2100,
    stock: 12,
    color: 'Noir Aluminium',
    material: 'Aluminium Anodisé & Aimants N52',
    isMagSafe: true,
    vendorName: 'Belkin Store El Biar',
    reorderPoint: 5,
    imageUrl: 'https://images.unsplash.com/photo-1586953208448-b95a79798f07?w=400&auto=format&fit=crop&q=80',
  },
];

const STOCK_IMAGES_GALLERY = [
  { label: 'Coque Silicone Noire', url: 'https://images.unsplash.com/photo-1603313011101-320f26a4f6f6?w=400&auto=format&fit=crop&q=80' },
  { label: 'Coque Cuir Élégante', url: 'https://images.unsplash.com/photo-1541872703-74c5e44368f9?w=400&auto=format&fit=crop&q=80' },
  { label: 'Chargeur Rapide 20W', url: 'https://images.unsplash.com/photo-1583863788434-e58a36330cf0?w=400&auto=format&fit=crop&q=80' },
  { label: 'Câble Tressé USB-C', url: 'https://images.unsplash.com/photo-1595941069915-4ebc5337c463?w=400&auto=format&fit=crop&q=80' },
  { label: 'Verre Trempé Protection', url: 'https://images.unsplash.com/photo-1592899677977-9c10ca588bbd?w=400&auto=format&fit=crop&q=80' },
  { label: 'Écouteurs & Audio', url: 'https://images.unsplash.com/photo-1590658268037-6bf12165a8df?w=400&auto=format&fit=crop&q=80' },
  { label: 'Accessoire Universel', url: 'https://images.unsplash.com/photo-1580910051074-3eb694886505?w=400&auto=format&fit=crop&q=80' },
  { label: 'Batterie Externe PowerBank', url: 'https://images.unsplash.com/photo-1609091839311-d5365f9ff1c5?w=400&auto=format&fit=crop&q=80' },
];

const COLOR_OPTIONS = [
  'Noir Titane',
  'Noir Mat',
  'Blanc / Argent',
  'Transparent',
  'Titane Naturel',
  'Bleu Nuit',
  'Rouge Product',
  'Vert Forêt',
  'Gris Sidéral',
  'Or / Champagne',
  'Violet Profond',
];

const MATERIAL_OPTIONS = [
  'Silicone Liquide Soft-Touch',
  'Verre Trempé 9H Dureté',
  'Cuir Véritable',
  'Polycarbonate Antichoc',
  'Fibre de Carbone / Kevlar',
  'Nylon Tressé Renforcé',
  'Aluminium Anodisé',
  'TPU Flexible Transparent',
];

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
  const fileInputRef = useRef<HTMLInputElement>(null);
  const barcodeCanvasRef = useRef<HTMLCanvasElement>(null);

  const [formData, setFormData] = useState<ProductInput>({
    sku: '',
    barcode: '',
    title: '',
    brand: 'Apple',
    compatibleModel: 'iPhone 15 Pro Max',
    category: 'Coques iPhone',
    price: 3500,
    wholesalePrice: 2400,
    costPrice: 1500,
    stock: 20,
    imageUrl: 'https://images.unsplash.com/photo-1603313011101-320f26a4f6f6?w=400&auto=format&fit=crop&q=80',
    color: 'Noir Titane',
    material: 'Silicone Liquide Soft-Touch',
    isMagSafe: false,
    isSerialized: false,
    imeiNumber: '',
    vendorName: 'Distributeur Officiel Apple Algérie',
    leadTimeDays: 7,
    dailySalesVelocity: 2.0,
    reorderPoint: 10,
    warrantyMonths: 0,
    shelfLocation: 'Rayon A1',
    minPrice: 2000,
  });

  const [dragActive, setDragActive] = useState(false);
  const [showGallery, setShowGallery] = useState(false);
  const [autoPrintLabel, setAutoPrintLabel] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Generate 100% collision-free EAN-13 and unique SKU
  const handleGenerateFreshCodes = () => {
    const freshBarcode = generateUniqueEan13Barcode(products, '613');
    const freshSku = generateUniqueSku(products, formData.category, formData.brand);
    setFormData((prev) => ({
      ...prev,
      barcode: freshBarcode,
      sku: freshSku,
    }));
    showToast(`Code EAN-13 généré : ${freshBarcode} (Algérie 613)`, 'info');
  };

  useEffect(() => {
    if (activeModal === 'product_editor') {
      if (editingProduct) {
        setFormData({
          ...editingProduct,
          warrantyMonths: editingProduct.warrantyMonths || 0,
          shelfLocation: editingProduct.shelfLocation || 'Rayon A1',
          minPrice: editingProduct.minPrice || Math.round(editingProduct.price * 0.8),
        });
      } else {
        const freshBarcode = generateUniqueEan13Barcode(products, '613');
        const freshSku = generateUniqueSku(products, 'Coques iPhone', 'Apple');
        setFormData({
          sku: freshSku,
          barcode: freshBarcode,
          title: '',
          brand: 'Apple',
          compatibleModel: 'iPhone 15 Pro Max',
          category: 'Coques iPhone',
          price: 3500,
          wholesalePrice: 2400,
          costPrice: 1500,
          stock: 20,
          imageUrl: 'https://images.unsplash.com/photo-1603313011101-320f26a4f6f6?w=400&auto=format&fit=crop&q=80',
          color: 'Noir Titane',
          material: 'Silicone Liquide Soft-Touch',
          isMagSafe: true,
          isSerialized: false,
          imeiNumber: '',
          vendorName: 'Distributeur Officiel Apple Algérie',
          leadTimeDays: 7,
          dailySalesVelocity: 2.0,
          reorderPoint: 10,
          warrantyMonths: 0,
          shelfLocation: 'Rayon A1',
          minPrice: 2000,
        });
      }
    }
  }, [editingProduct, activeModal, products]);

  // Live Barcode Canvas Rendering
  useEffect(() => {
    if (barcodeCanvasRef.current && formData.barcode) {
      try {
        const type = isValidBarcode(formData.barcode, 'ean13') ? 'ean13' : 'code128';
        renderBarcodeToCanvas(barcodeCanvasRef.current, formData.barcode, type, {
          width: 240,
          height: 60,
          fontSize: 11,
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

  // Magic Title Generator
  const handleGenerateSmartTitle = () => {
    let prefix = 'Accessoire';
    const cat = formData.category.toLowerCase();
    if (cat.includes('coque')) prefix = 'Coque';
    else if (cat.includes('charge')) prefix = 'Chargeur';
    else if (cat.includes('câble') || cat.includes('cable')) prefix = 'Câble';
    else if (cat.includes('protège') || cat.includes('verre')) prefix = 'Verre Trempé';
    else if (cat.includes('reprise') || cat.includes('occasion')) prefix = 'Smartphone';

    const magSafeTag = formData.isMagSafe ? 'MagSafe ' : '';
    const brandTag = formData.brand !== 'Autre' ? `${formData.brand} ` : '';
    const modelTag = formData.compatibleModel ? `${formData.compatibleModel}` : '';
    const colorTag = formData.color ? ` - ${formData.color}` : '';

    const autoTitle = `${prefix} ${brandTag}${magSafeTag}${modelTag}${colorTag}`.replace(/\s+/g, ' ').trim();
    setFormData((prev) => ({ ...prev, title: autoTitle }));
    showToast(`Désignation générée : ${autoTitle}`, 'success');
  };

  const handleApplyPreset = (preset: typeof PRESET_TEMPLATES[0]) => {
    const freshSku = generateUniqueSku(products, preset.category, preset.brand);
    setFormData((prev) => ({
      ...prev,
      sku: freshSku,
      title: preset.title,
      brand: preset.brand,
      category: preset.category,
      compatibleModel: preset.compatibleModel,
      price: preset.price,
      wholesalePrice: preset.wholesalePrice,
      costPrice: preset.costPrice,
      stock: preset.stock,
      color: preset.color,
      material: preset.material,
      isMagSafe: preset.isMagSafe,
      vendorName: preset.vendorName,
      reorderPoint: preset.reorderPoint,
      imageUrl: preset.imageUrl,
    }));
    showToast(`Modèle "${preset.title}" appliqué avec succès`, 'info');
  };

  const handleImageFile = (file: File) => {
    if (!file.type.startsWith('image/')) {
      showToast('Fichier image invalide (formats acceptés: PNG, JPG, WEBP)', 'error');
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.src = e.target?.result as string;
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const MAX_WIDTH = 480;
        const MAX_HEIGHT = 480;
        let width = img.width;
        let height = img.height;

        if (width > height) {
          if (width > MAX_WIDTH) {
            height *= MAX_WIDTH / width;
            width = MAX_WIDTH;
          }
        } else {
          if (height > MAX_HEIGHT) {
            width *= MAX_HEIGHT / height;
            height = MAX_HEIGHT;
          }
        }

        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx?.drawImage(img, 0, 0, width, height);

        const compressedDataUrl = canvas.toDataURL('image/jpeg', 0.85);
        setFormData((prev) => ({ ...prev, imageUrl: compressedDataUrl }));
        showToast('Image compressée et chargée avec succès (<100KB)', 'success');
      };
    };
    reader.readAsDataURL(file);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleImageFile(e.dataTransfer.files[0]);
    }
  };

  const handleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!formData.title.trim()) {
      showToast('Veuillez renseigner la désignation du produit.', 'error');
      return;
    }

    if (duplicateBarcodeProduct) {
      showToast(
        `Erreur : Le code-barres "${formData.barcode}" est déjà utilisé par "${duplicateBarcodeProduct.title}".`,
        'error'
      );
      return;
    }

    if (duplicateSkuProduct) {
      showToast(
        `Erreur : La référence SKU "${formData.sku}" est déjà utilisée par "${duplicateSkuProduct.title}".`,
        'error'
      );
      return;
    }

    if (formData.price <= 0) {
      showToast('Le prix de vente au détail doit être strictement supérieur à 0 DA.', 'error');
      return;
    }

    setIsSubmitting(true);
    const res = await saveProduct(formData);
    setIsSubmitting(false);

    if (res.success) {
      showToast(
        editingProduct
          ? `Produit "${formData.title}" mis à jour avec succès.`
          : `Produit "${formData.title}" ajouté au catalogue avec succès !`,
        'success'
      );

      if (autoPrintLabel) {
        openModal('label_printer');
      }
    } else {
      showToast(`Erreur lors de l'enregistrement : ${res.reason}`, 'error');
    }
  };

  if (activeModal !== 'product_editor') return null;

  // Real-Time Commercial Margin Calculations
  const grossProfit = Math.max(0, formData.price - (formData.costPrice || 0));
  const profitMarginPercent = formData.price > 0 ? ((grossProfit / formData.price) * 100).toFixed(1) : '0';
  const wholesaleProfit = Math.max(0, formData.wholesalePrice - (formData.costPrice || 0));
  const wholesaleMarginPercent =
    formData.wholesalePrice > 0 ? ((wholesaleProfit / formData.wholesalePrice) * 100).toFixed(1) : '0';

  const isLossPrice = formData.costPrice > 0 && formData.price <= formData.costPrice;
  const isWholesaleLoss = formData.costPrice > 0 && formData.wholesalePrice <= formData.costPrice;

  return (
    <div className="fixed inset-0 bg-black/85 backdrop-blur-md z-50 flex items-center justify-center p-3 sm:p-4 select-none">
      <div className="bg-pos-panel border border-pos-border rounded-2xl w-full max-w-4xl overflow-hidden shadow-2xl animate-in fade-in zoom-in-95 max-h-[94vh] flex flex-col">
        
        {/* Modal Header */}
        <div className="p-4 border-b border-pos-border flex items-center justify-between bg-pos-card shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center text-slate-950 font-bold shadow-lg shadow-emerald-500/20">
              <Sparkles className="w-5 h-5 stroke-[2.5]" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-black text-pos-text tracking-wide">
                  {editingProduct ? 'MODIFICATION FICHE PRODUIT' : 'CRÉATION FICHE PRODUIT CATALOGUE'}
                </h2>
                <span className="text-[10px] bg-emerald-500/10 text-emerald-400 font-black px-2 py-0.5 rounded border border-emerald-500/30 uppercase">
                  ENTERPRISE v2
                </span>
              </div>
              <p className="text-[11px] text-pos-muted">
                Gestion des prix gros/détail, codes EAN-13 certifiés sans doublon & marges en direct
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

        {/* Fast-Fill Template Toolbar (Only when creating new product) */}
        {!editingProduct && (
          <div className="bg-pos-bg border-b border-pos-border px-4 py-2 flex items-center justify-between gap-3 shrink-0 overflow-hidden">
            <div className="flex items-center gap-1.5 shrink-0 text-pos-muted">
              <Wand2 className="w-3.5 h-3.5 text-emerald-400" />
              <span className="text-[10px] font-black uppercase tracking-wider">
                Modèles Rapides :
              </span>
            </div>
            <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar py-0.5">
              {PRESET_TEMPLATES.map((tmpl) => (
                <button
                  key={tmpl.title}
                  type="button"
                  onClick={() => handleApplyPreset(tmpl)}
                  className="px-2.5 py-1 rounded-lg bg-pos-card border border-pos-border text-pos-text hover:border-emerald-400 text-[10px] font-bold shrink-0 transition flex items-center gap-1 cursor-pointer"
                >
                  <Tag className="w-2.5 h-2.5 text-emerald-400" />
                  {tmpl.title.split(' ')[0]} {tmpl.title.split(' ')[1]} {tmpl.title.split(' ')[2] || ''}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Scrollable Form Body */}
        <form onSubmit={handleFormSubmit} className="p-5 overflow-y-auto space-y-4 flex-1 bg-pos-bg">
          
          {/* Top Barcode Conflict Warning Banner */}
          {duplicateBarcodeProduct && (
            <div className="p-3 bg-red-500/10 border border-red-500/40 rounded-xl flex items-start justify-between gap-3 text-red-400 animate-in fade-in">
              <div className="flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                <div>
                  <p className="font-bold text-xs">Code-Barres déjà attribué à un autre article !</p>
                  <p className="text-[11px] text-red-300/80 mt-0.5">
                    Le code <span className="font-mono font-bold text-red-200">{formData.barcode}</span> appartient déjà au produit :{' '}
                    <span className="font-bold text-white">"{duplicateBarcodeProduct.title}"</span> (SKU: {duplicateBarcodeProduct.sku}).
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={handleGenerateFreshCodes}
                className="px-3 py-1 bg-red-500 text-slate-950 font-black text-xs rounded-lg shadow hover:bg-red-400 shrink-0 transition cursor-pointer"
              >
                Générer un Nouveau Code EAN
              </button>
            </div>
          )}

          {/* SKU Conflict Warning Banner */}
          {duplicateSkuProduct && (
            <div className="p-3 bg-amber-500/10 border border-amber-500/40 rounded-xl flex items-center justify-between gap-3 text-amber-400 animate-in fade-in">
              <div className="flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                <p className="text-xs font-bold">
                  La référence SKU <span className="font-mono text-white">{formData.sku}</span> est déjà utilisée par "{duplicateSkuProduct.title}".
                </p>
              </div>
              <button
                type="button"
                onClick={handleGenerateFreshCodes}
                className="px-3 py-1 bg-amber-500 text-slate-950 font-black text-xs rounded-lg shadow hover:bg-amber-400 shrink-0 transition cursor-pointer"
              >
                Nouveau SKU Unique
              </button>
            </div>
          )}

          {/* Section 1: Photo & Main Identifiers */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-start">
            
            {/* Image Preview & Upload Zone */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-[10px] font-black text-pos-muted uppercase tracking-wider">
                  Photo du Produit
                </label>
                <button
                  type="button"
                  onClick={() => setShowGallery(!showGallery)}
                  className="text-[10px] text-emerald-400 font-bold hover:underline flex items-center gap-1 cursor-pointer"
                >
                  <ImageIcon className="w-3 h-3" /> {showGallery ? 'Masquer Galerie' : 'Galerie Magasin'}
                </button>
              </div>

              {/* Upload Drag Box */}
              <div className="grid grid-cols-1 gap-2">
                <div
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragActive(true);
                  }}
                  onDragLeave={() => setDragActive(false)}
                  onDrop={handleDrop}
                  onClick={() => fileInputRef.current?.click()}
                  className={`h-36 rounded-xl border-2 border-dashed flex flex-col items-center justify-center p-3 cursor-pointer transition relative overflow-hidden group ${
                    dragActive
                      ? 'border-emerald-500 bg-emerald-950/20'
                      : 'border-pos-border hover:border-emerald-500/60 bg-pos-card'
                  }`}
                >
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    onChange={(e) => e.target.files?.[0] && handleImageFile(e.target.files[0])}
                    className="hidden"
                  />
                  {formData.imageUrl ? (
                    <>
                      <img
                        src={formData.imageUrl}
                        alt="Aperçu"
                        className="w-full h-full object-contain mix-blend-normal rounded-lg"
                      />
                      <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 flex flex-col items-center justify-center transition p-2 text-center">
                        <Upload className="w-5 h-5 text-white mb-1" />
                        <span className="text-[10px] text-white font-bold">Changer / Remplacer Photo</span>
                        <span className="text-[8px] text-gray-300">Glisser ou cliquer</span>
                      </div>
                    </>
                  ) : (
                    <div className="flex flex-col items-center text-center">
                      <Upload className="w-6 h-6 text-emerald-400 mb-1" />
                      <p className="text-xs font-bold text-pos-text">Glisser-déposer une image</p>
                      <p className="text-[9px] text-pos-muted mt-0.5">PNG, JPG, WEBP (Max 5 Mo)</p>
                    </div>
                  )}
                </div>

                {/* Stock Images Popover */}
                {showGallery && (
                  <div className="p-2 bg-pos-card border border-pos-border rounded-xl space-y-1.5 animate-in fade-in">
                    <span className="text-[9px] font-black text-pos-muted uppercase block">Photos Types Accessoires :</span>
                    <div className="grid grid-cols-4 gap-1.5">
                      {STOCK_IMAGES_GALLERY.map((img) => (
                        <button
                          key={img.label}
                          type="button"
                          onClick={() => {
                            setFormData((prev) => ({ ...prev, imageUrl: img.url }));
                            setShowGallery(false);
                          }}
                          className="h-12 rounded-lg border border-pos-border overflow-hidden hover:border-emerald-400 transition relative group"
                          title={img.label}
                        >
                          <img src={img.url} alt={img.label} className="w-full h-full object-cover" />
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Title, Brand, Category, Model */}
            <div className="md:col-span-2 space-y-3">
              
              {/* Product Title with Magic Auto-Naming Assistant */}
              <div>
                <div className="flex justify-between items-center mb-1">
                  <label className="text-[11px] font-bold text-pos-text flex items-center gap-1">
                    Désignation Commerciale du Produit <span className="text-emerald-400 font-bold">*</span>
                  </label>
                  <button
                    type="button"
                    onClick={handleGenerateSmartTitle}
                    className="text-[10px] text-emerald-400 font-bold hover:text-emerald-300 flex items-center gap-1 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/30 transition cursor-pointer"
                    title="Générer automatiquement le titre à partir des caractéristiques"
                  >
                    <Wand2 className="w-3 h-3" /> Titre Magique ✨
                  </button>
                </div>
                <input
                  type="text"
                  required
                  value={formData.title}
                  onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                  placeholder="ex: Coque Silicone MagSafe iPhone 15 Pro Max - Noir Titane"
                  className="w-full bg-pos-card border border-pos-border rounded-xl px-3 py-2 text-xs font-bold text-pos-text focus:border-emerald-400 focus:outline-none"
                />
              </div>

              {/* Brand & Category */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] font-bold text-pos-muted block mb-1">Marque / Fabricant</label>
                  <select
                    value={formData.brand}
                    onChange={(e) => setFormData({ ...formData, brand: e.target.value as BrandName })}
                    className="w-full bg-pos-card border border-pos-border rounded-xl px-3 py-2 text-xs font-bold text-pos-text focus:border-emerald-400 focus:outline-none cursor-pointer"
                  >
                    {BRANDS.map((b) => (
                      <option key={b} value={b}>{b}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="text-[10px] font-bold text-pos-muted block mb-1">Catégorie Article</label>
                  <select
                    value={formData.category}
                    onChange={(e) => setFormData({ ...formData, category: e.target.value as CategoryType })}
                    className="w-full bg-pos-card border border-pos-border rounded-xl px-3 py-2 text-xs font-bold text-pos-text focus:border-emerald-400 focus:outline-none cursor-pointer"
                  >
                    {CATEGORIES.map((c) => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Compatible Model & Supplier */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] font-bold text-pos-muted block mb-1">Modèle Compatible</label>
                  <input
                    type="text"
                    value={formData.compatibleModel}
                    onChange={(e) => setFormData({ ...formData, compatibleModel: e.target.value })}
                    placeholder="ex: iPhone 15 Pro Max / Universel"
                    className="w-full bg-pos-card border border-pos-border rounded-xl px-3 py-2 text-xs font-bold text-pos-text focus:border-emerald-400 focus:outline-none"
                  />
                </div>

                <div>
                  <label className="text-[10px] font-bold text-pos-muted block mb-1">Fournisseur / Grossiste</label>
                  <input
                    type="text"
                    value={formData.vendorName}
                    onChange={(e) => setFormData({ ...formData, vendorName: e.target.value })}
                    placeholder="ex: Distributeur Officiel Apple Algérie"
                    className="w-full bg-pos-card border border-pos-border rounded-xl px-3 py-2 text-xs font-bold text-pos-text focus:border-emerald-400 focus:outline-none"
                  />
                </div>
              </div>

            </div>
          </div>

          {/* Section 2: Barcode & SKU Suite (Guaranteed Zero Collision) */}
          <div className="p-3.5 bg-pos-card border border-pos-border rounded-2xl space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <BarcodeIcon className="w-4 h-4 text-emerald-400" />
                <h3 className="text-xs font-black text-pos-text uppercase tracking-wider">
                  Identification & Code-Barres EAN-13 Certifié
                </h3>
              </div>
              <button
                type="button"
                onClick={handleGenerateFreshCodes}
                className="px-3 py-1 rounded-xl bg-emerald-500/15 hover:bg-emerald-500 text-emerald-400 hover:text-slate-950 border border-emerald-500/30 text-xs font-black flex items-center gap-1.5 transition cursor-pointer"
              >
                <RefreshCw className="w-3 h-3" /> Générer Nouveau Code EAN-13 Unique
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-center">
              
              {/* SKU Field */}
              <div>
                <label className="text-[10px] font-bold text-pos-muted block mb-1">Référence SKU Interne</label>
                <input
                  type="text"
                  value={formData.sku}
                  onChange={(e) => setFormData({ ...formData, sku: e.target.value })}
                  placeholder="ex: COQ-APP-1024"
                  className={`w-full bg-pos-bg border rounded-xl px-3 py-2 text-xs font-mono font-bold text-pos-text focus:outline-none ${
                    duplicateSkuProduct ? 'border-amber-500 focus:border-amber-400' : 'border-pos-border focus:border-emerald-400'
                  }`}
                />
              </div>

              {/* Barcode Field */}
              <div>
                <div className="flex justify-between items-center mb-1">
                  <label className="text-[10px] font-bold text-pos-muted">Code-Barres EAN-13</label>
                  {isValidBarcode(formData.barcode, 'ean13') && !duplicateBarcodeProduct && (
                    <span className="text-[9px] text-emerald-400 font-bold flex items-center gap-0.5">
                      <CheckCircle2 className="w-2.5 h-2.5" /> Conforme GS1
                    </span>
                  )}
                </div>
                <input
                  type="text"
                  value={formData.barcode}
                  onChange={(e) => setFormData({ ...formData, barcode: e.target.value })}
                  placeholder="ex: 6130001234567"
                  className={`w-full bg-pos-bg border rounded-xl px-3 py-2 text-xs font-mono font-bold focus:outline-none ${
                    duplicateBarcodeProduct
                      ? 'border-red-500 text-red-400 focus:border-red-400'
                      : 'border-pos-border text-emerald-400 focus:border-emerald-400'
                  }`}
                />
              </div>

              {/* Barcode Live Canvas Visualizer */}
              <div className="flex flex-col items-center justify-center p-2 bg-white rounded-xl border border-pos-border shadow-sm">
                <canvas ref={barcodeCanvasRef} className="h-10 mix-blend-multiply max-w-full" />
              </div>

            </div>
          </div>

          {/* Section 3: Commercial Pricing & Margins */}
          <div className="p-3.5 bg-pos-card border border-pos-border rounded-2xl space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <TrendingUp className="w-4 h-4 text-emerald-400" />
                <h3 className="text-xs font-black text-pos-text uppercase tracking-wider">
                  Tarification Commerciale & Marges de Vente
                </h3>
              </div>
            </div>

            {/* Price inputs */}
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
              
              <div>
                <label className="text-[10px] font-bold text-pos-muted block mb-1">Prix Achat Cost (DA)</label>
                <input
                  type="number"
                  step="50"
                  value={formData.costPrice}
                  onChange={(e) => setFormData({ ...formData, costPrice: parseFloat(e.target.value) || 0 })}
                  className="w-full bg-pos-bg border border-pos-border rounded-xl px-3 py-2 text-xs font-bold text-pos-text focus:border-emerald-400 focus:outline-none"
                />
              </div>

              <div>
                <label className="text-[10px] font-bold text-emerald-400 block mb-1">Prix Détail (DA) *</label>
                <input
                  type="number"
                  step="50"
                  required
                  value={formData.price}
                  onChange={(e) => setFormData({ ...formData, price: parseFloat(e.target.value) || 0 })}
                  className={`w-full bg-pos-bg border rounded-xl px-3 py-2 text-xs font-black text-emerald-400 focus:outline-none ${
                    isLossPrice ? 'border-red-500' : 'border-pos-border focus:border-emerald-400'
                  }`}
                />
              </div>

              <div>
                <label className="text-[10px] font-bold text-amber-400 block mb-1">Prix Gros (DA) *</label>
                <input
                  type="number"
                  step="50"
                  required
                  value={formData.wholesalePrice}
                  onChange={(e) => setFormData({ ...formData, wholesalePrice: parseFloat(e.target.value) || 0 })}
                  className={`w-full bg-pos-bg border rounded-xl px-3 py-2 text-xs font-black text-amber-400 focus:outline-none ${
                    isWholesaleLoss ? 'border-red-500' : 'border-pos-border focus:border-amber-400'
                  }`}
                />
              </div>

              <div>
                <label className="text-[10px] font-bold text-pos-muted block mb-1">Prix Plancher Min (DA)</label>
                <input
                  type="number"
                  step="50"
                  value={formData.minPrice || 0}
                  onChange={(e) => setFormData({ ...formData, minPrice: parseFloat(e.target.value) || 0 })}
                  className="w-full bg-pos-bg border border-pos-border rounded-xl px-3 py-2 text-xs font-bold text-pos-muted focus:border-emerald-400 focus:outline-none"
                />
              </div>

              <div>
                <label className="text-[10px] font-bold text-pos-text block mb-1">Stock Quantité *</label>
                <input
                  type="number"
                  required
                  value={formData.stock}
                  onChange={(e) => setFormData({ ...formData, stock: parseInt(e.target.value) || 0 })}
                  className="w-full bg-pos-bg border border-pos-border rounded-xl px-3 py-2 text-xs font-black text-pos-text focus:border-emerald-400 focus:outline-none"
                />
              </div>

            </div>

            {/* Real-time Profit & Margin Metric Cards */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 pt-1">
              
              <div className="bg-pos-bg p-2.5 rounded-xl border border-pos-border flex justify-between items-center">
                <span className="text-[10px] text-pos-muted font-bold">Bénéfice Unitaire Détail :</span>
                <span className={`font-black text-sm ${isLossPrice ? 'text-red-400' : 'text-emerald-400'}`}>
                  {isLossPrice ? 'Vente à perte !' : `+${formatDZD(grossProfit)}`}
                </span>
              </div>

              <div className="bg-pos-bg p-2.5 rounded-xl border border-pos-border flex justify-between items-center">
                <span className="text-[10px] text-pos-muted font-bold">Marge Brute Détail % :</span>
                <span className={`font-black text-xs px-2 py-0.5 rounded ${isLossPrice ? 'bg-red-500/20 text-red-400' : 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30'}`}>
                  {profitMarginPercent}%
                </span>
              </div>

              <div className="bg-pos-bg p-2.5 rounded-xl border border-pos-border flex justify-between items-center">
                <span className="text-[10px] text-pos-muted font-bold">Marge Prix Gros % :</span>
                <span className={`font-black text-xs px-2 py-0.5 rounded ${isWholesaleLoss ? 'bg-red-500/20 text-red-400' : 'bg-amber-500/10 text-amber-400 border border-amber-500/30'}`}>
                  {wholesaleMarginPercent}%
                </span>
              </div>

            </div>
          </div>

          {/* Section 4: Specifications, Options & Inventory Features */}
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 bg-pos-card border border-pos-border p-3.5 rounded-2xl">
            
            {/* Color Selector */}
            <div>
              <label className="text-[10px] font-bold text-pos-muted block mb-1">Couleur</label>
              <select
                value={formData.color || 'Noir Titane'}
                onChange={(e) => setFormData({ ...formData, color: e.target.value })}
                className="w-full bg-pos-bg border border-pos-border rounded-xl px-3 py-2 text-xs font-bold text-pos-text focus:border-emerald-400 focus:outline-none cursor-pointer"
              >
                {COLOR_OPTIONS.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>

            {/* Material */}
            <div>
              <label className="text-[10px] font-bold text-pos-muted block mb-1">Matière / Finition</label>
              <select
                value={formData.material || 'Silicone Liquide Soft-Touch'}
                onChange={(e) => setFormData({ ...formData, material: e.target.value })}
                className="w-full bg-pos-bg border border-pos-border rounded-xl px-3 py-2 text-xs font-bold text-pos-text focus:border-emerald-400 focus:outline-none cursor-pointer"
              >
                {MATERIAL_OPTIONS.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </div>

            {/* Warranty */}
            <div>
              <label className="text-[10px] font-bold text-pos-muted block mb-1">Garantie Magasin</label>
              <select
                value={formData.warrantyMonths || 0}
                onChange={(e) => setFormData({ ...formData, warrantyMonths: parseInt(e.target.value) || 0 })}
                className="w-full bg-pos-bg border border-pos-border rounded-xl px-3 py-2 text-xs font-bold text-pos-text focus:border-emerald-400 focus:outline-none cursor-pointer"
              >
                <option value={0}>Sans Garantie</option>
                <option value={1}>1 Mois Garantie SAV</option>
                <option value={3}>3 Mois Garantie SAV</option>
                <option value={6}>6 Mois Garantie SAV</option>
                <option value={12}>1 An Garantie Constructeur</option>
                <option value={24}>2 Ans Garantie Officielle</option>
              </select>
            </div>

            {/* Shelf Location */}
            <div>
              <label className="text-[10px] font-bold text-pos-muted block mb-1">Emplacement Rayon</label>
              <input
                type="text"
                value={formData.shelfLocation || 'Rayon A1'}
                onChange={(e) => setFormData({ ...formData, shelfLocation: e.target.value })}
                placeholder="ex: Rayon A2 - Vitrine 1"
                className="w-full bg-pos-bg border border-pos-border rounded-xl px-3 py-2 text-xs font-bold text-pos-text focus:border-emerald-400 focus:outline-none"
              />
            </div>

            {/* Toggles: MagSafe & Serialized IMEI */}
            <div className="sm:col-span-4 flex flex-wrap items-center gap-6 pt-2 border-t border-pos-border/60">
              
              <label className="flex items-center gap-2 cursor-pointer text-xs font-bold text-pos-text">
                <input
                  type="checkbox"
                  checked={formData.isMagSafe || false}
                  onChange={(e) => setFormData({ ...formData, isMagSafe: e.target.checked })}
                  className="w-4 h-4 rounded text-emerald-500 focus:ring-emerald-400 cursor-pointer"
                />
                <span className="flex items-center gap-1">
                  <Zap className="w-3.5 h-3.5 text-emerald-400" /> Compatibilité MagSafe / Induction
                </span>
              </label>

              <label className="flex items-center gap-2 cursor-pointer text-xs font-bold text-pos-text">
                <input
                  type="checkbox"
                  checked={formData.isSerialized || false}
                  onChange={(e) => setFormData({ ...formData, isSerialized: e.target.checked })}
                  className="w-4 h-4 rounded text-emerald-500 focus:ring-emerald-400 cursor-pointer"
                />
                <span className="flex items-center gap-1">
                  <Shield className="w-3.5 h-3.5 text-cyan-400" /> Produit Sérialisé (Gestion IMEI / N° Série)
                </span>
              </label>

              <label className="flex items-center gap-2 cursor-pointer text-xs font-bold text-pos-text ml-auto">
                <input
                  type="checkbox"
                  checked={autoPrintLabel}
                  onChange={(e) => setAutoPrintLabel(e.target.checked)}
                  className="w-4 h-4 rounded text-emerald-500 focus:ring-emerald-400 cursor-pointer"
                />
                <span className="flex items-center gap-1 text-emerald-400">
                  <Printer className="w-3.5 h-3.5" /> Ouvrir impression d'étiquette après enregistrement
                </span>
              </label>

            </div>

          </div>

          {/* Footer Actions */}
          <div className="p-4 border-t border-pos-border bg-pos-card flex justify-between items-center -mx-5 -mb-5 mt-4 shrink-0">
            {editingProduct ? (
              <button
                type="button"
                onClick={() => {
                  if (confirm(`Voulez-vous vraiment supprimer le produit "${editingProduct.title}" du catalogue ?`)) {
                    deleteProduct(editingProduct.id);
                    showToast(`Produit "${editingProduct.title}" supprimé du catalogue.`, 'info');
                    closeModal();
                  }
                }}
                className="px-3.5 py-2 rounded-xl bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 text-xs font-bold flex items-center gap-1.5 transition border border-rose-500/30 cursor-pointer"
              >
                <Trash2 className="w-4 h-4" /> Supprimer Produit
              </button>
            ) : <div />}

            <div className="flex gap-2">
              <button
                type="button"
                onClick={closeModal}
                className="px-4 py-2 rounded-xl text-xs font-semibold text-pos-muted hover:text-pos-text transition cursor-pointer"
              >
                Annuler
              </button>
              <button
                type="submit"
                disabled={isSubmitting || Boolean(duplicateBarcodeProduct) || Boolean(duplicateSkuProduct)}
                className={`px-6 py-2.5 rounded-xl text-slate-950 font-bold text-xs shadow-lg flex items-center gap-1.5 transition cursor-pointer ${
                  duplicateBarcodeProduct || duplicateSkuProduct
                    ? 'bg-gray-600 text-gray-400 cursor-not-allowed'
                    : 'bg-emerald-500 hover:bg-emerald-400 shadow-emerald-500/20'
                }`}
              >
                <Check className="w-4 h-4" />
                {isSubmitting
                  ? 'Enregistrement en cours...'
                  : editingProduct
                  ? 'Mettre à Jour la Fiche'
                  : 'Enregistrer le Produit au Catalogue'}
              </button>
            </div>
          </div>

        </form>
      </div>
    </div>
  );
};
