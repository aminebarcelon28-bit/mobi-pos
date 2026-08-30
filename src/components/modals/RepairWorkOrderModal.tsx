import React, { useState } from 'react';
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
import { formatDZD } from '../../types/pos';
import type { ConditionChecklist, RepairOrder } from '../../types/pos';
import { printCoordinator } from '../../utils/printCoordinator';
import { buildWhatsAppUrl } from '../../utils/phoneUtils';

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
  } = usePosStore();

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
  const totalOrders = repairOrders.length;
  const diagnosticCount = repairOrders.filter(r => r.status === 'Diagnostic').length;
  const pendingPartsCount = repairOrders.filter(r => r.status === 'En attente de pièces').length;
  const inProgressCount = repairOrders.filter(r => r.status === 'En cours').length;
  const completedCount = repairOrders.filter(r => r.status === 'Prêt / Terminé').length;
  const totalRevenue = repairOrders.reduce((acc, r) => acc + (r.totalCost || 0), 0);

  // Filtered Repair Orders for History Tab
  const filteredOrders = repairOrders.filter((order) => {
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
    const remaining = Math.max(0, order.totalCost - (order.depositAmount || 0));
    const msg = `Bonjour ${order.customerName},\n\nVotre appareil *${order.deviceModel}* (Ticket N° *${order.ticketNumber}*) est réparé et prêt à être récupéré chez *MOBI ACCESSORIES* !\n\n💰 Montant restant à régler : *${remaining.toLocaleString('fr-DZ')} DA*\n📍 Boulevard Mohamed V, Alger Centre\n\nMerci de votre confiance !`;
    const url = buildWhatsAppUrl(order.customerPhone, msg);
    window.open(url, '_blank');
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
      alert('Veuillez renseigner le nom du client et le modèle d\'appareil avant d\'enregistrer.');
      return;
    }

    const validLabor = Math.max(0, isNaN(laborCost) ? 0 : laborCost);
    const validParts = Math.max(0, isNaN(partsCost) ? 0 : partsCost);
    const validTotal = validLabor + validParts;
    const validDeposit = Math.max(0, Math.min(validTotal, isNaN(depositAmount) ? 0 : depositAmount));

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

  const handlePrintTicket = (order: RepairOrder) => {
    setPrintingOrder(order);
    printCoordinator.printRepairWorkOrder(50);
  };

  const totalCost = laborCost + partsCost;
  const remainingBalance = Math.max(0, totalCost - depositAmount);

  if (activeModal !== 'repair_work_order') return null;

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4 select-none">
      <div className="bg-pos-panel border border-pos-border rounded-2xl w-full max-w-5xl overflow-hidden shadow-2xl animate-in fade-in zoom-in-95 h-[92vh] flex flex-col">
        
        {/* Header */}
        <div className="p-4 border-b border-pos-border flex items-center justify-between bg-pos-card shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center text-slate-950 font-bold shadow-lg shadow-emerald-500/20">
              <Wrench className="w-5 h-5 stroke-[2.5]" />
            </div>
            <div>
              <h2 className="text-base font-extrabold text-pos-text tracking-wide flex items-center gap-2">
                GESTION DES RÉPARATIONS & TICKETS SAV
                <span className="text-[10px] bg-emerald-500/10 text-emerald-400 font-bold px-2 py-0.5 rounded border border-emerald-500/30">
                  ENTERPRISE
                </span>
              </h2>
              <p className="text-[11px] text-pos-muted">Prise en charge atelier, checklist d'état matériel et suivi SAV</p>
            </div>
          </div>

          <button onClick={closeModal} className="p-1.5 hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-lg transition">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Executive KPI Summary Bar */}
        <div className="bg-pos-bg border-b border-pos-border px-4 py-2.5 grid grid-cols-6 gap-3 shrink-0 text-center select-none">
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
        <div className="flex border-b border-pos-border bg-pos-panel px-4 shrink-0">
          <button
            onClick={() => { setActiveTab('Nouveau'); if (!editingId) resetForm(); }}
            className={`px-4 py-3 text-xs font-bold border-b-2 transition-colors ${activeTab === 'Nouveau' ? 'border-emerald-500 text-emerald-400' : 'border-transparent text-pos-muted hover:text-pos-text'}`}
          >
            <div className="flex items-center gap-2">
              <Plus className="w-4 h-4" /> {editingId ? 'Modifier Fiche Ticket' : 'Créer Nouveau Ticket SAV'}
            </div>
          </button>
          <button
            onClick={() => setActiveTab('Historique')}
            className={`px-4 py-3 text-xs font-bold border-b-2 transition-colors ${activeTab === 'Historique' ? 'border-emerald-500 text-emerald-400' : 'border-transparent text-pos-muted hover:text-pos-text'}`}
          >
            <div className="flex items-center gap-2">
              <History className="w-4 h-4" /> Historique Atelier & Statuts ({repairOrders.length})
            </div>
          </button>
        </div>

        {/* Content Body */}
        <div className="flex-1 overflow-y-auto p-5 relative bg-pos-bg">
          {successMsg && (
            <div className="absolute top-3 left-1/2 -translate-x-1/2 bg-emerald-500/20 border border-emerald-500/60 text-emerald-300 px-5 py-2.5 rounded-full text-xs font-bold flex items-center gap-2 z-20 shadow-lg animate-in fade-in slide-in-from-top-4">
              <CheckCircle2 className="w-4 h-4" /> {successMsg}
            </div>
          )}

          {activeTab === 'Nouveau' && (
            <form onSubmit={handleSaveOrder} className="bg-pos-card border border-pos-border rounded-2xl p-5 space-y-4 max-w-4xl mx-auto shadow-md">
              
              {editingId && (
                <div className="flex justify-between items-center bg-emerald-500/10 border border-emerald-500/30 p-2.5 rounded-xl">
                  <span className="text-xs font-bold text-emerald-400 flex items-center gap-1.5">
                    <Edit className="w-4 h-4" /> Modification de la Fiche Réparation #{editingId}
                  </span>
                  <button type="button" onClick={resetForm} className="text-xs text-pos-muted hover:text-pos-text underline">
                    Annuler l'Édition
                  </button>
                </div>
              )}

              {/* Customer Selection & Auto-Fill Toolbar */}
              <div className="bg-pos-bg p-3.5 rounded-xl border border-pos-border space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-pos-text flex items-center gap-1.5">
                    <UserCheck className="w-4 h-4 text-emerald-400" /> Informations Client
                  </span>
                  {customers.length > 0 && (
                    <select
                      onChange={(e) => handleSelectCustomer(e.target.value)}
                      className="bg-pos-card border border-pos-border text-pos-text text-xs rounded-lg px-2.5 py-1 focus:border-emerald-400 focus:outline-none"
                    >
                      <option value="">Sélectionner un client existant...</option>
                      {customers.map(c => (
                        <option key={c.id} value={c.id}>{c.name} ({c.phone})</option>
                      ))}
                    </select>
                  )}
                </div>

                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label className="text-[11px] text-pos-muted block mb-1 font-semibold">Nom du Client</label>
                    <input
                      type="text"
                      required
                      value={customerName}
                      onChange={(e) => setCustomerName(e.target.value)}
                      placeholder="Ex: Yacine Benali"
                      className="w-full bg-pos-card border border-pos-border rounded-lg px-3 py-2 text-xs font-bold text-pos-text focus:border-emerald-400 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="text-[11px] text-pos-muted block mb-1 font-semibold">Téléphone / Contact</label>
                    <input
                      type="text"
                      required
                      value={customerPhone}
                      onChange={(e) => setCustomerPhone(e.target.value)}
                      placeholder="Ex: 0550 12 34 56"
                      className="w-full bg-pos-card border border-pos-border rounded-lg px-3 py-2 text-xs font-bold text-pos-text focus:border-emerald-400 focus:outline-none"
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
                      className="w-full bg-pos-card border border-pos-border rounded-lg px-3 py-2 text-xs font-bold text-pos-text focus:border-emerald-400 focus:outline-none"
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
                      className={`px-2 py-0.5 rounded text-[10px] font-semibold border transition shrink-0 ${
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
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[11px] text-pos-muted block mb-1 font-semibold">Numéro IMEI / N° Série</label>
                  <input
                    type="text"
                    required
                    value={imei}
                    onChange={(e) => setImei(e.target.value)}
                    placeholder="Ex: 358921004812345"
                    className="w-full bg-pos-bg border border-pos-border rounded-lg px-3 py-2 text-xs font-mono font-bold text-emerald-400 focus:border-emerald-400 focus:outline-none"
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
                    className="w-full bg-pos-bg border border-pos-border rounded-lg px-3 py-2 text-xs text-pos-text focus:border-emerald-400 focus:outline-none"
                  />
                </div>
              </div>

              <div>
                <label className="text-[11px] text-pos-muted block mb-1 font-semibold">Notes & Constatations du Technicien (Interne)</label>
                <textarea
                  rows={2}
                  value={diagnosticNotes}
                  onChange={(e) => setDiagnosticNotes(e.target.value)}
                  className="w-full bg-pos-bg border border-pos-border rounded-lg px-3 py-2 text-xs text-pos-text focus:border-emerald-400 focus:outline-none"
                  placeholder="Notes de diagnostic, micro-soudures nécessaires, tests effectués..."
                />
              </div>

              {/* Visual Interactive Checklists (Pre & Post) */}
              <div className="grid grid-cols-2 gap-4">
                {/* Pre Checklist */}
                <div className="bg-pos-bg p-3.5 rounded-xl border border-pos-border space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-extrabold text-pos-text uppercase tracking-wider block flex items-center gap-1.5">
                      <ShieldAlert className="w-3.5 h-3.5 text-amber-400" /> Checklist à la Réception
                    </span>
                    <button
                      type="button"
                      onClick={() => handleSetAllChecklistOk('pre')}
                      className="text-[10px] bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 px-2 py-0.5 rounded font-bold transition border border-emerald-500/30 cursor-pointer flex items-center gap-1"
                    >
                      <Check className="w-3 h-3" /> Tout Conforme
                    </button>
                  </div>
                  
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <button
                      type="button"
                      onClick={() => setChecklist({ ...checklist, screenOk: !checklist.screenOk })}
                      className={`p-2 rounded-lg border text-left font-bold flex items-center gap-2 transition cursor-pointer ${
                        checklist.screenOk ? 'bg-emerald-500/20 border-emerald-500/60 text-emerald-300' : 'bg-pos-card border-pos-border text-pos-muted'
                      }`}
                    >
                      <Smartphone className="w-3.5 h-3.5" /> Écran: {checklist.screenOk ? 'OK' : 'KO'}
                    </button>

                    <button
                      type="button"
                      onClick={() => setChecklist({ ...checklist, faceIdOk: !checklist.faceIdOk })}
                      className={`p-2 rounded-lg border text-left font-bold flex items-center gap-2 transition cursor-pointer ${
                        checklist.faceIdOk ? 'bg-emerald-500/20 border-emerald-500/60 text-emerald-300' : 'bg-pos-card border-pos-border text-pos-muted'
                      }`}
                    >
                      <Zap className="w-3.5 h-3.5" /> FaceID: {checklist.faceIdOk ? 'OK' : 'KO'}
                    </button>

                    <button
                      type="button"
                      onClick={() => setChecklist({ ...checklist, cameraOk: !checklist.cameraOk })}
                      className={`p-2 rounded-lg border text-left font-bold flex items-center gap-2 transition cursor-pointer ${
                        checklist.cameraOk ? 'bg-emerald-500/20 border-emerald-500/60 text-emerald-300' : 'bg-pos-card border-pos-border text-pos-muted'
                      }`}
                    >
                      <Camera className="w-3.5 h-3.5" /> Caméra: {checklist.cameraOk ? 'OK' : 'KO'}
                    </button>

                    <button
                      type="button"
                      onClick={() => setChecklist({ ...checklist, chargingOk: !checklist.chargingOk })}
                      className={`p-2 rounded-lg border text-left font-bold flex items-center gap-2 transition cursor-pointer ${
                        checklist.chargingOk ? 'bg-emerald-500/20 border-emerald-500/60 text-emerald-300' : 'bg-pos-card border-pos-border text-pos-muted'
                      }`}
                    >
                      <Zap className="w-3.5 h-3.5" /> Charge: {checklist.chargingOk ? 'OK' : 'KO'}
                    </button>

                    <button
                      type="button"
                      onClick={() => setChecklist({ ...checklist, batteryOk: !checklist.batteryOk })}
                      className={`p-2 rounded-lg border text-left font-bold flex items-center gap-2 transition cursor-pointer ${
                        checklist.batteryOk ? 'bg-emerald-500/20 border-emerald-500/60 text-emerald-300' : 'bg-pos-card border-pos-border text-pos-muted'
                      }`}
                    >
                      <Battery className="w-3.5 h-3.5" /> Batterie: {checklist.batteryOk ? 'OK' : 'KO'}
                    </button>

                    <button
                      type="button"
                      onClick={() => setChecklist({ ...checklist, audioOk: !checklist.audioOk })}
                      className={`p-2 rounded-lg border text-left font-bold flex items-center gap-2 transition cursor-pointer ${
                        checklist.audioOk ? 'bg-emerald-500/20 border-emerald-500/60 text-emerald-300' : 'bg-pos-card border-pos-border text-pos-muted'
                      }`}
                    >
                      <Volume2 className="w-3.5 h-3.5" /> Audio: {checklist.audioOk ? 'OK' : 'KO'}
                    </button>
                  </div>
                </div>

                {/* Post Checklist */}
                <div className="bg-pos-bg p-3.5 rounded-xl border border-pos-border space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-extrabold text-pos-text uppercase tracking-wider block flex items-center gap-1.5">
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" /> Contrôle Qualité (Après)
                    </span>
                    <button
                      type="button"
                      onClick={() => handleSetAllChecklistOk('post')}
                      className="text-[10px] bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 px-2 py-0.5 rounded font-bold transition border border-emerald-500/30 cursor-pointer flex items-center gap-1"
                    >
                      <Check className="w-3 h-3" /> Tout Conforme
                    </button>
                  </div>

                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <button
                      type="button"
                      onClick={() => setPostChecklist({ ...postChecklist, screenOk: !postChecklist.screenOk })}
                      className={`p-2 rounded-lg border text-left font-bold flex items-center gap-2 transition ${
                        postChecklist.screenOk ? 'bg-emerald-500/20 border-emerald-500/60 text-emerald-300' : 'bg-pos-card border-pos-border text-pos-muted'
                      }`}
                    >
                      <Smartphone className="w-3.5 h-3.5" /> Écran: {postChecklist.screenOk ? 'OK' : 'KO'}
                    </button>

                    <button
                      type="button"
                      onClick={() => setPostChecklist({ ...postChecklist, faceIdOk: !postChecklist.faceIdOk })}
                      className={`p-2 rounded-lg border text-left font-bold flex items-center gap-2 transition ${
                        postChecklist.faceIdOk ? 'bg-emerald-500/20 border-emerald-500/60 text-emerald-300' : 'bg-pos-card border-pos-border text-pos-muted'
                      }`}
                    >
                      <Zap className="w-3.5 h-3.5" /> FaceID: {postChecklist.faceIdOk ? 'OK' : 'KO'}
                    </button>

                    <button
                      type="button"
                      onClick={() => setPostChecklist({ ...postChecklist, cameraOk: !postChecklist.cameraOk })}
                      className={`p-2 rounded-lg border text-left font-bold flex items-center gap-2 transition ${
                        postChecklist.cameraOk ? 'bg-emerald-500/20 border-emerald-500/60 text-emerald-300' : 'bg-pos-card border-pos-border text-pos-muted'
                      }`}
                    >
                      <Camera className="w-3.5 h-3.5" /> Caméra: {postChecklist.cameraOk ? 'OK' : 'KO'}
                    </button>

                    <button
                      type="button"
                      onClick={() => setPostChecklist({ ...postChecklist, chargingOk: !postChecklist.chargingOk })}
                      className={`p-2 rounded-lg border text-left font-bold flex items-center gap-2 transition ${
                        postChecklist.chargingOk ? 'bg-emerald-500/20 border-emerald-500/60 text-emerald-300' : 'bg-pos-card border-pos-border text-pos-muted'
                      }`}
                    >
                      <Zap className="w-3.5 h-3.5" /> Charge: {postChecklist.chargingOk ? 'OK' : 'KO'}
                    </button>

                    <button
                      type="button"
                      onClick={() => setPostChecklist({ ...postChecklist, batteryOk: !postChecklist.batteryOk })}
                      className={`p-2 rounded-lg border text-left font-bold flex items-center gap-2 transition ${
                        postChecklist.batteryOk ? 'bg-emerald-500/20 border-emerald-500/60 text-emerald-300' : 'bg-pos-card border-pos-border text-pos-muted'
                      }`}
                    >
                      <Battery className="w-3.5 h-3.5" /> Batterie: {postChecklist.batteryOk ? 'OK' : 'KO'}
                    </button>

                    <button
                      type="button"
                      onClick={() => setPostChecklist({ ...postChecklist, audioOk: !postChecklist.audioOk })}
                      className={`p-2 rounded-lg border text-left font-bold flex items-center gap-2 transition ${
                        postChecklist.audioOk ? 'bg-emerald-500/20 border-emerald-500/60 text-emerald-300' : 'bg-pos-card border-pos-border text-pos-muted'
                      }`}
                    >
                      <Volume2 className="w-3.5 h-3.5" /> Audio: {postChecklist.audioOk ? 'OK' : 'KO'}
                    </button>
                  </div>
                </div>
              </div>

              {/* Financial Calculation & Deposit Engine */}
              <div className="bg-pos-bg p-3.5 rounded-xl border border-pos-border space-y-3">
                <div className="grid grid-cols-4 gap-3 items-center">
                  <div>
                    <label className="text-[11px] text-pos-muted block mb-1 font-semibold">Main d'Œuvre (DA)</label>
                    <input
                      type="number"
                      step="100"
                      value={laborCost}
                      onChange={(e) => setLaborCost(parseFloat(e.target.value) || 0)}
                      className="w-full bg-pos-card border border-pos-border rounded-lg px-3 py-2 text-xs font-bold text-emerald-400 focus:outline-none"
                    />
                  </div>

                  <div>
                    <label className="text-[11px] text-pos-muted block mb-1 font-semibold">Prix Pièces / Composants (DA)</label>
                    <input
                      type="number"
                      step="100"
                      value={partsCost}
                      onChange={(e) => setPartsCost(parseFloat(e.target.value) || 0)}
                      className="w-full bg-pos-card border border-pos-border rounded-lg px-3 py-2 text-xs font-bold text-amber-400 focus:outline-none"
                    />
                  </div>

                  <div>
                    <label className="text-[11px] text-pos-muted block mb-1 font-semibold">Acompte Versé (DA)</label>
                    <input
                      type="number"
                      step="100"
                      value={depositAmount}
                      onChange={(e) => setDepositAmount(parseFloat(e.target.value) || 0)}
                      className="w-full bg-pos-card border border-pos-border rounded-lg px-3 py-2 text-xs font-bold text-cyan-400 focus:outline-none"
                    />
                  </div>

                  <div className="text-right">
                    <span className="text-[10px] text-pos-muted uppercase block font-bold">Reste à Payer (Livraison)</span>
                    <span className="text-lg font-black text-emerald-400">{formatDZD(remainingBalance)}</span>
                  </div>
                </div>
              </div>

              {/* Status & Save Button */}
              <div className="flex justify-between items-center pt-2 border-t border-pos-border">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-pos-muted font-bold">Statut du Ticket:</span>
                  <select
                    value={status}
                    onChange={(e) => setStatus(e.target.value as any)}
                    className="bg-pos-bg border border-pos-border rounded-xl px-3.5 py-2 text-xs font-bold text-pos-text focus:outline-none cursor-pointer"
                  >
                    <option value="Diagnostic">Statut: Diagnostic</option>
                    <option value="En attente de pièces">Statut: En attente de pièces</option>
                    <option value="En cours">Statut: En cours</option>
                    <option value="Prêt / Terminé">Statut: Prêt / Terminé</option>
                  </select>
                </div>

                <button
                  type="submit"
                  className="px-6 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs flex items-center gap-2 transition shadow-lg shadow-emerald-500/20 cursor-pointer"
                >
                  <CheckCircle2 className="w-4 h-4" /> {editingId ? 'Mettre à jour Ticket' : 'Enregistrer le Ticket SAV'}
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
              {filteredOrders.length === 0 ? (
                <div className="text-center text-pos-muted text-xs py-12 bg-pos-card border border-pos-border rounded-2xl">
                  <Wrench className="w-8 h-8 opacity-40 mx-auto mb-2" />
                  <p className="font-semibold">Aucun ticket de réparation ne correspond à vos critères.</p>
                </div>
              ) : (
                filteredOrders.map((order) => (
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
                        <span className="text-[10px] text-pos-muted mt-0.5 block">{order.createdAt}</span>
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
          <div className="print-repair-target hidden print:block bg-white text-black p-6 font-sans text-xs">
            {/* Header */}
            <div className="flex justify-between items-start border-b-2 border-black pb-3 mb-4">
              <div>
                <h1 className="text-lg font-black uppercase">{receiptSettings.storeName || 'MOBI ACCESSORIES'}</h1>
                <p className="text-[10px] text-gray-600">Atelier de Réparation Express & SAV</p>
                <p className="text-[10px] text-gray-600">Tél: {receiptSettings.phone}</p>
              </div>
              <div className="text-right bg-gray-100 p-2 rounded border border-gray-300">
                <p className="text-[10px] font-black uppercase">FICHE D'INTERVENTION SAV</p>
                <p className="text-sm font-bold text-gray-900">N° {printingOrder.ticketNumber}</p>
                <p className="text-[9px] text-gray-600">Date: {printingOrder.createdAt}</p>
              </div>
            </div>

            {/* Customer & Device Information */}
            <div className="grid grid-cols-2 gap-3 bg-gray-50 border border-gray-200 p-3 rounded mb-4">
              <div>
                <p className="text-[9px] font-bold text-gray-500 uppercase">Client :</p>
                <p className="font-bold text-sm text-black">{printingOrder.customerName}</p>
                <p className="text-xs text-gray-700">Tél: {printingOrder.customerPhone || 'Non renseigné'}</p>
              </div>
              <div>
                <p className="text-[9px] font-bold text-gray-500 uppercase">Appareil Déposé :</p>
                <p className="font-bold text-sm text-black">{printingOrder.deviceModel}</p>
                <p className="text-[10px] text-gray-600 font-mono">IMEI / Série: {printingOrder.imei || 'N/A'}</p>
              </div>
            </div>

            {/* Diagnostic & Problem Description */}
            <div className="border border-gray-300 p-3 rounded mb-4 space-y-2">
              <div>
                <p className="text-[9px] font-bold text-gray-500 uppercase">Symptôme / Problème signalé :</p>
                <p className="font-semibold text-xs text-gray-900">{printingOrder.problemDescription}</p>
              </div>
              {printingOrder.diagnosticNotes && (
                <div>
                  <p className="text-[9px] font-bold text-gray-500 uppercase">Diagnostic Technique Atelier :</p>
                  <p className="text-xs text-gray-700 italic">{printingOrder.diagnosticNotes}</p>
                </div>
              )}
            </div>

            {/* Financial Summary */}
            <div className="bg-gray-100 border border-gray-300 p-3 rounded mb-6 flex justify-between items-center font-mono">
              <div>
                <span className="text-[10px] text-gray-600 block">Total Devis Réparation : {formatDZD(printingOrder.totalCost)}</span>
                {printingOrder.depositAmount ? (
                  <span className="text-[10px] text-blue-700 block">Acompte Versé : -{formatDZD(printingOrder.depositAmount)}</span>
                ) : null}
              </div>
              <div className="text-right">
                <span className="text-[10px] uppercase font-bold text-gray-500 block">Reste à Régler :</span>
                <span className="text-base font-black text-black">
                  {formatDZD(Math.max(0, printingOrder.totalCost - (printingOrder.depositAmount || 0)))}
                </span>
              </div>
            </div>

            {/* Terms and Signatures */}
            <div className="pt-2 border-t border-dashed border-gray-400 text-[8px] text-gray-500 space-y-1">
              <p>• Le client s'engage à récupérer son appareil dans un délai maximum de 30 jours après notification.</p>
              <p>• MOBI ACCESSORIES décline toute responsabilité quant aux données non sauvegardées préalablement.</p>
            </div>

            <div className="grid grid-cols-2 gap-6 pt-6 mt-4 border-t border-gray-300 text-center">
              <div>
                <p className="text-[10px] font-bold text-gray-700">Signature Client :</p>
                <div className="h-12 border-b border-gray-300 mt-1" />
              </div>
              <div>
                <p className="text-[10px] font-bold text-gray-700">Cachet Atelier :</p>
                <div className="h-12 border-b border-gray-300 mt-1" />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

