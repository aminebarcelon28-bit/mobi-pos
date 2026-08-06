import React, { useState, useEffect, useRef } from 'react';
import {
  X,
  Upload,
  Sparkles,
  Check,
  Trash2,
  Zap,
  TrendingUp,
  RefreshCw,
} from 'lucide-react';
import { usePosStore } from '../../store/usePosStore';
import { formatDZD } from '../../types/pos';
import type { BrandName, CategoryType, ProductInput } from '../../types/pos';

const BRANDS: BrandName[] = ['Apple', 'Samsung', 'Google', 'ZAGG', 'Belkin', 'Anker', 'Autre'];
const CATEGORIES: CategoryType[] = [
  'Coques iPhone',
  'Coques Samsung',
  'Coques Google',
  'Chargeurs',
  'Câbles',
  'Protège-Écran',
];

const PRESET_TEMPLATES = [
  {
    title: 'Coque Silicone Magsafe iPhone 15 Pro Max',
    brand: 'Apple' as BrandName,
    category: 'Coques iPhone' as CategoryType,
    compatibleModel: 'iPhone 15 Pro Max',
    price: 3500,
    wholesalePrice: 2400,
    costPrice: 1500,
    stock: 25,
    isMagSafe: true,
  },
  {
    title: 'Verre Trempé ZAGG InvisibleShield 9H',
    brand: 'ZAGG' as BrandName,
    category: 'Protège-Écran' as CategoryType,
    compatibleModel: 'iPhone 15 Pro Max / 14 Pro',
    price: 2800,
    wholesalePrice: 1800,
    costPrice: 1100,
    stock: 40,
    isMagSafe: false,
  },
  {
    title: 'Adaptateur Secteur 20W USB-C Original',
    brand: 'Apple' as BrandName,
    category: 'Chargeurs' as CategoryType,
    compatibleModel: 'Universel USB-C',
    price: 4500,
    wholesalePrice: 3200,
    costPrice: 2200,
    stock: 15,
    isMagSafe: false,
  },
];

export const ProductEditorModal: React.FC = () => {
  const { activeModal, closeModal, editingProduct, saveProduct, deleteProduct } = usePosStore();
  const fileInputRef = useRef<HTMLInputElement>(null);

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
    imageUrl: 'https://images.unsplash.com/photo-1603313011101-320f26a4f6f6?w=300&auto=format&fit=crop&q=80',
    color: 'Transparente',
    material: 'Polycarbonate',
    isMagSafe: false,
    vendorName: 'Distributeur Officiel Apple Algérie',
    leadTimeDays: 7,
    dailySalesVelocity: 2.0,
    reorderPoint: 15,
  });

  const [dragActive, setDragActive] = useState(false);

  const generateRandomCodes = () => {
    const randomSku = `ACC-${Math.floor(1000 + Math.random() * 9000)}`;
    const randomBarcode = `${Math.floor(613000000000 + Math.random() * 900000000000)}`;
    setFormData((prev) => ({
      ...prev,
      sku: randomSku,
      barcode: randomBarcode,
    }));
  };

  useEffect(() => {
    if (editingProduct) {
      setFormData(editingProduct);
    } else {
      generateRandomCodes();
    }
  }, [editingProduct, activeModal]);

  if (activeModal !== 'product_editor') return null;

  const handleApplyPreset = (preset: typeof PRESET_TEMPLATES[0]) => {
    setFormData((prev) => ({
      ...prev,
      title: preset.title,
      brand: preset.brand,
      category: preset.category,
      compatibleModel: preset.compatibleModel,
      price: preset.price,
      wholesalePrice: preset.wholesalePrice,
      costPrice: preset.costPrice,
      stock: preset.stock,
      isMagSafe: preset.isMagSafe,
    }));
  };

  const handleImageFile = (file: File) => {
    if (!file.type.startsWith('image/')) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.src = e.target?.result as string;
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const MAX_WIDTH = 500;
        const MAX_HEIGHT = 500;
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

  const handleFormSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.title.trim()) return;
    saveProduct(formData);
    closeModal();
  };

  // Real-Time Profit Calculations
  const grossProfit = Math.max(0, formData.price - (formData.costPrice || 0));
  const profitMarginPercent = formData.price > 0 ? ((grossProfit / formData.price) * 100).toFixed(1) : '0';

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4 select-none">
      <div className="bg-pos-panel border border-pos-border rounded-2xl w-full max-w-3xl overflow-hidden shadow-2xl animate-in fade-in zoom-in-95 max-h-[92vh] flex flex-col">
        
        {/* Header */}
        <div className="p-4 border-b border-pos-border flex items-center justify-between bg-pos-card shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center text-slate-950 font-bold shadow-lg shadow-emerald-500/20">
              <Sparkles className="w-5 h-5 stroke-[2.5]" />
            </div>
            <div>
              <h2 className="text-base font-extrabold text-pos-text tracking-wide flex items-center gap-2">
                {editingProduct ? 'ÉDITEUR DE PRODUIT CATALOGUE' : 'CREATION FICHE PRODUIT CATALOGUE'}
                <span className="text-[10px] bg-emerald-500/10 text-emerald-400 font-bold px-2 py-0.5 rounded border border-emerald-500/30">
                  ENTERPRISE
                </span>
              </h2>
              <p className="text-[11px] text-pos-muted">Gestion des prix gros/détail, codes-barres EAN et réapprovisionnement JIT</p>
            </div>
          </div>
          <button onClick={closeModal} className="p-1.5 hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-lg transition">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Fast-Fill Template Toolbar (Only when creating new) */}
        {!editingProduct && (
          <div className="bg-pos-bg border-b border-pos-border px-4 py-2 flex items-center justify-between gap-3 shrink-0">
            <span className="text-[10px] font-extrabold text-pos-muted uppercase tracking-wider shrink-0">
              Remplissage Rapide :
            </span>
            <div className="flex items-center gap-2 overflow-x-auto">
              {PRESET_TEMPLATES.map((tmpl) => (
                <button
                  key={tmpl.title}
                  type="button"
                  onClick={() => handleApplyPreset(tmpl)}
                  className="px-2.5 py-1 rounded-lg bg-pos-card border border-pos-border text-pos-text hover:border-emerald-400 text-[10px] font-bold shrink-0 transition"
                >
                  {tmpl.title.split(' ')[0]} {tmpl.title.split(' ')[1]}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Scrollable Form Body */}
        <form onSubmit={handleFormSubmit} className="p-5 overflow-y-auto space-y-4 flex-1 bg-pos-bg">
          
          {/* Image Upload Drag & Drop Zone */}
          <div>
            <label className="text-[11px] font-extrabold text-pos-muted block mb-1.5 uppercase tracking-wider">
              Photo du Produit
            </label>
            <div className="grid grid-cols-3 gap-3 items-center">
              {/* Preview Thumbnail */}
              <div className="h-32 rounded-xl bg-pos-card border border-pos-border overflow-hidden flex items-center justify-center relative group shadow-inner">
                <img src={formData.imageUrl} alt="Aperçu" className="w-full h-full object-cover" />
                <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 flex items-center justify-center transition">
                  <span className="text-[10px] text-white font-bold">Image Actuelle</span>
                </div>
              </div>

              {/* Drag & Drop Zone */}
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragActive(true);
                }}
                onDragLeave={() => setDragActive(false)}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                className={`col-span-2 h-32 rounded-xl border-2 border-dashed flex flex-col items-center justify-center p-4 cursor-pointer transition ${
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
                <Upload className="w-6 h-6 text-emerald-400 mb-1" />
                <p className="text-xs font-bold text-pos-text text-center">
                  Glisser-déposer une image ici ou <span className="text-emerald-400 underline">parcourir</span>
                </p>
                <p className="text-[10px] text-pos-muted mt-0.5">Format supporté: PNG, JPG, WEBP (Max 5 Mo)</p>
              </div>
            </div>
          </div>

          {/* Title & Brand Grid */}
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <label className="text-[11px] font-semibold text-pos-muted block mb-1">Désignation Produit *</label>
              <input
                type="text"
                required
                value={formData.title}
                onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                placeholder="ex: Coque Silicone Rouge iPhone 15 Pro Max"
                className="w-full bg-pos-card border border-pos-border rounded-lg px-3 py-2 text-xs font-bold text-pos-text focus:border-emerald-400 focus:outline-none"
              />
            </div>

            <div>
              <label className="text-[11px] font-semibold text-pos-muted block mb-1">Marque</label>
              <select
                value={formData.brand}
                onChange={(e) => setFormData({ ...formData, brand: e.target.value as BrandName })}
                className="w-full bg-pos-card border border-pos-border rounded-lg px-3 py-2 text-xs font-bold text-pos-text focus:border-emerald-400 focus:outline-none cursor-pointer"
              >
                {BRANDS.map((b) => (
                  <option key={b} value={b}>{b}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Category & Model Compatibility */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[11px] font-semibold text-pos-muted block mb-1">Catégorie</label>
              <select
                value={formData.category}
                onChange={(e) => setFormData({ ...formData, category: e.target.value as CategoryType })}
                className="w-full bg-pos-card border border-pos-border rounded-lg px-3 py-2 text-xs font-bold text-pos-text focus:border-emerald-400 focus:outline-none cursor-pointer"
              >
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="text-[11px] font-semibold text-pos-muted block mb-1">Modèle Compatible</label>
              <input
                type="text"
                value={formData.compatibleModel}
                onChange={(e) => setFormData({ ...formData, compatibleModel: e.target.value })}
                placeholder="ex: iPhone 15 Pro Max / Universel"
                className="w-full bg-pos-card border border-pos-border rounded-lg px-3 py-2 text-xs font-bold text-pos-text focus:border-emerald-400 focus:outline-none"
              />
            </div>
          </div>

          {/* Vendor Name & Reorder Threshold */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[11px] font-semibold text-pos-muted block mb-1">Grossiste / Fournisseur</label>
              <input
                type="text"
                value={formData.vendorName}
                onChange={(e) => setFormData({ ...formData, vendorName: e.target.value })}
                placeholder="ex: Distributeur Officiel Apple Algérie"
                className="w-full bg-pos-card border border-pos-border rounded-lg px-3 py-2 text-xs font-bold text-pos-text focus:border-emerald-400 focus:outline-none"
              />
            </div>

            <div>
              <label className="text-[11px] font-semibold text-pos-muted block mb-1">Seuil Alerte Reorder Point</label>
              <input
                type="number"
                value={formData.reorderPoint}
                onChange={(e) => setFormData({ ...formData, reorderPoint: parseInt(e.target.value) || 10 })}
                className="w-full bg-pos-card border border-pos-border rounded-lg px-3 py-2 text-xs font-bold text-pos-text focus:border-emerald-400 focus:outline-none"
              />
            </div>
          </div>

          {/* Price (Détail), Wholesale Price (Gros), Cost Price, Stock */}
          <div className="grid grid-cols-4 gap-3">
            <div>
              <label className="text-[11px] font-semibold text-pos-muted block mb-1">Prix Détail (DA) *</label>
              <input
                type="number"
                step="50"
                required
                value={formData.price}
                onChange={(e) => setFormData({ ...formData, price: parseFloat(e.target.value) || 0 })}
                className="w-full bg-pos-card border border-pos-border rounded-lg px-3 py-2 text-xs font-black text-emerald-400 focus:border-emerald-400 focus:outline-none"
              />
            </div>

            <div>
              <label className="text-[11px] font-semibold text-pos-muted block mb-1">Prix Gros (DA) *</label>
              <input
                type="number"
                step="50"
                required
                value={formData.wholesalePrice}
                onChange={(e) => setFormData({ ...formData, wholesalePrice: parseFloat(e.target.value) || 0 })}
                className="w-full bg-pos-card border border-pos-border rounded-lg px-3 py-2 text-xs font-black text-amber-400 focus:border-amber-400 focus:outline-none"
              />
            </div>

            <div>
              <label className="text-[11px] font-semibold text-pos-muted block mb-1">Prix Achat Cost (DA)</label>
              <input
                type="number"
                step="50"
                value={formData.costPrice}
                onChange={(e) => setFormData({ ...formData, costPrice: parseFloat(e.target.value) || 0 })}
                className="w-full bg-pos-card border border-pos-border rounded-lg px-3 py-2 text-xs font-bold text-pos-text focus:border-emerald-400 focus:outline-none"
              />
            </div>

            <div>
              <label className="text-[11px] font-semibold text-pos-muted block mb-1">Stock Quantité *</label>
              <input
                type="number"
                required
                value={formData.stock}
                onChange={(e) => setFormData({ ...formData, stock: parseInt(e.target.value) || 0 })}
                className="w-full bg-pos-card border border-pos-border rounded-lg px-3 py-2 text-xs font-bold text-pos-text focus:border-emerald-400 focus:outline-none"
              />
            </div>
          </div>

          {/* Real-Time Profit Calculation Bar */}
          <div className="bg-pos-card border border-pos-border p-3 rounded-xl flex items-center justify-between text-xs">
            <div className="flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-cyan-400" />
              <span className="text-pos-muted font-bold text-[11px]">Bénéfice Brut Estimé :</span>
              <span className="font-black text-cyan-400 text-sm">+{formatDZD(grossProfit)}</span>
            </div>
            <div className="flex items-center gap-1">
              <span className="text-pos-muted text-[10px] font-semibold">Marge Brute %:</span>
              <span className="bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 px-2 py-0.5 rounded font-black text-xs">
                {profitMarginPercent}%
              </span>
            </div>
          </div>

          {/* SKU, Barcode & Code Generator */}
          <div className="grid grid-cols-3 gap-3 items-center">
            <div>
              <label className="text-[11px] font-semibold text-pos-muted block mb-1">Code Réf (SKU)</label>
              <input
                type="text"
                value={formData.sku}
                onChange={(e) => setFormData({ ...formData, sku: e.target.value })}
                className="w-full bg-pos-card border border-pos-border rounded-lg px-3 py-2 text-xs font-mono font-bold text-pos-text focus:border-emerald-400 focus:outline-none"
              />
            </div>

            <div>
              <div className="flex justify-between items-center mb-1">
                <label className="text-[11px] font-semibold text-pos-muted">Code-Barres EAN</label>
                <button
                  type="button"
                  onClick={generateRandomCodes}
                  className="text-[9px] text-emerald-400 font-bold hover:underline flex items-center gap-0.5"
                >
                  <RefreshCw className="w-2.5 h-2.5" /> Générer
                </button>
              </div>
              <input
                type="text"
                value={formData.barcode}
                onChange={(e) => setFormData({ ...formData, barcode: e.target.value })}
                className="w-full bg-pos-card border border-pos-border rounded-lg px-3 py-2 text-xs font-mono font-bold text-emerald-400 focus:border-emerald-400 focus:outline-none"
              />
            </div>

            <div className="pt-4 flex items-center gap-3">
              <label className="flex items-center gap-2 cursor-pointer text-xs font-bold text-pos-text">
                <input
                  type="checkbox"
                  checked={formData.isMagSafe || false}
                  onChange={(e) => setFormData({ ...formData, isMagSafe: e.target.checked })}
                  className="w-4 h-4 rounded text-emerald-500 focus:ring-emerald-400 cursor-pointer"
                />
                <span className="flex items-center gap-1"><Zap className="w-3.5 h-3.5 text-emerald-400" /> MagSafe</span>
              </label>
            </div>
          </div>

          {/* Footer Actions */}
          <div className="p-4 border-t border-pos-border bg-pos-card flex justify-between items-center -mx-5 -mb-5 mt-4 shrink-0">
            {editingProduct ? (
              <button
                type="button"
                onClick={() => {
                  if (confirm('Voulez-vous vraiment supprimer ce produit du catalogue ?')) {
                    deleteProduct(editingProduct.id);
                    closeModal();
                  }
                }}
                className="px-3 py-1.5 rounded-xl bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 text-xs font-bold flex items-center gap-1 transition border border-rose-500/30"
              >
                <Trash2 className="w-4 h-4" /> Supprimer Produit
              </button>
            ) : <div />}

            <div className="flex gap-2">
              <button
                type="button"
                onClick={closeModal}
                className="px-4 py-2 rounded-xl text-xs font-semibold text-pos-muted hover:text-pos-text transition"
              >
                Annuler
              </button>
              <button
                type="submit"
                className="px-6 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs shadow-lg shadow-emerald-500/20 flex items-center gap-1.5 transition cursor-pointer"
              >
                <Check className="w-4 h-4" /> Enregistrer le Produit
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};

