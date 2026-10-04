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
  AlertTriangle,
  Eye,
  EyeOff,
  Pencil,
} from 'lucide-react';
import { usePosStore } from '../../store/usePosStore';
import type { CartItem, ImeiLifecycleDossier, WarrantyDossierSnapshot } from '../../types/pos';
import { soundEngine } from '../../utils/audioFeedback';
import { useToast } from '../ui/Toast';
import ModalShell from '../ui/ModalShell';
import WarrantyStatusChips from '../ui/WarrantyStatusChips';
// ZXing (bundled by the scanner) must not ride the entry chunk — load it only
// when the operator actually opens the camera.
const UniversalCameraScannerModal = React.lazy(() =>
  import('../camera/UniversalCameraScannerModal').then((m) => ({
    default: m.UniversalCameraScannerModal,
  }))
);
import {
  DEFAULT_WARRANTY_MONTHS,
  buildSavIntakeDraft,
  buildWarrantyDeviceList,
  computeDeviceWarranty,
  extractWarrantyMonths,
  formatWarrantyDate,
  formatWarrantyDuration,
  hasExplicitWarranty,
  normalizeDeviceKey,
  resolveWarrantyDossier,
  resolveWarrantyMonths,
  resolveWarrantyWithFallback,
  warrantyHeadline,
  warrantyStateLabel,
} from '../../utils/warrantyResolver';
import type { DeviceIdentifierMode, WarrantyStatus } from '../../utils/warrantyResolver';
import {
  canRevealSellerId,
  deviceOriginFor,
  isNationalIdMissing,
  originIndexByKey,
  originViewWithHistory,
  sellerIdAuditDetail,
} from '../../utils/tradeInOrigin';

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

/**
 * Neutral fallback for a dossier that carries no store status at all. Built as a
 * full `WarrantyStatus` so the label helpers keep their real type and no caller
 * has to invent a partial object (a partial would silently bypass the
 * exhaustive switches).
 */
const NEVER_COVERED_STATUS: WarrantyStatus = {
  state: 'NEVER_COVERED',
  kind: 'STORE',
  startDate: null,
  endDate: null,
  daysLeft: 0,
  source: 'none',
  term: 0,
};

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
    tradeIns,
    activeCashier,
    logSecurityAction,
    openTradeInIdentityEdit,
    receiptSettings,
  } = usePosStore();
  const { showToast } = useToast();

  const [inputImei, setInputImei] = useState('');
  const [idMode, setIdMode] = useState<DeviceIdentifierMode>('imei');
  const [searchedDossier, setSearchedDossier] = useState<ImeiLifecycleDossier | null>(null);
  /**
   * The full frozen resolver snapshot behind `searchedDossier`, kept so the SAV
   * handoff reuses exactly what the operator saw. `activeImeiDossier` alone is
   * not enough: the draft also needs `idValue`, `idMode`, `suggestedTier` and
   * `resolvedAt`, and re-deriving them meant a second (mode-clobbered) lookup.
   */
  const [activeSnapshot, setActiveSnapshot] = useState<WarrantyDossierSnapshot | null>(null);
  /**
   * Seller-document reveal state. Masked by DEFAULT; the unmasked value is only
   * ever shown after an explicit manager action that has been written to the
   * audit log. Reset on every device change so a revealed document cannot leak
   * onto the next lookup.
   */
  const [sellerIdRevealed, setSellerIdRevealed] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const lookupDeps = useMemo(
    () => ({ transactions, products, imeiRecords, repairOrders }),
    [transactions, products, imeiRecords, repairOrders]
  );

  // Warranty certificate print for the inspected dossier: resolves the
  // original sale + line item so the orphaned builder finally has a caller.
  const handlePrintCertificate = async (dossier: ImeiLifecycleDossier) => {
    // `dossier.imei` is the SANITIZED identifier (digits-only), while the stored
    // transaction line keeps its ingested form. Comparing raw strings made the
    // certificate printer report "facture introuvable" for every device whose
    // receipt line predates canonical ingestion.
    const needle = normalizeDeviceKey(dossier.imei);
    const tx = (transactions || []).find(
      (t) =>
        t.receiptNumber === dossier.originalReceiptNumber ||
        (t.items || []).some(
          (i: CartItem) => normalizeDeviceKey(i.imeiNumber ?? '') === needle
        )
    );
    if (!tx) {
      showToast('Facture d’origine introuvable — certificat indisponible pour ce dossier.', 'warning');
      return;
    }
    const item = (tx.items || []).find(
      (i: CartItem) => normalizeDeviceKey(i.imeiNumber ?? '') === needle
    );
    if (!item) {
      showToast('Ligne article introuvable sur la facture d’origine.', 'warning');
      return;
    }
    // Months come from the resolved STORE warranty, never from a default. The
    // old `Math.max(1, months || 3)` printed a 3-month certificate for a device
    // whose record says "Sans Garantie" — a signed-looking artefact promising
    // coverage that was never sold. An unknown or uncovered device gets no
    // certificate (fail closed) rather than an invented term.
    const status = dossier.storeWarranty;
    if (!status || dossier.isUnknownDevice || status.term <= 0) {
      showToast(
        "Aucune garantie magasin vérifiable pour cet appareil — certificat non disponible.",
        'warning'
      );
      return;
    }
    const months = status.term;
    const { SavPrintCoordinator } = await import('../../utils/savPrintCoordinator');
    const ok = await SavPrintCoordinator.printWarrantyCertificate(
      tx,
      item,
      receiptSettings,
      months,
      // Print the expiry that was frozen at sale, not a fresh recomputation.
      status.endDate ?? dossier.warrantyExpiresAt ?? null
    );
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
      setActiveSnapshot(null);
      showToast('Mode « Sans ID » : aucun dossier de garantie possible pour un appareil non identifié.', 'warning');
      return;
    }
    soundEngine.playKeyBeep?.();
    const res = resolveWarrantyDossier(raw, mode, lookupDeps);
    if (!res.ok || !res.snapshot) {
      setSearchedDossier(null);
      setActiveImeiDossier(null);
      setActiveSnapshot(null);
      soundEngine.playError?.();
      showToast(res.note || 'Identifiant invalide.', 'warning');
      return;
    }
    const dossier = res.snapshot.dossier;
    setSearchedDossier(dossier);
    setActiveImeiDossier(dossier);
    // The whole snapshot is kept, not just the dossier: the SAV handoff needs
    // `idValue` / `idMode` / `suggestedTier` / `resolvedAt` to build the draft
    // without a second lookup (see handleCreateSavIntake).
    setActiveSnapshot(res.snapshot);
    if (dossier.isWarrantyValid) soundEngine.playWarrantyActive();
    else soundEngine.playSuccess();
  };

  /**
   * Handoff to SAV. Uses the FROZEN snapshot the operator is looking at — it
   * performs NO second lookup.
   *
   * The old code re-resolved here with a hardcoded `'imei'` mode, so a serial
   * device could never create a SAV ticket: the dossier resolved in serial mode,
   * then the CTA threw that same identifier at the 15-digit IMEI gate and
   * refused with "le dossier SAV exige un identifiant contrôlé". Re-lookup also
   * meant the ticket could disagree with the screen it was opened from whenever
   * the underlying rows changed in between.
   */
  const handleCreateSavIntake = () => {
    // The only fallback is a dossier resolved outside this modal's own lookup
    // (e.g. opened directly from the list). It re-resolves in the mode the
    // operator actually selected — never a hardcoded 'imei'.
    const frozen = activeSnapshot;
    const fallbackMode: DeviceIdentifierMode = currentDossier?.imei
      ? normalizeDeviceKey(currentDossier.imei).length === 15
        ? 'imei'
        : 'serial'
      : idMode;
    const snap = frozen ?? resolveWarrantyDossier(currentDossier?.imei || inputImei, fallbackMode, lookupDeps).snapshot;

    if (!snap) {
      showToast(
        'Vérifiez un appareil avant de créer la prise en charge — le dossier SAV exige un identifiant contrôlé.',
        'warning'
      );
      return;
    }
    const draft = buildSavIntakeDraft(snap);
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

  // The list is a VIEW of the same resolver the detail panel uses. It no longer
  // recomputes warranties from the live catalog, which is what let a catalog edit
  // change the list while the detail kept the row's own snapshot (W-01/W-02).
  const serializedDevices = useMemo(
    () => buildWarrantyDeviceList(lookupDeps),
    [lookupDeps]
  );

  const currentDossier = activeImeiDossier || searchedDossier;
  const canCreateIntake = Boolean(currentDossier);

  /**
   * Where the device came from. Present ONLY for a device acquired by trade-in
   * — a device bought from a supplier has no origin and shows no section, rather
   * than an empty "unknown seller" block that could be mistaken for a gap in the
   * police register.
   *
   * The join is by canonical identifier (`normalizeDeviceKey`) because both
   * sides store the IMEI raw, and when several acquisitions share an IMEI the
   * most recent one wins.
   */
  const originIndex = useMemo(() => originIndexByKey(tradeIns), [tradeIns]);
  const origin = useMemo(
    () =>
      deviceOriginFor(tradeIns, [
        ...(currentDossier?.identifiers ?? []),
        ...(currentDossier?.imei ? [currentDossier.imei] : []),
      ]),
    [tradeIns, currentDossier]
  );
  const originViewModel = originViewWithHistory(origin);

  // The reveal is per-device state: any lookup drops it.
  useEffect(() => {
    setSellerIdRevealed(false);
  }, [currentDossier?.imei, inputImei]);

  const canRevealOrigin = canRevealSellerId(activeCashier?.role);

  /**
   * Reveal the seller's document number. Manager-only, and the audit line is
   * written BEFORE the value is shown: an unaudited reveal is exactly the thing
   * this gate exists to prevent. The audit detail carries the masked value, so
   * the log itself never becomes a copy of the PII.
   */
  const handleRevealSellerId = async () => {
    const trade = origin.latest;
    if (!canRevealOrigin || !trade) return;
    try {
      await logSecurityAction(
        'Consultation pièce d\'identité reprise',
        sellerIdAuditDetail({
          action: 'Consultation',
          deviceKey: String(trade.imei ?? ''),
          newValue: trade.nationalIdNumber ?? '',
        }),
        activeCashier?.name || 'Gérant',
        true
      );
    } catch {
      showToast("Journalisation impossible — consultation refusée (fail closed).", 'warning');
      return;
    }
    setSellerIdRevealed(true);
  };

  // One renderer for the two warranty lines, so the STORE and REPAIR rows can
  // never disagree about what they claim.
  const warrantyRowValue = (status: WarrantyStatus | null | undefined, dossier: ImeiLifecycleDossier) => {
    if (!status) return 'Aucune';
    if (status.kind === 'REPAIR') {
      return status.endDate
        ? `${warrantyStateLabel(status)} (jusqu'au ${formatWarrantyDate(status.endDate)})`
        : warrantyStateLabel(status);
    }
    if (status.state === 'NEVER_COVERED') {
      return dossier.isUnknownDevice
        ? 'Aucune (appareil inconnu — non enregistré)'
        : 'Aucune (aucun enregistrement de garantie)';
    }
    if (status.endDate) {
      return `${formatWarrantyDuration(status.term)} jusqu'au ${formatWarrantyDate(status.endDate)}`;
    }
    return `${formatWarrantyDuration(status.term)} (démarre à la vente)`;
  };

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
                // Clear the active dossier AND its snapshot: a snapshot captured
                // in IMEI mode must never be handed to SAV after the operator
                // switched to serial mode.
                setActiveImeiDossier(null);
                setActiveSnapshot(null);
                window.setTimeout(() => inputRef.current?.focus(), 0);
              }}
              className={`min-h-[44px] sm:min-h-[36px] rounded-md text-xs font-medium transition ${
                idMode === tab.mode
                  ? 'bg-cyan-500/10 text-cyan-700 dark:text-cyan-300 border border-cyan-500/40'
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
            const store = currentDossier.storeWarranty;
            const repair = currentDossier.repairWarranty ?? null;
            const state = store?.state ?? 'NEVER_COVERED';
            const tone =
              state === 'ACTIVE' || state === 'EXPIRING_SOON'
                ? 'bg-emerald-50 border-emerald-600/40 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300'
                : state === 'NOT_STARTED'
                  ? 'bg-slate-100 border-slate-600/30 text-slate-700 dark:bg-slate-500/10 dark:text-slate-200'
                  : 'bg-rose-50 border-rose-600/40 text-rose-700 dark:bg-rose-500/10 dark:text-rose-300';
            const showShield = state !== 'EXPIRED' && state !== 'NEVER_COVERED' && state !== 'VOID';
            return (
              <div className={`p-3 rounded-lg border flex items-start gap-2.5 ${tone}`}>
                {showShield ? (
                  <ShieldCheck className="w-8 h-8 shrink-0" aria-hidden="true" />
                ) : (
                  <ShieldAlert className="w-8 h-8 shrink-0" aria-hidden="true" />
                )}
                <div className="min-w-0 space-y-1">
                  <p className="text-xs sm:text-sm font-semibold uppercase tracking-tight">
                    {warrantyStateLabel(store ?? NEVER_COVERED_STATUS)}
                  </p>
                  <p className="text-xs font-medium">{warrantyHeadline(store)}</p>
                  {repair ? (
                    <p className="text-xs font-medium">
                      SAV : {warrantyStateLabel(repair)} — {warrantyHeadline(repair)}
                    </p>
                  ) : null}
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
                label: 'Garantie magasin',
                value: warrantyRowValue(currentDossier.storeWarranty, currentDossier),
                mono: false,
              },
              // S5: the repair warranty is its OWN line, not a variant of the
              // store term. It used to be absent from the panel entirely.
              ...(currentDossier.repairWarranty
                ? [
                    {
                      icon: <Wrench className="w-3.5 h-3.5 text-amber-600" aria-hidden="true" />,
                      label: 'Garantie réparation (SAV)',
                      value: warrantyRowValue(currentDossier.repairWarranty, currentDossier),
                      mono: false,
                    },
                  ]
                : []),
              {
                icon: <Wrench className="w-3.5 h-3.5 text-amber-600" aria-hidden="true" />,
                label: 'Interventions SAV',
                value: `${currentDossier.repairHistoryCount || 0} prise(s) en charge${
                  currentDossier.savTickets?.length
                    ? ` (${currentDossier.savTickets.map((t) => t.ticketNumber).join(', ')})`
                    : ''
                }`,
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

          {/* ── Origine de l'appareil ──────────────────────────────────────
              Shown ONLY for a device acquired by trade-in. A supplier-bought
              device has no origin and gets no section: an empty "seller
              unknown" block would read as a hole in the police register.
              The document number is masked; the reveal is manager-only and
              audited. Nothing here ever reaches a customer-facing print —
              the seller is the PREVIOUS owner, the buyer must only ever see
              their own sale. */}
          {originViewModel && (
            <div className="p-3 rounded-xl border border-pos-border bg-pos-bg space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] font-bold text-pos-muted uppercase tracking-wider flex items-center gap-1.5">
                  <User className="w-3.5 h-3.5" aria-hidden="true" /> Origine de l&apos;appareil
                </span>
                <button
                  type="button"
                  onClick={() => openTradeInIdentityEdit(originViewModel.tradeInId)}
                  aria-label={`Ouvrir la reprise ${originViewModel.tradeInId}`}
                  className="text-[9px] text-pos-muted hover:text-pos-text underline underline-offset-2 decoration-dotted transition cursor-pointer"
                >
                  Reprise {originViewModel.tradeInId}
                </button>
              </div>

              <div className="space-y-1.5 text-xs">
                <div className="flex justify-between gap-3">
                  <span className="text-pos-muted shrink-0">Vendeur :</span>
                  <span className="text-right font-medium text-pos-text truncate">
                    {originViewModel.sellerName}
                  </span>
                </div>
                <div className="flex justify-between gap-3">
                  <span className="text-pos-muted shrink-0">Téléphone vendeur :</span>
                  <span className="text-right font-mono text-pos-text">
                    {originViewModel.sellerPhone || '—'}
                  </span>
                </div>
                <div className="flex justify-between gap-3">
                  <span className="text-pos-muted shrink-0">Reprise le :</span>
                  <span className="text-right font-medium text-pos-text">
                    {formatWarrantyDate(originViewModel.acquiredAt)}
                  </span>
                </div>
                <div className="flex justify-between gap-3 items-start">
                  <span className="text-pos-muted shrink-0 flex items-center gap-1.5 flex-wrap">
                    {originViewModel.idTypeLabel} :
                    {originViewModel.idMissing && (
                      <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/60 bg-amber-500/10 px-2 py-0.5 text-[9px] font-bold text-amber-600 dark:text-amber-300">
                        <AlertTriangle className="w-3 h-3" aria-hidden="true" />
                        Pièce manquante
                      </span>
                    )}
                  </span>
                  <span className="text-right font-mono font-medium text-pos-text break-all">
                    {originViewModel.idMissing
                      ? 'Non renseignée'
                      : sellerIdRevealed && canRevealOrigin
                        ? String(origin.latest?.nationalIdNumber ?? '')
                        : originViewModel.idNumber}
                  </span>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2 pt-1">
                {!originViewModel.idMissing && canRevealOrigin && (
                  <button
                    type="button"
                    onClick={() => void handleRevealSellerId()}
                    className="h-9 px-2.5 rounded-lg border border-pos-border bg-pos-card hover:bg-pos-hover text-pos-text text-[11px] font-medium flex items-center gap-1.5 transition cursor-pointer active:scale-[0.98]"
                  >
                    {sellerIdRevealed ? (
                      <EyeOff className="w-3.5 h-3.5" aria-hidden="true" />
                    ) : (
                      <Eye className="w-3.5 h-3.5" aria-hidden="true" />
                    )}
                    {sellerIdRevealed ? 'Masquer' : 'Afficher'}
                  </button>
                )}
                {originViewModel.idMissing && (
                  <button
                    type="button"
                    onClick={() => openTradeInIdentityEdit(originViewModel.tradeInId)}
                    className="h-9 px-2.5 rounded-lg border border-amber-500/50 bg-amber-500/10 hover:bg-amber-500/20 text-amber-700 dark:text-amber-300 text-[11px] font-medium flex items-center gap-1.5 transition cursor-pointer active:scale-[0.98]"
                  >
                    <Pencil className="w-3.5 h-3.5" aria-hidden="true" />
                    Compléter
                  </button>
                )}
                {/* Every acquisition of this device, not just a count: an IMEI
                    that entered the shop twice is a register question the manager
                    must be able to answer from this screen, so each row is
                    dated and opens the record it names. */}
                {originViewModel.olderCount > 0 && (
                  <details className="w-full pt-1">
                    <summary className="text-[10px] text-pos-muted cursor-pointer select-none">
                      {originViewModel.olderCount} reprise(s) antérieure(s) sur le même appareil
                    </summary>
                    <ul className="mt-1 space-y-1">
                      {origin.history.slice(1).map((trade) => (
                        <li
                          key={trade.id}
                          className="flex items-center justify-between gap-2 text-[10px]"
                        >
                          <span className="text-pos-muted">
                            {formatWarrantyDate(trade.createdAt)}
                          </span>
                          <button
                            type="button"
                            onClick={() => openTradeInIdentityEdit(String(trade.id))}
                            aria-label={`Ouvrir la reprise ${trade.id}`}
                            className="font-mono text-pos-text hover:underline underline-offset-2 decoration-dotted transition cursor-pointer"
                          >
                            {trade.id}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>

              {/* The masked value is also the accessible description, so a
                  screen reader never reads the raw number either. */}
              <p className="sr-only" id="origin-seller-id-desc">
                {originViewModel.idMissing
                  ? "Aucune pièce d'identité enregistrée pour cette reprise."
                  : `Pièce d'identité ${originViewModel.idTypeLabel} se terminant par ${originViewModel.idNumber.slice(-4)}.`}
              </p>
            </div>
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
                      <WarrantyStatusChips store={dev.status} repair={dev.repairStatus} />
                      {dev.repairHistoryCount > 0 && (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-amber-50 dark:bg-amber-500/15 border border-amber-500/40 text-amber-700 dark:text-amber-300 text-[9px] font-medium">
                          <Wrench className="w-3 h-3" aria-hidden="true" />
                          SAV × {dev.repairHistoryCount}
                        </span>
                      )}
                      {/* Trade-in devices whose police-register document was
                          never recorded. Visible in the list so the gap is
                          spotted BEFORE a police request, not after. */}
                      {(() => {
                        const acquired = originIndex.get(normalizeDeviceKey(dev.imei))?.[0];
                        return acquired && isNationalIdMissing(acquired) ? (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-amber-50 dark:bg-amber-500/15 border border-amber-500/50 text-amber-700 dark:text-amber-300 text-[9px] font-medium">
                            <AlertTriangle className="w-3 h-3" aria-hidden="true" />
                            Pièce manquante
                          </span>
                        ) : null;
                      })()}
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