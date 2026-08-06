import React from 'react';
import { X, ShieldAlert, Lock, Clock, UserCheck } from 'lucide-react';
import { usePosStore } from '../../store/usePosStore';

export const SecurityAuditModal: React.FC = () => {
  const { activeModal, closeModal, securityAuditLog } = usePosStore();

  if (activeModal !== 'security_audit') return null;

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4 select-none">
      <div className="bg-pos-panel border border-pos-border rounded-2xl w-full max-w-3xl overflow-hidden shadow-2xl animate-in fade-in zoom-in-95 h-[75vh] flex flex-col">
        {/* Header */}
        <div className="p-4 border-b border-pos-border flex items-center justify-between bg-pos-card">
          <div className="flex items-center gap-2 text-amber-400">
            <ShieldAlert className="w-5 h-5" />
            <h2 className="text-sm font-bold text-pos-text">
              Journal d'Audit de Sécurité & Actions Sensibles (RBAC)
            </h2>
          </div>
          <button onClick={closeModal} className="p-1 hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-lg">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Audit Log Table */}
        <div className="flex-1 overflow-y-auto p-4">
          <p className="text-xs text-pos-muted mb-3">
            Registre inaltérable de toutes les ouvertures manuelles de tiroir-caisse ("No Sale"), remises hors limites, et modifications de stock nécessitant le PIN Administrateur.
          </p>

          <table className="w-full text-left text-xs border-collapse">
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
              {securityAuditLog.length === 0 ? (
                <tr>
                  <td colSpan={5} className="p-8 text-center text-pos-muted">
                    Aucune action sensible enregistrée pour le moment.
                  </td>
                </tr>
              ) : (
                securityAuditLog.map((log) => (
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
                        <span className="bg-amber-950 text-amber-300 border border-amber-800 px-2 py-0.5 rounded text-[10px] font-bold flex items-center justify-center gap-0.5">
                          <Lock className="w-3 h-3" /> PIN Validé
                        </span>
                      ) : (
                        <span className="text-pos-muted text-[10px]">Standard</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Footer */}
        <div className="p-3 border-t border-pos-border bg-pos-card flex justify-between items-center text-xs text-pos-muted">
          <span>Journal Cryptographiquement Horodaté - Sécurité Anti-Démarchage & Anti-Vol</span>
          <button onClick={closeModal} className="px-4 py-1.5 rounded-lg bg-pos-hover text-pos-text font-semibold">
            Fermer
          </button>
        </div>
      </div>
    </div>
  );
};
