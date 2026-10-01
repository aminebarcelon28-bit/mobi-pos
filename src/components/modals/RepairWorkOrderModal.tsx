import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  Wrench,
  CheckCircle2,
  Plus,
  Printer,
  History,
  Edit,
  Search,
  UserCheck,
  Smartphone,
  ShieldAlert,
  ShieldCheck,
  Camera,
  Battery,
  Volume2,
  Zap,
  MessageSquare,
  Check,
  FileCheck,
  FileText,
  ScanLine,
  ChevronDown,
  ClipboardCheck,
} from 'lucide-react';
import { usePosStore } from '../../store/usePosStore';
import { REPAIR_BALANCE_DUE_EVENT, REPAIR_DELIVERED_EVENT } from '../../store/slices/createRepairSlice';
import {
  formatDZD,
  formatDateTime,
  faitALine,
  DATA_LOSS_DISCLAIMER,
  UNCLAIMED_DEVICE_CLAUSE,
  REPAIR_STATUS_BADGE_TOKENS,
  REPAIR_SCHEMA_VERSION,
  computeWarrantyExpiryISO,
  repairRemainingBalance,
  repairQuoteNumber,
  repairFinancials,
  REPAIR_QUOTE_VALIDITY_DAYS,
  RESTITUTION_UNSETTLED_BANNER,
  LEGACY_DOSSIER_PILL,
  WARRANTY_TIER_LABELS,
  SAV_LEGAL_TERMS_FR,
  SAV_LEGAL_TERMS_AR,
  DEVICE_ID_KIND_LABELS,
  STORED_ID_KIND_LABELS,
  DEVICE_LOCK_LABELS,
  hasDeviceLock,
  describeIntakeDamage,
  intakeDamageSeverity,
  intakeBlocksRepairWarranty,
  isSchemaV2Order,
  warrantyMonthsToTier,
} from '../../types/pos';
import type {
  ConditionChecklist as LegacyConditionChecklist,
  IntakeDamageAssessment,
  IntakeDraft,
  IntakePhotoRef,
  RepairNotificationType,
  RepairOrder,
  RepairPrintKind,
  WarrantyDossierSnapshot,
  WarrantySnapshot,
  WarrantyTier,
} from '../../types/pos';
import { printCoordinator } from '../../utils/printCoordinator';
import { useToast } from '../ui/Toast';
import ModalShell from '../ui/ModalShell';
import ConditionChecklist, { EMPTY_DAMAGE } from '../ui/ConditionChecklist';
import WarrantyTierSelector from '../ui/WarrantyTierSelector';
import SignaturePad from '../ui/SignaturePad';
import WarrantyBadge from '../ui/WarrantyBadge';
import { QRCodeImage } from '../ui/QRCodeImage';
import { isMobileDevice } from '../../utils/platform';
import { cancelSavPrints, enqueueSavPrint } from '../../utils/savPrintQueue';
import { saveSavPhoto } from '../../utils/savAttachments';
import { validateRepairIntake } from '../../store/slices/createRepairSlice';
import {
  formatDzPhoneDisplay,
  imeiCheckState,
  isValidDzPhone,
  sanitizeDzPhone,
} from '../../utils/savValidation';
import { resolveWarrantyDossier, sanitizeDeviceIdentifier } from '../../utils/warrantyResolver';
import type { DeviceIdentifierMode } from '../../utils/warrantyResolver';

// Camera scanner is heavy (ZXing bundled): loaded on demand only, so opening
// the SAV form never pays for the barcode chunk.
const UniversalCameraScannerModal = React.lazy(() =>
  import('../camera/UniversalCameraScannerModal').then((m) => ({
    default: m.UniversalCameraScannerModal,
  }))
);

/** v1 boolean checklist — kept only for the legacy read-only renderer. */
const initialChecklist: LegacyConditionChecklist = {
  screenOk: false,
  faceIdOk: false,
  cameraOk: false,
  chargingOk: false,
  bodyOk: false,
  batteryOk: false,
  audioOk: false,
};

const DEVICE_PRESETS = [
  'iPhone 15 Pro Max',
  'iPhone 15 Pro',
  'iPhone 14 Pro Max',
  'iPhone 13 Pro',
  'Samsung S24 Ultra',
  'Samsung S23 Ultra',
  'Xiaomi Redmi Note 13',
  'Google Pixel 8 Pro',
];

/** How many of the 7 legacy v1 checks are ticked — shown on the closed disclosure. */
const countOk = (c: LegacyConditionChecklist): number =>
  [c.screenOk, c.faceIdOk, c.cameraOk, c.chargingOk, c.bodyOk, c.batteryOk, c.audioOk].filter(
    Boolean
  ).length;

/**
 * Inspector dossiers carry an inventory suffix on the product title
 * (e.g. "iPhone 13 Pro (Occasion A)"). The ticket's device model field is a
 * free-text model name, so the storage suffix is stripped at the boundary
 * instead of being carried into the printable work order.
 */
const stripDossierSuffix = (title: string): string =>
  title.replace(/\s*\((?:Occasion|Neuf|Reconditionné|Stock|Vitrine)[^)]*\)\s*$/i, '').trim();

export const RepairWorkOrderModal: React.FC = () => {
  const {
    activeModal,
    closeModal,
    repairOrders,
    createRepairOrder,
    updateRepairOrder,
    updateRepairOrderStatus,
    customers,
    receiptSettings,
    openModal,
    setSelectedRepairOrderForNotification,
    transactions,
    products,
    imeiRecords,
    pendingRepairPrint,
    setPendingRepairPrint,
    consumeIntakeDraft,
    clearIntakeDraft,
  } = usePosStore();

  const { showToast } = useToast();

  // A completed repair with an unpaid balance never auto-logs drawer cash:
  // the slice broadcasts REPAIR_BALANCE_DUE_EVENT — toast here and route the
  // cashier to an EXPLICIT shift-movement deposit (Mouvements de caisse).
  useEffect(() => {
    const onBalanceDue = (e: Event) => {
      const detail =
        (e as CustomEvent<{ ticketNumber?: string; remainingBalance?: number }>).detail || {};
      const amount = Math.max(0, Math.round(Number(detail.remainingBalance) || 0));
      if (amount <= 0) return;
      showToast(
        `Ticket SAV #${detail.ticketNumber || '?'} soldé avec ${formatDZD(amount)} restants — enregistrez un dépôt manuel explicite (Mouvements de caisse → Dépôt manuel) pour encaisser le solde.`,
        'warning',
        8000
      );
    };
    window.addEventListener(REPAIR_BALANCE_DUE_EVENT, onBalanceDue);
    return () => window.removeEventListener(REPAIR_BALANCE_DUE_EVENT, onBalanceDue);
  }, [showToast]);

  // Delivery handshake: checkout settled SAV line(s) → open the dossier on the
  // delivered ticket with a direct [Imprimer Bon de Restitution] banner.
  // Listener lives on the always-mounted host, so it fires even though the
  // settle path closed this modal.
  const [justDelivered, setJustDelivered] = useState<{ tickets: string[]; receipt: string } | null>(null);
  useEffect(() => {
    const onDelivered = (e: Event) => {
      const detail =
        (e as CustomEvent<{ ticketNumbers?: string[]; receiptNumber?: string }>).detail || {};
      const tickets = (detail.ticketNumbers || []).filter(Boolean);
      if (tickets.length === 0) return;
      setJustDelivered({ tickets, receipt: detail.receiptNumber || '' });
      setActiveTab('Historique');
      setHistorySearch(tickets[0]);
      setHistoryStatusFilter('Tous');
      openModal('repair_work_order');
      showToast(
        `Ticket${tickets.length > 1 ? 's' : ''} ${tickets.join(', ')} livré${tickets.length > 1 ? 's' : ''} — imprimez le bon de restitution.`,
        'success',
        8000
      );
    };
    window.addEventListener(REPAIR_DELIVERED_EVENT, onDelivered);
    return () => window.removeEventListener(REPAIR_DELIVERED_EVENT, onDelivered);
  }, [showToast, openModal]);

  // Cross-modal reprint handshake (Command archive → this modal): consume and
  // reset immediately on mount so re-renders never repeat the print.
  const [printingDocKind, setPrintingDocKind] = useState<RepairPrintKind>('work_order');
  useEffect(() => {
    if (activeModal !== 'repair_work_order' || !pendingRepairPrint) return;
    const req = pendingRepairPrint;
    setPendingRepairPrint(null);
    const order = usePosStore.getState().repairOrders.find((r) => r.id === req.orderId);
    if (!order) {
      showToast('Dossier SAV introuvable pour réimpression.', 'warning');
      return;
    }
    setActiveTab('Historique');
    setHistorySearch(order.ticketNumber);
    void fireDocPrint(order, req.kind);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeModal, pendingRepairPrint]);

  const [activeTab, setActiveTab] = useState<'Nouveau' | 'Historique'>('Nouveau');
  // Mobile KPI disclosure. Desktop ignores it (the grid is always shown).
  const [kpiOpen, setKpiOpen] = useState(false);
  const [successMsg, setSuccessMsg] = useState<string>('');

  // History Search & Filter State
  const [historySearch, setHistorySearch] = useState<string>('');
  const [historyStatusFilter, setHistoryStatusFilter] = useState<string>('Tous');

  // Form State
  const [editingId, setEditingId] = useState<string | null>(null);
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [deviceModel, setDeviceModel] = useState('');
  const [imei, setImei] = useState('');
  /** Identifier polymorphism: IMEI (Luhn-gated) / serial / none. */
  const [imeiKind, setImeiKind] = useState<DeviceIdentifierMode>('imei');
  const [problemDescription, setProblemDescription] = useState('');
  const [diagnosticNotes, setDiagnosticNotes] = useState('');
  const [laborCost, setLaborCost] = useState<number>(0);
  const [partsCost, setPartsCost] = useState<number>(0);
  const [depositAmount, setDepositAmount] = useState<number>(0);
  const [estimatedDate, setEstimatedDate] = useState('');
  const [status, setStatus] = useState<RepairOrder['status']>('Diagnostic');
  const [checklist, setChecklist] = useState<LegacyConditionChecklist>(initialChecklist);
  const [postChecklist, setPostChecklist] = useState<LegacyConditionChecklist>(initialChecklist);
  const [printingOrder, setPrintingOrder] = useState<RepairOrder | null>(null);
  // Phase 3: intake validation + warranty auto-hook (warn-only, never blocks save).
  const [imeiTouched, setImeiTouched] = useState(false);
  const [phoneTouched, setPhoneTouched] = useState(false);
  // v2 legal record state.
  const [intakeDamage, setIntakeDamage] = useState<IntakeDamageAssessment>(EMPTY_DAMAGE);
  const [signatureIntake, setSignatureIntake] = useState<string | null>(null);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [warrantyTier, setWarrantyTier] = useState<WarrantyTier | undefined>(undefined);
  const [suggestedTier, setSuggestedTier] = useState<WarrantyTier | null>(null);
  const [intakePhotos, setIntakePhotos] = useState<IntakePhotoRef[]>([]);
  const [photosBusy, setPhotosBusy] = useState(false);
  const [warrantyDossier, setWarrantyDossier] = useState<WarrantyDossierSnapshot | null>(null);
  const [warrantyLoading, setWarrantyLoading] = useState(false);
  const [warrantySnapshot, setWarrantySnapshot] = useState<WarrantySnapshot | undefined>(undefined);
  const [mobileChecklistTab, setMobileChecklistTab] = useState<'pre' | 'post'>('pre');
  const warrantyTimer = useRef<number | null>(null);
  const imeiInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  /** Orders that must not print (cancelled mid-flight). */
  const printScopeRef = useRef<string | null>(null);
  /** Aborts the in-flight desktop triad when the modal closes. */
  const activePrintController = useRef<AbortController | null>(null);

  const imeiState = imeiTouched || imei ? imeiCheckState(imei) : 'idle';
  const phoneValid = !customerPhone || isValidDzPhone(customerPhone);
  const showPhoneHint = (phoneTouched || customerPhone) && customerPhone.trim() !== '' && !phoneValid;
  const damageSeverity = intakeDamageSeverity(intakeDamage);
  const money = repairFinancials({ laborCost, partsCost, depositAmount });

  /**
   * Inspector → SAV hydration. Runs once when the modal opens for a NEW ticket
   * and consumes the draft atomically, so a reopen cannot replay it and the
   * customer/device data survives the modal switch.
   */
  const hydratedDraftRef = useRef(false);
  useEffect(() => {
    if (activeModal !== 'repair_work_order' || hydratedDraftRef.current) return;
    if (editingId) return;
    hydratedDraftRef.current = true;
    const draft: IntakeDraft | null = consumeIntakeDraft();
    if (!draft) return;
    setImei(draft.sanitizedId);
    setImeiKind(draft.idType === 'serial' ? 'serial' : 'imei');
    setImeiTouched(true);
    if (draft.deviceTitle) setDeviceModel(stripDossierSuffix(draft.deviceTitle));
    if (draft.customer.name) setCustomerName(draft.customer.name);
    if (draft.customer.phone) setCustomerPhone(formatDzPhoneDisplay(draft.customer.phone) || draft.customer.phone);
    setWarrantyDossier(draft.warrantyDossier);
    setSuggestedTier(draft.warrantyDossier.suggestedTier);
    showToast(
      `Dossier ${draft.sanitizedId} repris de l’inspecteur — vérifiez le constat avant enregistrement.`,
      'success'
    );
  }, [activeModal, consumeIntakeDraft, editingId, showToast]);

  // Any modal close discards an unconsumed draft + in-flight prints, so a
  // later open can never hydrate from abandoned state or print stale content.
  useEffect(() => {
    if (activeModal === 'repair_work_order') return;
    hydratedDraftRef.current = false;
    clearIntakeDraft();
    cancelSavPrints(printScopeRef.current || '');
    printScopeRef.current = null;
    activePrintController.current?.abort();
    activePrintController.current = null;
  }, [activeModal, clearIntakeDraft]);

  // Debounced warranty lookup. Delegates to the SAME resolver the Inspector
  // uses — one authority, one answer per identifier.
  const runWarrantyLookup = (value: string, mode: DeviceIdentifierMode = imeiKind) => {
    const res = resolveWarrantyDossier(value, mode, {
      transactions,
      products,
      imeiRecords,
      repairOrders,
    });
    setWarrantyLoading(false);
    if (mode === 'imei' && value.trim().length < 8) {
      setWarrantyDossier(null);
      return;
    }
    setWarrantyDossier(res.snapshot);
    setSuggestedTier(res.snapshot?.suggestedTier ?? null);
  };

  const handleImeiChange = (raw: string) => {
    setImei(raw);
    setImeiTouched(true);
    setWarrantyLoading(raw.trim().length >= 8);
    if (warrantyTimer.current) window.clearTimeout(warrantyTimer.current);
    warrantyTimer.current = window.setTimeout(() => {
      runWarrantyLookup(raw.trim().toUpperCase(), imeiKind);
    }, 400);
  };

  const handleImeiBlur = () => {
    setImeiTouched(true);
    if (imeiKind === 'manual') {
      setImei('');
      setWarrantyDossier(null);
      return;
    }
    const normalized = (imei || '').trim().toUpperCase();
    const sanitized = sanitizeDeviceIdentifier(normalized, imeiKind);
    setImei(sanitized.value);
    runWarrantyLookup(sanitized.value, imeiKind);
  };

  const handleScanClick = useCallback(() => {
    setScannerOpen(true);
  }, []);
  const [scannerOpen, setScannerOpen] = useState(false);

  /** A scanned 15-digit value implies IMEI; anything else is a serial. */
  const handleScannedCode = (rawCode: string) => {
    setScannerOpen(false);
    const code = rawCode.trim();
    if (!code) {
      showToast('Aucun code-barres détecté — saisissez l’identifiant au clavier.', 'warning');
      return;
    }
    const digits = code.replace(/\D/g, '');
    const nextMode: DeviceIdentifierMode = /^\d{15}$/.test(digits) ? 'imei' : 'serial';
    setImeiKind(nextMode);
    setImeiTouched(true);
    const sanitized = sanitizeDeviceIdentifier(code, nextMode);
    setImei(sanitized.value);
    setWarrantyLoading(true);
    runWarrantyLookup(sanitized.value, nextMode);
  };

  const handlePhoneChange = (raw: string) => {
    // Live mask 0X XX XX XX XX; store display string, sanitize on save.
    const digits = raw.replace(/\D/g, '');
    if (digits.length <= 10 || raw.trim() === '') {
      setCustomerPhone(formatDzPhoneDisplay(raw) || raw);
    } else {
      setCustomerPhone(raw);
    }
  };

  const handleApplyWarranty = () => {
    const dossier = warrantyDossier?.dossier;
    if (!dossier) return;
    const tier = warrantyTier ?? warrantyDossier?.suggestedTier ?? warrantyMonthsToTier(dossier.warrantyMonths);
    setLaborCost(0);
    setPartsCost(0);
    setWarrantyTier(tier);
    const expiry = dossier.warrantyExpiresAt
      ? new Date(dossier.warrantyExpiresAt).toLocaleDateString('fr-DZ')
      : '';
    setWarrantySnapshot({
      isUnderWarranty: true,
      label: `Garantie Magasin Active — Échéance ${expiry}`,
      expiryDate: dossier.warrantyExpiresAt,
    });
    setDiagnosticNotes((prev) => {
      const tag = `[Prise en charge garantie le ${new Date().toLocaleDateString('fr-DZ')}]`;
      return prev?.includes('Prise en charge garantie') ? prev : `${tag}${prev ? ` ${prev}` : ''}`;
    });
    showToast(
      'Prise en charge sous garantie appliquée (main d’œuvre + pièces à 0 — ajustables).',
      'success'
    );
  };

  // Escape / close with dirty-form discard confirmation (desktop ergonomics).
  // The unconsumed draft is dropped at the same time, so a cancelled intake
  // can never be replayed into the next ticket.
  const handleRequestClose = useCallback(() => {
    const dirty =
      customerName.trim() !== '' ||
      deviceModel.trim() !== '' ||
      imei.trim() !== '' ||
      problemDescription.trim() !== '';
    if (!dirty || window.confirm('Fermer la fiche SAV ? Les modifications non enregistrées seront perdues.')) {
      clearIntakeDraft();
      closeModal();
    }
  }, [customerName, deviceModel, imei, problemDescription, clearIntakeDraft, closeModal]);

  useEffect(() => {
    if (activeModal !== 'repair_work_order') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        handleRequestClose();
        return;
      }
      // Ctrl/Cmd+Enter saves from anywhere in the form — a POS operator should
      // never have to reach the footer button with the keyboard.
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        const form = document.getElementById('sav-intake-form') as HTMLFormElement | null;
        if (form) {
          e.preventDefault();
          form.requestSubmit();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeModal, handleRequestClose]);

  // KPI Computations
  const safeRepairOrders = repairOrders || [];
  const totalOrders = safeRepairOrders.length;
  const diagnosticCount = safeRepairOrders.filter(r => r.status === 'Diagnostic').length;
  const pendingPartsCount = safeRepairOrders.filter(r => r.status === 'En attente de pièces').length;
  const inProgressCount = safeRepairOrders.filter(r => r.status === 'En cours').length;
  const completedCount = safeRepairOrders.filter(r => r.status === 'Prêt / Terminé').length;
  const totalRevenue = safeRepairOrders.reduce((acc, r) => acc + (r.totalCost || 0), 0);

  // Filtered Repair Orders for History Tab
  const filteredOrders = safeRepairOrders.filter((order) => {
    const matchesStatus = historyStatusFilter === 'Tous' || order.status === historyStatusFilter;
    const q = historySearch.trim().toLowerCase();
    const matchesSearch =
      !q ||
      order.ticketNumber.toLowerCase().includes(q) ||
      order.customerName.toLowerCase().includes(q) ||
      order.customerPhone.toLowerCase().includes(q) ||
      order.deviceModel.toLowerCase().includes(q) ||
      order.imei.toLowerCase().includes(q);

    return matchesStatus && matchesSearch;
  });

  const resetForm = () => {
    setEditingId(null);
    setCustomerName('');
    setCustomerPhone('');
    setDeviceModel('');
    setImei('');
    setImeiKind('imei');
    setProblemDescription('');
    setDiagnosticNotes('');
    setLaborCost(0);
    setPartsCost(0);
    setDepositAmount(0);
    setEstimatedDate('');
    setStatus('Diagnostic');
    setChecklist(initialChecklist);
    setPostChecklist(initialChecklist);
    setImeiTouched(false);
    setPhoneTouched(false);
    setWarrantyDossier(null);
    setWarrantySnapshot(undefined);
    setSuggestedTier(null);
    setMobileChecklistTab('pre');
    // v2 legal record state resets too — a new ticket never inherits the
    // previous ticket's signature or damage constat.
    setIntakeDamage(EMPTY_DAMAGE);
    setSignatureIntake(null);
    setTermsAccepted(false);
    setWarrantyTier(undefined);
    setIntakePhotos([]);
  };

  /** Attach intake photos (filesystem + SHA-256, never inline bytes). */
  const handlePhotoFiles = async (files: FileList | null) => {
    const list = Array.from(files || []);
    if (list.length === 0) return;
    setPhotosBusy(true);
    const orderId = editingId || `draft_${Date.now()}`;
    const added: IntakePhotoRef[] = [];
    let rejected = 0;
    for (const file of list) {
      if (!file.type.startsWith('image/')) continue;
      try {
        const res = await saveSavPhoto({ orderId, index: intakePhotos.length + added.length, file });
        // Fail closed: a photo whose bytes are not on disk is not evidence.
        // Recording it anyway would put a path in the ticket that can never be
        // reopened, which is worse than no photo at all in a dispute.
        if (!res.persisted) {
          rejected += 1;
          continue;
        }
        const { persisted: _persisted, ...ref } = res;
        added.push(ref);
      } catch {
        rejected += 1;
      }
    }
    setIntakePhotos((prev) => [...prev, ...added]);
    setPhotosBusy(false);
    if (rejected > 0) {
      showToast(
        `${rejected} photo${rejected > 1 ? 's' : ''} non enregistrée${rejected > 1 ? 's' : ''} — stockage local indisponible. La preuve photo sera absente du dossier.`,
        'warning',
        8000
      );
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const showSuccess = (msg: string) => {
    setSuccessMsg(msg);
    setTimeout(() => setSuccessMsg(''), 3000);
  };

  const handleSelectCustomer = (customerId: string) => {
    const found = customers.find(c => c.id === customerId);
    if (found) {
      setCustomerName(found.name);
      setCustomerPhone(found.phone);
      if (found.registeredDevice && found.registeredDevice !== 'N/A') {
        setDeviceModel(found.registeredDevice);
      }
    }
  };

  const handleSendWhatsAppNotification = (order: RepairOrder, template: RepairNotificationType = 'READY_FOR_PICKUP') => {
    // Guard the whatsapp-modal precondition: opening 'whatsapp_dispatch' with
    // no order context renders an empty modal with no feedback. Toast instead.
    if (!order) {
      showToast('Aucun ordre de réparation sélectionné pour la notification.', 'warning');
      return;
    }
    setSelectedRepairOrderForNotification(order, template);
    openModal('whatsapp_dispatch');
  };

  const handleSettleAndDeliver = async (order: RepairOrder) => {
    const { settleAndDeliverRepair, markRepairDelivered } = usePosStore.getState();
    const res = await settleAndDeliverRepair(order.id);
    if (res.action === 'cart') {
      showToast(`Solde ${formatDZD(res.remainingBalance)} injecté au panier — encaissez pour livrer ${order.ticketNumber}.`, 'success');
      closeModal();
      return;
    }
    if (window.confirm(`Livrer ${order.ticketNumber} (${order.deviceModel}) ? Solde à zéro confirmé.`)) {
      const ok = await markRepairDelivered(order.id);
      showToast(ok ? `Ticket ${order.ticketNumber} livré.` : 'Livraison impossible — solde restant.', ok ? 'success' : 'warning');
    }
  };

  const handleSetAllChecklistOk = (target: 'pre' | 'post') => {
    const allOk: LegacyConditionChecklist = {
      screenOk: true,
      faceIdOk: true,
      cameraOk: true,
      chargingOk: true,
      bodyOk: true,
      batteryOk: true,
      audioOk: true,
    };
    if (target === 'pre') setChecklist(allOk);
    else setPostChecklist(allOk);
  };

  const handleSaveOrder = async (e: React.FormEvent) => {
    e.preventDefault();

    // Fail closed BEFORE any write: an incomplete v2 legal record must never
    // reach SQLite, because a ticket without a signature is unenforceable in
    // exactly the restitution dispute it exists to settle.
    const sanitized =
      imeiKind === 'manual' ? '' : sanitizeDeviceIdentifier(imei.trim().toUpperCase(), imeiKind).value;
    const validDeposit = Math.min(money.totalCost, money.depositAmount);
    // `manual` in the form is persisted as `none` — the stored vocabulary has
    // exactly three values and a ticket must never contain a UI-only one.
    const storedKind: NonNullable<RepairOrder['imeiKind']> =
      imeiKind === 'manual' ? 'none' : imeiKind;
    const acceptedAt = termsAccepted ? new Date().toISOString() : undefined;

    // A v1 dossier is validated against the DESCRIPTIVE minimum only: the full
    // v2 legal gate must not block a typo correction, and equally must not be
    // satisfied by evidence the form's read-only blocks cannot collect.
    const isLegacySave = Boolean(editingId && !isSchemaV2Order(editedOrder!));
    const candidate = {
      schemaVersion: isLegacySave ? undefined : REPAIR_SCHEMA_VERSION,
      customerName: customerName.trim(),
      deviceModel: deviceModel.trim(),
      imei: sanitized,
      imeiKind: storedKind,
      problemDescription: problemDescription.trim(),
      conditionChecklist: checklist,
      postRepairChecklist: postChecklist,
      intakeDamage,
      signatureCustomerIntake: signatureIntake ?? undefined,
      legalTermsAcceptedAt: acceptedAt,
      warrantyTier,
      intakePhotos,
      diagnosticNotes,
      laborCost: money.laborCost,
      partsCost: money.partsCost,
      depositAmount: validDeposit,
      status,
    } as unknown as RepairOrder;

    const verdict = validateRepairIntake(candidate);
    if (!verdict.ok) {
      showToast(
        `Dossier SAV incomplet : ${verdict.reasons.length} point${verdict.reasons.length > 1 ? 's' : ''} bloquant${verdict.reasons.length > 1 ? 's' : ''}.`,
        'warning',
        6000
      );
      // Surface every blocker: a single toast hides the rest of the gaps.
      showToast(verdict.reasons.join(' • '), 'warning', 12000);
      return;
    }

    // Phone stored sanitized E.164 (213...); identifier already sanitized.
    const cleanPhone = sanitizeDzPhone(customerPhone.trim()) || customerPhone.trim();
    const shared = {
      customerName: candidate.customerName,
      customerPhone: cleanPhone,
      deviceModel: candidate.deviceModel,
      imei: candidate.imei,
      imeiKind: storedKind,
      imeiKindLabel: STORED_ID_KIND_LABELS[storedKind],
      problemDescription: candidate.problemDescription,
      diagnosticNotes,
      status,
      laborCost: money.laborCost,
      partsCost: money.partsCost,
      depositAmount: validDeposit,
      estimatedCompletionDate: estimatedDate,
      conditionChecklist: checklist,
      postRepairChecklist: postChecklist,
      ...(warrantySnapshot ? { warrantySnapshot } : {}),
    };

    if (editingId) {
      await updateRepairOrder(editingId, {
        ...shared,
        // Legal evidence is APPEND-ONLY: an edit may add a signature or a
        // re-acceptance, but never blank one that is already on file. The slice
        // preserves existing values for these keys, so omitting them is the
        // correct "leave as-is" signal.
        //
        // A LEGACY save writes NONE of them: `schemaVersion` stays absent so the
        // row is never silently promoted to a v2 legal record, and the intake
        // evidence it never captured is not back-dated to today.
        ...(isLegacySave
          ? {}
          : {
              ...(signatureIntake
                ? {
                    signatureCustomerIntake: signatureIntake,
                    signatureIntakeAt: new Date().toISOString(),
                  }
                : {}),
              ...(acceptedAt ? { legalTermsAcceptedAt: acceptedAt } : {}),
              intakeDamage,
              warrantyTier,
              intakePhotos,
            }),
      });
      showSuccess('Réparation mise à jour avec succès !');
      return;
    }

    try {
      await createRepairOrder({
        ...shared,
        intakeDamage,
        signatureCustomerIntake: signatureIntake ?? undefined,
        signatureIntakeAt: new Date().toISOString(),
        legalTermsAcceptedAt: acceptedAt,
        warrantyTier,
        intakePhotos,
      } as Omit<RepairOrder, 'id' | 'ticketNumber' | 'totalCost' | 'createdAt' | 'schemaVersion'>);
    } catch (err) {
      // The slice re-validates at the write boundary and throws; surface it as a
      // toast instead of an unhandled rejection, and keep the form filled so
      // the technician can fix the gap without retyping the ticket.
      showToast(
        err instanceof Error ? err.message : 'Enregistrement du dossier SAV refusé.',
        'warning',
        10000
      );
      return;
    }

    showSuccess('Nouvelle Fiche de Réparation créée !');
    clearIntakeDraft();
    resetForm();
  };

  const handleEditClick = (order: RepairOrder) => {
    const legacy = !isSchemaV2Order(order);
    if (legacy && order.status !== 'Diagnostic') {
      showToast(
        `Dossier archivé (non migré) : consultable mais non modifiable à ce stade (${order.status}).`,
        'warning'
      );
      return;
    }
    setEditingId(order.id);
    setCustomerName(order.customerName);
    setCustomerPhone(formatDzPhoneDisplay(order.customerPhone) || order.customerPhone);
    setDeviceModel(order.deviceModel);
    setImei(order.imei || '');
    setImeiKind(order.imeiKind === 'serial' ? 'serial' : order.imei ? 'imei' : 'manual');
    setProblemDescription(order.problemDescription);
    setDiagnosticNotes(order.diagnosticNotes || '');
    setLaborCost(order.laborCost);
    setPartsCost(order.partsCost);
    setDepositAmount(order.depositAmount || 0);
    setEstimatedDate(order.estimatedCompletionDate || '');
    setStatus(order.status);
    setChecklist(order.conditionChecklist || initialChecklist);
    setPostChecklist(order.postRepairChecklist || initialChecklist);
    setWarrantySnapshot(order.warrantySnapshot);
    setIntakeDamage(order.intakeDamage ?? EMPTY_DAMAGE);
    setSignatureIntake(order.signatureCustomerIntake ?? order.signatureCustomer ?? null);
    setTermsAccepted(Boolean(order.legalTermsAcceptedAt));
    // A v1 row has no `warrantyTier`, and a legacy boolean `warrantySnapshot`
    // carries no duration — deriving a tier from its mere presence would
    // invent 90 days of coverage the dossier never granted. Show the selector
    // unset instead and let the operator choose from the presets.
    setWarrantyTier(order.warrantyTier ?? undefined);
    setIntakePhotos(order.intakePhotos ?? []);
    setWarrantyDossier(null);
    setImeiTouched(false);
    setPhoneTouched(false);
    setActiveTab('Nouveau');
  };

  const handleStatusChange = (id: string, newStatus: RepairOrder['status']) => {
    updateRepairOrderStatus(id, newStatus);
    showSuccess('Statut mis à jour !');
  };

  const handlePrintTicket = async (order: RepairOrder) => {
    printScopeRef.current = order.id;
    // Idempotent triad: a second tap on the same order reuses the in-flight
    // job instead of double-printing a garbled spooler sequence.
    if (isMobileDevice()) {
      const { repairVoucherEscPosText, workshopSlipText, chassisTagEscPosText } = await import(
        '../../utils/mobileDocPrint'
      );
      const steps = [
        { kind: 'voucher' as const, medium: 'mobileSheet' as const, title: `Bon SAV ${order.ticketNumber}`, text: repairVoucherEscPosText(order, receiptSettings) },
        { kind: 'workshop' as const, medium: 'mobileSheet' as const, title: `Fiche Atelier ${order.ticketNumber}`, text: workshopSlipText(order) },
        { kind: 'chassisTag' as const, medium: 'mobileSheet' as const, title: `Étiquette ${order.ticketNumber}`, text: chassisTagEscPosText(order) },
      ];
      const outcomes: string[] = [];
      for (const step of steps) {
        const outcome = await enqueueSavPrint({
          orderId: order.id,
          kind: step.kind,
          medium: step.medium,
          title: step.title,
          produce: async (signal) => {
            const { openNativePrint } = await import('../../utils/phoneUtils');
            return openNativePrint(step.title, step.text, signal);
          },
        });
        outcomes.push(outcome.status);
      }
      const anyPrinted = outcomes.includes('printed');
      showToast(
        anyPrinted
          ? '🖨️ Feuilles d’impression Android ouvertes (bon + fiche atelier + étiquette 58mm).'
          : outcomes.includes('aborted')
            ? 'Impression annulée.'
            : 'Impression indisponible sur cet appareil.',
        anyPrinted ? 'success' : 'warning'
      );
      return;
    }
    // Desktop: full triad (voucher + workshop slip + TSPL/ZPL or 58mm fallback).
    try {
      const { executeCompleteIntakeTriad } = await import('../../utils/savPrintCoordinator');
      const controller = new AbortController();
      activePrintController.current = controller;
      const res = await executeCompleteIntakeTriad(order, receiptSettings, controller.signal);
      activePrintController.current = null;
      if (!res.customerVoucherPrinted && !res.workshopCardPrinted && !res.chassisStickerPrinted) {
        throw new Error('TRIAD_FAILED');
      }
      showToast(
        res.fallbackUsed
          ? 'Triade SAV imprimée (étiquette en mode ticket 58mm).'
          : 'Triade SAV imprimée (bon + fiche + étiquette).',
        'success'
      );
      return;
    } catch {
      // Fall through to the A4 HTML fiche.
      activePrintController.current = null;
    }
    setPrintingOrder(order);
    setPrintingDocKind('work_order');
    printCoordinator.printRepairWorkOrder(50);
  };

  /**
   * Kind-aware document print: thermal bytes via SavPrintCoordinator on both
   * platforms, plus A4 (print-repair-target, reused repair_work_order
   * channel) on desktop. Consumed by history buttons, the delivered banner,
   * and the cross-modal pendingRepairPrint handshake.
   */
  const fireDocPrint = async (order: RepairOrder, kind: Exclude<RepairPrintKind, 'work_order'>) => {
    printScopeRef.current = order.id;
    const { SavPrintCoordinator } = await import('../../utils/savPrintCoordinator');
    const quoteKind = kind === 'quote';
    const outcome = await enqueueSavPrint({
      orderId: order.id,
      kind,
      medium: isMobileDevice() ? 'mobileSheet' : 'thermal80',
      title: `${quoteKind ? 'Devis' : 'Bon restitution'} ${order.ticketNumber}`,
      produce: async () =>
        quoteKind
          ? SavPrintCoordinator.printRepairQuote(order, receiptSettings)
          : SavPrintCoordinator.printRepairRestitution(order, receiptSettings),
    });

    if (outcome.status === 'aborted') {
      showToast('Impression annulée.', 'warning');
      return;
    }
    if (outcome.status === 'printed') {
      showToast(
        quoteKind ? '🖨️ Devis ouvert (feuille Android).' : '🖨️ Bon de restitution ouvert (feuille Android).',
        'success'
      );
      return;
    }
    // Thermal path failed — always offer the A4 workshop voucher instead of
    // silently doing nothing.
    showToast(
      isMobileDevice()
        ? 'Impression indisponible sur cet appareil.'
        : 'Imprimante ticket indisponible — impression A4 uniquement.',
      'warning'
    );
    setPrintingOrder(order);
    setPrintingDocKind(kind);
    printCoordinator.printRepairWorkOrder(60);
  };

  const totalCost = money.totalCost;
  const remainingBalance = money.balanceDue;
  // One declaration, rendered once — the six KPI cards previously repeated this
  // markup, which is how the label/value treatments drifted apart.
  const KPI_ITEMS = useMemo(
    () => [
      { label: 'Dossiers', value: String(totalOrders) },
      { label: 'Diagnostic', value: String(diagnosticCount), tone: 'text-amber-700 dark:text-amber-400' },
      { label: 'Attente', value: String(pendingPartsCount), tone: 'text-cyan-700 dark:text-cyan-300' },
      { label: 'En cours', value: String(inProgressCount), tone: 'text-blue-700 dark:text-blue-300' },
      { label: 'Prêts', value: String(completedCount), tone: 'text-emerald-700 dark:text-emerald-300' },
      { label: 'CA SAV', value: formatDZD(totalRevenue), tone: 'text-emerald-700 dark:text-emerald-300' },
    ],
    [totalOrders, diagnosticCount, pendingPartsCount, inProgressCount, completedCount, totalRevenue]
  );
  const editedOrder = editingId ? repairOrders.find((r) => r.id === editingId) ?? null : null;
  const isLegacyEdit = editedOrder ? !isSchemaV2Order(editedOrder) : false;
  // Customer-facing tracking link for the restitution PV. The customer scans
  // this with the phone camera to follow the ticket after they leave the shop.
  const orderLookupUrl = useMemo(() => {
    const ticket = justDelivered?.tickets[0] ?? '';
    return ticket ? `https://mobi-pos.app/sav/${encodeURIComponent(ticket)}` : '';
  }, [justDelivered?.tickets]);

  if (activeModal !== 'repair_work_order') return null;

  return (
    <>
    <ModalShell
      open
      onClose={handleRequestClose}
      width="5xl"
      title="RÉPARATIONS & TICKETS SAV"
      subtitle="Prise en charge atelier, constat et suivi SAV"
      icon={
        <div className="w-8 h-8 sm:w-10 sm:h-10 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center text-slate-950 font-bold shadow-lg shadow-emerald-500/20 shrink-0">
          <Wrench className="w-4 h-4 sm:w-5 sm:h-5 stroke-[2.5]" />
        </div>
      }
      headerExtras={
        <>
          {/* KPI strip (outside the scroll container, above the tabs).
              Desktop: one compact row, ~34px. Mobile: collapsed to a single
              summary bar that expands on tap, because the intake form — not a
              dashboard — is the reason this modal is open. */}
          <div className="bg-pos-bg border-b border-pos-border select-none">
            {/* Mobile summary bar */}
            <button
              type="button"
              onClick={() => setKpiOpen((v) => !v)}
              aria-expanded={kpiOpen}
              className="sm:hidden w-full min-h-[44px] px-3 py-2 flex items-center gap-2 text-left active:bg-pos-hover"
            >
              <span className="text-[10px] font-medium text-pos-muted shrink-0">Atelier</span>
              <span className="flex items-center gap-1.5 min-w-0 overflow-hidden">
                <span className="text-[11px] font-medium text-pos-text font-mono tabular-nums whitespace-nowrap">
                  {totalOrders} dossiers
                </span>
                <span className="text-pos-muted text-[10px] shrink-0">•</span>
                <span className="text-[11px] font-medium text-cyan-700 dark:text-cyan-300 font-mono tabular-nums whitespace-nowrap">
                  {pendingPartsCount} en attente
                </span>
                <span className="text-pos-muted text-[10px] shrink-0">•</span>
                <span className="text-[11px] font-medium text-emerald-700 dark:text-emerald-300 font-mono tabular-nums whitespace-nowrap">
                  {formatDZD(totalRevenue)}
                </span>
              </span>
              <ChevronDown
                className={`w-3.5 h-3.5 text-pos-muted shrink-0 ml-auto transition-transform ${kpiOpen ? 'rotate-180' : ''}`}
                aria-hidden="true"
              />
            </button>

            {/* Expanded grid: always visible on sm+, toggled on mobile */}
            <div
              className={`${kpiOpen ? 'grid' : 'hidden'} sm:grid grid-cols-3 sm:grid-cols-6 gap-1.5 sm:gap-2 p-2 sm:p-2 text-center`}
            >
              {KPI_ITEMS.map((k) => (
                <div key={k.label} className="bg-pos-card border border-pos-border rounded-lg p-1 sm:p-1.5">
                  <span className="block text-[10px] font-medium uppercase tracking-tight text-pos-muted">
                    {k.label}
                  </span>
                  <span
                    className={`block text-xs sm:text-sm font-semibold font-mono tabular-nums ${
                      k.tone ?? 'text-pos-text'
                    }`}
                  >
                    {k.value}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Tabs */}
          <div className="flex border-b border-pos-border bg-pos-panel px-2.5 sm:px-4">
            <button
              type="button"
              onClick={() => {
                setActiveTab('Nouveau');
                if (!editingId) resetForm();
              }}
              className={`min-h-[44px] px-3.5 sm:px-4 py-2.5 text-xs font-bold border-b-2 transition-colors shrink-0 active:scale-95 ${activeTab === 'Nouveau' ? 'border-emerald-500 text-emerald-600 dark:text-emerald-400' : 'border-transparent text-pos-muted hover:text-pos-text'}`}
            >
              <span className="flex items-center gap-2">
                <Plus className="w-4 h-4" aria-hidden="true" />{' '}
                <span>{editingId ? 'Modifier Fiche' : 'Nouveau Ticket SAV'}</span>
              </span>
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('Historique')}
              className={`min-h-[44px] px-3.5 sm:px-4 py-2.5 text-xs font-bold border-b-2 transition-colors shrink-0 active:scale-95 ${activeTab === 'Historique' ? 'border-emerald-500 text-emerald-600 dark:text-emerald-400' : 'border-transparent text-pos-muted hover:text-pos-text'}`}
            >
              <span className="flex items-center gap-2">
                <History className="w-4 h-4" aria-hidden="true" />{' '}
                <span>Historique Atelier ({repairOrders.length})</span>
              </span>
            </button>
          </div>
        </>
      }
      footer={
        activeTab === 'Nouveau' ? (
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-end gap-2 sm:gap-3">
            {isLegacyEdit && (
              <span className="inline-flex items-center gap-1.5 self-start sm:self-auto px-2 py-1 rounded-full bg-slate-100 dark:bg-slate-500/15 border border-slate-600/30 dark:border-slate-500/40 text-slate-700 dark:text-slate-300 text-[10px] font-semibold uppercase tracking-wider">
                {LEGACY_DOSSIER_PILL}
              </span>
            )}
            <div className="flex items-center gap-2 w-full sm:w-auto">
              <label htmlFor="sav-status" className="text-xs text-pos-muted font-bold whitespace-nowrap shrink-0">
                Statut du Ticket:
              </label>
              <select
                id="sav-status"
                value={status}
                onChange={(e) => setStatus(e.target.value as RepairOrder['status'])}
                className="flex-1 sm:flex-none min-h-[44px] min-w-[48px] bg-pos-card border border-pos-border rounded-xl px-3 py-2 text-sm sm:text-xs font-bold text-pos-text focus:outline-none cursor-pointer"
              >
                <option value="Diagnostic">Diagnostic</option>
                <option value="En attente de pièces">En attente de pièces</option>
                <option value="En cours">En cours</option>
                <option value="Prêt / Terminé">Prêt / Terminé</option>
                <option value="Livré">Livré</option>
                <option value="Annulé">Annulé</option>
              </select>
            </div>
            <button
              type="submit"
              form="sav-intake-form"
              className="w-full sm:w-auto min-h-[48px] min-w-[48px] px-6 py-3 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-sm sm:text-xs flex items-center justify-center gap-2 transition shadow-lg shadow-emerald-500/20 cursor-pointer active:scale-[0.98]"
            >
              <CheckCircle2 className="w-5 h-5 sm:w-4 sm:h-4" aria-hidden="true" />{' '}
              {editingId ? 'Mettre à jour Ticket' : 'Enregistrer le Ticket SAV'}
            </button>
          </div>
        ) : null
      }
    >
      <>
      {successMsg && (
        <div className="rounded-full bg-emerald-500/20 border border-emerald-500/60 text-emerald-700 dark:text-emerald-300 px-5 py-2.5 text-xs font-bold flex items-center gap-2 shadow-lg animate-in fade-in slide-in-from-top-4 justify-self-center">
          <CheckCircle2 className="w-4 h-4" aria-hidden="true" /> {successMsg}
        </div>
      )}

          {/* Post-delivery handshake banner: direct restitution print */}
          {justDelivered && (
            <div className="max-w-4xl mx-auto mb-3 p-3 rounded-2xl bg-emerald-500/10 border border-emerald-500/40 flex flex-col sm:flex-row sm:items-center gap-2.5">
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <FileCheck className="w-5 h-5 text-emerald-400 shrink-0" />
                <p className="text-xs font-bold text-pos-text truncate">
                  Livré{justDelivered.tickets.length > 1 ? 's' : ''} : {justDelivered.tickets.join(', ')}
                  {justDelivered.receipt ? ` • Reçu ${justDelivered.receipt}` : ''}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => {
                    const first = repairOrders.find((r) => r.ticketNumber === justDelivered.tickets[0]);
                    if (first) void fireDocPrint(first, 'restitution');
                    else showToast('Dossier SAV introuvable pour impression.', 'warning');
                  }}
                  className="h-10 sm:h-9 px-3.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs sm:text-sm font-medium shadow-sm transition active:scale-95 flex items-center justify-center gap-1.5"
                >
                  <FileCheck className="w-4 h-4" /> Imprimer Bon de Restitution
                </button>
                <button
                  type="button"
                  onClick={() => setJustDelivered(null)}
                  className="min-h-[48px] min-w-[48px] px-3 rounded-xl text-pos-muted hover:text-pos-text transition text-xs font-bold"
                >
                  ✕
                </button>
              </div>
              {orderLookupUrl && (
                <div className="w-full sm:w-auto flex items-center gap-2 border-t sm:border-t-0 sm:border-l border-emerald-500/30 pt-2 sm:pt-0 sm:pl-3">
                  <QRCodeImage
                    value={orderLookupUrl}
                    size={64}
                    alt={`Suivi du ticket SAV ${justDelivered.tickets[0]}`}
                  />
                  <span className="text-[10px] text-pos-muted leading-tight">
                    Le client scanne ce QR
                    <br />
                    pour suivre son dossier
                  </span>
                </div>
              )}
            </div>
          )}

          {activeTab === 'Nouveau' && (
            <form id="sav-intake-form" onSubmit={handleSaveOrder} className="bg-pos-card border border-pos-border rounded-2xl p-3.5 sm:p-5 space-y-3 sm:space-y-4 max-w-4xl mx-auto shadow-md">
              
              {editingId && (
                <div className="flex flex-col gap-2 sm:flex-row sm:justify-between sm:items-center bg-emerald-500/10 border border-emerald-500/30 p-2.5 rounded-xl">
                  <span className="text-xs font-bold text-emerald-400 flex items-center gap-1.5">
                    <Edit className="w-4 h-4 shrink-0" /> <span className="truncate">Modification de la Fiche Réparation #{editingId}</span>
                  </span>
                  <div className="flex items-center gap-2 self-start sm:self-auto">
                    <button
                      type="button"
                      onClick={() => {
                        const target = repairOrders.find((r) => r.id === editingId);
                        if (target) void fireDocPrint(target, 'quote');
                        else showToast('Enregistrez la fiche avant d’imprimer le devis.', 'warning');
                      }}
                      className="min-h-[44px] px-3 rounded-xl bg-blue-500/15 hover:bg-blue-500/25 text-blue-300 border border-blue-500/40 flex items-center gap-1.5 transition text-xs font-bold cursor-pointer"
                      title="Imprimer le devis estimatif (A4 + ticket 58mm)"
                    >
                      <FileText className="w-4 h-4" /> Imprimer Devis
                    </button>
                    <button type="button" onClick={resetForm} className="text-xs text-pos-muted hover:text-pos-text underline min-h-[32px]">
                      Annuler l'Édition
                    </button>
                  </div>
                </div>
              )}

              {/* A v1 dossier has no intakeDamage / signature / CGV acceptance.
                  It stays consultable and typo-correctable, but the legal-record
                  blocks below are read-only: back-filling them now would create
                  evidence dated today for a device received months ago, which is
                  worse than an explicit "not recorded". */}
              {isLegacyEdit && (
                <div className="flex items-start gap-2 bg-slate-100 dark:bg-slate-500/10 border border-slate-600/30 dark:border-slate-500/40 p-3 rounded-xl">
                  <ShieldAlert className="w-4 h-4 text-slate-500 shrink-0 mt-0.5" aria-hidden="true" />
                  <p className="text-[11px] text-slate-700 dark:text-slate-300 leading-snug">
                    <strong className="font-semibold uppercase tracking-wider">{LEGACY_DOSSIER_PILL}</strong> —
                    constat physique, signature client et conditions générales n&apos;ont pas été relevés
                    à la prise en charge sur ce dossier. Les blocs de preuve légale plus bas sont en
                    lecture seule et ne peuvent pas être renseignés après coup.
                  </p>
                </div>
              )}

              {/* Customer Selection & Auto-Fill Toolbar */}
              <div className="bg-pos-bg p-3 sm:p-3.5 rounded-xl border border-pos-border space-y-3">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <span className="text-xs font-bold text-pos-text flex items-center gap-1.5">
                    <UserCheck className="w-4 h-4 text-emerald-400" /> Informations Client
                  </span>
                  {customers.length > 0 && (
                    <select
                      onChange={(e) => handleSelectCustomer(e.target.value)}
                      className="w-full sm:w-auto min-h-[44px] bg-pos-card border border-pos-border text-pos-text text-sm sm:text-xs rounded-lg px-2.5 py-1 focus:border-emerald-400 focus:outline-none"
                    >
                      <option value="">Sélectionner un client existant...</option>
                      {(customers || []).map(c => (
                        <option key={c.id} value={c.id}>{c.name} ({c.phone})</option>
                      ))}
                    </select>
                  )}
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                  <div>
                    <label htmlFor="sav-customer" className="text-xs font-medium text-pos-text block mb-1">Nom du client</label>
                    <input
                      id="sav-customer"
                      type="text"
                      required
                      tabIndex={1}
                      value={customerName}
                      onChange={(e) => setCustomerName(e.target.value)}
                      placeholder="Ex: Yacine Benali"
                      className="w-full h-10 sm:h-9 bg-pos-card border border-pos-border rounded-lg px-3 py-1.5 text-base sm:text-xs font-normal text-pos-text placeholder:text-pos-muted focus:outline-none focus:ring-1 focus:ring-emerald-500"
                    />
                  </div>
                  <div>
                    <label htmlFor="sav-phone" className="text-xs font-medium text-pos-text block mb-1">Téléphone / Contact</label>
                    <input
                      id="sav-phone"
                      type="tel"
                      inputMode="tel"
                      required
                      tabIndex={2}
                      value={customerPhone}
                      onChange={(e) => handlePhoneChange(e.target.value)}
                      onBlur={() => setPhoneTouched(true)}
                      placeholder="Ex: 0550 12 34 56"
                      className={`w-full h-10 sm:h-9 bg-pos-card border rounded-lg px-3 py-1.5 text-base sm:text-xs font-normal font-mono tabular-nums tracking-normal text-pos-text placeholder:font-sans placeholder:text-pos-muted focus:outline-none focus:ring-1 focus:ring-emerald-500 ${showPhoneHint ? 'border-amber-500' : 'border-pos-border'}`}
                    />
                    {showPhoneHint && (
                      <p className="text-[10px] text-amber-600 dark:text-amber-400 font-medium mt-1">
                        Format DZ attendu : 05/06/07 XX XX XX XX ou 213… — enregistré tel quel.
                      </p>
                    )}
                  </div>
                  <div>
                    <label className="text-xs font-medium text-pos-text block mb-1">Appareil / Modèle</label>
                    <input
                      type="text"
                      required
                      tabIndex={3}
                      value={deviceModel}
                      onChange={(e) => setDeviceModel(e.target.value)}
                      placeholder="Ex: iPhone 15 Pro Max"
                      className="w-full h-10 sm:h-9 bg-pos-card border border-pos-border rounded-lg px-3 py-1.5 text-base sm:text-xs font-normal text-pos-text placeholder:text-pos-muted focus:outline-none focus:ring-1 focus:ring-emerald-500"
                    />
                  </div>
                </div>

                {/* Device Quick Presets — low-profile filter tags.
                    Mobile (< sm): single scrollable row with a trailing fade
                    mask, because 8 models cannot wrap without costing three
                    extra rows of the intake form.
                    Desktop (>= sm): wraps onto as many lines as it needs, since
                    there is horizontal room to spare. */}
                <div>
                  <div className="flex sm:flex-wrap items-center gap-1.5 overflow-x-auto sm:overflow-visible overscroll-contain snap-x sm:snap-none no-scrollbar scroll-fade-x sm:[mask-image:none] py-0.5">
                    <span className="text-[10px] sm:text-[11px] font-semibold uppercase tracking-wider text-pos-muted shrink-0">
                      Modèles
                    </span>
                    {DEVICE_PRESETS.map((preset) => (
                      <button
                        key={preset}
                        type="button"
                        onClick={() => setDeviceModel(preset)}
                        aria-pressed={deviceModel === preset}
                        className={`min-h-[44px] sm:min-h-[32px] px-2.5 sm:px-2.5 py-1 snap-start text-xs font-medium rounded-full border transition shrink-0 active:scale-95 ${
                          deviceModel === preset
                            ? 'bg-emerald-500 text-slate-950 border-emerald-500'
                            : 'bg-pos-card border-pos-border text-pos-muted hover:border-pos-muted hover:text-pos-text'
                        }`}
                      >
                        {preset}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Identifier polymorphism + direct scan trigger */}
              <div className="bg-pos-bg p-3 sm:p-3.5 rounded-xl border border-pos-border space-y-2">
                <div
                  role="tablist"
                  aria-label="Type d'identifiant appareil"
                  className="grid grid-cols-3 gap-1 p-1 rounded-xl bg-pos-card border border-pos-border"
                >
                  {(['imei', 'serial', 'manual'] as DeviceIdentifierMode[]).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      role="tab"
                      aria-selected={imeiKind === mode}
                      onClick={() => {
                        setImeiKind(mode);
                        if (mode === 'manual') {
                          setImei('');
                          setWarrantyDossier(null);
                        }
                      }}
                      className={`min-h-[44px] sm:min-h-[36px] rounded-lg text-xs font-medium transition ${
                        imeiKind === mode
                          ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border border-emerald-500/40'
                          : 'text-pos-muted border border-transparent hover:text-pos-text'
                      }`}
                    >
                      {DEVICE_ID_KIND_LABELS[mode]}
                    </button>
                  ))}
                </div>

                <div className="flex items-center gap-2">
                  <div className="relative flex-1 min-w-0">
                    <input
                      ref={imeiInputRef}
                      type="text"
                      inputMode={imeiKind === 'imei' ? 'numeric' : 'text'}
                      disabled={imeiKind === 'manual'}
                      value={imei}
                      onChange={(e) => handleImeiChange(e.target.value)}
                      onBlur={handleImeiBlur}
                      placeholder={
                        imeiKind === 'imei'
                          ? 'Scanner ou 15 chiffres…'
                          : imeiKind === 'serial'
                            ? 'Scanner ou N° de série…'
                            : 'Aucun identifiant saisi'
                      }
                      aria-label={DEVICE_ID_KIND_LABELS[imeiKind]}
                      className={`w-full h-11 sm:h-10 bg-pos-card border rounded-lg px-3 py-1.5 text-base sm:text-xs font-normal font-mono tabular-nums tracking-normal placeholder:font-sans placeholder:text-pos-muted focus:outline-none focus:ring-1 focus:ring-emerald-500 disabled:opacity-50 ${
                        imeiKind === 'imei'
                          ? imeiState === 'valid'
                            ? 'border-emerald-500 text-emerald-700 dark:text-emerald-300'
                            : imeiState === 'invalid'
                              ? 'border-amber-500 text-amber-700 dark:text-amber-300'
                              : 'border-pos-border'
                          : 'border-pos-border'
                      }`}
                    />
                  </div>
                  <button
                    type="button"
                    onClick={handleScanClick}
                    disabled={imeiKind === 'manual'}
                    className="h-11 sm:h-10 min-w-[44px] px-3 rounded-lg bg-pos-card border border-pos-border text-pos-muted hover:text-pos-text flex items-center gap-1.5 text-xs sm:text-sm font-medium transition cursor-pointer active:scale-95 shrink-0 disabled:opacity-50"
                    title="Scanner le code-barres / QR de l'appareil"
                    aria-label="Scanner l'identifiant"
                  >
                    <ScanLine className="w-4 h-4" aria-hidden="true" />
                    <span className="hidden sm:inline">Scanner</span>
                  </button>
                </div>
                <p className="text-[10px] text-pos-muted">
                  {imeiKind === 'imei'
                    ? 'IMEI : 15 chiffres, clé de contrôle Luhn vérifiée à la sortie.'
                    : imeiKind === 'serial'
                      ? 'Numéro de série : aucun contrôle Luhn (saisie libre, 4 caractères minimum).'
                      : 'Appareil sans identifiant lisible — la garantie magasin ne sera pas résolue.'}
                </p>
              </div>

              {/* IMEI validation readout + problem description. The identifier
                  itself lives in the polymorphic block above; this row pairs
                  its verdict with the free-text fault report. */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                <div>
                  <span className="text-xs font-medium text-pos-text block mb-1">
                    {DEVICE_ID_KIND_LABELS[imeiKind]} de l&apos;appareil
                  </span>
                  {imeiState === 'valid' && (
                    <p className="text-[10px] text-emerald-700 dark:text-emerald-400 font-medium mt-1 flex items-center gap-1">
                      <Check className="w-3 h-3" aria-hidden="true" /> IMEI valide (Luhn OK)
                    </p>
                  )}
                  {imeiState === 'invalid' && (
                    <p className="text-[10px] text-amber-700 dark:text-amber-400 font-medium mt-1">
                      Clé de contrôle IMEI invalide — corrigez la saisie pour ouvrir un dossier SAV.
                    </p>
                  )}
                </div>
                <div>
                  <label htmlFor="sav-problem" className="text-xs font-medium text-pos-text block mb-1">
                    Panne signalée par le client
                  </label>
                  <input
                    id="sav-problem"
                    type="text"
                    required
                    value={problemDescription}
                    onChange={(e) => setProblemDescription(e.target.value)}
                    placeholder="Ex: écran fissuré + connecteur de charge cassé"
                    className="w-full h-10 sm:h-9 bg-pos-bg border border-pos-border rounded-lg px-3 py-1.5 text-base sm:text-xs font-normal text-pos-text placeholder:text-pos-muted focus:outline-none focus:ring-1 focus:ring-emerald-500"
                  />
                </div>
              </div>

              {(warrantyLoading || warrantyDossier || warrantySnapshot) && (
                <div className={`p-2.5 rounded-lg border flex flex-col sm:flex-row sm:items-center gap-2 ${
                  warrantyDossier?.dossier.isWarrantyValid || warrantySnapshot?.isUnderWarranty
                    ? 'bg-emerald-50 dark:bg-emerald-500/10 border-emerald-500/40'
                    : 'bg-pos-bg border-pos-border'
                }`}>
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    <ShieldCheck className={`w-4 h-4 shrink-0 ${warrantyDossier?.dossier.isWarrantyValid || warrantySnapshot?.isUnderWarranty ? 'text-emerald-600 dark:text-emerald-400' : 'text-pos-muted'}`} aria-hidden="true" />
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-pos-text truncate">
                        {warrantyLoading
                          ? 'Vérification garantie…'
                          : warrantyDossier?.dossier.isWarrantyValid
                            ? `Garantie Magasin Active — Échéance ${warrantyDossier.dossier.warrantyExpiresAt ? new Date(warrantyDossier.dossier.warrantyExpiresAt).toLocaleDateString('fr-DZ') : '—'} (J-${warrantyDossier.dossier.daysRemaining ?? 0})`
                            : warrantySnapshot?.isUnderWarranty
                              ? warrantySnapshot.label
                              : warrantyDossier
                                ? 'Hors garantie magasin — constat SAV ordinaire'
                                : 'Garantie vérifiée'}
                      </p>
                      {warrantyDossier && (
                        <p className="text-[10px] text-pos-muted truncate font-mono">
                          {warrantyDossier.dossier.productTitle} •{' '}
                          {warrantyDossier.dossier.originalReceiptNumber}
                        </p>
                      )}
                    </div>
                  </div>
                  {warrantyDossier?.dossier.isWarrantyValid && (
                    <button
                      type="button"
                      onClick={handleApplyWarranty}
                      className="h-10 sm:h-9 px-3.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs sm:text-sm font-medium shadow-sm flex items-center justify-center gap-1.5 transition shrink-0 active:scale-95"
                    >
                      Appliquer prise en charge sous garantie
                    </button>
                  )}
                </div>
              )}

              <div>
                <label htmlFor="sav-notes" className="text-[11px] text-pos-muted block mb-1 font-semibold">
                  Notes & Constatations du Technicien (Interne)
                </label>
                <textarea
                  id="sav-notes"
                  rows={2}
                  value={diagnosticNotes}
                  onChange={(e) => setDiagnosticNotes(e.target.value)}
                  className="w-full min-h-[64px] bg-pos-bg border border-pos-border rounded-lg px-3 py-2 text-base sm:text-xs text-pos-text focus:border-emerald-400 focus:outline-none"
                  placeholder="Notes de diagnostic, micro-soudures nécessaires, tests effectués..."
                />
              </div>

              {/* Physical damage constat (v2 legal record) */}
              <div className="bg-pos-card border border-pos-border rounded-2xl p-3.5 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-[10px] sm:text-[11px] font-semibold uppercase tracking-wider text-pos-muted">
                    Constat physique contradictoire
                  </h3>
                  <span
                    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] sm:text-[11px] font-medium border ${
                      damageSeverity === 'major'
                        ? 'bg-rose-50 dark:bg-rose-500/10 border-rose-600/40 dark:border-rose-500/40 text-rose-700 dark:text-rose-300'
                        : damageSeverity === 'minor'
                          ? 'bg-amber-50 dark:bg-amber-500/10 border-amber-600/40 dark:border-amber-500/40 text-amber-700 dark:text-amber-300'
                          : 'bg-emerald-50 dark:bg-emerald-500/10 border-emerald-600/40 dark:border-emerald-500/40 text-emerald-700 dark:text-emerald-300'
                    }`}
                  >
                    {damageSeverity === 'major'
                      ? 'Dommage majeur'
                      : damageSeverity === 'minor'
                        ? 'Dommage mineur'
                        : 'Conforme'}
                  </span>
                </div>
                <ConditionChecklist
                  value={intakeDamage}
                  onChange={setIntakeDamage}
                  readOnly={isLegacyEdit}
                />
                {/* Screen-reader + print summary of the matrix above: the
                    one-line legal description of the customer's own constat. */}
                <p className="text-[10px] text-pos-muted leading-snug">
                  <span className="font-semibold uppercase tracking-wider text-pos-muted">Constat :</span>{' '}
                  {describeIntakeDamage(intakeDamage)}
                </p>

                {/* Photo evidence — filesystem + SHA-256 */}
                <div className="rounded-xl border border-pos-border bg-pos-bg p-3 space-y-2">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <span className="text-[10px] sm:text-[11px] font-semibold uppercase tracking-wider text-pos-muted">
                      Photos de l&apos;appareil ({intakePhotos.length})
                    </span>
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={photosBusy || isLegacyEdit}
                      className="min-h-[44px] px-3 rounded-lg bg-pos-card border border-pos-border text-pos-muted hover:text-pos-text text-[10px] font-bold flex items-center gap-1.5 disabled:opacity-50"
                    >
                      <Camera className="w-3.5 h-3.5" aria-hidden="true" />
                      {photosBusy ? 'Compression…' : 'Ajouter une photo'}
                    </button>
                  </div>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    multiple
                    capture="environment"
                    className="hidden"
                    onChange={(e) => void handlePhotoFiles(e.target.files)}
                  />
                  {intakePhotos.length > 0 && (
                    <ul className="space-y-1">
                      {intakePhotos.map((p, i) => (
                        <li
                          key={p.relativePath}
                          className="flex items-center justify-between gap-2 text-[10px] text-pos-muted"
                        >
                          <span className="font-mono truncate">Photo {i + 1} • {p.relativePath}</span>
                          <span className="shrink-0 font-mono opacity-70">
                            SHA-256 {p.sha256.slice(0, 12)}…
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                  <p className="text-[10px] text-pos-muted">
                    Les images sont stockées sur le disque local avec empreinte SHA-256 ; seuls le chemin
                    et le hash sont inscrits au dossier (preuve opposable en cas de litige de restitution).
                  </p>
                </div>
              </div>

              {/* Strict warranty tier (RESTITUE-anchored) */}
              <div className="bg-pos-card border border-pos-border rounded-2xl p-3.5 space-y-2">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <h3 className="text-[10px] sm:text-[11px] font-semibold uppercase tracking-wider text-pos-muted">
                    Garantie de réparation
                  </h3>
                  {warrantyTier && warrantyTier !== 'none' && (
                    <WarrantyBadge
                      tier={warrantyTier}
                      size="sm"
                      showLabel
                      expiryDate={
                        editedOrder?.deliveredAt
                          ? computeWarrantyExpiryISO(editedOrder.deliveredAt, warrantyTier)
                          : null
                      }
                    />
                  )}
                </div>
                <WarrantyTierSelector
                  value={warrantyTier}
                  onChange={setWarrantyTier}
                  suggestedTier={suggestedTier}
                  deliveredAt={editedOrder?.deliveredAt ?? null}
                  damageBlocksWarranty={intakeBlocksRepairWarranty(intakeDamage)}
                  readOnly={isLegacyEdit}
                />
              </div>

              {/* Legacy v1 boolean checklists (pre / post). Demoted to a
                  closed-by-default disclosure: they are display-only history
                  data, superseded for anything legally binding by the v2
                  damage matrix + signature above, and they were consuming
                  ~200px of the intake form above the fold. The LABEL stays
                  open so nobody mistakes "collapsed" for "not filled in". */}
              <details className="rounded-xl border border-pos-border bg-pos-card">
                <summary className="min-h-[44px] px-3 py-2 flex items-center gap-2 cursor-pointer text-xs font-medium text-pos-text">
                  <ClipboardCheck className="w-3.5 h-3.5 text-pos-muted shrink-0" aria-hidden="true" />
                  Contrôle fonctionnel complémentaire (optionnel)
                  <span className="ml-auto flex items-center gap-1.5 shrink-0">
                    <span className="text-[10px] font-mono tabular-nums text-pos-muted">
                      {countOk(checklist)}/7 · {countOk(postChecklist)}/7
                    </span>
                    <ChevronDown className="w-3.5 h-3.5 text-pos-muted" aria-hidden="true" />
                  </span>
                </summary>
                <div className="p-3 pt-0">
              {/* Visual Interactive Checklists (Pre & Post) — segmented on mobile, side-by-side on sm+ */}
              <div className="flex sm:hidden gap-2 p-1 rounded-lg bg-pos-bg border border-pos-border">
                <button
                  type="button"
                  onClick={() => setMobileChecklistTab('pre')}
                  className={`flex-1 min-h-[44px] rounded-lg text-xs font-medium transition active:scale-95 ${mobileChecklistTab === 'pre' ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300 border border-amber-500/40' : 'text-pos-muted'}`}
                >
                  Réception (Amber)
                </button>
                <button
                  type="button"
                  onClick={() => setMobileChecklistTab('post')}
                  className={`flex-1 min-h-[44px] rounded-lg text-xs font-medium transition active:scale-95 ${mobileChecklistTab === 'post' ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border border-emerald-500/40' : 'text-pos-muted'}`}
                >
                  Sortie (Emerald)
                </button>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                {/* Pre Checklist */}
                <div className={`${mobileChecklistTab === 'pre' ? 'block' : 'hidden'} sm:block bg-pos-bg p-3 rounded-lg border border-amber-500/30 space-y-2`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[10px] sm:text-[11px] font-semibold uppercase tracking-wider text-pos-muted block flex items-center gap-1.5 min-w-0 truncate">
                      <ShieldAlert className="w-3.5 h-3.5 text-amber-400 shrink-0" /> <span className="truncate">Checklist à la Réception</span>
                    </span>
                    <button
                      type="button"
                      onClick={() => handleSetAllChecklistOk('pre')}
                      className="text-[10px] bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 px-2.5 py-1.5 min-h-[36px] rounded font-bold transition border border-emerald-500/30 cursor-pointer flex items-center gap-1 whitespace-nowrap shrink-0 active:scale-95"
                    >
                      <Check className="w-3 h-3" /> Tout Conforme
                    </button>
                  </div>
                  
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <button
                      type="button"
                      onClick={() => setChecklist({ ...checklist, screenOk: !checklist.screenOk })}
                      className={`min-h-[48px] px-3 py-2 rounded-lg border text-left font-bold flex items-center gap-2 transition cursor-pointer active:scale-95 ${
                        checklist.screenOk ? 'bg-emerald-500/20 border-emerald-500/60 text-emerald-300' : 'bg-pos-card border-pos-border text-pos-muted'
                      }`}
                    >
                      <Smartphone className="w-3.5 h-3.5" /> Écran: {checklist.screenOk ? 'OK' : 'KO'}
                    </button>

                    <button
                      type="button"
                      onClick={() => setChecklist({ ...checklist, faceIdOk: !checklist.faceIdOk })}
                      className={`min-h-[48px] px-3 py-2 rounded-lg border text-left font-bold flex items-center gap-2 transition cursor-pointer active:scale-95 ${
                        checklist.faceIdOk ? 'bg-emerald-500/20 border-emerald-500/60 text-emerald-300' : 'bg-pos-card border-pos-border text-pos-muted'
                      }`}
                    >
                      <Zap className="w-3.5 h-3.5" /> FaceID: {checklist.faceIdOk ? 'OK' : 'KO'}
                    </button>

                    <button
                      type="button"
                      onClick={() => setChecklist({ ...checklist, cameraOk: !checklist.cameraOk })}
                      className={`min-h-[48px] px-3 py-2 rounded-lg border text-left font-bold flex items-center gap-2 transition cursor-pointer active:scale-95 ${
                        checklist.cameraOk ? 'bg-emerald-500/20 border-emerald-500/60 text-emerald-300' : 'bg-pos-card border-pos-border text-pos-muted'
                      }`}
                    >
                      <Camera className="w-3.5 h-3.5" /> Caméra: {checklist.cameraOk ? 'OK' : 'KO'}
                    </button>

                    <button
                      type="button"
                      onClick={() => setChecklist({ ...checklist, chargingOk: !checklist.chargingOk })}
                      className={`min-h-[48px] px-3 py-2 rounded-lg border text-left font-bold flex items-center gap-2 transition cursor-pointer active:scale-95 ${
                        checklist.chargingOk ? 'bg-emerald-500/20 border-emerald-500/60 text-emerald-300' : 'bg-pos-card border-pos-border text-pos-muted'
                      }`}
                    >
                      <Zap className="w-3.5 h-3.5" /> Charge: {checklist.chargingOk ? 'OK' : 'KO'}
                    </button>

                    <button
                      type="button"
                      onClick={() => setChecklist({ ...checklist, batteryOk: !checklist.batteryOk })}
                      className={`min-h-[48px] px-3 py-2 rounded-lg border text-left font-bold flex items-center gap-2 transition cursor-pointer active:scale-95 ${
                        checklist.batteryOk ? 'bg-emerald-500/20 border-emerald-500/60 text-emerald-300' : 'bg-pos-card border-pos-border text-pos-muted'
                      }`}
                    >
                      <Battery className="w-3.5 h-3.5" /> Batterie: {checklist.batteryOk ? 'OK' : 'KO'}
                    </button>

                    <button
                      type="button"
                      onClick={() => setChecklist({ ...checklist, audioOk: !checklist.audioOk })}
                      className={`min-h-[48px] px-3 py-2 rounded-lg border text-left font-bold flex items-center gap-2 transition cursor-pointer active:scale-95 ${
                        checklist.audioOk ? 'bg-emerald-500/20 border-emerald-500/60 text-emerald-300' : 'bg-pos-card border-pos-border text-pos-muted'
                      }`}
                    >
                      <Volume2 className="w-3.5 h-3.5" /> Audio: {checklist.audioOk ? 'OK' : 'KO'}
                    </button>
                  </div>
                </div>

                {/* Post Checklist */}
                <div className={`${mobileChecklistTab === 'post' ? 'block' : 'hidden'} sm:block bg-pos-bg p-3 sm:p-3.5 rounded-xl border border-emerald-500/30 space-y-2.5`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[10px] sm:text-[11px] font-semibold uppercase tracking-wider text-pos-muted block flex items-center gap-1.5 min-w-0 truncate">
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" /> <span className="truncate">Contrôle Qualité (Après)</span>
                    </span>
                    <button
                      type="button"
                      onClick={() => handleSetAllChecklistOk('post')}
                      className="text-[10px] bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 px-2.5 py-1.5 min-h-[36px] rounded font-bold transition border border-emerald-500/30 cursor-pointer flex items-center gap-1 whitespace-nowrap shrink-0 active:scale-95"
                    >
                      <Check className="w-3 h-3" /> Tout Conforme
                    </button>
                  </div>

                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <button
                      type="button"
                      onClick={() => setPostChecklist({ ...postChecklist, screenOk: !postChecklist.screenOk })}
                      className={`min-h-[48px] px-3 py-2 rounded-lg border text-left font-bold flex items-center gap-2 transition cursor-pointer active:scale-95 ${
                        postChecklist.screenOk ? 'bg-emerald-500/20 border-emerald-500/60 text-emerald-300' : 'bg-pos-card border-pos-border text-pos-muted'
                      }`}
                    >
                      <Smartphone className="w-3.5 h-3.5" /> Écran: {postChecklist.screenOk ? 'OK' : 'KO'}
                    </button>

                    <button
                      type="button"
                      onClick={() => setPostChecklist({ ...postChecklist, faceIdOk: !postChecklist.faceIdOk })}
                      className={`min-h-[48px] px-3 py-2 rounded-lg border text-left font-bold flex items-center gap-2 transition cursor-pointer active:scale-95 ${
                        postChecklist.faceIdOk ? 'bg-emerald-500/20 border-emerald-500/60 text-emerald-300' : 'bg-pos-card border-pos-border text-pos-muted'
                      }`}
                    >
                      <Zap className="w-3.5 h-3.5" /> FaceID: {postChecklist.faceIdOk ? 'OK' : 'KO'}
                    </button>

                    <button
                      type="button"
                      onClick={() => setPostChecklist({ ...postChecklist, cameraOk: !postChecklist.cameraOk })}
                      className={`min-h-[48px] px-3 py-2 rounded-lg border text-left font-bold flex items-center gap-2 transition cursor-pointer active:scale-95 ${
                        postChecklist.cameraOk ? 'bg-emerald-500/20 border-emerald-500/60 text-emerald-300' : 'bg-pos-card border-pos-border text-pos-muted'
                      }`}
                    >
                      <Camera className="w-3.5 h-3.5" /> Caméra: {postChecklist.cameraOk ? 'OK' : 'KO'}
                    </button>

                    <button
                      type="button"
                      onClick={() => setPostChecklist({ ...postChecklist, chargingOk: !postChecklist.chargingOk })}
                      className={`min-h-[48px] px-3 py-2 rounded-lg border text-left font-bold flex items-center gap-2 transition cursor-pointer active:scale-95 ${
                        postChecklist.chargingOk ? 'bg-emerald-500/20 border-emerald-500/60 text-emerald-300' : 'bg-pos-card border-pos-border text-pos-muted'
                      }`}
                    >
                      <Zap className="w-3.5 h-3.5" /> Charge: {postChecklist.chargingOk ? 'OK' : 'KO'}
                    </button>

                    <button
                      type="button"
                      onClick={() => setPostChecklist({ ...postChecklist, batteryOk: !postChecklist.batteryOk })}
                      className={`min-h-[48px] px-3 py-2 rounded-lg border text-left font-bold flex items-center gap-2 transition cursor-pointer active:scale-95 ${
                        postChecklist.batteryOk ? 'bg-emerald-500/20 border-emerald-500/60 text-emerald-300' : 'bg-pos-card border-pos-border text-pos-muted'
                      }`}
                    >
                      <Battery className="w-3.5 h-3.5" /> Batterie: {postChecklist.batteryOk ? 'OK' : 'KO'}
                    </button>

                    <button
                      type="button"
                      onClick={() => setPostChecklist({ ...postChecklist, audioOk: !postChecklist.audioOk })}
                      className={`min-h-[48px] px-3 py-2 rounded-lg border text-left font-bold flex items-center gap-2 transition cursor-pointer active:scale-95 ${
                        postChecklist.audioOk ? 'bg-emerald-500/20 border-emerald-500/60 text-emerald-300' : 'bg-pos-card border-pos-border text-pos-muted'
                      }`}
                    >
                      <Volume2 className="w-3.5 h-3.5" /> Audio: {postChecklist.audioOk ? 'OK' : 'KO'}
                    </button>
                  </div>
                </div>
              </div>
                </div>
              </details>

              {/* Financial Calculation & Deposit Engine */}
              <div className="bg-pos-bg p-3 rounded-xl border border-pos-border space-y-2.5">
                <h3 className="text-[10px] sm:text-[11px] font-semibold uppercase tracking-wider text-pos-muted">
                  Montants de l&apos;intervention
                </h3>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                  <div>
                    <label htmlFor="sav-labor" className="text-xs font-medium text-pos-text mb-1 block">
                      Main d&apos;Œuvre (DA)
                    </label>
                    <input
                      id="sav-labor"
                      type="number"
                      inputMode="decimal"
                      step="1"
                      min="0"
                      value={laborCost}
                      onChange={(e) => setLaborCost(parseFloat(e.target.value) || 0)}
                      className="w-full h-10 sm:h-9 bg-pos-card border border-pos-border rounded-lg px-3 py-1.5 text-base sm:text-xs font-normal font-mono tabular-nums text-pos-text placeholder:text-pos-muted focus:outline-none focus:ring-1 focus:ring-emerald-500"
                    />
                  </div>

                  <div>
                    <label htmlFor="sav-parts" className="text-xs font-medium text-pos-text mb-1 block">
                      Pièces / Composants (DA)
                    </label>
                    <input
                      id="sav-parts"
                      type="number"
                      inputMode="decimal"
                      step="1"
                      min="0"
                      value={partsCost}
                      onChange={(e) => setPartsCost(parseFloat(e.target.value) || 0)}
                      className="w-full h-10 sm:h-9 bg-pos-card border border-pos-border rounded-lg px-3 py-1.5 text-base sm:text-xs font-normal font-mono tabular-nums text-pos-text placeholder:text-pos-muted focus:outline-none focus:ring-1 focus:ring-emerald-500"
                    />
                  </div>

                  <div>
                    <label htmlFor="sav-deposit" className="text-xs font-medium text-pos-text mb-1 block">
                      Acompte versé (DA)
                    </label>
                    <input
                      id="sav-deposit"
                      type="number"
                      inputMode="decimal"
                      step="1"
                      min="0"
                      max={totalCost}
                      value={depositAmount}
                      onChange={(e) => setDepositAmount(parseFloat(e.target.value) || 0)}
                      className={`w-full h-10 sm:h-9 bg-pos-card border rounded-lg px-3 py-1.5 text-base sm:text-xs font-normal font-mono tabular-nums placeholder:text-pos-muted focus:outline-none focus:ring-1 focus:ring-emerald-500 ${
                        depositAmount > totalCost
                          ? 'border-rose-500 text-rose-600 dark:text-rose-300'
                          : 'border-pos-border text-pos-text'
                      }`}
                    />
                  </div>
                </div>

                {/* Single source of truth for the totals. `balanceDue` is DERIVED
                    (never stored), so this row can never disagree with the three
                    inputs above or with the printed ticket. The balance used to
                    render twice — here and in a separate breakdown card — which
                    is how two copies drifted apart. */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 p-2.5 rounded-lg bg-pos-card border border-pos-border">
                  {[
                    { label: 'Pièces', value: money.partsCost, tone: 'text-pos-text' },
                    { label: 'Main d’œuvre', value: money.laborCost, tone: 'text-pos-text' },
                    { label: 'Acompte', value: money.depositAmount, tone: 'text-pos-text' },
                    {
                      label: 'Reste à payer',
                      value: remainingBalance,
                      tone: 'text-emerald-700 dark:text-emerald-300',
                      emphasis: true,
                    },
                  ].map((row) => (
                    <div
                      key={row.label}
                      className={row.emphasis ? 'col-span-2 sm:col-span-1 border-t sm:border-t-0 sm:border-l sm:border-pos-border sm:pl-2.5' : ''}
                    >
                      <span className="block text-[10px] font-medium uppercase tracking-tight text-pos-muted">
                        {row.label}
                      </span>
                      <span
                        className={`block font-mono tabular-nums tracking-tight whitespace-nowrap ${
                          row.emphasis ? 'text-sm sm:text-base font-semibold' : 'text-xs sm:text-sm font-medium'
                        } ${row.tone}`}
                      >
                        {formatDZD(row.value)}
                      </span>
                    </div>
                  ))}
                </div>
                {depositAmount > totalCost && (
                  <p className="text-[10px] font-medium text-rose-600 dark:text-rose-400">
                    L&apos;acompte dépasse le total de l&apos;intervention — il sera plafonné à{' '}
                    <span className="font-mono tabular-nums">{formatDZD(totalCost)}</span> à
                    l&apos;enregistrement.
                  </p>
                )}
              </div>

              {/* CGV acceptance — the customer signs them at intake.
                  The terms deliberately have NO `max-h` / `overflow-y-auto`:
                  a nested scroller inside the modal body is the exact defect
                  that produces the double-scrollbar on mobile. They now expand
                  in the one scroll container the dialog already owns. */}
              <div className="bg-pos-card border border-pos-border rounded-xl p-3 space-y-2">
                <h3 className="text-[10px] sm:text-[11px] font-semibold uppercase tracking-wider text-pos-muted">
                  Conditions Générales de Prise en Charge SAV
                </h3>
                <details className="group rounded-lg border border-pos-border bg-pos-bg p-2">
                  <summary className="min-h-[44px] flex items-center gap-2 text-xs font-medium text-pos-text cursor-pointer">
                    Lire les {SAV_LEGAL_TERMS_FR.length} conditions (FR + AR)
                  </summary>
                  <div className="mt-1.5 space-y-2">
                    <ol className="space-y-1.5 text-[11px] text-pos-muted leading-snug list-decimal pl-4">
                      {SAV_LEGAL_TERMS_FR.map((t) => (
                        <li key={t.slice(0, 24)}>{t}</li>
                      ))}
                    </ol>
                    <div dir="rtl" className="border-t border-pos-border pt-2 space-y-1.5">
                      {SAV_LEGAL_TERMS_AR.map((t) => (
                        <p key={t.slice(0, 16)} className="text-[11px] text-pos-muted leading-relaxed">
                          {t}
                        </p>
                      ))}
                    </div>
                  </div>
                </details>
                <label className={`flex items-start gap-2.5 min-h-[44px] py-1 ${isLegacyEdit ? 'opacity-60' : 'cursor-pointer'}`}>
                  <input
                    type="checkbox"
                    checked={termsAccepted}
                    disabled={isLegacyEdit}
                    onChange={(e) => setTermsAccepted(e.target.checked)}
                    className="mt-0.5 w-5 h-5 accent-emerald-500 shrink-0"
                  />
                  <span className="text-xs text-pos-text leading-snug">
                    Le client a lu et accepte les conditions ci-dessus. Son état des lieux contradictoire
                    (écran, châssis, liquide, verrouillage) est confirmé par sa signature.
                  </span>
                </label>
              </div>

              {/* Customer signature — legally required for a v2 record */}
              <div className="bg-pos-card border border-pos-border rounded-xl p-3">
                <SignaturePad
                  label="Signature du client — accord & état des lieux"
                  required
                  readOnly={isLegacyEdit}
                  initialDataUrl={signatureIntake}
                  onChange={setSignatureIntake}
                  onClear={() => setTermsAccepted(false)}
                  height={170}
                />
                {!signatureIntake && !isLegacyEdit && (
                  <p className="text-[10px] text-rose-600 dark:text-rose-400 font-bold mt-1 flex items-center gap-1">
                    Signature obligatoire avant enregistrement du ticket SAV.
                  </p>
                )}
              </div>
            </form>
          )}

          {activeTab === 'Historique' && (
            <div className="space-y-4 max-w-4xl mx-auto">
              
              {/* History Search & Filter Bar */}
              <div className="bg-pos-card border border-pos-border p-3 rounded-2xl flex items-center justify-between gap-3">
                <div className="relative flex-1">
                  <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-pos-muted" />
                  <input
                    type="text"
                    value={historySearch}
                    onChange={(e) => setHistorySearch(e.target.value)}
                    placeholder="Rechercher par N° Ticket, Client, Tél, Modèle, IMEI..."
                    className="w-full bg-pos-bg border border-pos-border rounded-xl pl-9 pr-3 py-2 text-xs text-pos-text placeholder-pos-muted focus:border-emerald-400 focus:outline-none"
                  />
                  {historySearch && (
                    <button
                      onClick={() => setHistorySearch('')}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-pos-muted hover:text-pos-text text-xs"
                    >
                      ✕
                    </button>
                  )}
                </div>

                {/* Status Pills Filter */}
                <div className="flex items-center gap-1 overflow-x-auto overscroll-contain">
                  {['Tous', 'Diagnostic', 'En attente de pièces', 'En cours', 'Prêt / Terminé', 'Livré', 'Annulé'].map((st) => (
                    <button
                      key={st}
                      type="button"
                      onClick={() => setHistoryStatusFilter(st)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-bold whitespace-nowrap transition ${
                        historyStatusFilter === st
                          ? 'bg-emerald-500 text-slate-950 shadow-md'
                          : 'bg-pos-bg text-pos-muted hover:text-pos-text border border-pos-border'
                      }`}
                    >
                      {st}
                    </button>
                  ))}
                </div>
              </div>

              {/* History Ticket Cards List */}
              {(filteredOrders || []).length === 0 ? (
                <div className="text-center text-pos-muted text-xs py-12 bg-pos-card border border-pos-border rounded-2xl">
                  <Wrench className="w-8 h-8 opacity-40 mx-auto mb-2" />
                  <p className="font-semibold">Aucun ticket de réparation ne correspond à vos critères.</p>
                </div>
              ) : (
                (filteredOrders || []).map((order) => (
                  <div key={order.id} className="bg-pos-card border border-pos-border p-4.5 rounded-2xl flex flex-col gap-3 text-xs shadow-sm hover:border-emerald-500/40 transition">
                    <div className="flex justify-between items-start">
                      <div>
                        <div className="flex items-center gap-2.5 mb-1">
                          <span className="font-mono tabular-nums font-medium text-emerald-700 dark:text-emerald-300 bg-emerald-500/10 px-2 py-0.5 rounded-md border border-emerald-500/30">
                            {order.ticketNumber}
                          </span>
                          <span className="font-semibold text-pos-text text-xs sm:text-sm">{order.customerName}</span>
                        <span className="text-pos-muted text-xs font-normal font-mono tabular-nums tracking-normal">({order.customerPhone})</span>
                      </div>
                      <p className="text-pos-text font-medium text-xs">
                        {order.deviceModel}{' '}
                        <span className="text-pos-muted font-mono tabular-nums tracking-normal text-[10px] ml-2">IMEI: {order.imei}</span>
                      </p>
                      <p className="text-pos-muted mt-1 text-xs">
                        Panne: <span className="text-pos-text font-normal">{order.problemDescription}</span>
                      </p>
                    </div>

                    <div className="text-right">
                      <span className="font-mono tabular-nums font-semibold text-emerald-700 dark:text-emerald-300 text-sm sm:text-base block">{formatDZD(order.totalCost)}</span>
                      {order.depositAmount ? (
                        <span className="text-[10px] text-cyan-600 dark:text-cyan-400 font-medium font-mono tabular-nums block">Acompte: {formatDZD(order.depositAmount)}</span>
                      ) : null}
                      {repairRemainingBalance(order) > 0 && order.status === 'Prêt / Terminé' && (
                        <span className="text-[10px] text-amber-600 dark:text-amber-300 font-medium font-mono tabular-nums block">Reste: {formatDZD(repairRemainingBalance(order))}</span>
                      )}
                        <span className="text-[10px] text-pos-muted mt-0.5 block">{formatDateTime(order.createdAt)}</span>
                      </div>
                    </div>

                    <div className="flex items-center justify-between pt-3 border-t border-pos-border">
                      <div className="flex items-center gap-2">
                        <span className="text-pos-muted text-[10px] uppercase font-bold">Statut Actuel :</span>
                        <select
                          value={order.status}
                          onChange={(e) => handleStatusChange(order.id, e.target.value as RepairOrder['status'])}
                          className={`text-xs font-bold px-3 py-1 rounded-lg border focus:outline-none cursor-pointer ${REPAIR_STATUS_BADGE_TOKENS[order.status] ?? 'bg-pos-bg text-pos-text border-pos-border'}`}
                        >
                          <option value="Diagnostic">Diagnostic</option>
                          <option value="En attente de pièces">En attente de pièces</option>
                          <option value="En cours">En cours</option>
                          <option value="Prêt / Terminé">Prêt / Terminé</option>
                          <option value="Livré">Livré</option>
                          <option value="Annulé">Annulé</option>
                        </select>
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        {order.status === 'Prêt / Terminé' && (
                          <>
                            <button
                              onClick={() => void handleSettleAndDeliver(order)}
                              className="h-10 sm:h-9 px-3.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 flex items-center justify-center gap-1.5 transition text-xs sm:text-sm font-medium cursor-pointer shadow-sm active:scale-95"
                              title="Injecter le solde au panier ou livrer si soldé"
                            >
                              <CheckCircle2 className="w-4 h-4" /> Régler & Livrer
                            </button>
                            <button
                              onClick={() => handleSendWhatsAppNotification(order, 'READY_FOR_PICKUP')}
                              className="h-10 sm:h-9 px-3.5 rounded-lg bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 border border-emerald-500/50 flex items-center gap-1.5 transition text-xs sm:text-sm font-medium cursor-pointer shadow-sm shadow-emerald-500/10"
                              title="Envoyer un message WhatsApp pré-rempli au client"
                            >
                              <MessageSquare className="w-3.5 h-3.5 text-emerald-400" /> WhatsApp
                            </button>
                          </>
                        )}
                        {(order.status === 'Diagnostic' || order.status === 'En cours') && (
                          <>
                            <button
                              onClick={() => handleSendWhatsAppNotification(order, 'QUOTE_APPROVAL_REQUIRED')}
                              className="min-h-[48px] px-3.5 py-1.5 rounded-xl bg-blue-500/15 hover:bg-blue-500/25 text-blue-300 border border-blue-500/40 flex items-center gap-1.5 transition text-xs font-bold cursor-pointer"
                              title="Envoyer le devis à valider"
                            >
                              <MessageSquare className="w-3.5 h-3.5" /> Devis
                            </button>
                            <button
                              onClick={() => void fireDocPrint(order, 'quote')}
                              className="min-h-[48px] px-3.5 py-1.5 rounded-xl bg-blue-500/10 hover:bg-blue-500/20 text-blue-300 border border-blue-500/30 flex items-center gap-1.5 transition text-xs font-bold cursor-pointer"
                              title="Imprimer le devis estimatif (A4 + ticket 58mm)"
                            >
                              <FileText className="w-3.5 h-3.5" /> Imprimer Devis
                            </button>
                          </>
                        )}
                        {order.status === 'Livré' && (
                          <button
                            onClick={() => void fireDocPrint(order, 'restitution')}
                            className="h-10 sm:h-9 px-3.5 rounded-lg bg-zinc-500/10 hover:bg-zinc-500/20 text-zinc-600 dark:text-zinc-300 border border-zinc-500/40 flex items-center gap-1.5 transition text-xs sm:text-sm font-medium cursor-pointer"
                            title="Imprimer le bon de restitution (A4 + ticket 58mm)"
                          >
                            <FileCheck className="w-3.5 h-3.5" /> Fiche Restitution
                          </button>
                        )}
                        {order.status === 'En attente de pièces' && (
                          <>
                            <button
                              onClick={() => handleSendWhatsAppNotification(order, 'PARTS_DELAY_NOTICE')}
                              className="min-h-[48px] px-3.5 py-1.5 rounded-xl bg-cyan-500/15 hover:bg-cyan-500/25 text-cyan-300 border border-cyan-500/40 flex items-center gap-1.5 transition text-xs font-bold cursor-pointer"
                              title="Prévenir du retard pièces"
                            >
                              <MessageSquare className="w-3.5 h-3.5" /> Retard pièces
                            </button>
                            <button
                              onClick={() => void fireDocPrint(order, 'quote')}
                              className="min-h-[48px] px-3.5 py-1.5 rounded-xl bg-blue-500/10 hover:bg-blue-500/20 text-blue-300 border border-blue-500/30 flex items-center gap-1.5 transition text-xs font-bold cursor-pointer"
                              title="Imprimer le devis estimatif (A4 + ticket 58mm)"
                            >
                              <FileText className="w-3.5 h-3.5" /> Imprimer Devis
                            </button>
                          </>
                        )}
                        {order.warrantySnapshot?.isUnderWarranty && (
                          <span className="px-2 py-1 rounded-lg text-[10px] font-bold bg-emerald-500/10 text-emerald-300 border border-emerald-500/30">
                            {order.warrantySnapshot.label}
                          </span>
                        )}
                        <button
                          onClick={() => handleEditClick(order)}
                          className="px-3.5 py-1.5 rounded-xl bg-pos-bg hover:bg-pos-hover text-pos-text border border-pos-border flex items-center gap-1.5 transition text-xs font-semibold cursor-pointer"
                        >
                          <Edit className="w-3.5 h-3.5 text-emerald-400" /> Éditer
                        </button>
                        <button
                          onClick={() => handlePrintTicket(order)}
                          className="px-3.5 py-1.5 rounded-xl bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 flex items-center gap-1.5 transition text-xs font-bold cursor-pointer"
                        >
                          <Printer className="w-3.5 h-3.5" /> Fiche Reçu
                        </button>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
      </>

      {/* Camera scanner — lazy so ZXing never rides the entry chunk. Rendered
          above the shell (own z-layer) so it can never be clipped by the
          shell's overflow/transform stacking context. */}
      {scannerOpen && (
        <React.Suspense
          fallback={
            <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/80 text-pos-text text-xs font-bold">
              Ouverture de la caméra…
            </div>
          }
        >
          <UniversalCameraScannerModal
            onClose={() => setScannerOpen(false)}
            onCaptureImage={(_canvas, barcodes) => {
              handleScannedCode(barcodes.find((b) => b && b.trim()) ?? '');
            }}
          />
        </React.Suspense>
      )}
    </ModalShell>

    {/* Dedicated SAV Repair Ticket Print Template — OUTSIDE the modal shell so
        it never participates in layout or the scroll container.
        printingDocKind selects work_order (intake fiche) vs restitution
        (handover PV) vs quote (devis) — same channel + target, zero CSS. */}
    {printingOrder && (
      <div className="print-repair-target hidden print:block bg-white text-black p-2 font-sans text-xs">
            {printingDocKind === 'restitution' ? (
              <>
                <div className="doc-banner">
                  <div>
                    <p className="doc-title">{receiptSettings.storeName || 'MOBI ACCESSORIES'}</p>
                    <p className="doc-sub">Atelier de Réparation Express & SAV • Tél: {receiptSettings.phone}{receiptSettings.taxNumber ? ` • NIF / RC : ${receiptSettings.taxNumber}` : ''}</p>
                  </div>
                  <div className="doc-refbox">
                    <p className="doc-reftype">Bon de Restitution SAV</p>
                    <p className="doc-ref">N° {printingOrder.ticketNumber}</p>
                    <p className="doc-refdate">Restitué le {formatDateTime(printingOrder.updatedAt || printingOrder.createdAt)}</p>
                  </div>
                </div>

                {repairRemainingBalance(printingOrder) > 0 && (
                  <div className="doc-notebox">
                    <p className="doc-label" style={{ fontWeight: 900, color: '#991b1b', fontVariantNumeric: 'tabular-nums' }}>{RESTITUTION_UNSETTLED_BANNER} — Reste {formatDZD(repairRemainingBalance(printingOrder))}</p>
                  </div>
                )}

                <div className="doc-grid2">
                  <div className="doc-card">
                    <p className="doc-label">Client</p>
                    <p className="doc-value">{printingOrder.customerName}</p>
                    <p className="doc-muted">Tél: {printingOrder.customerPhone || 'Non renseigné'}</p>
                  </div>
                  <div className="doc-card">
                    <p className="doc-label">Appareil restitué</p>
                    <p className="doc-value">{printingOrder.deviceModel}</p>
                    <p className="doc-muted" style={{ fontFamily: 'monospace' }}>IMEI / Série: {printingOrder.imei || 'N/A'}</p>
                  </div>
                </div>

                <table className="doc-table">
                  <thead>
                    <tr><th>N°</th><th>Désignation</th><th className="doc-num">Montant</th></tr>
                  </thead>
                  <tbody>
                    <tr><td className="doc-center">1</td><td>Main d'œuvre</td><td className="doc-num">{formatDZD(Math.round(printingOrder.laborCost || 0))}</td></tr>
                    <tr><td className="doc-center">2</td><td>Pièces détachées</td><td className="doc-num">{formatDZD(Math.round(printingOrder.partsCost || 0))}</td></tr>
                    <tr><td className="doc-center">3</td><td>Acompte réglé (déduit)</td><td className="doc-num">−{formatDZD(Math.round(printingOrder.depositAmount || 0))}</td></tr>
                  </tbody>
                </table>

                <p className="doc-label">Contrôle qualité sortie</p>
                <div className="doc-checkgrid">
                  {([
                    ['Écran', (printingOrder.postRepairChecklist || printingOrder.conditionChecklist)?.screenOk],
                    ['FaceID', (printingOrder.postRepairChecklist || printingOrder.conditionChecklist)?.faceIdOk],
                    ['Caméra', (printingOrder.postRepairChecklist || printingOrder.conditionChecklist)?.cameraOk],
                    ['Charge', (printingOrder.postRepairChecklist || printingOrder.conditionChecklist)?.chargingOk],
                    ['Batterie', (printingOrder.postRepairChecklist || printingOrder.conditionChecklist)?.batteryOk],
                    ['Audio', (printingOrder.postRepairChecklist || printingOrder.conditionChecklist)?.audioOk],
                  ] as Array<[string, boolean | undefined]>).map(([label, ok]) => (
                    <span key={label} className={`doc-chip ${ok ? 'doc-chip-ok' : 'doc-chip-ko'}`}>
                      {label} : {ok ? 'OK' : 'KO'}
                    </span>
                  ))}
                </div>

                <div className="doc-totalband">
                  <div>
                    <p className="doc-totallabel">Solde acquitté à la livraison</p>
                    <p className="doc-totalsub">Total {formatDZD(Math.round(printingOrder.totalCost))} • Acompte −{formatDZD(Math.round(printingOrder.depositAmount || 0))}</p>
                  </div>
                  <span className="doc-totalval">{formatDZD(Math.round(printingOrder.totalCost) - repairRemainingBalance(printingOrder))}</span>
                </div>

                <div className="doc-notebox">
                  <p className="doc-terms">• L'appareil a été vérifié fonctionnel en présence du client au moment du retrait.</p>
                  <p className="doc-terms">• MOBI ACCESSORIES décline toute responsabilité quant aux données non sauvegardées préalablement.</p>
                  <p className="doc-terms">• {DATA_LOSS_DISCLAIMER}</p>
                  <p className="doc-terms">• Garantie 30 jours sur pièces remplacées, hors chocs, humidité et démontage ultérieur.</p>
                  <p className="doc-terms">• {UNCLAIMED_DEVICE_CLAUSE}</p>
                </div>

                <p className="doc-muted">{faitALine(receiptSettings)}</p>

                {/* The exit PV (restitution) is signed IN THE SHOP at handover, so
                    a blank line is legitimate here — the customer's wet signature
                    goes on this copy. The INTAKE fiche, further down, is the one
                    that must carry the captured signature. */}
                <div className="doc-sign">
                  <div>
                    <p className="doc-signlabel">Pour l'Atelier</p>
                    <div className="doc-signline" />
                  </div>
                  <div>
                    <p className="doc-signlabel">Le Client — « Appareil reçu conforme » (Lu et approuvé)</p>
                    <div className="doc-signline" />
                  </div>
                </div>

                <div className="doc-footer">
                  <span>{receiptSettings.storeName || 'MOBI ACCESSORIES'} • Tél: {receiptSettings.phone}</span>
                  <span>Ticket N° {printingOrder.ticketNumber}</span>
                  <span>Document généré par Mobi-POS</span>
                </div>
              </>
            ) : printingDocKind === 'quote' ? (
              <>
                <div className="doc-banner">
                  <div>
                    <p className="doc-title">{receiptSettings.storeName || 'MOBI ACCESSORIES'}</p>
                    <p className="doc-sub">Atelier de Réparation Express & SAV • Tél: {receiptSettings.phone}{receiptSettings.taxNumber ? ` • NIF / RC : ${receiptSettings.taxNumber}` : ''}</p>
                  </div>
                  <div className="doc-refbox">
                    <p className="doc-reftype">Devis Estimatif SAV</p>
                    <p className="doc-ref">N° {repairQuoteNumber(printingOrder)}</p>
                    <p className="doc-refdate">Émis le {new Date().toLocaleDateString('fr-DZ')}</p>
                  </div>
                </div>

                <div className="doc-notebox">
                  <p className="doc-label" style={{ fontWeight: 900 }}>Validité : {REPAIR_QUOTE_VALIDITY_DAYS} jours — jusqu'au {new Date(Date.now() + REPAIR_QUOTE_VALIDITY_DAYS * 86400000).toLocaleDateString('fr-DZ')}</p>
                </div>

                <div className="doc-grid2">
                  <div className="doc-card">
                    <p className="doc-label">Client</p>
                    <p className="doc-value">{printingOrder.customerName}</p>
                    <p className="doc-muted">Tél: {printingOrder.customerPhone || 'Non renseigné'}</p>
                  </div>
                  <div className="doc-card">
                    <p className="doc-label">Appareil</p>
                    <p className="doc-value">{printingOrder.deviceModel}</p>
                    <p className="doc-muted" style={{ fontFamily: 'monospace' }}>IMEI / Série: {printingOrder.imei || 'N/A'}</p>
                  </div>
                </div>

                <div className="doc-notebox">
                  <p className="doc-label">Symptôme / diagnostic</p>
                  <p className="doc-muted" style={{ fontWeight: 700, color: '#111827' }}>{printingOrder.problemDescription}</p>
                  {printingOrder.diagnosticNotes && (
                    <p className="doc-muted" style={{ fontStyle: 'italic' }}>{printingOrder.diagnosticNotes}</p>
                  )}
                </div>

                <table className="doc-table">
                  <thead>
                    <tr><th>N°</th><th>Désignation</th><th className="doc-num">Montant estimé</th></tr>
                  </thead>
                  <tbody>
                    <tr><td className="doc-center">1</td><td>Main d'œuvre estimée</td><td className="doc-num">{formatDZD(Math.round(printingOrder.laborCost || 0))}</td></tr>
                    <tr><td className="doc-center">2</td><td>Pièces estimées</td><td className="doc-num">{formatDZD(Math.round(printingOrder.partsCost || 0))}</td></tr>
                  </tbody>
                </table>

                <div className="doc-totalband">
                  <div>
                    <p className="doc-totallabel">Total estimé</p>
                    <p className="doc-totalsub">Acompte requis : {formatDZD(Math.round(Math.round(printingOrder.totalCost) / 2))} • Devis gratuit, sans engagement</p>
                  </div>
                  <span className="doc-totalval">{formatDZD(Math.round(printingOrder.totalCost))}</span>
                </div>

                <p className="doc-muted">{faitALine(receiptSettings)}</p>

                <div className="doc-sign">
                  <div>
                    <p className="doc-signlabel">Pour l'Atelier</p>
                    <div className="doc-signline" />
                  </div>
                  <div>
                    <p className="doc-signlabel">Bon pour accord (signature client)</p>
                    <div className="doc-signline" />
                  </div>
                </div>

                <div className="doc-footer">
                  <span>{receiptSettings.storeName || 'MOBI ACCESSORIES'} • Tél: {receiptSettings.phone}</span>
                  <span>Devis N° {repairQuoteNumber(printingOrder)} • Ticket {printingOrder.ticketNumber}</span>
                  <span>Document généré par Mobi-POS</span>
                </div>
              </>
            ) : (
              <>
            <div className="doc-banner">
              <div>
                <p className="doc-title">{receiptSettings.storeName || 'MOBI ACCESSORIES'}</p>
                <p className="doc-sub">Atelier de Réparation Express & SAV • Tél: {receiptSettings.phone}</p>
              </div>
              <div className="doc-refbox">
                <p className="doc-reftype">Fiche d'intervention SAV</p>
                <p className="doc-ref">N° {printingOrder.ticketNumber}</p>
                <p className="doc-refdate">{formatDateTime(printingOrder.createdAt)}</p>
              </div>
            </div>

            {/* Customer & Device Information */}
            <div className="doc-grid2">
              <div className="doc-card">
                <p className="doc-label">Client</p>
                <p className="doc-value">{printingOrder.customerName}</p>
                <p className="doc-muted">Tél: {printingOrder.customerPhone || 'Non renseigné'}</p>
              </div>
              <div className="doc-card">
                <p className="doc-label">Appareil déposé</p>
                <p className="doc-value">{printingOrder.deviceModel}</p>
                <p className="doc-muted" style={{ fontFamily: 'monospace' }}>IMEI / Série: {printingOrder.imei || 'N/A'}</p>
              </div>
            </div>

            {/* Diagnostic & Problem Description */}
            <div className="doc-notebox">
              <p className="doc-label">Symptôme / problème signalé</p>
              <p className="doc-muted" style={{ fontWeight: 700, color: '#111827' }}>{printingOrder.problemDescription}</p>
              {printingOrder.diagnosticNotes && (
                <>
                  <p className="doc-label" style={{ marginTop: '6px' }}>Diagnostic technique atelier</p>
                  <p className="doc-muted" style={{ fontStyle: 'italic' }}>{printingOrder.diagnosticNotes}</p>
                </>
              )}
            </div>

            {/* Reception & Quality Checklists */}
            {(() => {
              const checks: Array<[string, boolean | undefined]> = [
                ['Écran', printingOrder.conditionChecklist?.screenOk],
                ['FaceID', printingOrder.conditionChecklist?.faceIdOk],
                ['Caméra', printingOrder.conditionChecklist?.cameraOk],
                ['Charge', printingOrder.conditionChecklist?.chargingOk],
                ['Batterie', printingOrder.conditionChecklist?.batteryOk],
                ['Audio', printingOrder.conditionChecklist?.audioOk],
              ];
              const postChecks: Array<[string, boolean | undefined]> = [
                ['Écran', printingOrder.postRepairChecklist?.screenOk],
                ['FaceID', printingOrder.postRepairChecklist?.faceIdOk],
                ['Caméra', printingOrder.postRepairChecklist?.cameraOk],
                ['Charge', printingOrder.postRepairChecklist?.chargingOk],
                ['Batterie', printingOrder.postRepairChecklist?.batteryOk],
                ['Audio', printingOrder.postRepairChecklist?.audioOk],
              ];
              const renderChips = (list: Array<[string, boolean | undefined]>) => (
                <div className="doc-checkgrid">
                  {list.map(([label, ok]) => (
                    <span key={label} className={`doc-chip ${ok ? 'doc-chip-ok' : 'doc-chip-ko'}`}>
                      {label} : {ok ? 'OK' : 'KO'}
                    </span>
                  ))}
                </div>
              );
              return (
                <>
                  <p className="doc-label">Checklist à la réception</p>
                  {renderChips(checks)}
                  <p className="doc-label">Contrôle qualité après réparation</p>
                  {renderChips(postChecks)}
                </>
              );
            })()}

            {/* Financial Summary */}
            <div className="doc-totalband">
              <div>
                <p className="doc-totallabel">Reste à régler à la livraison</p>
                <p className="doc-totalsub">Devis {formatDZD(printingOrder.totalCost)}{printingOrder.depositAmount ? ` • Acompte −${formatDZD(printingOrder.depositAmount)}` : ''}</p>
              </div>
              <span className="doc-totalval">
                {formatDZD(Math.max(0, printingOrder.totalCost - (printingOrder.depositAmount || 0)))}
              </span>
            </div>

            {/* v2 legal record on paper: the constat the customer signed, the
                warranty actually granted, and the photo evidence manifest. A v1
                ticket has none of these and says so explicitly instead of
                leaving blanks a reader could mistake for "nothing to declare". */}
            {isSchemaV2Order(printingOrder) ? (
              <>
                <div className="doc-notebox">
                  <p className="doc-label">Constat contradictoire à la prise en charge</p>
                  <p className="doc-muted" style={{ fontWeight: 700, color: '#111827' }}>
                    {describeIntakeDamage(printingOrder.intakeDamage)}
                  </p>
                  {printingOrder.intakeDamage?.liquidIndicatorTripped && (
                    <p className="doc-terms">
                      • Indicateur de liquide DÉCLENCHÉ à la remise — la garantie de réparation est exclue.
                    </p>
                  )}
                  {hasDeviceLock(printingOrder.intakeDamage?.deviceLock) && (
                    <p className="doc-terms">
                      • Appareil VERROUILLÉ (
                      {DEVICE_LOCK_LABELS[printingOrder.intakeDamage!.deviceLock!.type]}) — aucune
                      fonction n&apos;a pu être vérifiée par l&apos;atelier ; garantie de réparation
                      exclue.
                    </p>
                  )}
                  {intakeBlocksRepairWarranty(printingOrder.intakeDamage) &&
                    !printingOrder.intakeDamage?.liquidIndicatorTripped &&
                    !hasDeviceLock(printingOrder.intakeDamage?.deviceLock) && (
                      <p className="doc-terms">
                        • Dommage majeur constaté — la garantie de réparation est exclue.
                      </p>
                    )}
                  {printingOrder.warrantyTier && (
                    <p className="doc-terms">
                      • Garantie de réparation accordée :{' '}
                      <strong>{WARRANTY_TIER_LABELS[printingOrder.warrantyTier]}</strong>
                      {printingOrder.warrantyExpiresAt
                        ? ` — jusqu'au ${formatDateTime(printingOrder.warrantyExpiresAt)}`
                        : ''}
                    </p>
                  )}
                  {printingOrder.legalTermsAcceptedAt && (
                    <p className="doc-terms">
                      • CGV acceptées par le client le {formatDateTime(printingOrder.legalTermsAcceptedAt)}.
                    </p>
                  )}
                  {printingOrder.intakePhotos && printingOrder.intakePhotos.length > 0 && (
                    <>
                      <p className="doc-label" style={{ marginTop: '6px' }}>
                        Pièces photo (empreinte SHA-256)
                      </p>
                      {printingOrder.intakePhotos.map((p, i) => (
                        <p key={p.sha256} className="doc-terms" style={{ fontFamily: 'monospace' }}>
                          • Photo {i + 1} : {p.relativePath} — {p.sha256.slice(0, 32)}…
                        </p>
                      ))}
                    </>
                  )}
                </div>

                <div className="doc-sign">
                  <div>
                    <p className="doc-signlabel">Pour l'Atelier</p>
                    <div className="doc-signline" />
                  </div>
                  <div>
                    <p className="doc-signlabel">
                      Le Client — accord & état des lieux (signature numérisée)
                    </p>
                    {printingOrder.signatureCustomerIntake ? (
                      <img
                        src={printingOrder.signatureCustomerIntake}
                        alt="Signature du client à la prise en charge"
                        style={{ maxHeight: '38px', maxWidth: '100%', objectFit: 'contain' }}
                      />
                    ) : (
                      <div className="doc-signline" />
                    )}
                    {printingOrder.signatureIntakeAt && (
                      <p className="doc-muted" style={{ fontSize: '8px' }}>
                        Signé le {formatDateTime(printingOrder.signatureIntakeAt)}
                      </p>
                    )}
                  </div>
                </div>
              </>
            ) : (
              <>
                <div className="doc-notebox">
                  <p className="doc-label">{LEGACY_DOSSIER_PILL}</p>
                  <p className="doc-terms">
                    • Constat physique, signature et conditions générales n'ont pas été relevés à la
                    prise en charge sur ce dossier (antérieur au registre v2). Document non
                    contractuel pour la constatation d'état.
                  </p>
                </div>
                <div className="doc-sign">
                  <div>
                    <p className="doc-signlabel">Pour l'Atelier</p>
                    <div className="doc-signline" />
                  </div>
                  <div>
                    <p className="doc-signlabel">Le Client (Lu et approuvé)</p>
                    <div className="doc-signline" />
                  </div>
                </div>
              </>
            )}

            <div className="doc-notebox">
              <p className="doc-terms">• {UNCLAIMED_DEVICE_CLAUSE}</p>
              <p className="doc-terms">• MOBI ACCESSORIES décline toute responsabilité quant aux données non sauvegardées préalablement.</p>
              <p className="doc-terms">• {DATA_LOSS_DISCLAIMER}</p>
            </div>

            <p className="doc-muted">{faitALine(receiptSettings)}</p>

            <div className="doc-footer">
              <span>{receiptSettings.storeName || 'MOBI ACCESSORIES'} • Tél: {receiptSettings.phone}</span>
              <span>Ticket N° {printingOrder.ticketNumber}</span>
              <span>Document généré par Mobi-POS</span>
            </div>
              </>
            )}
      </div>
    )}
    </>
  );
};

