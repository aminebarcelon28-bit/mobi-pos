import React, { useState, useEffect } from 'react';
import {
  X,
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
  Camera,
  Battery,
  Volume2,
  Zap,
  MessageSquare,
  Check,
} from 'lucide-react';
import { usePosStore } from '../../store/usePosStore';
import { REPAIR_BALANCE_DUE_EVENT } from '../../store/slices/createRepairSlice';
import { formatDZD, formatDateTime } from '../../types/pos';
import type { ConditionChecklist, RepairOrder } from '../../types/pos';
import { printCoordinator } from '../../utils/printCoordinator';
import { useToast } from '../ui/Toast';
import { isMobileDevice } from '../../utils/platform';

const initialChecklist: ConditionChecklist = {
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

  const [activeTab, setActiveTab] = useState<'Nouveau' | 'Historique'>('Nouveau');
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
  const [problemDescription, setProblemDescription] = useState('');
  const [diagnosticNotes, setDiagnosticNotes] = useState('');
  const [laborCost, setLaborCost] = useState<number>(0);
  const [partsCost, setPartsCost] = useState<number>(0);
  const [depositAmount, setDepositAmount] = useState<number>(0);
  const [estimatedDate, setEstimatedDate] = useState('');
  const [status, setStatus] = useState<RepairOrder['status']>('Diagnostic');
  const [checklist, setChecklist] = useState<ConditionChecklist>(initialChecklist);
  const [postChecklist, setPostChecklist] = useState<ConditionChecklist>(initialChecklist);
  const [printingOrder, setPrintingOrder] = useState<RepairOrder | null>(null);

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
    setProblemDescription('');
    setDiagnosticNotes('');
    setLaborCost(0);
    setPartsCost(0);
    setDepositAmount(0);
    setEstimatedDate('');
    setStatus('Diagnostic');
    setChecklist(initialChecklist);
    setPostChecklist(initialChecklist);
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

  const handleSendWhatsAppNotification = (order: RepairOrder) => {
    // Guard the whatsapp-modal precondition: opening 'whatsapp_dispatch' with
    // no order context renders an empty modal with no feedback. Toast instead.
    if (!order) {
      showToast('Aucun ordre de réparation sélectionné pour la notification.', 'warning');
      return;
    }
    setSelectedRepairOrderForNotification(order);
    openModal('whatsapp_dispatch');
  };

  const handleSetAllChecklistOk = (target: 'pre' | 'post') => {
    const allOk: ConditionChecklist = {
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

  const handleSaveOrder = (e: React.FormEvent) => {
    e.preventDefault();
    if (!customerName.trim() || !deviceModel.trim()) {
      showToast('Veuillez renseigner le nom du client et le modèle d\'appareil avant d\'enregistrer.', 'warning');
      return;
    }

    // B-033: integer DZD at the write boundary — drawer movements round, so
    // unrounded labor/parts/deposit drift repair reports vs drawer.
    const validLabor = Math.max(0, Math.round(isNaN(laborCost) ? 0 : laborCost));
    const validParts = Math.max(0, Math.round(isNaN(partsCost) ? 0 : partsCost));
    const validTotal = validLabor + validParts;
    const validDeposit = Math.max(0, Math.min(validTotal, Math.round(isNaN(depositAmount) ? 0 : depositAmount)));

    if (editingId) {
      updateRepairOrder(editingId, {
        customerName: customerName.trim(),
        customerPhone: customerPhone.trim(),
        deviceModel: deviceModel.trim(),
        imei: imei.trim().toUpperCase(),
        problemDescription,
        diagnosticNotes,
        status,
        laborCost: validLabor,
        partsCost: validParts,
        depositAmount: validDeposit,
        estimatedCompletionDate: estimatedDate,
        conditionChecklist: checklist,
        postRepairChecklist: postChecklist,
      });
      showSuccess('Réparation mise à jour avec succès !');
    } else {
      createRepairOrder({
        customerName: customerName.trim(),
        customerPhone: customerPhone.trim(),
        deviceModel: deviceModel.trim(),
        imei: imei.trim().toUpperCase(),
        problemDescription,
        diagnosticNotes,
        status,
        laborCost: validLabor,
        partsCost: validParts,
        depositAmount: validDeposit,
        estimatedCompletionDate: estimatedDate,
        conditionChecklist: checklist,
        postRepairChecklist: postChecklist,
      });
      showSuccess('Nouvelle Fiche de Réparation créée !');
      resetForm();
    }
  };

  const handleEditClick = (order: RepairOrder) => {
    setEditingId(order.id);
    setCustomerName(order.customerName);
    setCustomerPhone(order.customerPhone);
    setDeviceModel(order.deviceModel);
    setImei(order.imei);
    setProblemDescription(order.problemDescription);
    setDiagnosticNotes(order.diagnosticNotes || '');
    setLaborCost(order.laborCost);
    setPartsCost(order.partsCost);
    setDepositAmount(order.depositAmount || 0);
    setEstimatedDate(order.estimatedCompletionDate || '');
    setStatus(order.status);
    setChecklist(order.conditionChecklist || initialChecklist);
    setPostChecklist(order.postRepairChecklist || initialChecklist);
    setActiveTab('Nouveau');
  };

  const handleStatusChange = (id: string, newStatus: RepairOrder['status']) => {
    updateRepairOrderStatus(id, newStatus);
    showSuccess('Statut mis à jour !');
  };

  const handlePrintTicket = async (order: RepairOrder) => {
    // Mobile: no window.print dialog — text fiche via the Android sheet.
    if (isMobileDevice()) {
      const { openNativePrint } = await import('../../utils/phoneUtils');
      const { repairTicketText } = await import('../../utils/mobileDocPrint');
      const ok = await openNativePrint(
        `Fiche SAV ${order.ticketNumber}`,
        repairTicketText(order, receiptSettings)
      );
      showToast(
        ok ? '🖨️ Feuille d’impression Android ouverte.' : 'Impression indisponible sur cet appareil.',
        ok ? 'success' : 'error'
      );
      return;
    }
    setPrintingOrder(order);
    printCoordinator.printRepairWorkOrder(50);
  };

  const totalCost = laborCost + partsCost;
  const remainingBalance = Math.max(0, totalCost - depositAmount);

  if (activeModal !== 'repair_work_order') return null;

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 pt-[max(0.5rem,var(--safe-top))] pb-[max(0.5rem,var(--safe-bottom))] select-none">
      <div className="bg-pos-panel border border-pos-border rounded-t-3xl sm:rounded-2xl w-full max-w-5xl overflow-hidden shadow-2xl animate-in slide-in-from-bottom-5 sm:zoom-in-95 h-[94vh] sm:h-[92vh] flex flex-col">
        {/* Mobile drag handle */}
        <div className="w-8 h-1 rounded-full bg-pos-muted/40 mx-auto mt-2.5 mb-1 sm:hidden shrink-0" />
        
        {/* Header */}
        <div className="p-3.5 sm:p-4 border-b border-pos-border flex items-center justify-between bg-pos-card shrink-0 gap-2">
          <div className="flex items-center gap-2.5 sm:gap-3 min-w-0">
            <div className="w-8 h-8 sm:w-10 sm:h-10 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center text-slate-950 font-bold shadow-lg shadow-emerald-500/20 shrink-0">
              <Wrench className="w-4 h-4 sm:w-5 sm:h-5 stroke-[2.5]" />
            </div>
            <div className="min-w-0">
              <h2 className="text-xs sm:text-base font-extrabold text-pos-text tracking-wide flex items-center gap-2 truncate">
                <span>RÉPARATIONS & TICKETS SAV</span>
                <span className="text-[9px] sm:text-[10px] bg-emerald-500/10 text-emerald-400 font-bold px-1.5 sm:px-2 py-0.5 rounded border border-emerald-500/30 shrink-0">
                  ENTERPRISE
                </span>
              </h2>
              <p className="text-[10px] sm:text-[11px] text-pos-muted truncate">Prise en charge atelier, checklist et suivi SAV</p>
            </div>
          </div>

          <button
            onClick={closeModal}
            className="p-1.5 hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-xl transition min-h-[38px] min-w-[38px] flex items-center justify-center cursor-pointer shrink-0"
            aria-label="Fermer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Executive KPI Summary Bar */}
        <div className="bg-pos-bg border-b border-pos-border px-3 sm:px-4 py-2 sm:py-2.5 grid grid-cols-3 sm:grid-cols-6 gap-2 sm:gap-3 shrink-0 text-center select-none">
          <div className="bg-pos-card border border-pos-border rounded-lg p-2">
            <span className="text-[9px] uppercase font-bold text-pos-muted block">Total Dossiers</span>
            <span className="text-sm font-black text-pos-text">{totalOrders}</span>
          </div>

          <div className="bg-pos-card border border-amber-500/30 rounded-lg p-2">
            <span className="text-[9px] uppercase font-bold text-amber-400 block">Diagnostic</span>
            <span className="text-sm font-black text-amber-300">{diagnosticCount}</span>
          </div>

          <div className="bg-pos-card border border-cyan-500/30 rounded-lg p-2">
            <span className="text-[9px] uppercase font-bold text-cyan-400 block">Attente Pièces</span>
            <span className="text-sm font-black text-cyan-300">{pendingPartsCount}</span>
          </div>

          <div className="bg-pos-card border border-blue-500/30 rounded-lg p-2">
            <span className="text-[9px] uppercase font-bold text-blue-400 block">En Cours</span>
            <span className="text-sm font-black text-blue-300">{inProgressCount}</span>
          </div>

          <div className="bg-pos-card border border-emerald-500/30 rounded-lg p-2">
            <span className="text-[9px] uppercase font-bold text-emerald-400 block">Prêts / Terminés</span>
            <span className="text-sm font-black text-emerald-300">{completedCount}</span>
          </div>

          <div className="bg-pos-card border border-emerald-500/30 rounded-lg p-2">
            <span className="text-[9px] uppercase font-bold text-pos-muted block">Chiffre d'Affaires SAV</span>
            <span className="text-sm font-black text-emerald-400">{formatDZD(totalRevenue)}</span>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-pos-border bg-pos-panel px-2.5 sm:px-4 shrink-0 overflow-x-auto no-scrollbar whitespace-nowrap">
          <button
            onClick={() => { setActiveTab('Nouveau'); if (!editingId) resetForm(); }}
            className={`min-h-[44px] px-3.5 sm:px-4 py-2.5 text-xs font-bold border-b-2 transition-colors shrink-0 active:scale-95 ${activeTab === 'Nouveau' ? 'border-emerald-500 text-emerald-400' : 'border-transparent text-pos-muted hover:text-pos-text'}`}
          >
            <div className="flex items-center gap-2">
              <Plus className="w-4 h-4" /> <span>{editingId ? 'Modifier Fiche' : 'Nouveau Ticket SAV'}</span>
            </div>
          </button>
          <button
            onClick={() => setActiveTab('Historique')}
            className={`min-h-[44px] px-3.5 sm:px-4 py-2.5 text-xs font-bold border-b-2 transition-colors shrink-0 active:scale-95 ${activeTab === 'Historique' ? 'border-emerald-500 text-emerald-400' : 'border-transparent text-pos-muted hover:text-pos-text'}`}
          >
            <div className="flex items-center gap-2">
              <History className="w-4 h-4" /> <span>Historique Atelier ({repairOrders.length})</span>
            </div>
          </button>
        </div>

        {/* Content Body */}
        <div className="flex-1 overflow-y-auto p-3 sm:p-5 relative bg-pos-bg">
          {successMsg && (
            <div className="absolute top-3 left-1/2 -translate-x-1/2 bg-emerald-500/20 border border-emerald-500/60 text-emerald-300 px-5 py-2.5 rounded-full text-xs font-bold flex items-center gap-2 z-20 shadow-lg animate-in fade-in slide-in-from-top-4">
              <CheckCircle2 className="w-4 h-4" /> {successMsg}
            </div>
          )}

          {activeTab === 'Nouveau' && (
            <form onSubmit={handleSaveOrder} className="bg-pos-card border border-pos-border rounded-2xl p-3.5 sm:p-5 space-y-3 sm:space-y-4 max-w-4xl mx-auto shadow-md">
              
              {editingId && (
                <div className="flex flex-col gap-2 sm:flex-row sm:justify-between sm:items-center bg-emerald-500/10 border border-emerald-500/30 p-2.5 rounded-xl">
                  <span className="text-xs font-bold text-emerald-400 flex items-center gap-1.5">
                    <Edit className="w-4 h-4 shrink-0" /> <span className="truncate">Modification de la Fiche Réparation #{editingId}</span>
                  </span>
                  <button type="button" onClick={resetForm} className="text-xs text-pos-muted hover:text-pos-text underline self-start sm:self-auto min-h-[32px]">
                    Annuler l'Édition
                  </button>
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

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label className="text-[11px] text-pos-muted block mb-1 font-semibold">Nom du Client</label>
                    <input
                      type="text"
                      required
                      value={customerName}
                      onChange={(e) => setCustomerName(e.target.value)}
                      placeholder="Ex: Yacine Benali"
                      className="w-full min-h-[48px] bg-pos-card border border-pos-border rounded-lg px-3 py-2 text-base sm:text-xs font-bold text-pos-text focus:border-emerald-400 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="text-[11px] text-pos-muted block mb-1 font-semibold">Téléphone / Contact</label>
                    <input
                      type="tel"
                      inputMode="tel"
                      required
                      value={customerPhone}
                      onChange={(e) => setCustomerPhone(e.target.value)}
                      placeholder="Ex: 0550 12 34 56"
                      className="w-full min-h-[48px] bg-pos-card border border-pos-border rounded-lg px-3 py-2 text-base sm:text-xs font-bold text-pos-text focus:border-emerald-400 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="text-[11px] text-pos-muted block mb-1 font-semibold">Appareil / Modèle</label>
                    <input
                      type="text"
                      required
                      value={deviceModel}
                      onChange={(e) => setDeviceModel(e.target.value)}
                      placeholder="Ex: iPhone 15 Pro Max"
                      className="w-full min-h-[48px] bg-pos-card border border-pos-border rounded-lg px-3 py-2 text-base sm:text-xs font-bold text-pos-text focus:border-emerald-400 focus:outline-none"
                    />
                  </div>
                </div>

                {/* Device Quick Presets */}
                <div className="flex items-center gap-1.5 pt-1 overflow-x-auto">
                  <span className="text-[10px] text-pos-muted font-semibold shrink-0">Presets Modèle:</span>
                  {DEVICE_PRESETS.map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => setDeviceModel(preset)}
                      className={`min-h-[40px] px-2.5 py-1.5 rounded text-[10px] font-semibold border transition shrink-0 active:scale-95 ${
                        deviceModel === preset
                          ? 'bg-emerald-500 text-slate-950 border-emerald-400 font-bold'
                          : 'bg-pos-card border-pos-border text-pos-muted hover:text-pos-text'
                      }`}
                    >
                      {preset}
                    </button>
                  ))}
                </div>
              </div>

              {/* IMEI & Problem Description */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="text-[11px] text-pos-muted block mb-1 font-semibold">Numéro IMEI / N° Série</label>
                  <input
                    type="text"
                    inputMode="numeric"
                    required
                    value={imei}
                    onChange={(e) => setImei(e.target.value)}
                    placeholder="Ex: 358921004812345"
                    className="w-full min-h-[48px] bg-pos-bg border border-pos-border rounded-lg px-3 py-2 text-base sm:text-xs font-mono font-bold text-emerald-400 focus:border-emerald-400 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="text-[11px] text-pos-muted block mb-1 font-semibold">Panne Signalée par le Client</label>
                  <input
                    type="text"
                    required
                    value={problemDescription}
                    onChange={(e) => setProblemDescription(e.target.value)}
                    placeholder="Ex: Écran fissuré + connecteur de charge cassé"
                    className="w-full min-h-[48px] bg-pos-bg border border-pos-border rounded-lg px-3 py-2 text-base sm:text-xs text-pos-text focus:border-emerald-400 focus:outline-none"
                  />
                </div>
              </div>

              <div>
                <label className="text-[11px] text-pos-muted block mb-1 font-semibold">Notes & Constatations du Technicien (Interne)</label>
                <textarea
                  rows={2}
                  value={diagnosticNotes}
                  onChange={(e) => setDiagnosticNotes(e.target.value)}
                  className="w-full min-h-[64px] bg-pos-bg border border-pos-border rounded-lg px-3 py-2 text-base sm:text-xs text-pos-text focus:border-emerald-400 focus:outline-none"
                  placeholder="Notes de diagnostic, micro-soudures nécessaires, tests effectués..."
                />
              </div>

              {/* Visual Interactive Checklists (Pre & Post) */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
                {/* Pre Checklist */}
                <div className="bg-pos-bg p-3 sm:p-3.5 rounded-xl border border-pos-border space-y-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] font-extrabold text-pos-text uppercase tracking-wider block flex items-center gap-1.5 min-w-0 truncate">
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
                <div className="bg-pos-bg p-3 sm:p-3.5 rounded-xl border border-pos-border space-y-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] font-extrabold text-pos-text uppercase tracking-wider block flex items-center gap-1.5 min-w-0 truncate">
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

              {/* Financial Calculation & Deposit Engine */}
              <div className="bg-pos-bg p-3 sm:p-3.5 rounded-xl border border-pos-border space-y-3">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:items-center">
                  <div>
                    <label className="text-[11px] text-pos-muted block mb-1 font-semibold">Main d'Œuvre (DA)</label>
                    <input
                      type="number"
                      inputMode="decimal"
                      step="any"
                      value={laborCost}
                      onChange={(e) => setLaborCost(parseFloat(e.target.value) || 0)}
                      className="w-full min-h-[48px] bg-pos-card border border-pos-border rounded-lg px-3 py-2 text-base sm:text-xs font-bold text-emerald-400 focus:outline-none"
                    />
                  </div>

                  <div>
                    <label className="text-[11px] text-pos-muted block mb-1 font-semibold">Prix Pièces / Composants (DA)</label>
                    <input
                      type="number"
                      inputMode="decimal"
                      step="any"
                      value={partsCost}
                      onChange={(e) => setPartsCost(parseFloat(e.target.value) || 0)}
                      className="w-full min-h-[48px] bg-pos-card border border-pos-border rounded-lg px-3 py-2 text-base sm:text-xs font-bold text-amber-400 focus:outline-none"
                    />
                  </div>

                  <div>
                    <label className="text-[11px] text-pos-muted block mb-1 font-semibold">Acompte Versé (DA)</label>
                    <input
                      type="number"
                      inputMode="decimal"
                      step="any"
                      value={depositAmount}
                      onChange={(e) => setDepositAmount(parseFloat(e.target.value) || 0)}
                      className="w-full min-h-[48px] bg-pos-card border border-pos-border rounded-lg px-3 py-2 text-base sm:text-xs font-bold text-cyan-400 focus:outline-none"
                    />
                  </div>

                  <div className="col-span-2 sm:col-span-1 bg-emerald-500/10 border border-emerald-500/30 rounded-lg px-3 py-2 sm:bg-transparent sm:border-0 sm:p-0 text-left sm:text-right flex sm:block items-center justify-between gap-2">
                    <span className="text-[10px] text-pos-muted uppercase block font-bold">Reste à Payer (Livraison)</span>
                    <span className="text-xl sm:text-lg font-black text-emerald-400 whitespace-nowrap">{formatDZD(remainingBalance)}</span>
                  </div>
                </div>
              </div>

              {/* Status & Save Button */}
              <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3 pt-2 border-t border-pos-border">
                <div className="flex items-center gap-2 w-full sm:w-auto">
                  <span className="text-xs text-pos-muted font-bold whitespace-nowrap shrink-0">Statut du Ticket:</span>
                  <select
                    value={status}
                    onChange={(e) => setStatus(e.target.value as RepairOrder['status'])}
                    className="flex-1 sm:flex-none min-h-[48px] bg-pos-bg border border-pos-border rounded-xl px-3.5 py-2 text-sm sm:text-xs font-bold text-pos-text focus:outline-none cursor-pointer"
                  >
                    <option value="Diagnostic">Statut: Diagnostic</option>
                    <option value="En attente de pièces">Statut: En attente de pièces</option>
                    <option value="En cours">Statut: En cours</option>
                    <option value="Prêt / Terminé">Statut: Prêt / Terminé</option>
                  </select>
                </div>

                <button
                  type="submit"
                  className="w-full sm:w-auto min-h-[52px] px-6 py-3 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-sm sm:text-xs flex items-center justify-center gap-2 transition shadow-lg shadow-emerald-500/20 cursor-pointer active:scale-[0.98]"
                >
                  <CheckCircle2 className="w-5 h-5 sm:w-4 sm:h-4" /> {editingId ? 'Mettre à jour Ticket' : 'Enregistrer le Ticket SAV'}
                </button>
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
                <div className="flex items-center gap-1 overflow-x-auto">
                  {['Tous', 'Diagnostic', 'En attente de pièces', 'En cours', 'Prêt / Terminé'].map((st) => (
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
                          <span className="font-mono font-black text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/30">
                            {order.ticketNumber}
                          </span>
                          <span className="font-extrabold text-pos-text text-sm">{order.customerName}</span>
                          <span className="text-pos-muted text-xs font-semibold">({order.customerPhone})</span>
                        </div>
                        <p className="text-pos-text font-bold text-xs">
                          {order.deviceModel}{' '}
                          <span className="text-pos-muted font-mono font-normal text-[10px] ml-2">IMEI: {order.imei}</span>
                        </p>
                        <p className="text-pos-muted mt-1 text-xs">
                          Panne: <span className="text-pos-text font-medium">{order.problemDescription}</span>
                        </p>
                      </div>

                      <div className="text-right">
                        <span className="font-black text-emerald-400 text-base block">{formatDZD(order.totalCost)}</span>
                        {order.depositAmount ? (
                          <span className="text-[10px] text-cyan-400 font-semibold block">Acompte: {formatDZD(order.depositAmount)}</span>
                        ) : null}
                        <span className="text-[10px] text-pos-muted mt-0.5 block">{formatDateTime(order.createdAt)}</span>
                      </div>
                    </div>

                    <div className="flex items-center justify-between pt-3 border-t border-pos-border">
                      <div className="flex items-center gap-2">
                        <span className="text-pos-muted text-[10px] uppercase font-bold">Statut Actuel :</span>
                        <select
                          value={order.status}
                          onChange={(e) => handleStatusChange(order.id, e.target.value as RepairOrder['status'])}
                          className={`text-xs font-bold px-3 py-1 rounded-lg border focus:outline-none cursor-pointer ${
                            order.status === 'Prêt / Terminé'
                              ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/50'
                              : order.status === 'En cours'
                              ? 'bg-blue-500/20 text-blue-300 border-blue-500/50'
                              : order.status === 'En attente de pièces'
                              ? 'bg-amber-500/20 text-amber-300 border-amber-500/50'
                              : 'bg-pos-bg text-pos-text border-pos-border'
                          }`}
                        >
                          <option value="Diagnostic">Diagnostic</option>
                          <option value="En attente de pièces">En attente de pièces</option>
                          <option value="En cours">En cours</option>
                          <option value="Prêt / Terminé">Prêt / Terminé</option>
                        </select>
                      </div>

                      <div className="flex items-center gap-2">
                        {order.status === 'Prêt / Terminé' && (
                          <button
                            onClick={() => handleSendWhatsAppNotification(order)}
                            className="px-3.5 py-1.5 rounded-xl bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 border border-emerald-500/50 flex items-center gap-1.5 transition text-xs font-black cursor-pointer shadow-sm shadow-emerald-500/10"
                            title="Envoyer un message WhatsApp pré-rempli au client"
                          >
                            <MessageSquare className="w-3.5 h-3.5 text-emerald-400" /> WhatsApp
                          </button>
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
        </div>

        {/* Dedicated SAV Repair Ticket Print Template */}
        {printingOrder && (
          <div className="print-repair-target hidden print:block bg-white text-black p-2 font-sans text-xs">
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

            {/* Terms and Signatures */}
            <div className="doc-notebox">
              <p className="doc-terms">• Le client s'engage à récupérer son appareil dans un délai maximum de 30 jours après notification.</p>
              <p className="doc-terms">• MOBI ACCESSORIES décline toute responsabilité quant aux données non sauvegardées préalablement.</p>
            </div>

            <div className="doc-sign">
              <div>
                <p className="doc-signlabel">Signature client</p>
                <div className="doc-signline" />
              </div>
              <div>
                <p className="doc-signlabel">Cachet atelier</p>
                <div className="doc-signline" />
              </div>
            </div>

            <div className="doc-footer">
              <span>{receiptSettings.storeName || 'MOBI ACCESSORIES'} • Tél: {receiptSettings.phone}</span>
              <span>Ticket N° {printingOrder.ticketNumber}</span>
              <span>Document généré par Mobi-POS</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

