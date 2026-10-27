import React, { useState } from 'react';
import {
  Shield, ShieldCheck, ShieldAlert, Lock, Users, UserPlus,
  Edit3, Trash2, Eye, EyeOff
} from 'lucide-react';
import { usePosStore } from '../../../store/usePosStore';
import { useToast } from '../../ui/Toast';
import type { CashierUser } from '../../../types/pos';
import { verifyPin, hashDeviceLocalPin, isCommonPin } from '../../../utils/security';
import { verifyManagerGate, verifyUserGate } from '../../../utils/pinGate';
import { friendlyPinSetError } from '../../../api/pin';
import { canSeeJournalLauncher } from '../../../utils/auditGate';
import { soundEngine } from '../../../utils/audioFeedback';

interface SecuritySettingsTabProps {
  managerKdfLabel: string;
}

export const SecuritySettingsTab: React.FC<SecuritySettingsTabProps> = ({ managerKdfLabel }) => {
  const {
    openModal,
    cashierUsers,
    setCashierUsers,
    activeCashier,
    securityAuditLog,
  } = usePosStore();
  const { showToast } = useToast();

  // Manager Security PIN State
  const [currentPinInput, setCurrentPinInput] = useState('');
  const [newPinInput, setNewPinInput] = useState('');
  const [confirmPinInput, setConfirmPinInput] = useState('');
  const [isUpdatingPin, setIsUpdatingPin] = useState(false);
  const [showManagerPin, setShowManagerPin] = useState(false);

  // Cashier & Staff Management State
  const [isCashierModalOpen, setIsCashierModalOpen] = useState(false);
  const [editingCashierId, setEditingCashierId] = useState<string | null>(null);
  const [cashierNameInput, setCashierNameInput] = useState('');
  const [previousCashierPinInput, setPreviousCashierPinInput] = useState('');
  const [cashierPinInput, setCashierPinInput] = useState('');
  const [confirmCashierPinInput, setConfirmCashierPinInput] = useState('');
  const [cashierRoleInput, setCashierRoleInput] = useState<'admin' | 'cashier'>('cashier');
  const [cashierColorInput, setCashierColorInput] = useState('#10b981');
  const [showCashierPin, setShowCashierPin] = useState(false);
  const [isSavingCashier, setIsSavingCashier] = useState(false);

  const handleOpenAddCashier = () => {
    setEditingCashierId(null);
    setCashierNameInput('');
    setPreviousCashierPinInput('');
    setCashierPinInput('');
    setConfirmCashierPinInput('');
    setCashierRoleInput('cashier');
    setCashierColorInput('#10b981');
    setShowCashierPin(false);
    setIsCashierModalOpen(true);
  };

  const handleOpenEditCashier = (cashier: CashierUser) => {
    setEditingCashierId(cashier.id);
    setCashierNameInput(cashier.name);
    setPreviousCashierPinInput('');
    setCashierPinInput('');
    setConfirmCashierPinInput('');
    setCashierRoleInput(cashier.role);
    setCashierColorInput(cashier.avatarColor || '#3b82f6');
    setShowCashierPin(false);
    setIsCashierModalOpen(true);
  };

  const handleUpdateManagerPin = async () => {
    if (!currentPinInput) {
      showToast('Veuillez saisir votre code PIN actuel.', 'error');
      return;
    }
    const gate = await verifyManagerGate(currentPinInput);
    if (!gate.ok) {
      showToast(
        gate.locked
          ? `Verrouillé — réessayez dans ${Math.max(1, Math.ceil(gate.remainingMs / 1000))}s.`
          : 'Le code PIN actuel est incorrect.',
        'error'
      );
      return;
    }
    if (!/^[0-9]{6,8}$/.test(newPinInput)) {
      showToast('Le nouveau code PIN gérant doit comporter 6 à 8 chiffres.', 'error');
      return;
    }
    if (newPinInput !== confirmPinInput) {
      showToast('Les deux nouveaux codes PIN saisis ne correspondent pas.', 'error');
      return;
    }
    if (isCommonPin(newPinInput)) {
      showToast('Code trop simple (suite, répétition ou code banal) — choisissez un code moins prévisible.', 'error');
      return;
    }
    setIsUpdatingPin(true);
    try {
      await usePosStore.getState().rotatePinCredential('manager', newPinInput, true, { supervisorPin: currentPinInput });
      setCurrentPinInput('');
      setNewPinInput('');
      setConfirmPinInput('');
      soundEngine.playSuccess?.();
      showToast('Nouveau Code PIN Manager enregistré avec succès.', 'success');
    } catch (e: unknown) {
      showToast(friendlyPinSetError(e), 'error');
    } finally {
      setIsUpdatingPin(false);
    }
  };

  const handleSaveCashier = async () => {
    const cleanName = cashierNameInput.trim();
    if (!cleanName) {
      showToast("Veuillez saisir un nom pour l'employé.", 'error');
      return;
    }

    let targetPin = '';

    if (editingCashierId) {
      const existing = cashierUsers.find((u) => u.id === editingCashierId);
      if (!existing) return;

      const cleanPrev = previousCashierPinInput.trim();
      const cleanNew = cashierPinInput.trim();
      const cleanConfirm = confirmCashierPinInput.trim();

      const isAttemptingPinChange = cleanPrev.length > 0 || cleanNew.length > 0 || cleanConfirm.length > 0;

      if (isAttemptingPinChange) {
        const isTargetManager = cashierRoleInput === 'admin' || existing.role === 'admin';
        const minLen = isTargetManager ? 6 : 4;
        const maxLen = isTargetManager ? 8 : 4;

        if (!cleanPrev) {
          showToast(
            isTargetManager
              ? "Sécurité : veuillez saisir l'ancien code PIN gérant (ou le PIN Manager actuel)."
              : "Sécurité : veuillez saisir l'ancien code PIN du caissier (ou le PIN Manager).",
            'error'
          );
          return;
        }

        const ownGate = await verifyUserGate(existing.id, cleanPrev);
        const managerGate = ownGate.ok ? null : await verifyManagerGate(cleanPrev);
        const isAuthorized = ownGate.ok || managerGate?.ok === true;
        if (managerGate?.locked || ownGate.locked) {
          showToast(
            `Verrouillé — réessayez dans ${Math.max(
              1,
              Math.ceil((managerGate?.remainingMs ?? ownGate.remainingMs) / 1000)
            )}s.`,
            'error'
          );
          return;
        }

        if (!isAuthorized) {
          showToast("L'ancien code PIN est incorrect (ou PIN Manager invalide).", 'error');
          return;
        }

        if (!/^[0-9]+$/.test(cleanNew) || cleanNew.length < minLen || cleanNew.length > maxLen) {
          showToast(
            isTargetManager
              ? "Le nouveau code PIN gérant doit comporter 6 à 8 chiffres."
              : "Le nouveau code PIN caissier doit comporter exactement 4 chiffres.",
            'error'
          );
          return;
        }

        if (cleanNew !== cleanConfirm) {
          showToast("Les deux nouveaux codes PIN saisis ne correspondent pas.", 'error');
          return;
        }

        const otherUsers = cashierUsers.filter((u) => u.id !== editingCashierId);
        if (otherUsers.some((u) => verifyPin(cleanNew, u.pin))) {
          showToast('Chaque personne doit avoir un code PIN différent (code déjà utilisé).', 'error');
          return;
        }
        if (isCommonPin(cleanNew)) {
          showToast('Code trop simple (suite, répétition ou code banal) — choisissez un code moins prévisible.', 'error');
          return;
        }

        const primaryAdminId = cashierUsers.find((u) => u.role === 'admin')?.id;
        if (existing.id === primaryAdminId) {
          await usePosStore.getState().rotatePinCredential('manager', cleanNew, true, { supervisorPin: cleanPrev });
          targetPin = usePosStore.getState().managerPin;
          if (!targetPin) {
            showToast("Échec de l'enregistrement du nouveau PIN. Réessayez.", 'error');
            return;
          }
          showToast('Code PIN du gérant mis à jour (PIN Manager synchronisé).', 'success');
        } else {
          const managerHash = usePosStore.getState().managerPin;
          if (managerHash && verifyPin(cleanNew, managerHash)) {
            showToast('Chaque personne doit avoir un code PIN différent (code gérant réservé).', 'error');
            return;
          }
          await usePosStore.getState().rotatePinCredential(existing.id, cleanNew, false);
          targetPin = usePosStore.getState().cashierUsers.find((u) => u.id === existing.id)?.pin || '';
          if (!targetPin) {
            showToast("Échec de l'enregistrement du nouveau PIN. Réessayez.", 'error');
            return;
          }
        }
      } else {
        targetPin = existing.pin;
      }
    } else {
      const cleanNew = cashierPinInput.trim();
      const cleanConfirm = confirmCashierPinInput.trim();
      const isTargetManager = cashierRoleInput === 'admin';
      const minLen = isTargetManager ? 6 : 4;
      const maxLen = isTargetManager ? 8 : 4;

      if (!/^[0-9]+$/.test(cleanNew) || cleanNew.length < minLen || cleanNew.length > maxLen) {
        showToast(
          isTargetManager
            ? "Le code PIN gérant doit comporter 6 à 8 chiffres."
            : "Le code PIN caissier doit comporter exactement 4 chiffres (ex: 1234).",
          'error'
        );
        return;
      }

      if (cleanNew !== cleanConfirm) {
        showToast("Les deux codes PIN saisis ne correspondent pas.", 'error');
        return;
      }

      const managerHashForNew = usePosStore.getState().managerPin;
      if (
        cashierUsers.some((u) => verifyPin(cleanNew, u.pin)) ||
        (managerHashForNew && verifyPin(cleanNew, managerHashForNew))
      ) {
        showToast('Chaque personne doit avoir un code PIN différent (code déjà utilisé).', 'error');
        return;
      }
      if (isCommonPin(cleanNew)) {
        showToast('Code trop simple (suite, répétition ou code banal) — choisissez un code moins prévisible.', 'error');
        return;
      }

      const newId = `usr-${Date.now().toString(36)}`;
      const { isTauriEnv } = await import('../../../db/adapters/base');
      if (isTauriEnv()) {
        const placeholder = `PENDING-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
        const skeleton: CashierUser = {
          id: newId,
          name: cleanName,
          pin: placeholder,
          role: cashierRoleInput,
          avatarColor: cashierColorInput,
        };
        await setCashierUsers([...cashierUsers, skeleton]);
        try {
          await usePosStore.getState().rotatePinCredential(newId, cleanNew, cashierRoleInput === 'admin');
        } catch (e: unknown) {
          await setCashierUsers(cashierUsers).catch(() => {});
          showToast(`Création refusée (${friendlyPinSetError(e)}).`, 'error');
          setIsSavingCashier(false);
          return;
        }
        targetPin = usePosStore.getState().cashierUsers.find((u) => u.id === newId)?.pin || '';
        if (!targetPin) {
          await setCashierUsers(cashierUsers).catch(() => {});
          showToast("Échec de l'enregistrement du nouveau PIN. Réessayez.", 'error');
          setIsSavingCashier(false);
          return;
        }
        await setCashierUsers(
          usePosStore.getState().cashierUsers.map((u) =>
            u.id === newId ? { ...u, name: cleanName, role: cashierRoleInput, avatarColor: cashierColorInput } : u
          )
        );
        setIsCashierModalOpen(false);
        soundEngine.playSuccess?.();
        showToast(`Caissier "${cleanName}" ajouté à l'équipe !`, 'success');
        return;
      } else {
        targetPin = hashDeviceLocalPin(cleanNew);
      }
    }

    setIsSavingCashier(true);
    try {
      let updated: CashierUser[];
      if (editingCashierId) {
        const otherAdmins = cashierUsers.filter((u) => u.id !== editingCashierId && u.role === 'admin');
        if (otherAdmins.length === 0 && cashierRoleInput !== 'admin') {
          showToast('Impossible : il doit rester au moins un Administrateur dans le système.', 'error');
          setIsSavingCashier(false);
          return;
        }

        updated = cashierUsers.map((u) =>
          u.id === editingCashierId
            ? {
                ...u,
                name: cleanName,
                pin: targetPin,
                role: cashierRoleInput,
                avatarColor: cashierColorInput,
              }
            : u
        );
      } else {
        const newId = `usr-${Date.now().toString(36)}`;
        const newCashier: CashierUser = {
          id: newId,
          name: cleanName,
          pin: targetPin,
          role: cashierRoleInput,
          avatarColor: cashierColorInput,
        };
        updated = [...cashierUsers, newCashier];
      }

      const prevPrimaryId = cashierUsers.find((u) => u.role === 'admin')?.id;
      const nextPrimary = updated.find((u) => u.role === 'admin');
      const masterHash = usePosStore.getState().managerPin;
      const demotedPrimary =
        editingCashierId && prevPrimaryId === editingCashierId && nextPrimary && nextPrimary.id !== editingCashierId;
      const finalUpdated =
        demotedPrimary && masterHash && nextPrimary.pin !== masterHash
          ? updated.map((u) => (u.id === nextPrimary.id ? { ...u, pin: masterHash } : u))
          : updated;

      await setCashierUsers(finalUpdated);
      setIsCashierModalOpen(false);
      soundEngine.playSuccess?.();
      showToast(
        editingCashierId
          ? `Caissier "${cleanName}" mis à jour avec succès.`
          : `Caissier "${cleanName}" ajouté à l'équipe !`,
        'success'
      );
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const friendly = friendlyPinSetError(e);
      showToast(friendly !== "Échec de l'enregistrement du nouveau PIN. Réessayez." ? friendly : `Erreur : ${msg}`, 'error');
    } finally {
      setIsSavingCashier(false);
    }
  };

  const handleDeleteCashier = async (cashierId: string) => {
    const target = cashierUsers.find((u) => u.id === cashierId);
    if (!target) return;

    if (target.role === 'admin') {
      const adminCount = cashierUsers.filter((u) => u.role === 'admin').length;
      if (adminCount <= 1) {
        showToast('Action impossible : vous ne pouvez pas supprimer le seul Administrateur du magasin.', 'error');
        return;
      }
    }

    if (!window.confirm(`Êtes-vous sûr de vouloir supprimer le compte caissier "${target.name}" ?`)) {
      return;
    }

    try {
      const nextUsers = cashierUsers.filter((u) => u.id !== cashierId);
      const wasPrimary = cashierUsers.find((u) => u.role === 'admin')?.id === cashierId;
      const masterHash = usePosStore.getState().managerPin;
      const nextPrimary = nextUsers.find((u) => u.role === 'admin');
      const finalUsers =
        wasPrimary && masterHash && nextPrimary && nextPrimary.pin !== masterHash
          ? nextUsers.map((u) => (u.id === nextPrimary.id ? { ...u, pin: masterHash } : u))
          : nextUsers;
      await setCashierUsers(finalUsers);
      soundEngine.playSuccess?.();
      showToast(`Compte caissier "${target.name}" supprimé.`, 'info');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      showToast(`Erreur suppression : ${msg}`, 'error');
    }
  };

  return (
    <div className="space-y-6 max-w-4xl mx-auto py-1">
      {/* Executive Security Header Card */}
      <div className="bg-gradient-to-r from-emerald-950/40 via-pos-card to-purple-950/40 border border-emerald-500/30 rounded-2xl p-4 shadow-xl">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-xl bg-emerald-500/20 text-emerald-400 flex items-center justify-center border border-emerald-500/40 shadow-lg shadow-emerald-500/10 shrink-0">
              <ShieldCheck className="w-6 h-6 stroke-[2.5]" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-extrabold text-pos-text tracking-wide">
                  Contrôle d'Accès, Personnel & Sécurité (RBAC)
                </h3>
                <span className="bg-emerald-500/20 text-emerald-300 text-[10px] font-bold px-2 py-0.5 rounded-full border border-emerald-500/30 flex items-center gap-1 shrink-0">
                  <Lock className="w-3 h-3" /> Protection Anti-Coulage
                </span>
              </div>
              <p className="text-[11px] text-pos-muted">
                Configurez le Code PIN Superviseur, gérez l'équipe de caisse et inspectez le journal des dérogations.
              </p>
            </div>
          </div>

          {canSeeJournalLauncher(activeCashier?.role) && (
            <button
              type="button"
              onClick={() => openModal('security_audit')}
              className="px-3.5 py-2 rounded-xl bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/40 text-amber-300 text-xs font-bold flex items-center justify-center gap-2 transition cursor-pointer shrink-0 shadow-sm"
            >
              <ShieldAlert className="w-4 h-4 text-amber-400" />
              <span>Journal d'Audit ({securityAuditLog.length})</span>
            </button>
          )}
        </div>
      </div>

      {/* ── CARD 1: Code PIN Manager Maître (Superviseur) ── */}
      <div className="bg-pos-card border border-pos-border rounded-2xl p-5 space-y-4 shadow-md">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between border-b border-pos-border/60 pb-3 gap-2">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-purple-500/20 text-purple-400 flex items-center justify-center border border-purple-500/30 shrink-0">
              <Shield className="w-4 h-4" />
            </div>
            <div>
              <h4 className="text-xs font-bold text-pos-text uppercase tracking-wider">
                Code PIN Manager Maître (Superviseur)
              </h4>
              <span className="text-[10px] text-pos-muted">
                Clé universelle de dérogation pour remises &gt; 20%, ventes sous coût, tiroir No Sale et annulations
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-[10px] text-pos-muted bg-pos-bg px-2.5 py-1 rounded-lg border border-pos-border">
              Statut : <strong className="text-emerald-400 font-mono">{managerKdfLabel}</strong>
            </span>
            <button
              type="button"
              onClick={() => setShowManagerPin(!showManagerPin)}
              className="p-1.5 rounded-lg bg-pos-bg hover:bg-pos-hover border border-pos-border text-pos-muted hover:text-pos-text text-xs transition cursor-pointer"
              title={showManagerPin ? 'Masquer chiffres' : 'Afficher chiffres'}
            >
              {showManagerPin ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label className="text-[10px] text-pos-muted font-bold block mb-1">PIN Actuel (Obligatoire)</label>
            <input
              type={showManagerPin ? 'text' : 'password'}
              inputMode="numeric"
              pattern="[0-9]*"
              autoComplete="current-password"
              enterKeyHint="next"
              aria-label="PIN Actuel (Obligatoire)"
              maxLength={8}
              value={currentPinInput}
              onChange={(e) => setCurrentPinInput(e.target.value.replace(/[^0-9]/g, ''))}
              placeholder="PIN Actuel"
              className="w-full min-h-[48px] bg-pos-bg border border-pos-border rounded-xl px-3 py-2 text-base sm:text-xs font-mono font-bold text-pos-text focus:outline-none focus:border-purple-400"
            />
          </div>
          <div>
            <label className="text-[10px] text-pos-muted font-bold block mb-1">
              Nouveau PIN Gérant (6 à 8 chiffres)
            </label>
            <input
              type={showManagerPin ? 'text' : 'password'}
              inputMode="numeric"
              pattern="[0-9]*"
              autoComplete="new-password"
              enterKeyHint="next"
              aria-label="Nouveau PIN Gérant (6 à 8 chiffres)"
              maxLength={8}
              value={newPinInput}
              onChange={(e) => setNewPinInput(e.target.value.replace(/[^0-9]/g, '').slice(0, 8))}
              placeholder="6 à 8 chiffres"
              className="w-full min-h-[48px] bg-pos-bg border border-pos-border rounded-xl px-3 py-2 text-base sm:text-xs font-mono font-bold text-pos-text focus:outline-none focus:border-purple-400"
            />
          </div>
          <div>
            <label className="text-[10px] text-pos-muted font-bold block mb-1">
              Confirmer le Nouveau PIN (6 à 8 chiffres)
            </label>
            <input
              type={showManagerPin ? 'text' : 'password'}
              inputMode="numeric"
              pattern="[0-9]*"
              autoComplete="new-password"
              enterKeyHint="done"
              aria-label="Confirmer le Nouveau PIN (6 à 8 chiffres)"
              maxLength={8}
              value={confirmPinInput}
              onChange={(e) => setConfirmPinInput(e.target.value.replace(/[^0-9]/g, '').slice(0, 8))}
              placeholder="6 à 8 chiffres"
              className="w-full min-h-[48px] bg-pos-bg border border-pos-border rounded-xl px-3 py-2 text-base sm:text-xs font-mono font-bold text-pos-text focus:outline-none focus:border-purple-400"
            />
          </div>
        </div>

        <div className="flex flex-col sm:flex-row sm:items-center justify-between pt-1 gap-2 border-t border-pos-border/40">
          <span className="text-[10px] text-pos-muted italic">
            Aucun code usine par défaut — le PIN Manager est créé à l'installation. Conservez-le strictement confidentiel.
          </span>
          <button
            type="button"
            onClick={handleUpdateManagerPin}
            disabled={isUpdatingPin || !currentPinInput || !newPinInput || !confirmPinInput}
            className="py-2 px-5 rounded-xl bg-purple-600 hover:bg-purple-500 text-white font-bold text-xs transition disabled:opacity-40 cursor-pointer shadow-md shadow-purple-600/20 active:scale-95"
          >
            {isUpdatingPin ? 'Enregistrement...' : 'Enregistrer le PIN Manager'}
          </button>
        </div>
      </div>

      {/* ── CARD 2: Gestion de l'Équipe & Caissiers (Personnel) ── */}
      <div className="bg-pos-card border border-pos-border rounded-2xl p-5 space-y-4 shadow-md">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between border-b border-pos-border/60 pb-3 gap-3">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-emerald-500/20 text-emerald-400 flex items-center justify-center border border-emerald-500/30 shrink-0">
              <Users className="w-4 h-4" />
            </div>
            <div>
              <h4 className="text-xs font-bold text-pos-text uppercase tracking-wider">
                Équipe de Caisse & Codes PIN Vendeurs
              </h4>
              <span className="text-[10px] text-pos-muted">
                Chaque employé possède son profil, couleur et code PIN sécurisé (4 chiffres caissiers, 6 à 8 gérants)
              </span>
            </div>
          </div>

          <button
            type="button"
            onClick={handleOpenAddCashier}
            className="py-2 px-3.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs flex items-center justify-center gap-1.5 transition cursor-pointer shadow-md shadow-emerald-600/20 active:scale-95 shrink-0"
          >
            <UserPlus className="w-4 h-4" />
            <span>Ajouter un Caissier</span>
          </button>
        </div>

        {/* Inline Cashier Add / Edit Modal Drawer */}
        {isCashierModalOpen && (
          <div className="bg-pos-panel border border-emerald-500/40 rounded-2xl p-4 space-y-4 shadow-xl animate-in fade-in zoom-in-95">
            <div className="flex items-center justify-between border-b border-pos-border pb-2">
              <div className="flex items-center gap-2">
                {editingCashierId ? <Edit3 className="w-4 h-4 text-amber-400" /> : <UserPlus className="w-4 h-4 text-emerald-400" />}
                <h5 className="text-xs font-bold text-pos-text">
                  {editingCashierId ? 'Modifier les informations du collaborateur' : 'Ajouter un nouveau membre d\'équipe'}
                </h5>
              </div>
              <button
                type="button"
                onClick={() => setIsCashierModalOpen(false)}
                className="p-1 rounded-lg hover:bg-pos-hover text-pos-muted hover:text-pos-text cursor-pointer"
              >
                ✕
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="text-[10px] text-pos-muted font-bold block mb-1">Nom du Caissier / Prénom</label>
                <input
                  type="text"
                  value={cashierNameInput}
                  onChange={(e) => setCashierNameInput(e.target.value)}
                  placeholder="ex: Leila, Salma, Fatima..."
                  className="w-full bg-pos-bg border border-pos-border rounded-xl px-3 py-2 text-xs font-bold text-pos-text focus:outline-none focus:border-emerald-400"
                />
              </div>

              <div>
                <label className="text-[10px] text-pos-muted font-bold block mb-1">Rôle & Permissions Système</label>
                <select
                  value={cashierRoleInput}
                  onChange={(e) => setCashierRoleInput(e.target.value as 'admin' | 'cashier')}
                  className="w-full bg-pos-bg border border-pos-border rounded-xl px-3 py-2 text-xs font-bold text-pos-text focus:outline-none focus:border-emerald-400 cursor-pointer"
                >
                  <option value="cashier">Caissier Standard (Vente, Ticket, Reprise)</option>
                  <option value="admin">Administrateur / Gérant (Accès Réglages, Dérogations)</option>
                </select>
              </div>

              {editingCashierId && (
                <div className="sm:col-span-2">
                  <label className="text-[10px] text-pos-muted font-bold block mb-1">
                    Ancien Code PIN du Caissier (ou PIN Manager Actuel)
                  </label>
                  <input
                    type={showCashierPin ? 'text' : 'password'}
                    inputMode="numeric"
                    maxLength={8}
                    value={previousCashierPinInput}
                    onChange={(e) => setPreviousCashierPinInput(e.target.value.replace(/[^0-9]/g, ''))}
                    placeholder="Saisissez l'ancien code pour autoriser la modification"
                    className="w-full bg-pos-bg border border-pos-border rounded-xl px-3 py-2 text-xs font-mono font-bold text-pos-text focus:outline-none focus:border-amber-400"
                  />
                </div>
              )}

              <div>
                <label className="text-[10px] text-pos-muted font-bold block mb-1">
                  {editingCashierId ? 'Nouveau Code PIN (Laisser vide pour ne pas changer)' : 'Code PIN (4 chiffres)'}
                </label>
                <input
                  type={showCashierPin ? 'text' : 'password'}
                  inputMode="numeric"
                  maxLength={cashierRoleInput === 'admin' ? 8 : 4}
                  value={cashierPinInput}
                  onChange={(e) => setCashierPinInput(e.target.value.replace(/[^0-9]/g, ''))}
                  placeholder={cashierRoleInput === 'admin' ? '6 à 8 chiffres' : '4 chiffres (ex: 1234)'}
                  className="w-full bg-pos-bg border border-pos-border rounded-xl px-3 py-2 text-xs font-mono font-bold text-pos-text focus:outline-none focus:border-emerald-400"
                />
              </div>

              <div>
                <label className="text-[10px] text-pos-muted font-bold block mb-1">Confirmer le Code PIN</label>
                <input
                  type={showCashierPin ? 'text' : 'password'}
                  inputMode="numeric"
                  maxLength={cashierRoleInput === 'admin' ? 8 : 4}
                  value={confirmCashierPinInput}
                  onChange={(e) => setConfirmCashierPinInput(e.target.value.replace(/[^0-9]/g, ''))}
                  placeholder="Répétez le code PIN"
                  className="w-full bg-pos-bg border border-pos-border rounded-xl px-3 py-2 text-xs font-mono font-bold text-pos-text focus:outline-none focus:border-emerald-400"
                />
              </div>

              <div>
                <label className="text-[10px] text-pos-muted font-bold block mb-1">Couleur Pastille Profil</label>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={cashierColorInput}
                    onChange={(e) => setCashierColorInput(e.target.value)}
                    className="w-9 h-9 rounded-lg border border-pos-border bg-transparent cursor-pointer p-0.5"
                  />
                  <span className="text-xs font-mono text-pos-text font-bold">{cashierColorInput}</span>
                </div>
              </div>

              <div className="flex items-end">
                <button
                  type="button"
                  onClick={() => setShowCashierPin(!showCashierPin)}
                  className="py-2 px-3 rounded-xl bg-pos-bg hover:bg-pos-hover border border-pos-border text-xs text-pos-muted hover:text-pos-text flex items-center gap-1.5 transition cursor-pointer"
                >
                  {showCashierPin ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                  <span>{showCashierPin ? 'Masquer PIN' : 'Afficher PIN'}</span>
                </button>
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-pos-border">
              <button
                type="button"
                onClick={() => setIsCashierModalOpen(false)}
                className="py-2 px-4 rounded-xl text-xs font-semibold text-pos-muted hover:text-pos-text transition cursor-pointer"
              >
                Annuler
              </button>
              <button
                type="button"
                onClick={handleSaveCashier}
                disabled={isSavingCashier}
                className="py-2 px-5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs transition cursor-pointer shadow-md shadow-emerald-600/20 active:scale-95 disabled:opacity-50"
              >
                {isSavingCashier ? 'Enregistrement...' : 'Enregistrer le collaborateur'}
              </button>
            </div>
          </div>
        )}

        {/* Cashier Roster Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3 pt-1">
          {cashierUsers.map((cashier) => {
            const isAdmin = cashier.role === 'admin';
            return (
              <div
                key={cashier.id}
                className="p-3.5 rounded-xl bg-pos-bg border border-pos-border flex items-center justify-between gap-3 shadow-sm hover:border-pos-hover transition"
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <div
                    className="w-10 h-10 rounded-xl flex items-center justify-center font-black text-xs text-slate-950 shrink-0 shadow-md"
                    style={{ backgroundColor: cashier.avatarColor || (isAdmin ? '#a855f7' : '#10b981') }}
                  >
                    {cashier.name.slice(0, 2).toUpperCase()}
                  </div>
                  <div className="min-w-0">
                    <h5 className="text-xs font-bold text-pos-text truncate">{cashier.name}</h5>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <span
                        className={`text-[9px] font-bold px-1.5 py-0.2 rounded-full uppercase tracking-wider ${
                          isAdmin
                            ? 'bg-purple-500/15 text-purple-400 border border-purple-500/30'
                            : 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30'
                        }`}
                      >
                        {isAdmin ? 'Gérant' : 'Caissier'}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    onClick={() => handleOpenEditCashier(cashier)}
                    className="p-1.5 rounded-lg bg-pos-panel hover:bg-pos-hover text-pos-muted hover:text-pos-text transition cursor-pointer"
                    title={`Modifier ${cashier.name}`}
                  >
                    <Edit3 className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDeleteCashier(cashier.id)}
                    className="p-1.5 rounded-lg bg-pos-panel hover:bg-red-500/20 text-pos-muted hover:text-red-400 transition cursor-pointer"
                    title={`Supprimer ${cashier.name}`}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

