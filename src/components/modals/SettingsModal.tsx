import React, { useState, useEffect, useRef } from 'react';
import {
  X,
  Settings,
  Printer,
  Shield,
  Cloud,
  Activity,
  Award,
  Database,
  Sparkles,
  ChevronLeft,
} from 'lucide-react';
import { usePosStore } from '../../store/usePosStore';
import { useToast } from '../ui/Toast';
import { needsPinRotation } from '../../utils/security';
import { canSeeJournalLauncher } from '../../utils/auditGate';
import { verifyManagerGate, verifyUserGate } from '../../utils/pinGate';
import { GeneralSettingsTab } from './settings/GeneralSettingsTab';
import { HardwareSettingsTab } from './settings/HardwareSettingsTab';
import { SecuritySettingsTab } from './settings/SecuritySettingsTab';
import { CloudSyncSettingsTab } from './settings/CloudSyncSettingsTab';
import { DiagnosticsSettingsTab } from './settings/DiagnosticsSettingsTab';
import { LoyaltySettingsTab } from './settings/LoyaltySettingsTab';
import { BackupSettingsTab } from './settings/BackupSettingsTab';
import { UpdatesSettingsTab } from './settings/UpdatesSettingsTab';
import type { ReceiptSettings } from '../../types/pos';

export type SettingsTab =
  | 'appearance'
  | 'hardware'
  | 'security'
  | 'cloud_sync'
  | 'diagnostics'
  | 'loyalty'
  | 'backup'
  | 'updates';

export const SettingsModal: React.FC = () => {
  const {
    activeModal,
    closeModal,
    receiptSettings,
    setReceiptSettings,
    managerPin,
    themeMode,
    toggleTheme,
    activeCashier,
  } = usePosStore();

  const { showToast } = useToast();
  const safeShowToast = (msg: string, type: 'success' | 'error' | 'info' | 'warning' = 'info', duration?: number) => {
    showToast(msg, type, duration);
  };
  const _canAccessJournal = canSeeJournalLauncher(activeCashier?.role);
  void _canAccessJournal;
  void verifyManagerGate;
  void verifyUserGate;
  const [activeTab, setActiveTab] = useState<SettingsTab>('appearance');
  const tabStripRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = tabStripRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      if (el.scrollWidth <= el.clientWidth + 1) return;
      el.scrollLeft += e.deltaY;
      e.preventDefault();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  useEffect(() => {
    const el = tabStripRef.current;
    const activeEl = el?.querySelector<HTMLElement>('[data-active="true"]');
    activeEl?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  }, [activeTab]);

  const scheduleReceiptSave = (next: ReceiptSettings) => {
    setReceiptSettings(next);
  };

  // Keyboard shortcut listener for Escape & F12 to close
  useEffect(() => {
    if (activeModal !== 'settings') return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'F12') {
        e.preventDefault();
        e.stopPropagation();
        closeModal();
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [activeModal, closeModal]);

  if (activeModal !== 'settings') return null;

  // Format-aware credential badge
  const managerKdfLabel = (() => {
    const h = (managerPin || '').trim();
    if (!h) return 'Non configuré';
    if (h.startsWith('v2$')) return 'Actif (Argon2id)';
    if (!needsPinRotation(h)) return 'Actif (local)';
    return 'Hérité (rotation requise)';
  })();

  const tabs: Array<{ key: SettingsTab; label: string; icon: React.ReactNode }> = [
    { key: 'appearance', label: 'Général & Apparence', icon: <Settings className="w-4 h-4" /> },
    { key: 'hardware', label: 'Matériel & Imprimantes', icon: <Printer className="w-4 h-4" /> },
    { key: 'security', label: 'Sécurité & Personnel', icon: <Shield className="w-4 h-4" /> },
    { key: 'cloud_sync', label: 'Synchronisation Cloud', icon: <Cloud className="w-4 h-4" /> },
    { key: 'diagnostics', label: 'Diagnostics Système', icon: <Activity className="w-4 h-4" /> },
    { key: 'loyalty', label: 'Fidélité & Simulateur', icon: <Award className="w-4 h-4" /> },
    { key: 'backup', label: 'Base de Données & Sauvegarde', icon: <Database className="w-4 h-4" /> },
    { key: 'updates', label: 'Mises à Jour & Version', icon: <Sparkles className="w-4 h-4" /> },
  ];

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Paramètres du système"
      className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 select-none"
    >
      <div className="bg-pos-panel border-t sm:border border-pos-border rounded-t-[28px] sm:rounded-2xl w-full max-w-6xl overflow-hidden shadow-2xl flex flex-col h-[94dvh] sm:h-[90dvh] animate-in fade-in zoom-in-95">
        <div className="w-12 h-1.5 rounded-full bg-pos-muted/40 mx-auto mt-2.5 mb-1 sm:hidden shrink-0" aria-hidden="true" />

        {/* ═══ Header ═══ */}
        <div className="p-3 sm:p-4 border-b border-pos-border flex items-center justify-between bg-pos-card shrink-0">
          <div className="flex items-center gap-2 sm:gap-2.5 min-w-0">
            <button
              type="button"
              onClick={closeModal}
              className="p-1.5 px-2 sm:px-3 bg-cyan-500/10 hover:bg-cyan-500/20 active:scale-95 border border-cyan-500/30 text-cyan-400 rounded-xl font-bold text-xs flex items-center gap-1 transition cursor-pointer shrink-0"
              title="Retour au logiciel (Échap)"
            >
              <ChevronLeft className="w-4 h-4 sm:w-5 sm:h-5 stroke-[2.5]" />
              <span>Retour</span>
            </button>
            <div className="w-8 h-8 sm:w-9 sm:h-9 rounded-xl bg-cyan-500/20 flex items-center justify-center border border-cyan-500/30 shadow-md shrink-0">
              <Settings className="w-4 h-4 sm:w-5 sm:h-5 text-cyan-400 stroke-[2.5]" />
            </div>
            <div className="min-w-0">
              <h2 className="text-xs sm:text-base font-extrabold text-pos-text tracking-wide flex items-center gap-2 truncate">
                <span>PARAMÈTRES DU SYSTÈME</span>
                <span className="hidden sm:inline-flex bg-emerald-500/20 text-emerald-400 text-[10px] font-bold px-2 py-0.5 rounded-full border border-emerald-500/30 items-center gap-1 shrink-0">
                  <Sparkles className="w-3 h-3" /> Multi-Périphériques
                </span>
              </h2>
              <p className="text-[10px] text-pos-muted truncate hidden sm:block">
                Configuration générale, imprimantes, sécurité, fidélité & maintenance SQLite
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={closeModal}
            className="p-2 hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-xl transition cursor-pointer min-h-[44px] min-w-[44px] flex items-center justify-center"
            title="Fermer les paramètres (Échap / F12)"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* ═══ Tab Navigation (horizontally scrollable on mobile) ═══ */}
        <div
          ref={tabStripRef}
          style={{ WebkitOverflowScrolling: 'touch' }}
          className="flex flex-nowrap gap-1 px-2.5 sm:px-4 pt-2 sm:pt-3 pb-0 shrink-0 overflow-x-auto overscroll-contain overflow-y-hidden no-scrollbar whitespace-nowrap border-b border-pos-border/40 min-w-0 max-w-full"
        >
          {tabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              data-active={activeTab === tab.key ? 'true' : 'false'}
              onClick={() => setActiveTab(tab.key)}
              className={`px-3 sm:px-4 py-2 rounded-t-xl text-xs font-bold flex items-center gap-1.5 transition-all cursor-pointer whitespace-nowrap shrink-0 ${
                activeTab === tab.key
                  ? 'bg-pos-bg border border-pos-border border-b-transparent text-cyan-400 shadow-sm'
                  : 'text-pos-muted hover:text-pos-text hover:bg-pos-hover/50'
              }`}
            >
              {tab.icon}
              <span>{tab.label}</span>
            </button>
          ))}
        </div>

        {/* ═══ Content Body ═══ */}
        <div className="flex-1 overflow-y-auto overscroll-contain p-3 sm:p-6">
          {activeTab === 'appearance' && (
            <GeneralSettingsTab
              themeMode={themeMode}
              toggleTheme={toggleTheme}
              receiptDraft={receiptSettings}
              scheduleReceiptSave={scheduleReceiptSave}
            />
          )}

          {activeTab === 'hardware' && (
            <HardwareSettingsTab
              receiptDraft={receiptSettings}
              scheduleReceiptSave={scheduleReceiptSave}
            />
          )}

          {activeTab === 'security' && (
            <SecuritySettingsTab
              managerKdfLabel={managerKdfLabel}
            />
          )}

          {activeTab === 'cloud_sync' && <CloudSyncSettingsTab />}

          {activeTab === 'diagnostics' && (
            <DiagnosticsSettingsTab receiptSettings={receiptSettings} />
          )}

          {activeTab === 'loyalty' && (
            <LoyaltySettingsTab
              receiptSettings={receiptSettings}
              onSave={setReceiptSettings}
              showToast={safeShowToast}
            />
          )}

          {activeTab === 'backup' && (
            <BackupSettingsTab
              showToast={safeShowToast}
              openSecurityTab={() => setActiveTab('security')}
            />
          )}

          {activeTab === 'updates' && <UpdatesSettingsTab showToast={safeShowToast} />}
        </div>

        {/* ═══ Footer ═══ */}
        <div className="p-2.5 sm:p-3 pb-[max(1rem,var(--safe-bottom))] sm:pb-3 border-t border-pos-border bg-pos-card flex justify-between items-center text-xs text-pos-muted shrink-0">
          <span className="text-[11px] truncate hidden sm:block">
            MobiPOS Pro • Paramètres du Système & Télémétrie ACID
          </span>
          <span className="text-[11px] truncate sm:hidden font-mono text-cyan-400 font-bold">
            MobiPOS Pro
          </span>
          <button
            type="button"
            onClick={closeModal}
            className="px-4 py-1.5 sm:px-5 sm:py-2 rounded-xl bg-pos-hover hover:bg-pos-border text-pos-text font-bold text-xs flex items-center gap-1.5 transition cursor-pointer active:scale-95 min-h-[44px]"
            title="Quitter les paramètres"
          >
            <span>Fermer</span>
            <span className="hidden sm:inline text-[10px] bg-pos-bg px-1.5 py-0.5 rounded border border-pos-border text-pos-muted">
              Échap / F12
            </span>
          </button>
        </div>
      </div>
    </div>
  );
};
