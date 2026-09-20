import React from 'react';
import { X, ShieldAlert, Lock, Clock, UserCheck } from 'lucide-react';
import { usePosStore } from '../../store/usePosStore';

export const SecurityAuditModal: React.FC = () => {
  const { activeModal, closeModal, securityAuditLog } = usePosStore();

  if (activeModal !== 'security_audit') return null;

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 select-none">
      <div className="bg-pos-panel border-t sm:border border-pos-border rounded-t-3xl sm:rounded-2xl w-full max-w-3xl overflow-hidden shadow-2xl animate-in fade-in zoom-in-95 max-h-[92vh] sm:h-[75vh] flex flex-col pt-[max(0.5rem,var(--safe-top))] pb-[max(0.5rem,var(--safe-bottom))] sm:py-0">
        <div className="w-8 h-1 rounded-full bg-pos-muted/40 mx-auto mt-2.5 mb-1 sm:hidden shrink-0" />

        {/* Header */}
        <div className="p-4 border-b border-pos-border flex items-center justify-between bg-pos-card shrink-0">
          <div className="flex items-center gap-2 text-amber-400 min-w-0">
            <ShieldAlert className="w-5 h-5 shrink-0" />
            <h2 className="text-sm font-bold text-pos-text truncate">
              Journal d'Audit de Sécurité & Actions Sensibles (RBAC)
            </h2>
          </div>
          <button
            onClick={closeModal}
            className="p-1.5 hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-lg min-h-[44px] min-w-[44px] flex items-center justify-center shrink-0"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Audit Log Body */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          <p className="text-xs text-pos-muted">
            Registre inaltérable de toutes les ouvertures manuelles de tiroir-caisse ("No Sale"), remises hors limites, et modifications de stock nécessitant le PIN Administrateur.
          </p>

          {securityAuditLog.length === 0 ? (
            <div className="p-8 text-center text-pos-muted text-xs bg-pos-card border border-pos-border rounded-xl">
              Aucune action sensible enregistrée pour le moment.
            </div>
          ) : (
            <>
              {/* Mobile Card List (md:hidden) */}
              <div className="md:hidden space-y-2.5">
                {securityAuditLog.map((log) => (
                  <div key={log.id} className="bg-pos-card border border-pos-border rounded-xl p-3 space-y-2">
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-pos-muted flex items-center gap-1 font-mono">
                        <Clock className="w-3 h-3 text-amber-400" /> {log.timestamp}
                      </span>
                      {log.requiresPin ? (
                        <span className="bg-amber-950 text-amber-300 border border-amber-800 px-2 py-0.5 rounded text-[10px] font-bold flex items-center gap-1">
                          <Lock className="w-3 h-3" /> PIN Validé
                        </span>
                      ) : (
                        <span className="text-pos-muted text-[10px]">Standard</span>
                      )}
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-xs text-amber-400">{log.action}</span>
                      <span className="text-xs font-semibold text-pos-text flex items-center gap-1">
                        <UserCheck className="w-3 h-3 text-emerald-400" /> {log.user}
                      </span>
                    </div>
                    {log.details && (
                      <p className="text-xs text-pos-muted bg-pos-bg/80 p-2 rounded-lg border border-pos-border/50">
                        {log.details}
                      </p>
                    )}
                  </div>
                ))}
              </div>

              {/* Desktop Table (hidden on mobile) */}
              <table className="hidden md:table w-full text-left text-xs border-collapse">
                <thead className="bg-pos-card text-pos-muted text-[10px] uppercase font-bold border-b border-pos-border">
                  <tr>
                    <th className="p-3">Horodatage</th>
                    <th className="p-3">Utilisateur / Rôle</th>
                    <th className="p-3">Action Sensible</th>
                    <th className="p-3">Détails / Motif</th>
                    <th className="p-3 text-center">Validation PIN</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-pos-border/40">
                  {securityAuditLog.map((log) => (
                    <tr key={log.id} className="hover:bg-pos-hover/50">
                      <td className="p-3 text-pos-muted flex items-center gap-1 font-mono">
                        <Clock className="w-3 h-3 text-amber-400" /> {log.timestamp}
                      </td>
                      <td className="p-3 font-semibold text-pos-text flex items-center gap-1">
                        <UserCheck className="w-3 h-3 text-emerald-400" /> {log.user}
                      </td>
                      <td className="p-3 font-bold text-amber-400">{log.action}</td>
                      <td className="p-3 text-pos-muted">{log.details}</td>
                      <td className="p-3 text-center">
                        {log.requiresPin ? (
                          <span className="bg-amber-950 text-amber-300 border border-amber-800 px-2 py-0.5 rounded text-[10px] font-bold inline-flex items-center justify-center gap-0.5">
                            <Lock className="w-3 h-3" /> PIN Validé
                          </span>
                        ) : (
                          <span className="text-pos-muted text-[10px]">Standard</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="p-3 sm:p-4 border-t border-pos-border bg-pos-card flex flex-col sm:flex-row justify-between items-stretch sm:items-center gap-2 text-xs text-pos-muted shrink-0">
          <span className="truncate max-w-[280px] sm:max-w-none">Journal Cryptographiquement Horodaté - Sécurité RBAC</span>
          <button
            onClick={closeModal}
            className="px-5 py-2.5 rounded-xl bg-pos-hover hover:bg-pos-border text-pos-text font-bold text-xs min-h-[44px] flex items-center justify-center active-press"
          >
            Fermer
          </button>
        </div>
      </div>
    </div>
  );
};
