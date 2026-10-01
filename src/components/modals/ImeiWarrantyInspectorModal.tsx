import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ShieldCheck,
  ShieldAlert,
  Wrench,
  Receipt,
  User,
  Search,
  Smartphone,
  CheckCircle2,
  ArrowRight,
  Printer,
  ScanLine,
  Keyboard,
} from 'lucide-react';
import { usePosStore } from '../../store/usePosStore';
import type { CartItem, ImeiLifecycleDossier, SaleTransaction } from '../../types/pos';
import type { IntakeDraft } from '../../types/pos';
import { soundEngine } from '../../utils/audioFeedback';
import { useToast } from '../ui/Toast';
import ModalShell from '../ui/ModalShell';
import WarrantyBadge from '../ui/WarrantyBadge';
// ZXing (bundled by the scanner) must not ride the entry chunk — load it only
// when the operator actually opens the camera.
const UniversalCameraScannerModal = React.lazy(() =>
  import('../camera/UniversalCameraScannerModal').then((m) => ({
    default: m.UniversalCameraScannerModal,
  }))
);
import {
  DEFAULT_WARRANTY_MONTHS,
  computeDeviceWarranty,
  extractWarrantyMonths,
  formatWarrantyDuration,
  hasExplicitWarranty,
  resolveWarrantyDossier,
  resolveWarrantyMonths,
  resolveWarrantyWithFallback,
  savCountFor,
} from '../../utils/warrantyResolver';
import type { DeviceIdentifierMode } from '../../utils/warrantyResolver';

// Re-exported for backward compat (other modules import these from the modal).
export {
  DEFAULT_WARRANTY_MONTHS,
  computeDeviceWarranty,
  extractWarrantyMonths,
  formatWarrantyDuration,
  hasExplicitWarranty,
  resolveWarrantyMonths,
  resolveWarrantyWithFallback,
};
export type { DeviceIdentifierMode };

const ID_MODE_TABS: Array<{ mode: DeviceIdentifierMode; label: string; hint: string }> = [
  { mode: 'imei', label: 'IMEI', hint: 'Scanner ou saisir IMEI à 15 chiffres...' },
  { mode: 'serial', label: 'N° Série', hint: 'Scanner ou saisir le N° de série...' },
  { mode: 'manual', label: 'Sans ID', hint: 'Appareil sans identifiant lisible' },
];

export const ImeiWarrantyInspectorModal: React.FC = () => {
  const {
    activeModal,
    closeModal,
    activeImeiDossier,
    setActiveImeiDossier,
    openModal,
    seedIntakeDraft,
    clearIntakeDraft,
    transactions,
    products,
    repairOrders,
    imeiRecords,
    receiptSettings,
  } = usePosStore();
  const { showToast } = useToast();

  const [inputImei, setInputImei] = useState('');
  const [idMode, setIdMode] = useState<DeviceIdentifierMode>('imei');
  const [searchedDossier, setSearchedDossier] = useState<ImeiLifecycleDossier | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const lookupDeps = useMemo(
    () => ({ transactions, products, imeiRecords, repairOrders }),
    [transactions, products, imeiRecords, repairOrders]
  );

  // Warranty certificate print for the inspected dossier: resolves the
  // original sale + line item so the orphaned builder finally has a caller.
  const handlePrintCertificate = async (dossier: ImeiLifecycleDossier) => {
    const needle = (dossier.imei || '').trim().toLowerCase();
    const tx = (transactions || []).find(
      (t) =>
        t.receiptNumber === dossier.originalReceiptNumber ||
        (t.items || []).some(
          (i: CartItem) => (i.imeiNumber || '').trim().toLowerCase() === needle
        )
    );
    if (!tx) {
      showToast('Facture d’origine introuvable — certificat indisponible pour ce dossier.', 'warning');
      return;
    }
    const item = (tx.items || []).find(
      (i: CartItem) => (i.imeiNumber || '').trim().toLowerCase() === needle
    );
    if (!item) {
      showToast('Ligne article introuvable sur la facture d’origine.', 'warning');
      return;
    }
    const months = Math.max(1, Math.floor(dossier.warrantyMonths || 3));
    const { SavPrintCoordinator } = await import('../../utils/savPrintCoordinator');
    const ok = await SavPrintCoordinator.printWarrantyCertificate(tx, item, receiptSettings, months);
    showToast(
      ok ? `Certificat de garantie imprimé (${months} mois).` : 'Impression indisponible sur cet appareil.',
      ok ? 'success' : 'error'
    );
  };

  /**
   * THE lookup. Delegates to the shared resolver — there is no second branch
   * order in this component, which is what guarantees the Inspector and the
   * SAV intake agree for the same identifier.
   */
  const handleLookup = (raw: string, mode: DeviceIdentifierMode = idMode) => {
    if (mode === 'manual') {
      setSearchedDossier(null);
      setActiveImeiDossier(null);
      showToast('Mode « Sans ID » : aucun dossier de garantie possible pour un appareil non identifié.', 'warning');
      return;
    }
    soundEngine.playKeyBeep?.();
    const res = resolveWarrantyDossier(raw, mode, lookupDeps);
    if (!res.ok || !res.snapshot) {
      setSearchedDossier(null);
      setActiveImeiDossier(null);
      soundEngine.playError?.();
      showToast(res.note || 'Identifiant invalide.', 'warning');
      return;
    }
    const dossier = res.snapshot.dossier;
    setSearchedDossier(dossier);
    setActiveImeiDossier(dossier);
    if (dossier.isWarrantyValid) soundEngine.playWarrantyActive();
    else soundEngine.playSuccess();
  };

  /**
   * Handoff to SAV. The draft carries the FROZEN resolver snapshot, so the
   * ticket records exactly what the operator saw here — no re-lookup, no lost
   * data, no blank form.
   */
  const handleCreateSavIntake = () => {
    const snapshotState = resolveWarrantyDossier(
      currentDossier?.imei || inputImei,
      currentDossier ? 'imei' : idMode,
      lookupDeps
    );
    if (!snapshotState.ok || !snapshotState.snapshot) {
      showToast(
        'Vérifiez un appareil avant de créer la prise en charge — le dossier SAV exige un identifiant contrôlé.',
        'warning'
      );
      return;
    }
    const snap = snapshotState.snapshot;
    const draft: IntakeDraft = {
      sanitizedId: snap.idValue,
      idType: snap.idMode === 'serial' ? 'serial' : 'imei',
      deviceTitle: snap.dossier.productTitle,
      customer: {
        name: snap.dossier.originalCustomerName && snap.dossier.originalCustomerName !== 'Client Comptoir'
          ? snap.dossier.originalCustomerName
          : undefined,
        phone:
          snap.dossier.originalCustomerPhone && snap.dossier.originalCustomerPhone !== '-'
            ? snap.dossier.originalCustomerPhone
            : undefined,
      },
      warrantyDossier: snap,
      createdAt: new Date().toISOString(),
    };
    // Order matters: seed BEFORE closeModal, because closeModal resets the
    // active dossier and a draft seeded after the switch would be orphaned.
    seedIntakeDraft(draft);
    closeModal();
    openModal('repair_work_order');
    showToast(`Prise en charge ${draft.sanitizedId} transmise au dossier SAV.`, 'success');
  };

  const handleClose = () => {
    // Escape / backdrop close discards an unconsumed draft so a later SAV open
    // can never hydrate from a dossier the operator abandoned.
    clearIntakeDraft();
    closeModal();
  };

  // Extract all serialized devices from transactions, repairs, and inventory —
  // each card carries its warranty state plus SAV history.
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
        repairHistoryCount: savCountFor(repairOrders, base.imei),
      });
    };

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

    (repairOrders || []).forEach((order) => {
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
            repairHistoryCount: savCountFor(repairOrders, rec.imei),
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

  const currentDossier = activeImeiDossier || searchedDossier;
  const canCreateIntake = Boolean(currentDossier);

  // Ctrl/Cmd+Enter submits the lookup from anywhere in the dialog.
  useEffect(() => {
    if (activeModal !== 'imei_inspector') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        handleLookup(inputImei, idMode);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeModal, inputImei, idMode, lookupDeps]);

  /**
   * Direct camera trigger adjacent to the identifier field. ZXing returns the
   * decoded string; we hand it straight to the same resolver path as typing,
   * so a scan can never take a different validation branch.
   */
  const [scannerOpen, setScannerOpen] = useState(false);
  const onScanClick = useCallback(() => setScannerOpen(true), []);

  if (activeModal !== 'imei_inspector') return null;

  const modeTab = ID_MODE_TABS.find((t) => t.mode === idMode)!;

  return (
    <ModalShell
      open
      onClose={handleClose}
      width="xl"
      title="Inspecteur IMEI & Garantie"
      subtitle="Validité de garantie et historique SAV"
      icon={
        <div className="w-8 h-8 sm:w-9 sm:h-9 rounded-xl bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center text-cyan-400 shrink-0">
          <Smartphone className="w-4 h-4 sm:w-5 sm:h-5" />
        </div>
      }
      footer={
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={handleClose}
            className="h-11 sm:h-9 px-3.5 rounded-lg text-xs sm:text-sm font-medium text-pos-muted hover:text-pos-text transition cursor-pointer"
          >
            Fermer
          </button>
          <button
            type="button"
            onClick={handleCreateSavIntake}
            disabled={!canCreateIntake}
            title={
              canCreateIntake
                ? 'Transmettre ce dossier à la prise en charge SAV'
                : 'Vérifiez un appareil d’abord'
            }
            className="h-11 sm:h-9 px-4 rounded-lg bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 disabled:cursor-not-allowed text-slate-950 font-medium text-xs sm:text-sm flex items-center justify-center gap-1.5 shadow-sm transition cursor-pointer active:scale-[0.98]"
          >
            <Wrench className="w-4 h-4" /> Créer Prise en Charge SAV
          </button>
        </div>
      }
    >
      {/* Identifier polymorphism + direct scan trigger */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          handleLookup(inputImei, idMode);
        }}
        className="space-y-2"
      >
        <div
          role="tablist"
          aria-label="Type d'identifiant"
          className="grid grid-cols-3 gap-1 p-1 rounded-lg bg-pos-card border border-pos-border"
        >
          {ID_MODE_TABS.map((tab) => (
            <button
              key={tab.mode}
              type="button"
              role="tab"
              aria-selected={idMode === tab.mode}
              onClick={() => {
                setIdMode(tab.mode);
                setSearchedDossier(null);
                window.setTimeout(() => inputRef.current?.focus(), 0);
              }}
              className={`min-h-[44px] sm:min-h-[36px] rounded-md text-xs font-medium transition ${
                idMode === tab.mode
                  ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40'
                  : 'text-pos-muted border border-transparent hover:text-pos-text'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <div className="relative flex-1 min-w-0">
            <Search className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-pos-muted" aria-hidden="true" />
            <input
              ref={inputRef}
              type="text"
              data-modal-autofocus
              value={inputImei}
              onChange={(e) => setInputImei(e.target.value)}
              inputMode={idMode === 'imei' ? 'numeric' : 'text'}
              disabled={idMode === 'manual'}
              placeholder={modeTab.hint}
              aria-label={modeTab.label}
              className="w-full h-11 sm:h-10 bg-pos-card border border-pos-border focus:border-cyan-500 rounded-lg pl-10 pr-3 py-1.5 text-base sm:text-xs font-mono tabular-nums tracking-normal text-pos-text placeholder:font-sans placeholder:text-pos-muted focus:outline-none focus:ring-1 focus:ring-cyan-500 transition-all disabled:opacity-50"
            />
          </div>
          <button
            type="button"
            onClick={onScanClick}
            className="h-11 sm:h-10 min-w-[44px] px-3 rounded-lg bg-pos-card border border-pos-border text-pos-muted hover:text-pos-text flex items-center gap-1.5 transition cursor-pointer active:scale-95 shrink-0"
            title="Scanner le code-barres / QR de l'appareil"
            aria-label="Scanner l'identifiant"
          >
            <ScanLine className="w-4 h-4" aria-hidden="true" />
            <span className="hidden sm:inline text-xs font-medium">Scanner</span>
          </button>
          <button
            type="submit"
            className="h-11 sm:h-10 px-4 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-medium text-xs sm:text-sm shadow-sm transition cursor-pointer shrink-0"
          >
            Vérifier
          </button>
        </div>
        <p className="text-[10px] text-pos-muted flex items-center gap-1">
          <Keyboard className="w-3 h-3 shrink-0" aria-hidden="true" />
          Ctrl + Entrée pour vérifier · Luhn appliqué uniquement en mode IMEI
        </p>
      </form>

      {currentDossier ? (
        <div className="space-y-3 animate-in fade-in slide-in-from-top-2">
          {(() => {
            const stockWithWarranty =
              !currentDossier.isSold && (currentDossier.warrantyMonths || 0) > 0;
            const tone = currentDossier.isWarrantyValid
              ? 'bg-emerald-50 border-emerald-600/40 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300'
              : stockWithWarranty
                ? 'bg-slate-100 border-slate-600/30 text-slate-700 dark:bg-slate-500/10 dark:text-slate-200'
                : 'bg-rose-50 border-rose-600/40 text-rose-700 dark:bg-rose-500/10 dark:text-rose-300';
            return (
              <div className={`p-3 rounded-lg border flex items-center gap-2.5 ${tone}`}>
                {currentDossier.isWarrantyValid ? (
                  <ShieldCheck className="w-8 h-8 shrink-0" aria-hidden="true" />
                ) : stockWithWarranty ? (
                  <ShieldCheck className="w-8 h-8 shrink-0" aria-hidden="true" />
                ) : (
                  <ShieldAlert className="w-8 h-8 shrink-0" aria-hidden="true" />
                )}
                <div className="min-w-0">
                  <p className="text-xs sm:text-sm font-semibold uppercase tracking-tight">
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
                          ? `A expiré le ${new Date(currentDossier.warrantyExpiresAt).toLocaleDateString('fr-DZ')}`
                          : 'Aucune garantie enregistrée sur ce numéro de série.'}
                  </p>
                </div>
              </div>
            );
          })()}

          <div className="bg-pos-card border border-pos-border rounded-lg p-3 space-y-2 text-xs">
            {[
              {
                icon: <Smartphone className="w-3.5 h-3.5 text-cyan-500" aria-hidden="true" />,
                label: 'Appareil',
                value: currentDossier.productTitle,
                mono: false,
              },
              {
                icon: <CheckCircle2 className="w-3.5 h-3.5 text-cyan-500" aria-hidden="true" />,
                label: idMode === 'serial' ? 'N° Série' : 'IMEI',
                value: currentDossier.imei,
                mono: true,
              },
              {
                icon: <Receipt className="w-3.5 h-3.5 text-emerald-600" aria-hidden="true" />,
                label: "Facture d'Origine",
                value: currentDossier.originalReceiptNumber || 'N/A',
                mono: true,
              },
              {
                icon: <User className="w-3.5 h-3.5 text-violet-500" aria-hidden="true" />,
                label: 'Client Acheteur',
                value: currentDossier.originalCustomerName || 'Client Comptoir',
                mono: false,
              },
              {
                icon: <Wrench className="w-3.5 h-3.5 text-amber-600" aria-hidden="true" />,
                label: 'Garantie incluse',
                value:
                  (currentDossier.warrantyMonths || 0) > 0
                    ? formatWarrantyDuration(currentDossier.warrantyMonths || 0) +
                      (currentDossier.isSold && currentDossier.warrantyExpiresAt
                        ? ` (jusqu'au ${new Date(currentDossier.warrantyExpiresAt).toLocaleDateString('fr-DZ')})`
                        : ' (démarre à la vente)')
                    : 'Aucune',
                mono: false,
              },
              {
                icon: <Wrench className="w-3.5 h-3.5 text-amber-600" aria-hidden="true" />,
                label: 'Interventions SAV',
                value: `${currentDossier.repairHistoryCount || 0} prise(s) en charge`,
                mono: false,
              },
            ].map((row) => (
              <div
                key={row.label}
                className="flex justify-between gap-3 border-b border-pos-border/50 pb-2 last:border-0 last:pb-0"
              >
                <span className="text-pos-muted flex items-center gap-1.5 shrink-0">
                  {row.icon} {row.label} :
                </span>
                <span className={`text-right ${row.mono ? 'font-mono tabular-nums tracking-normal font-medium' : 'font-medium'} text-pos-text`}>
                  {row.value}
                </span>
              </div>
            ))}
          </div>

          {currentDossier.isWarrantyValid && (
            <button
              type="button"
              onClick={() => void handlePrintCertificate(currentDossier)}
              className="w-full h-10 sm:h-9 px-4 rounded-lg bg-emerald-50 hover:bg-emerald-100 dark:bg-emerald-500/15 dark:hover:bg-emerald-500/25 text-emerald-700 dark:text-emerald-300 border border-emerald-500/40 flex items-center justify-center gap-2 transition text-xs sm:text-sm font-medium cursor-pointer active:scale-[0.98]"
              title="Imprimer le certificat de garantie (thermique / feuille mobile)"
            >
              <Printer className="w-4 h-4" aria-hidden="true" /> Imprimer Certificat de Garantie
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          <span className="text-[10px] sm:text-[11px] font-semibold text-pos-muted uppercase tracking-wider block">
            Appareils & Téléphones Récents ({serializedDevices.length})
          </span>

          {serializedDevices.length > 0 ? (
            <div className="space-y-1.5 max-h-64 overflow-y-auto overscroll-contain pr-1">
              {serializedDevices.map((dev) => (
                <button
                  key={dev.imei}
                  type="button"
                  onClick={() => {
                    setInputImei(dev.imei);
                    handleLookup(dev.imei, 'imei');
                  }}
                  className="w-full p-2.5 rounded-lg bg-pos-card hover:bg-pos-hover border border-pos-border flex items-center justify-between gap-2 text-left transition cursor-pointer active:scale-[0.99]"
                >
                  <span className="min-w-0">
                    <span className="font-medium text-pos-text truncate block">{dev.productTitle}</span>
                    <span className="text-[10px] font-mono tabular-nums tracking-normal text-cyan-700 dark:text-cyan-300 truncate block">
                      IMEI : {dev.imei}
                    </span>
                    <span className="flex items-center gap-1.5 mt-1 flex-wrap">
                      {dev.isWarrantyValid ? (
                        <WarrantyBadge tier="repair_90d" size="sm" showExpiry={false} daysRemaining={dev.daysRemaining} />
                      ) : dev.warrantyMonths > 0 ? (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-pos-muted/10 border border-pos-border text-pos-text text-[9px] font-medium uppercase tracking-wide">
                          <ShieldCheck className="w-3 h-3" aria-hidden="true" />
                          {formatWarrantyDuration(dev.warrantyMonths)}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-rose-50 dark:bg-rose-500/10 border border-rose-500/30 text-rose-700 dark:text-rose-300 text-[9px] font-medium uppercase tracking-wide">
                          <ShieldAlert className="w-3 h-3" aria-hidden="true" />
                          Sans garantie
                        </span>
                      )}
                      {dev.repairHistoryCount > 0 && (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-amber-50 dark:bg-amber-500/15 border border-amber-500/40 text-amber-700 dark:text-amber-300 text-[9px] font-medium">
                          <Wrench className="w-3 h-3" aria-hidden="true" />
                          SAV × {dev.repairHistoryCount}
                        </span>
                      )}
                    </span>
                  </span>
                  <span className="flex items-center gap-2 shrink-0">
                    <span className="text-[10px] text-pos-muted truncate max-w-[80px]">{dev.customerName}</span>
                    <ArrowRight className="w-3.5 h-3.5 text-pos-muted shrink-0" aria-hidden="true" />
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <div className="p-6 text-center text-pos-muted text-xs border border-dashed border-pos-border rounded-lg">
              <Smartphone className="w-8 h-8 mx-auto text-pos-muted/40 mb-1.5" aria-hidden="true" />
              <p>Aucun appareil sérialisé enregistré pour le moment.</p>
              <p className="text-[10px] mt-0.5">
                Scannez ou saisissez un IMEI dans le champ ci-dessus pour vérifier.
              </p>
            </div>
          )}
        </div>
      )}

      {scannerOpen && (
        <React.Suspense
          fallback={
            <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 text-pos-text text-xs">
              Ouverture de la caméra…
            </div>
          }
        >
          <UniversalCameraScannerModal
            onClose={() => setScannerOpen(false)}
            onCaptureImage={(_canvas, barcodes) => {
              setScannerOpen(false);
              const code = barcodes.find((b) => b && b.trim()) ?? '';
              if (!code) {
                showToast(
                  'Aucun code-barres détecté — saisissez l’identifiant au clavier.',
                  'warning'
                );
                return;
              }
              // A scanned 15-digit value implies IMEI mode; anything else is a
              // serial. Either way it goes through the ONE resolver path.
              const digits = code.replace(/\D/g, '');
              const nextMode: DeviceIdentifierMode =
                digits.length === 15 && /^\d+$/.test(digits) ? 'imei' : 'serial';
              setIdMode(nextMode);
              setInputImei(code.trim());
              handleLookup(code.trim(), nextMode);
            }}
          />
        </React.Suspense>
      )}
    </ModalShell>
  );
};