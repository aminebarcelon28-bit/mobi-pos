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
import type { ImeiLifecycleDossier, SaleTransaction, CartItem, RepairOrder, Product } from '../../types/pos';
import { soundEngine } from '../../utils/audioFeedback';

const DEFAULT_WARRANTY_MONTHS = 12;

/** Human warranty duration label, e.g. "Garantie 1 an", "Garantie 6 mois". */
export function formatWarrantyDuration(months: number): string {
  const m = Math.max(0, Math.floor(months || 0));
  if (m <= 0) return 'Sans garantie';
  if (m % 12 === 0) {
    const y = m / 12;
    return `Garantie ${y} an${y > 1 ? 's' : ''}`;
  }
  return `Garantie ${m} mois`;
}

export type WarrantyCarrier = Pick<Product, 'warrantyMonths'> & {
  json_payload?: unknown;
  garantie_magasin?: unknown;
  garantie?: unknown;
  warranty_months?: unknown;
} | null | undefined;

/** Coerce a warranty-like value (12, "12", "12 mois", "1 an") to months. */
function coerceWarrantyMonths(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const direct = Number(value);
  if (Number.isFinite(direct)) return Math.max(0, Math.floor(direct));
  if (typeof value === 'string') {
    const m = value.match(/(\d+)/);
    if (m) return Math.max(0, Math.floor(Number(m[1])));
  }
  return undefined;
}

function readWarrantyField(obj: Record<string, unknown> | null | undefined): number | undefined {
  if (!obj) return undefined;
  const candidates = [
    obj.warrantyMonths,
    obj.garantie_magasin,
    obj.garantie,
    obj.warranty_months,
    (obj as Record<string, unknown>).warranty,
  ];
  for (const c of candidates) {
    const parsed = coerceWarrantyMonths(c);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

/**
 * Raw included store warranty (months) for a product, or 0 when absent. The
 * SQLite authority row carries no warranty_months column — warranty lives on
 * the Dexie product object (warrantyMonths / legacy `garantie_magasin`
 * alias) and inside its nested editor-form blob (json_payload, string or
 * object). All shapes are consulted. An explicit 0 ("Sans Garantie") is
 * preserved as 0.
 */
export function extractWarrantyMonths(prod?: WarrantyCarrier): number {
  const direct = readWarrantyField(prod as Record<string, unknown> | null | undefined);
  if (direct !== undefined) return direct;
  const nested = (prod as { json_payload?: unknown } | null)?.json_payload;
  if (nested) {
    try {
      const inner =
        typeof nested === 'string'
          ? (JSON.parse(nested) as Record<string, unknown>)
          : (nested as Record<string, unknown>);
      const fromBlob = readWarrantyField(inner);
      if (fromBlob !== undefined) return fromBlob;
    } catch {
      // Unparseable blob — fall through to store policy.
    }
  }
  return 0;
}

/** True when a product carries an explicit warranty value (including 0). */
export function hasExplicitWarranty(prod?: WarrantyCarrier): boolean {
  if (readWarrantyField(prod as Record<string, unknown> | null | undefined) !== undefined) return true;
  const nested = (prod as { json_payload?: unknown } | null)?.json_payload;
  if (nested) {
    try {
      const inner =
        typeof nested === 'string'
          ? (JSON.parse(nested) as Record<string, unknown>)
          : (nested as Record<string, unknown>);
      if (readWarrantyField(inner) !== undefined) return true;
    } catch {
      // Ignore — treated as absent.
    }
  }
  return false;
}

/**
 * Included warranty with store-policy default (12 months) when absent.
 * An explicit 0 ("Sans Garantie") is respected and NOT replaced.
 */
export function resolveWarrantyMonths(prod?: WarrantyCarrier): number {
  if (hasExplicitWarranty(prod)) return extractWarrantyMonths(prod);
  const extracted = extractWarrantyMonths(prod);
  return extracted > 0 ? extracted : DEFAULT_WARRANTY_MONTHS;
}

/**
 * Resolve warranty preferring the catalog record, falling back to the
 * transaction-line snapshot (which may carry the warranty at sale time).
 */
export function resolveWarrantyWithFallback(
  primary?: WarrantyCarrier,
  fallback?: WarrantyCarrier
): number {
  if (hasExplicitWarranty(primary)) return extractWarrantyMonths(primary);
  if (hasExplicitWarranty(fallback)) return extractWarrantyMonths(fallback);
  return (
    extractWarrantyMonths(primary) ||
    extractWarrantyMonths(fallback) ||
    DEFAULT_WARRANTY_MONTHS
  );
}

export interface DeviceWarrantyState {
  warrantyMonths: number;
  warrantyExpiresAt: string;
  daysRemaining: number;
  isWarrantyValid: boolean;
}

/**
 * Warranty state for a device card/dossier. Coverage runs from the sale date
 * for sold devices; in-stock devices carry the included duration (coverage
 * starts at sale, so they are never "valid" yet, never "expired" either).
 */
export function computeDeviceWarranty(args: {
  warrantyMonths: number;
  startIso: string;
  sold: boolean;
  nowIso?: string;
}): DeviceWarrantyState {
  const months = Math.max(0, Math.floor(args.warrantyMonths || 0));
  const now = new Date(args.nowIso || new Date().toISOString());
  const expiry = new Date(args.startIso);
  if (Number.isNaN(expiry.getTime())) {
    return { warrantyMonths: months, warrantyExpiresAt: args.startIso, daysRemaining: 0, isWarrantyValid: false };
  }
  expiry.setMonth(expiry.getMonth() + months);
  const daysRemaining = Math.max(0, Math.ceil((expiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)));
  return {
    warrantyMonths: months,
    warrantyExpiresAt: expiry.toISOString(),
    daysRemaining,
    isWarrantyValid: args.sold && months > 0 && daysRemaining > 0,
  };
}

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
    imeiRecords,
  } = usePosStore();

  const [inputImei, setInputImei] = useState('');
  const [searchedDossier, setSearchedDossier] = useState<ImeiLifecycleDossier | null>(null);

  // SAV history count for an IMEI (shared by cards and dossiers).
  const savCountFor = (imei: string) => {
    const needle = imei.trim().toLowerCase();
    return (repairOrders || []).filter(
      (r) => r.imei && r.imei.trim().toLowerCase() === needle
    ).length;
  };

  // Extract all serialized devices from transactions, repairs, and inventory —
  // each card carries its warranty state (months, expiry, validity) plus SAV
  // history so badges render without a second lookup.
  const serializedDevices = useMemo(() => {
    const list: Array<{
      imei: string;
      productTitle: string;
      customerName: string;
      saleDate: string;
      receiptNumber: string;
      warrantyMonths: number;
      warrantyExpiresAt: string;
      daysRemaining: number;
      isWarrantyValid: boolean;
      repairHistoryCount: number;
    }> = [];
    const push = (base: {
      imei: string;
      productTitle: string;
      customerName: string;
      saleDate: string;
      receiptNumber: string;
      warrantyMonths: number;
      sold: boolean;
    }) => {
      if (list.some((i) => i.imei === base.imei)) return;
      const w = computeDeviceWarranty({
        warrantyMonths: base.warrantyMonths,
        startIso: base.saleDate,
        sold: base.sold,
      });
      list.push({
        imei: base.imei,
        productTitle: base.productTitle,
        customerName: base.customerName,
        saleDate: base.saleDate,
        receiptNumber: base.receiptNumber,
        warrantyMonths: w.warrantyMonths,
        warrantyExpiresAt: w.warrantyExpiresAt,
        daysRemaining: w.daysRemaining,
        isWarrantyValid: w.isWarrantyValid,
        repairHistoryCount: savCountFor(base.imei),
      });
    };

    // From valid sales transactions (excluding voided sales and refund credit notes).
    // Warranty ("Garantie Magasin" / garantie_magasin) is fetched from the
    // catalog record first, falling back to the sale-line snapshot, so recent
    // cards always carry the expiry basis without a second lookup.
    (transactions || []).forEach((sale: SaleTransaction) => {
      if (sale.status === 'VOIDED' || sale.isRefund) return;
      (sale.items || []).forEach((item: CartItem) => {
        if (item.imeiNumber && item.imeiNumber.trim()) {
          const matched = (products || []).find((p) => p.id === item.product?.id);
          push({
            imei: item.imeiNumber.trim(),
            productTitle: item.product?.title || matched?.title || 'Smartphone',
            customerName: sale.customer?.name || 'Client Comptoir',
            saleDate: sale.createdAt,
            receiptNumber: sale.receiptNumber || sale.id.slice(0, 8),
            warrantyMonths: resolveWarrantyWithFallback(matched ?? null, item.product ?? null),
            sold: true,
          });
        }
      });
    });

    // From repair work orders
    (repairOrders || []).forEach((order: RepairOrder) => {
      if (order.imei && order.imei.trim()) {
        push({
          imei: order.imei.trim(),
          productTitle: order.deviceModel || 'Appareil SAV',
          customerName: order.customerName || 'Client SAV',
          saleDate: order.createdAt,
          receiptNumber: order.ticketNumber,
          warrantyMonths: DEFAULT_WARRANTY_MONTHS,
          sold: false,
        });
      }
    });

    // From IMEI records registry
    (imeiRecords || []).forEach((rec) => {
      if (!rec.imei) return;
      const prod = (products || []).find((p) => p.id === rec.productId);
      const sold = Boolean(rec.soldAt);
      if (rec.warrantyExpiresAt) {
        const now = new Date();
        const expiry = new Date(rec.warrantyExpiresAt);
        const daysRemaining = Number.isNaN(expiry.getTime())
          ? 0
          : Math.max(0, Math.ceil((expiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)));
        const months = resolveWarrantyMonths(prod);
        if (!list.some((i) => i.imei === rec.imei)) {
          list.push({
            imei: rec.imei,
            productTitle: prod?.title || 'Appareil Enregistré',
            customerName: sold ? 'Appareil Vendu' : 'En Stock Magasin',
            saleDate: rec.soldAt || rec.receivedAt,
            receiptNumber: rec.saleTransactionId ? `TXN-${rec.saleTransactionId.slice(0, 8)}` : 'STOCK',
            warrantyMonths: months,
            warrantyExpiresAt: rec.warrantyExpiresAt,
            daysRemaining: sold ? daysRemaining : 0,
            isWarrantyValid: sold && daysRemaining > 0,
            repairHistoryCount: savCountFor(rec.imei),
          });
        }
        return;
      }
      push({
        imei: rec.imei,
        productTitle: prod?.title || 'Appareil Enregistré',
        customerName: sold ? 'Appareil Vendu' : 'En Stock Magasin',
        saleDate: rec.soldAt || rec.receivedAt,
        receiptNumber: rec.saleTransactionId ? `TXN-${rec.saleTransactionId.slice(0, 8)}` : 'STOCK',
        warrantyMonths: resolveWarrantyMonths(prod),
        sold,
      });
    });

    // From products in stock (imeiNumber when present, else serialized
    // barcode — historically any barcode >= 10 chars, IMEIs being 15).
    (products || []).forEach((prod) => {
      const bar = prod.barcode?.trim();
      const prodImei =
        prod.imeiNumber?.trim() ||
        (prod.isSerialized && bar && bar.length >= 10 ? bar : undefined);
      if (prodImei) {
        push({
          imei: prodImei,
          productTitle: prod.title,
          customerName: 'En Stock Magasin',
          saleDate: new Date().toISOString(),
          receiptNumber: 'STOCK-' + prod.sku,
          warrantyMonths: resolveWarrantyMonths(prod),
          sold: false,
        });
      }
    });

    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transactions, repairOrders, products, imeiRecords]);

  if (activeModal !== 'imei_inspector') return null;

  const currentDossier = activeImeiDossier || searchedDossier;

  const handleLookup = (imeiToSearch: string) => {
    const q = imeiToSearch.trim();
    if (!q) return;

    soundEngine.playKeyBeep?.();

    // 1. Search in transactions (prioritize newest first)
    const sortedSales = [...(transactions || [])].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );

    const matchingTxns = sortedSales.filter((sale) =>
      (sale.items || []).some(
        (i: CartItem) => i.imeiNumber && i.imeiNumber.trim().toLowerCase() === q.toLowerCase()
      )
    );

    if (matchingTxns.length > 0) {
      const latestTxn = matchingTxns[0];
      const isRefunded = matchingTxns.some((t) => t.isRefund) || latestTxn.status === 'REFUNDED';
      const isVoided = latestTxn.status === 'VOIDED';

      // Find original sale (non-refund, non-voided)
      const originalSale = matchingTxns.find((t) => !t.isRefund && t.status !== 'VOIDED') || latestTxn;
      const originalItem = originalSale.items?.find(
        (i: CartItem) => i.imeiNumber && i.imeiNumber.trim().toLowerCase() === q.toLowerCase()
      );

      const matchedProduct = (products || []).find((p) => p.id === originalItem?.product?.id);
      const warrantyMonths = resolveWarrantyWithFallback(
        matchedProduct ?? null,
        originalItem?.product ?? null
      );

      const saleDate = new Date(originalSale.createdAt);
      const warrantyExpiry = new Date(saleDate);
      warrantyExpiry.setMonth(warrantyExpiry.getMonth() + warrantyMonths);

      const now = new Date();
      const diffMs = warrantyExpiry.getTime() - now.getTime();
      const daysRemaining = Math.max(0, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));
      const isWarrantyValid = !isRefunded && !isVoided && daysRemaining > 0;

      const savCount = savCountFor(q);

      let statusSuffix = '';
      if (isVoided) statusSuffix = ' (Vente Annulée)';
      else if (isRefunded) statusSuffix = ' (Article Retourné / Remboursé)';

      const dossier: ImeiLifecycleDossier = {
        imei: q,
        productTitle: (originalItem?.product?.title || matchedProduct?.title || 'Smartphone Vendu') + statusSuffix,
        isSold: !isRefunded && !isVoided,
        warrantyMonths,
        originalReceiptNumber: originalSale.receiptNumber,
        originalCustomerName: originalSale.customer?.name || 'Client Comptoir',
        originalCustomerPhone: originalSale.customer?.phone || '-',
        soldAt: originalSale.createdAt,
        warrantyExpiresAt: warrantyExpiry.toISOString(),
        isWarrantyValid,
        daysRemaining: isRefunded || isVoided ? 0 : daysRemaining,
        repairHistoryCount: savCount,
      };

      setSearchedDossier(dossier);
      setActiveImeiDossier(dossier);
      if (isWarrantyValid) {
        soundEngine.playWarrantyActive();
      } else {
        soundEngine.playError();
      }
      return;
    }

    // 2. Search in repair work orders
    const foundRepair = (repairOrders || []).find(
      (r) => r.imei && r.imei.trim().toLowerCase() === q.toLowerCase()
    );

    if (foundRepair) {
      const now = new Date();
      const savCount = savCountFor(q);

      const dossier: ImeiLifecycleDossier = {
        imei: q,
        productTitle: foundRepair.deviceModel || 'Appareil SAV',
        isSold: false,
        warrantyMonths: DEFAULT_WARRANTY_MONTHS,
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

    // 3. Search in IMEI records registry
    const foundImeiRecord = (imeiRecords || []).find(
      (r) => r.imei.trim().toLowerCase() === q.toLowerCase()
    );

    if (foundImeiRecord) {
      const matchedProd = (products || []).find((p) => p.id === foundImeiRecord.productId);
      const isSold = Boolean(foundImeiRecord.soldAt);
      const now = new Date();
      const warrantyMonths = resolveWarrantyMonths(matchedProd);
      const baseDate = new Date(foundImeiRecord.soldAt || foundImeiRecord.receivedAt);
      const warrantyExpiry = foundImeiRecord.warrantyExpiresAt
        ? new Date(foundImeiRecord.warrantyExpiresAt)
        : new Date(baseDate.setMonth(baseDate.getMonth() + warrantyMonths));
      const diffMs = warrantyExpiry.getTime() - now.getTime();
      const daysRemaining = Math.max(0, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));
      const isWarrantyValid = isSold && daysRemaining > 0;

      const savCount = savCountFor(q);

      const dossier: ImeiLifecycleDossier = {
        imei: q,
        productTitle: matchedProd?.title || 'Appareil Enregistré',
        isSold,
        warrantyMonths,
        originalReceiptNumber: foundImeiRecord.saleTransactionId ? `TXN-${foundImeiRecord.saleTransactionId.slice(0, 8)}` : 'STOCK',
        originalCustomerName: isSold ? 'Client Enregistré' : 'Article en Stock Magasin',
        originalCustomerPhone: '-',
        soldAt: foundImeiRecord.soldAt || foundImeiRecord.receivedAt,
        warrantyExpiresAt: warrantyExpiry.toISOString(),
        isWarrantyValid,
        daysRemaining: isSold ? daysRemaining : 0,
        repairHistoryCount: savCount,
      };

      setSearchedDossier(dossier);
      setActiveImeiDossier(dossier);
      soundEngine.playSuccess();
      return;
    }

    // 4. Search in inventory products
    const foundProduct = (products || []).find(
      (p) =>
        (p.imeiNumber && p.imeiNumber.trim().toLowerCase() === q.toLowerCase()) ||
        (p.barcode && p.barcode.trim().toLowerCase() === q.toLowerCase()) ||
        p.sku.toLowerCase() === q.toLowerCase() ||
        (p.isSerialized && p.title.toLowerCase().includes(q.toLowerCase()))
    );

    if (foundProduct) {
      // In-stock device: fetch the real included warranty (product record +
      // nested form blob) and the real SAV history instead of blank defaults —
      // coverage itself starts at sale, but the card/dossier must show it.
      const now = new Date();
      const warrantyMonths = resolveWarrantyMonths(foundProduct);
      const savCount = savCountFor(q);
      const preview = computeDeviceWarranty({
        warrantyMonths,
        startIso: now.toISOString(),
        sold: false,
      });
      const dossier: ImeiLifecycleDossier = {
        imei: q,
        productTitle: foundProduct.title,
        isSold: false,
        warrantyMonths,
        originalReceiptNumber: 'STOCK-' + foundProduct.sku,
        originalCustomerName: 'Article en Stock Magasin (Non Vendu)',
        originalCustomerPhone: '-',
        soldAt: now.toISOString(),
        warrantyExpiresAt: preview.warrantyExpiresAt,
        isWarrantyValid: false,
        daysRemaining: 0,
        repairHistoryCount: savCount,
      };

      setSearchedDossier(dossier);
      setActiveImeiDossier(dossier);
      soundEngine.playSuccess();
      return;
    }

    // 5. Fallback: Not found in database (Strictly Non-Registered / No Warranty)
    const now = new Date();
    const dossier: ImeiLifecycleDossier = {
      imei: q,
      productTitle: `Appareil Non Référencé (IMEI ${q.length >= 8 ? q.slice(0, 8) + '...' : q})`,
      isSold: false,
      originalReceiptNumber: 'NON ENREGISTRÉ',
      originalCustomerName: 'Appareil Inconnu / Hors Réseau',
      originalCustomerPhone: '-',
      soldAt: now.toISOString(),
      warrantyExpiresAt: now.toISOString(),
      isWarrantyValid: false,
      daysRemaining: 0,
      repairHistoryCount: 0,
    };

    setSearchedDossier(dossier);
    setActiveImeiDossier(dossier);
    soundEngine.playError?.();
  };

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 pt-[max(0.5rem,var(--safe-top))] pb-[max(0.5rem,var(--safe-bottom))] select-none animate-in fade-in">
      <div className="bg-pos-panel border border-pos-border rounded-t-3xl sm:rounded-2xl w-full max-w-xl overflow-hidden shadow-2xl animate-in slide-in-from-bottom-5 sm:zoom-in-95 flex flex-col max-h-[94vh] sm:max-h-[90vh]">
        {/* Mobile drag handle */}
        <div className="w-8 h-1 rounded-full bg-pos-muted/40 mx-auto mt-2.5 mb-1 sm:hidden shrink-0" />

        {/* Header */}
        <div className="p-3.5 sm:p-4 border-b border-pos-border bg-pos-card flex items-center justify-between gap-2 shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 sm:w-9 sm:h-9 rounded-xl bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center text-cyan-400 shrink-0">
              <Smartphone className="w-4 h-4 sm:w-5 sm:h-5" />
            </div>
            <div className="min-w-0">
              <h2 className="text-xs sm:text-sm font-black text-pos-text flex items-center gap-2 truncate">
                Inspecteur IMEI & Garantie
              </h2>
              <p className="text-[10px] sm:text-[11px] text-pos-muted truncate">
                Validité de garantie et historique SAV
              </p>
            </div>
          </div>
          <button
            onClick={closeModal}
            className="p-1.5 hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-xl transition cursor-pointer min-h-[38px] min-w-[38px] flex items-center justify-center shrink-0"
            aria-label="Fermer"
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
              {/* Status Banner (sold+valid / in-stock with included warranty / expired) */}
              {(() => {
                const stockWithWarranty =
                  !currentDossier.isSold && (currentDossier.warrantyMonths || 0) > 0;
                const tone = currentDossier.isWarrantyValid
                  ? 'bg-emerald-500/10 border-emerald-500/40 text-emerald-300'
                  : stockWithWarranty
                  ? 'bg-slate-500/10 border-slate-500/40 text-slate-200'
                  : 'bg-red-500/10 border-red-500/40 text-red-300';
                return (
                  <div className={`p-4 rounded-xl border flex items-center gap-3 ${tone}`}>
                    {currentDossier.isWarrantyValid ? (
                      <ShieldCheck className="w-8 h-8 text-emerald-400 shrink-0" />
                    ) : stockWithWarranty ? (
                      <ShieldCheck className="w-8 h-8 text-slate-300 shrink-0" />
                    ) : (
                      <ShieldAlert className="w-8 h-8 text-red-400 shrink-0" />
                    )}
                    <div>
                      <p className="text-sm font-black uppercase">
                        {currentDossier.isWarrantyValid
                          ? 'Garantie Magasin Active'
                          : stockWithWarranty
                          ? `En stock — ${formatWarrantyDuration(currentDossier.warrantyMonths || 0)} incluse`
                          : 'Garantie Expirée / Hors Garantie'}
                      </p>
                      <p className="text-xs mt-0.5 font-medium">
                        {currentDossier.isWarrantyValid
                          ? `Valable encore ${currentDossier.daysRemaining} jours (Jusqu'au ${new Date(
                              currentDossier.warrantyExpiresAt!
                            ).toLocaleDateString('fr-DZ')})`
                          : stockWithWarranty
                          ? 'Couverture démarrant à la vente. Historique SAV ci-dessous.'
                          : currentDossier.warrantyExpiresAt
                          ? `A expiré le ${new Date(
                              currentDossier.warrantyExpiresAt
                            ).toLocaleDateString('fr-DZ')}`
                          : 'Aucune garantie enregistrée sur ce numéro de série.'}
                      </p>
                    </div>
                  </div>
                );
              })()}

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

                <div className="flex justify-between border-b border-pos-border/50 pb-2">
                  <span className="text-pos-muted flex items-center gap-1.5">
                    <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" /> Garantie incluse :
                  </span>
                  <span className="font-bold text-pos-text">
                    {(currentDossier.warrantyMonths || 0) > 0
                      ? formatWarrantyDuration(currentDossier.warrantyMonths || 0) +
                        (currentDossier.isSold && currentDossier.warrantyExpiresAt
                          ? ` (jusqu'au ${new Date(currentDossier.warrantyExpiresAt).toLocaleDateString('fr-DZ')})`
                          : ' (démarre à la vente)')
                      : 'Aucune'}
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
                Appareils & Téléphones Récents ({(serializedDevices || []).length})
              </span>

              {(serializedDevices || []).length > 0 ? (
                <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
                  {(serializedDevices || []).map((dev, idx) => (
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
                        <div className="flex items-center gap-1.5 mt-1">
                          {dev.isWarrantyValid ? (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 text-[9px] font-black uppercase tracking-wide">
                              <ShieldCheck className="w-3 h-3" />
                              Sous garantie{dev.daysRemaining > 0 ? ` • ${dev.daysRemaining}j` : ''}
                            </span>
                          ) : dev.warrantyMonths > 0 ? (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-slate-500/15 border border-slate-500/40 text-slate-300 text-[9px] font-black uppercase tracking-wide">
                              <ShieldCheck className="w-3 h-3" />
                              {formatWarrantyDuration(dev.warrantyMonths)}
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-rose-500/10 border border-rose-500/30 text-rose-300 text-[9px] font-black uppercase tracking-wide">
                              <ShieldAlert className="w-3 h-3" />
                              Sans garantie
                            </span>
                          )}
                          {dev.repairHistoryCount > 0 && (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-amber-500/15 border border-amber-500/40 text-amber-300 text-[9px] font-bold">
                              <Wrench className="w-3 h-3" />
                              SAV × {dev.repairHistoryCount}
                            </span>
                          )}
                        </div>
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
