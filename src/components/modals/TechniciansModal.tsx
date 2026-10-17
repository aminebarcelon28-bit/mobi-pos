/**
 * UPGRADE-05 — Workshop team management surface.
 *
 * Dedicated modal opened from RepairWorkOrderModal ("Gérer l'équipe").
 * Manages the technician roster, per-technician time-on-job stats and the
 * commission rules (tables `technicians` / `technician_time_log` /
 * `commission_rules`, migration v120) through techniciansAdapter. Storage is
 * merchant-local; outside Tauri reads degrade to empty and writes fail loud —
 * the modal explains and disables.
 *
 * Payroll invariants: technicians are never deleted (deactivate instead —
 * delivered tickets keep referencing them); commission rates are percents
 * 0–100; commission totals are integer DZD summed for display only.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  X,
  Plus,
  Trash2,
  Pencil,
  Users,
  AlertTriangle,
  Coins,
  Clock,
  CheckCircle2,
} from 'lucide-react';
import { usePosStore } from '../../store/usePosStore';
import { formatDZD } from '../../types/pos';
import { useToast } from '../ui/Toast';
import {
  isTechnicianStorageAvailable,
  listTechnicians,
  saveTechnician,
  listTimeLogs,
  listCommissionRules,
  saveCommissionRule,
  deleteCommissionRule,
  type TechnicianRecord,
  type CommissionRuleRecord,
} from '../../db/adapters/techniciansAdapter';
import {
  formatDurationMs,
  clampRatePercent,
  COMMISSION_BASIS_LABELS,
  type CommissionBasis,
} from '../../utils/technicianCommission';

interface TechniciansModalProps {
  isOpen: boolean;
  onClose: () => void;
}

/** Stats window: bounded so the board never pays for unbounded table scans. */
const STATS_WINDOW_DAYS = 30;

interface TechnicianStats {
  loggedMs: number;
  deliveredCount: number;
  commissionTotal: number;
}

const EMPTY_STATS: TechnicianStats = { loggedMs: 0, deliveredCount: 0, commissionTotal: 0 };

export const TechniciansModal: React.FC<TechniciansModalProps> = ({ isOpen, onClose }) => {
  const { showToast } = useToast();
  const storageOk = isTechnicianStorageAvailable();

  const [loading, setLoading] = useState(false);
  const [technicians, setTechnicians] = useState<TechnicianRecord[]>([]);
  const [rules, setRules] = useState<CommissionRuleRecord[]>([]);
  const [stats, setStats] = useState<Record<string, TechnicianStats>>({});

  // ── Technician form ──────────────────────────────────────────────────────
  const [techFormOpen, setTechFormOpen] = useState(false);
  const [editingTechId, setEditingTechId] = useState<string | null>(null);
  const [formName, setFormName] = useState('');
  const [formRole, setFormRole] = useState('Technicien');
  const [formActive, setFormActive] = useState(true);

  // ── Rule form ────────────────────────────────────────────────────────────
  const [ruleFormOpen, setRuleFormOpen] = useState(false);
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [ruleTechnicianId, setRuleTechnicianId] = useState('');
  const [ruleBasis, setRuleBasis] = useState<CommissionBasis>('labor');
  const [ruleRate, setRuleRate] = useState('10');
  const [ruleActive, setRuleActive] = useState(true);

  const technicianNameOf = (id: string | null | undefined): string => {
    if (!id) return 'Règle par défaut (tous)';
    return technicians.find((t) => t.id === id)?.name ?? id;
  };

  const reload = useCallback(async () => {
    if (!storageOk) {
      setTechnicians([]);
      setRules([]);
      setStats({});
      return;
    }
    setLoading(true);
    try {
      const sinceIso = new Date(
        Date.now() - STATS_WINDOW_DAYS * 24 * 60 * 60 * 1000
      ).toISOString();
      const [techs, ruleRows, logs] = await Promise.all([
        listTechnicians(),
        listCommissionRules(),
        listTimeLogs({ sinceIso }),
      ]);
      setTechnicians(techs);
      setRules(ruleRows);

      const acc: Record<string, TechnicianStats> = {};
      for (const t of techs) acc[t.id] = { ...EMPTY_STATS };
      // 'work' sessions only — the kind column exists for future kinds (travel,
      // diagnostics); payroll must never count rows this board never opened.
      for (const log of logs) {
        if (log.kind !== 'work') continue;
        const entry = acc[log.technicianId];
        if (!entry) continue;
        const started = new Date(log.startedAt).getTime();
        const ended = (log.endedAt ? new Date(log.endedAt) : new Date()).getTime();
        if (Number.isFinite(started) && Number.isFinite(ended)) {
          entry.loggedMs += Math.max(0, ended - started);
        }
      }
      // Repair-derived stats inside the same window, read from the in-memory
      // store (hydrated at boot) so the board matches the ticket list the
      // operator sees. Stamped commission amounts are integer DZD by
      // construction — summed as-is, never re-rounded.
      const orders = usePosStore.getState().repairOrders;
      const sinceMs = new Date(sinceIso).getTime();
      for (const o of orders) {
        const techId = o.commissionTechnicianId ?? o.assignedTechnicianId;
        if (!techId) continue;
        const entry = acc[techId];
        if (!entry) continue;
        if (
          o.status === 'Livré' &&
          o.deliveredAt &&
          new Date(o.deliveredAt).getTime() >= sinceMs
        ) {
          entry.deliveredCount += 1;
        }
        if (
          o.commissionComputedAt &&
          new Date(o.commissionComputedAt).getTime() >= sinceMs &&
          Number.isFinite(o.commissionAmount)
        ) {
          entry.commissionTotal += Math.max(0, Number(o.commissionAmount) || 0);
        }
      }
      setStats(acc);
    } finally {
      setLoading(false);
    }
  }, [storageOk]);

  useEffect(() => {
    if (isOpen) void reload();
  }, [isOpen, reload]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  const openCreateTech = () => {
    setEditingTechId(null);
    setFormName('');
    setFormRole('Technicien');
    setFormActive(true);
    setTechFormOpen(true);
  };

  const openEditTech = (tech: TechnicianRecord) => {
    setEditingTechId(tech.id);
    setFormName(tech.name);
    setFormRole(tech.role);
    setFormActive(tech.active);
    setTechFormOpen(true);
  };

  const handleSaveTech = async () => {
    if (!formName.trim()) {
      showToast('Nom du technicien requis.', 'warning');
      return;
    }
    const id = await saveTechnician({
      id: editingTechId ?? undefined,
      name: formName,
      role: formRole,
      active: formActive,
    });
    if (!id) {
      showToast('Enregistrement impossible (base locale indisponible).', 'error');
      return;
    }
    setTechFormOpen(false);
    await reload();
    showToast(editingTechId ? 'Technicien mis à jour.' : 'Technicien ajouté.', 'success');
  };

  const openCreateRule = () => {
    setEditingRuleId(null);
    setRuleTechnicianId('');
    setRuleBasis('labor');
    setRuleRate('10');
    setRuleActive(true);
    setRuleFormOpen(true);
  };

  const openEditRule = (rule: CommissionRuleRecord) => {
    setEditingRuleId(rule.id);
    setRuleTechnicianId(rule.technicianId ?? '');
    setRuleBasis(rule.basis);
    setRuleRate(String(rule.ratePercent));
    setRuleActive(rule.active);
    setRuleFormOpen(true);
  };

  const handleSaveRule = async () => {
    const rate = Number(String(ruleRate).replace(',', '.'));
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
      showToast('Taux invalide — pourcentage entre 0 et 100.', 'warning');
      return;
    }
    const id = await saveCommissionRule({
      id: editingRuleId ?? undefined,
      technicianId: ruleTechnicianId || null,
      basis: ruleBasis,
      ratePercent: rate,
      active: ruleActive,
    });
    if (!id) {
      showToast('Enregistrement impossible (base locale indisponible).', 'error');
      return;
    }
    setRuleFormOpen(false);
    await reload();
    showToast(
      editingRuleId ? 'Règle de commission mise à jour.' : 'Règle de commission créée.',
      'success'
    );
  };

  const handleDeleteRule = async (rule: CommissionRuleRecord) => {
    const label = technicianNameOf(rule.technicianId);
    if (!window.confirm(`Supprimer la règle de commission « ${label} » ?`)) return;
    const ok = await deleteCommissionRule(rule.id);
    if (!ok) {
      showToast('Suppression impossible.', 'error');
      return;
    }
    await reload();
    showToast('Règle de commission supprimée.', 'info');
  };

  if (!isOpen) return null;

  const inputClass =
    'w-full bg-pos-bg border border-pos-border rounded-lg px-3 py-2 text-xs text-pos-text focus:border-emerald-400 focus:outline-none';
  const labelClass = 'text-[10px] uppercase font-bold text-pos-muted block mb-1';

  return createPortal(
    <div
      className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[80] flex items-center justify-center p-0 sm:p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Équipe technique — techniciens, temps de travail et commissions"
        onClick={(e) => e.stopPropagation()}
        className="bg-pos-panel border border-pos-border rounded-t-[28px] sm:rounded-xl w-full max-w-3xl max-h-[92dvh] flex flex-col shadow-2xl animate-in zoom-in-95 relative overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-pos-border px-4 py-3 shrink-0">
          <div className="flex items-center gap-2 text-emerald-400">
            <Users className="w-5 h-5" aria-hidden="true" />
            <h3 className="text-sm font-black text-pos-text">
              Équipe Technique — Commissions & Temps
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fermer la gestion de l'équipe"
            className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg hover:bg-pos-hover text-pos-muted hover:text-pos-text transition shrink-0"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        {!storageOk && (
          <div className="mx-4 mt-3 p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-300 text-xs font-bold flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />
            L'équipe technique est disponible uniquement dans l'application de bureau (base locale).
          </div>
        )}

        {/* Body */}
        <div className="flex-1 overflow-y-auto overscroll-contain p-4 flex flex-col md:flex-row gap-4">
          {/* Roster column */}
          <div className="md:w-3/5 flex flex-col gap-2 min-w-0">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] uppercase font-bold text-pos-muted">
                Techniciens ({technicians.length}) — stats {STATS_WINDOW_DAYS} j
              </span>
              <button
                type="button"
                onClick={openCreateTech}
                disabled={!storageOk}
                className="px-2.5 py-1.5 min-h-[36px] rounded-lg bg-emerald-500 hover:bg-emerald-400 disabled:opacity-40 text-slate-950 text-[11px] font-black flex items-center gap-1 transition cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" aria-hidden="true" /> Nouveau technicien
              </button>
            </div>

            {loading ? (
              <p className="text-xs text-pos-muted py-6 text-center">Chargement…</p>
            ) : technicians.length === 0 ? (
              <p className="text-xs text-pos-muted py-6 text-center">
                Aucun technicien. Ajoutez l'équipe de l'atelier pour assigner et suivre les
                tickets.
              </p>
            ) : (
              <div className="space-y-1.5">
                {technicians.map((tech) => {
                  const s = stats[tech.id] ?? EMPTY_STATS;
                  return (
                    <div
                      key={tech.id}
                      className="w-full px-3 py-2.5 rounded-xl border border-pos-border bg-pos-card"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="text-xs font-black text-pos-text truncate">
                              {tech.name}
                            </span>
                            <span
                              className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full border shrink-0 ${
                                tech.active
                                  ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
                                  : 'bg-pos-hover text-pos-muted border-pos-border'
                              }`}
                            >
                              {tech.active ? 'Actif' : 'Inactif'}
                            </span>
                          </div>
                          <p className="text-[10px] text-pos-muted mt-0.5">{tech.role}</p>
                        </div>
                        <button
                          type="button"
                          onClick={() => openEditTech(tech)}
                          aria-label={`Modifier ${tech.name}`}
                          className="p-1.5 min-h-[32px] rounded-lg hover:bg-pos-hover text-pos-muted hover:text-pos-text transition cursor-pointer shrink-0"
                        >
                          <Pencil className="w-3.5 h-3.5" aria-hidden="true" />
                        </button>
                      </div>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1.5 text-[10px] text-pos-muted">
                        <span className="flex items-center gap-1">
                          <Clock className="w-3 h-3" aria-hidden="true" />
                          {formatDurationMs(s.loggedMs)}
                        </span>
                        <span className="flex items-center gap-1">
                          <CheckCircle2 className="w-3 h-3" aria-hidden="true" />
                          {s.deliveredCount} livré{s.deliveredCount > 1 ? 's' : ''}
                        </span>
                        <span className="flex items-center gap-1 font-mono tabular-nums">
                          <Coins className="w-3 h-3" aria-hidden="true" />
                          {formatDZD(s.commissionTotal)} commissions
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* ── Technician form ── */}
            {techFormOpen && (
              <div className="mt-2 p-3 rounded-xl border border-pos-border bg-pos-card space-y-3">
                <p className="text-[11px] font-black text-pos-text">
                  {editingTechId ? 'Modifier le technicien' : 'Nouveau technicien'}
                </p>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label htmlFor="tm-tech-name" className={labelClass}>
                      Nom
                    </label>
                    <input
                      id="tm-tech-name"
                      type="text"
                      value={formName}
                      onChange={(e) => setFormName(e.target.value)}
                      placeholder="ex. Karim B."
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label htmlFor="tm-tech-role" className={labelClass}>
                      Rôle
                    </label>
                    <input
                      id="tm-tech-role"
                      type="text"
                      value={formRole}
                      onChange={(e) => setFormRole(e.target.value)}
                      placeholder="Technicien"
                      className={inputClass}
                    />
                  </div>
                </div>
                <label
                  htmlFor="tm-tech-active"
                  className="flex items-center gap-2 text-xs text-pos-text cursor-pointer"
                >
                  <input
                    id="tm-tech-active"
                    type="checkbox"
                    checked={formActive}
                    onChange={(e) => setFormActive(e.target.checked)}
                    className="accent-emerald-500 w-4 h-4"
                  />
                  Actif — proposé à l'assignation des tickets
                </label>
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setTechFormOpen(false)}
                    className="px-3 py-2 min-h-[38px] rounded-lg bg-pos-hover text-pos-muted hover:text-pos-text text-[11px] font-bold cursor-pointer"
                  >
                    Annuler
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleSaveTech()}
                    className="px-3 py-2 min-h-[38px] rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-[11px] font-black cursor-pointer"
                  >
                    Enregistrer
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Rules column */}
          <div className="md:flex-1 min-w-0 flex flex-col gap-2 border-t md:border-t-0 md:border-l border-pos-border md:pl-4 pt-4 md:pt-0">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] uppercase font-bold text-pos-muted">
                Règles de commission ({rules.length})
              </span>
              <button
                type="button"
                onClick={openCreateRule}
                disabled={!storageOk}
                className="px-2.5 py-1.5 min-h-[36px] rounded-lg bg-pos-card border border-emerald-500/40 hover:bg-emerald-500/10 disabled:opacity-40 text-emerald-500 text-[11px] font-black flex items-center gap-1 transition cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" aria-hidden="true" /> Nouvelle règle
              </button>
            </div>
            <p className="text-[10px] text-pos-muted">
              Évaluée à la livraison du ticket : une règle par technicien prime sur la règle par
              défaut. Sans règle, la commission évaluée est nulle (aucun montant dû).
            </p>

            {rules.length === 0 ? (
              <p className="text-xs text-pos-muted py-4 text-center">
                Aucune règle de commission.
              </p>
            ) : (
              <div className="space-y-1.5">
                {rules.map((rule) => (
                  <div
                    key={rule.id}
                    className="flex items-center justify-between gap-2 px-3 py-2 rounded-xl border border-pos-border bg-pos-card"
                  >
                    <div className="min-w-0">
                      <p className="text-xs font-bold text-pos-text truncate">
                        {technicianNameOf(rule.technicianId)}
                      </p>
                      <p className="text-[10px] text-pos-muted">
                        {clampRatePercent(rule.ratePercent)}% — {COMMISSION_BASIS_LABELS[rule.basis]}
                        {rule.active ? '' : ' • inactive'}
                      </p>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        type="button"
                        onClick={() => openEditRule(rule)}
                        aria-label={`Modifier la règle — ${technicianNameOf(rule.technicianId)}`}
                        className="p-1.5 min-h-[32px] rounded-lg hover:bg-pos-hover text-pos-muted hover:text-pos-text transition cursor-pointer"
                      >
                        <Pencil className="w-3.5 h-3.5" aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleDeleteRule(rule)}
                        aria-label={`Supprimer la règle — ${technicianNameOf(rule.technicianId)}`}
                        className="p-1.5 min-h-[32px] rounded-lg hover:bg-rose-500/10 text-rose-400 transition cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* ── Rule form ── */}
            {ruleFormOpen && (
              <div className="mt-2 p-3 rounded-xl border border-pos-border bg-pos-card space-y-3">
                <p className="text-[11px] font-black text-pos-text">
                  {editingRuleId ? 'Modifier la règle de commission' : 'Nouvelle règle de commission'}
                </p>
                <div>
                  <label htmlFor="tm-rule-tech" className={labelClass}>
                    Technicien
                  </label>
                  <select
                    id="tm-rule-tech"
                    value={ruleTechnicianId}
                    onChange={(e) => setRuleTechnicianId(e.target.value)}
                    className={inputClass}
                  >
                    <option value="">Règle par défaut (tous les techniciens)</option>
                    {technicians.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                        {t.active ? '' : ' (inactif)'}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label htmlFor="tm-rule-basis" className={labelClass}>
                      Base de calcul
                    </label>
                    <select
                      id="tm-rule-basis"
                      value={ruleBasis}
                      onChange={(e) => setRuleBasis(e.target.value === 'total' ? 'total' : 'labor')}
                      className={inputClass}
                    >
                      <option value="labor">{COMMISSION_BASIS_LABELS.labor}</option>
                      <option value="total">{COMMISSION_BASIS_LABELS.total}</option>
                    </select>
                  </div>
                  <div>
                    <label htmlFor="tm-rule-rate" className={labelClass}>
                      Taux (%)
                    </label>
                    <input
                      id="tm-rule-rate"
                      type="number"
                      min={0}
                      max={100}
                      step={0.5}
                      inputMode="decimal"
                      value={ruleRate}
                      onChange={(e) => setRuleRate(e.target.value)}
                      className={`${inputClass} font-mono`}
                    />
                  </div>
                </div>
                <label
                  htmlFor="tm-rule-active"
                  className="flex items-center gap-2 text-xs text-pos-text cursor-pointer"
                >
                  <input
                    id="tm-rule-active"
                    type="checkbox"
                    checked={ruleActive}
                    onChange={(e) => setRuleActive(e.target.checked)}
                    className="accent-emerald-500 w-4 h-4"
                  />
                  Active — appliquée aux prochaines livraisons
                </label>
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setRuleFormOpen(false)}
                    className="px-3 py-2 min-h-[38px] rounded-lg bg-pos-hover text-pos-muted hover:text-pos-text text-[11px] font-bold cursor-pointer"
                  >
                    Annuler
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleSaveRule()}
                    className="px-3 py-2 min-h-[38px] rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-[11px] font-black cursor-pointer"
                  >
                    Enregistrer
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
};
