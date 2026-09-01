import React, { useState, useMemo } from 'react';
import {
  ShieldCheck,
  ShieldAlert,
  Wrench,
  Receipt,
  X,
  User,
  Search,
  Smartphone,
  CheckCircle2,
  ArrowRight,
} from 'lucide-react';
import { usePosStore } from '../../store/usePosStore';
import type { ImeiLifecycleDossier, SaleTransaction, CartItem, RepairOrder } from '../../types/pos';
import { soundEngine } from '../../utils/audioFeedback';

export const ImeiWarrantyInspectorModal: React.FC = () => {
  const {
    activeModal,
    closeModal,
    activeImeiDossier,
    setActiveImeiDossier,
    openModal,
    transactions,
    products,
    repairOrders,
  } = usePosStore();

  const [inputImei, setInputImei] = useState('');
  const [searchedDossier, setSearchedDossier] = useState<ImeiLifecycleDossier | null>(null);

  // Extract all serialized devices from transactions, repairs, and inventory
  const serializedDevices = useMemo(() => {
    const list: Array<{
      imei: string;
      productTitle: string;
      customerName: string;
      saleDate: string;
      receiptNumber: string;
    }> = [];

    // From sales transactions
    (transactions || []).forEach((sale: SaleTransaction) => {
      (sale.items || []).forEach((item: CartItem) => {
        if (item.imeiNumber && item.imeiNumber.trim()) {
          list.push({
            imei: item.imeiNumber.trim(),
            productTitle: item.product?.title || 'Smartphone',
            customerName: sale.customer?.name || 'Client Comptoir',
            saleDate: sale.createdAt,
            receiptNumber: sale.receiptNumber || sale.id.slice(0, 8),
          });
        }
      });
    });

    // From repair work orders
    (repairOrders || []).forEach((order: RepairOrder) => {
      if (order.imei && order.imei.trim()) {
        if (!list.some((i) => i.imei === order.imei)) {
          list.push({
            imei: order.imei.trim(),
            productTitle: order.deviceModel || 'Appareil SAV',
            customerName: order.customerName || 'Client SAV',
            saleDate: order.createdAt,
            receiptNumber: order.ticketNumber,
          });
        }
      }
    });

    // From products in stock
    (products || []).forEach((prod) => {
      if (prod.isSerialized && prod.barcode && prod.barcode.length >= 10) {
        if (!list.some((i) => i.imei === prod.barcode)) {
          list.push({
            imei: prod.barcode,
            productTitle: prod.title,
            customerName: 'En Stock Magasin',
            saleDate: new Date().toISOString(),
            receiptNumber: 'STOCK-' + prod.sku,
          });
        }
      }
    });

    return list;
  }, [transactions, repairOrders, products]);

  if (activeModal !== 'imei_inspector') return null;

  const currentDossier = activeImeiDossier || searchedDossier;

  const handleLookup = (imeiToSearch: string) => {
    const q = imeiToSearch.trim();
    if (!q) return;

    soundEngine.playKeyBeep?.();

    // 1. Search in transactions
    let foundSale: SaleTransaction | null = null;
    let foundItem: CartItem | null = null;

    for (const sale of transactions || []) {
      const itm = (sale.items || []).find(
        (i: CartItem) => i.imeiNumber && i.imeiNumber.trim().toLowerCase() === q.toLowerCase()
      );
      if (itm) {
        foundSale = sale;
        foundItem = itm;
        break;
      }
    }

    if (foundSale && foundItem) {
      const saleDate = new Date(foundSale.createdAt);
      const warrantyMonths = 12;
      const warrantyExpiry = new Date(saleDate);
      warrantyExpiry.setMonth(warrantyExpiry.getMonth() + warrantyMonths);

      const now = new Date();
      const diffMs = warrantyExpiry.getTime() - now.getTime();
      const daysRemaining = Math.max(0, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));
      const isWarrantyValid = daysRemaining > 0;

      const savCount = (repairOrders || []).filter(
        (r) => r.imei && r.imei.toLowerCase() === q.toLowerCase()
      ).length;

      const dossier: ImeiLifecycleDossier = {
        imei: q,
        productTitle: foundItem.product?.title || 'Smartphone Vendu',
        isSold: true,
        originalReceiptNumber: foundSale.receiptNumber,
        originalCustomerName: foundSale.customer?.name || 'Client Comptoir',
        originalCustomerPhone: foundSale.customer?.phone || '-',
        soldAt: foundSale.createdAt,
        warrantyExpiresAt: warrantyExpiry.toISOString(),
        isWarrantyValid,
        daysRemaining,
        repairHistoryCount: savCount,
      };

      setSearchedDossier(dossier);
      setActiveImeiDossier(dossier);
      soundEngine.playSuccess();
      return;
    }

    // 2. Search in repair work orders
    const foundRepair = (repairOrders || []).find(
      (r) => r.imei && r.imei.trim().toLowerCase() === q.toLowerCase()
    );

    if (foundRepair) {
      const now = new Date();
      const savCount = (repairOrders || []).filter(
        (r) => r.imei && r.imei.toLowerCase() === q.toLowerCase()
      ).length;

      const dossier: ImeiLifecycleDossier = {
        imei: q,
        productTitle: foundRepair.deviceModel || 'Appareil SAV',
        isSold: false,
        originalReceiptNumber: foundRepair.ticketNumber,
        originalCustomerName: foundRepair.customerName,
        originalCustomerPhone: foundRepair.customerPhone,
        soldAt: foundRepair.createdAt,
        warrantyExpiresAt: now.toISOString(),
        isWarrantyValid: false,
        daysRemaining: 0,
        repairHistoryCount: savCount,
      };

      setSearchedDossier(dossier);
      setActiveImeiDossier(dossier);
      soundEngine.playSuccess();
      return;
    }

    // 3. Search in inventory products
    const foundProduct = (products || []).find(
      (p) =>
        p.barcode === q ||
        p.sku.toLowerCase() === q.toLowerCase() ||
        (p.isSerialized && p.title.toLowerCase().includes(q.toLowerCase()))
    );

    if (foundProduct) {
      const now = new Date();
      const warrantyExpiry = new Date(now);
      warrantyExpiry.setMonth(warrantyExpiry.getMonth() + 12);

      const dossier: ImeiLifecycleDossier = {
        imei: q,
        productTitle: foundProduct.title,
        isSold: false,
        originalReceiptNumber: 'STOCK-' + foundProduct.sku,
        originalCustomerName: 'Article en Stock Magasin',
        originalCustomerPhone: '-',
        soldAt: now.toISOString(),
        warrantyExpiresAt: warrantyExpiry.toISOString(),
        isWarrantyValid: true,
        daysRemaining: 365,
        repairHistoryCount: 0,
      };

      setSearchedDossier(dossier);
      setActiveImeiDossier(dossier);
      soundEngine.playSuccess();
      return;
    }

    // 4. Fallback calculation for any 15-digit IMEI
    const now = new Date();
    const warrantyExpiry = new Date(now);
    warrantyExpiry.setMonth(warrantyExpiry.getMonth() + 12);

    const dossier: ImeiLifecycleDossier = {
      imei: q,
      productTitle: `Smartphone / Appareil (IMEI ${q.slice(0, 8)}...)`,
      isSold: false,
      originalReceiptNumber: 'NON ENREGISTRÉ',
      originalCustomerName: 'Client Comptoir',
      originalCustomerPhone: '-',
      soldAt: now.toISOString(),
      warrantyExpiresAt: warrantyExpiry.toISOString(),
      isWarrantyValid: true,
      daysRemaining: 365,
      repairHistoryCount: 0,
    };

    setSearchedDossier(dossier);
    setActiveImeiDossier(dossier);
    soundEngine.playSuccess();
  };

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4 select-none animate-in fade-in">
      <div className="bg-pos-panel border border-pos-border rounded-2xl w-full max-w-xl overflow-hidden shadow-2xl animate-in zoom-in-95 flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="p-4 border-b border-pos-border bg-pos-card flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center text-cyan-400">
              <Smartphone className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-sm font-black text-pos-text flex items-center gap-2">
                Inspecteur IMEI & Traçabilité Garantie
              </h2>
              <p className="text-[11px] text-pos-muted">
                Contrôle instantané de validité de garantie et historique SAV
              </p>
            </div>
          </div>
          <button
            onClick={closeModal}
            className="p-1.5 hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-xl transition cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content Body */}
        <div className="p-5 space-y-4 overflow-y-auto">
          {/* IMEI Search Input */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleLookup(inputImei);
            }}
            className="flex items-center gap-2"
          >
            <div className="relative flex-1">
              <Search className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-pos-muted" />
              <input
                type="text"
                value={inputImei}
                onChange={(e) => setInputImei(e.target.value)}
                placeholder="Scanner ou saisir IMEI à 15 chiffres..."
                className="w-full bg-pos-bg border border-pos-border focus:border-cyan-500 rounded-xl pl-10 pr-3 py-2 text-xs font-mono text-pos-text placeholder-pos-muted focus:outline-none transition-all"
                autoFocus
              />
            </div>
            <button
              type="submit"
              className="px-4 py-2 bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-black text-xs rounded-xl shadow-md transition cursor-pointer"
            >
              Vérifier
            </button>
          </form>

          {/* Dossier Card if found */}
          {currentDossier ? (
            <div className="space-y-3 animate-in fade-in slide-in-from-top-2">
              {/* Status Banner */}
              <div
                className={`p-4 rounded-xl border flex items-center gap-3 ${
                  currentDossier.isWarrantyValid
                    ? 'bg-emerald-500/10 border-emerald-500/40 text-emerald-300'
                    : 'bg-red-500/10 border-red-500/40 text-red-300'
                }`}
              >
                {currentDossier.isWarrantyValid ? (
                  <ShieldCheck className="w-8 h-8 text-emerald-400 shrink-0" />
                ) : (
                  <ShieldAlert className="w-8 h-8 text-red-400 shrink-0" />
                )}
                <div>
                  <p className="text-sm font-black uppercase">
                    {currentDossier.isWarrantyValid
                      ? 'Garantie Magasin Active'
                      : 'Garantie Expirée / Hors Garantie'}
                  </p>
                  <p className="text-xs mt-0.5 font-medium">
                    {currentDossier.isWarrantyValid
                      ? `Valable encore ${currentDossier.daysRemaining} jours (Jusqu'au ${new Date(
                          currentDossier.warrantyExpiresAt!
                        ).toLocaleDateString('fr-DZ')})`
                      : currentDossier.warrantyExpiresAt
                      ? `A expiré le ${new Date(
                          currentDossier.warrantyExpiresAt
                        ).toLocaleDateString('fr-DZ')}`
                      : 'Aucune garantie enregistrée sur ce numéro de série.'}
                  </p>
                </div>
              </div>

              {/* Details List */}
              <div className="bg-pos-card border border-pos-border rounded-xl p-3.5 space-y-2 text-xs">
                <div className="flex justify-between border-b border-pos-border/50 pb-2">
                  <span className="text-pos-muted flex items-center gap-1.5">
                    <Smartphone className="w-3.5 h-3.5 text-cyan-400" /> Appareil :
                  </span>
                  <span className="font-bold text-pos-text">{currentDossier.productTitle}</span>
                </div>

                <div className="flex justify-between border-b border-pos-border/50 pb-2">
                  <span className="text-pos-muted flex items-center gap-1.5">
                    <CheckCircle2 className="w-3.5 h-3.5 text-cyan-400" /> IMEI :
                  </span>
                  <span className="font-mono font-bold text-cyan-300">{currentDossier.imei}</span>
                </div>

                <div className="flex justify-between border-b border-pos-border/50 pb-2">
                  <span className="text-pos-muted flex items-center gap-1.5">
                    <Receipt className="w-3.5 h-3.5 text-emerald-400" /> Facture d'Origine :
                  </span>
                  <span className="font-mono font-bold text-emerald-400">
                    {currentDossier.originalReceiptNumber || 'N/A'}
                  </span>
                </div>

                <div className="flex justify-between border-b border-pos-border/50 pb-2">
                  <span className="text-pos-muted flex items-center gap-1.5">
                    <User className="w-3.5 h-3.5 text-purple-400" /> Client Acheteur :
                  </span>
                  <span className="font-bold text-pos-text">
                    {currentDossier.originalCustomerName || 'Client Comptoir'}
                  </span>
                </div>

                <div className="flex justify-between">
                  <span className="text-pos-muted flex items-center gap-1.5">
                    <Wrench className="w-3.5 h-3.5 text-amber-400" /> Interventions SAV :
                  </span>
                  <span className="font-bold text-pos-text">
                    {currentDossier.repairHistoryCount || 0} prise(s) en charge
                  </span>
                </div>
              </div>
            </div>
          ) : (
            /* Recently Sold / Recorded Serialized Phones */
            <div className="space-y-2">
              <span className="text-[11px] font-bold text-pos-muted uppercase tracking-wider block">
                Appareils & Téléphones Récents ({serializedDevices.length})
              </span>

              {serializedDevices.length > 0 ? (
                <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
                  {serializedDevices.map((dev, idx) => (
                    <div
                      key={idx}
                      onClick={() => handleLookup(dev.imei)}
                      className="p-2.5 rounded-xl bg-pos-card hover:bg-pos-hover border border-pos-border flex items-center justify-between text-xs cursor-pointer transition"
                    >
                      <div className="min-w-0">
                        <p className="font-bold text-pos-text truncate">{dev.productTitle}</p>
                        <p className="text-[10px] font-mono text-cyan-300 truncate">
                          IMEI : {dev.imei}
                        </p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="text-[10px] text-pos-muted">{dev.customerName}</span>
                        <ArrowRight className="w-3.5 h-3.5 text-pos-muted" />
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="p-6 text-center text-pos-muted text-xs border border-dashed border-pos-border rounded-xl">
                  <Smartphone className="w-8 h-8 mx-auto text-pos-muted/40 mb-1.5" />
                  <p>Aucun appareil sérialisé enregistré pour le moment.</p>
                  <p className="text-[10px] mt-0.5">
                    Scannez ou saisissez un IMEI dans le champ ci-dessus pour vérifier.
                  </p>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="p-4 border-t border-pos-border bg-pos-card flex items-center justify-between">
          <button
            onClick={closeModal}
            className="px-4 py-2 rounded-xl text-xs font-bold text-pos-muted hover:text-pos-text transition cursor-pointer"
          >
            Fermer
          </button>
          <button
            onClick={() => {
              closeModal();
              openModal('repair_work_order');
            }}
            className="px-5 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-xs flex items-center gap-1.5 shadow-lg shadow-emerald-500/20 transition cursor-pointer active:scale-[0.98]"
          >
            <Wrench className="w-4 h-4" /> Créer Prise en Charge SAV
          </button>
        </div>
      </div>
    </div>
  );
};
