import React, { useState, useMemo } from 'react';
import {
  CheckCircle2,
  AlertTriangle,
  Filter,
  ArrowRight,
  Wand2,
  Plus,
  Trash2,
  Check,
} from 'lucide-react';
import { formatDZD } from '../types/pos';
import { commitStockBatch } from '../api/po';
import { usePosStore } from '../store/usePosStore';
import type { EditableReviewLine, ProcessRawScanResponse } from '../types/po';

interface PoReviewScreenProps {
  supplierName: string;
  reportedTax: number;
  reportedFreight: number;
  reportedGrandTotal: number;
  scanData: ProcessRawScanResponse;
  onCommitSuccess: (count: number) => void;
  onCancel: () => void;
}

export const PoReviewScreen: React.FC<PoReviewScreenProps> = ({
  supplierName,
  reportedTax,
  reportedFreight,
  reportedGrandTotal,
  scanData,
  onCommitSuccess,
  onCancel,
}) => {
  const activeShift = usePosStore((state) => state.activeShift);
  const products = usePosStore((state) => state.products);

  const [lines, setLines] = useState<EditableReviewLine[]>(() =>
    scanData.resolved_lines.map((l, idx) => ({
      client_id: `line_${Date.now()}_${idx}`,
      raw_description: l.raw_description,
      quantity: l.quantity,
      unit_cost: l.unit_cost,
      line_total: l.line_total,
      selected_product_id: l.matched_product?.id ?? null,
      match_tier: l.match_tier,
      save_alias: l.match_tier !== 'tier1exactalias',
      candidates: l.candidate_suggestions,
    }))
  );

  const [grandTotalState, setGrandTotalState] = useState<number>(() =>
    reportedGrandTotal > 0
      ? reportedGrandTotal
      : Math.round(scanData.invariant_report.calculated_grand_total * 100) / 100
  );

  const [exceptionsOnly, setExceptionsOnly] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [balanceSuccessNotice, setBalanceSuccessNotice] = useState<string | null>(null);

  // Full catalog memo for unconstrained assignment
  const catalogOptions = useMemo(() => {
    return products
      .filter((p) => p.isActive !== false)
      .map((p) => ({
        id: p.id,
        sku: p.sku || p.barcode || '',
        name: p.title || 'Produit',
        cost: p.costPrice || 0,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [products]);

  // Client-side real-time invariant evaluation (strict tolerance <= 0.01 DA)
  const mathState = useMemo(() => {
    let subtotal = 0;
    const faultyRows = new Map<string, { expected: number; actual: number }>();

    lines.forEach((line) => {
      const expected = Math.round(line.quantity * line.unit_cost * 100) / 100;
      const actual = Math.round(line.line_total * 100) / 100;
      if (Math.abs(expected - actual) > 0.01) {
        faultyRows.set(line.client_id, { expected, actual });
      }
      subtotal += actual;
    });

    const calculatedTotal = Math.round((subtotal + reportedTax + reportedFreight) * 100) / 100;
    const targetTotal = grandTotalState > 0 ? grandTotalState : calculatedTotal;
    const delta = Math.round((calculatedTotal - targetTotal) * 100) / 100;
    const isBalanced = Math.abs(delta) <= 0.01 && faultyRows.size === 0;

    return { subtotal, calculatedTotal, targetTotal, delta, isBalanced, faultyRows };
  }, [lines, reportedTax, reportedFreight, grandTotalState]);

  const unassignedCount = useMemo(
    () => lines.filter((l) => !l.selected_product_id).length,
    [lines]
  );
  const invalidQtyCount = useMemo(
    () => lines.filter((l) => l.quantity <= 0).length,
    [lines]
  );
  const isAutoApproveEligible = mathState.isBalanced && unassignedCount === 0 && invalidQtyCount === 0;

  const updateLine = (id: string, updates: Partial<EditableReviewLine>) => {
    setLines((prev) =>
      prev.map((item) => {
        if (item.client_id !== id) return item;
        const next = { ...item, ...updates };
        if (updates.quantity !== undefined || updates.unit_cost !== undefined) {
          next.line_total = Math.round(next.quantity * next.unit_cost * 100) / 100;
        } else if (updates.line_total !== undefined && next.quantity > 0) {
          next.unit_cost = Math.round((next.line_total / next.quantity) * 100) / 100;
        }
        return next;
      })
    );
  };

  const handleDeleteLine = (id: string) => {
    setLines((prev) => prev.filter((l) => l.client_id !== id));
  };

  const handleAddLine = () => {
    const newLine: EditableReviewLine = {
      client_id: `line_manual_${Date.now()}`,
      raw_description: 'Article ajouté manuellement',
      quantity: 1,
      unit_cost: 0,
      line_total: 0,
      selected_product_id: null,
      match_tier: 'tier3unmatched',
      save_alias: false,
      candidates: [],
    };
    setLines((prev) => [...prev, newLine]);
  };

  // 1-Tap Auto-Balance: re-aligns Q * C = T for all lines and snaps Grand Total to sum
  const handleAutoBalance = () => {
    let newSubtotal = 0;
    const updated = lines.map((line) => {
      let qty = line.quantity;
      let unitCost = line.unit_cost;
      let lineTotal = line.line_total;

      if (qty > 0 && unitCost > 0) {
        lineTotal = Math.round(qty * unitCost * 100) / 100;
      } else if (qty > 0 && lineTotal > 0 && unitCost <= 0) {
        unitCost = Math.round((lineTotal / qty) * 100) / 100;
      } else if (unitCost > 0 && lineTotal > 0 && qty <= 0) {
        qty = Math.max(1, Math.round(lineTotal / unitCost));
      }
      newSubtotal += lineTotal;
      return {
        ...line,
        quantity: qty,
        unit_cost: unitCost,
        line_total: lineTotal,
      };
    });

    setLines(updated);

    const newGrandTotal = Math.round((newSubtotal + reportedTax + reportedFreight) * 100) / 100;
    setGrandTotalState(newGrandTotal);
    setBalanceSuccessNotice(`Comptabilité équilibrée automatiquement (Total: ${formatDZD(newGrandTotal)}).`);
    setTimeout(() => setBalanceSuccessNotice(null), 4000);
  };

  const handleCommit = async () => {
    if (!mathState.isBalanced) return;

    if (invalidQtyCount > 0) {
      setErrorMessage(`Toutes les quantités doivent être strictement positives (${invalidQtyCount} ligne(s) invalide(s)).`);
      return;
    }

    if (unassignedCount > 0) {
      setErrorMessage(`Veuillez affecter tous les articles avant validation (${unassignedCount} restant(s)).`);
      return;
    }

    try {
      setIsSubmitting(true);
      setErrorMessage(null);

      const count = await commitStockBatch({
        supplier_name: supplierName,
        user_id: activeShift?.cashierName || 'local_user',
        items: lines.map((l) => ({
          product_id: l.selected_product_id as string,
          quantity: l.quantity,
          unit_cost: l.unit_cost,
          raw_supplier_name: l.raw_description,
          save_as_alias: l.save_alias,
        })),
      });

      onCommitSuccess(count);
    } catch (e: unknown) {
      setErrorMessage(e instanceof Error ? e.message : String(e) || 'Échec de la transaction');
    } finally {
      setIsSubmitting(false);
    }
  };

  const visibleLines = exceptionsOnly
    ? lines.filter(
        (l) =>
          mathState.faultyRows.has(l.client_id) ||
          !l.selected_product_id ||
          l.match_tier === 'tier3unmatched'
      )
    : lines;

  return (
    <div className="flex flex-col h-full max-h-[94dvh] bg-slate-950 text-slate-100 font-sans">
      {/* 1. STICKY INVARIANT HEADER */}
      <header className="sticky top-0 z-30 bg-slate-900 border-b border-slate-800 p-3.5 sm:p-4 shadow-xl shrink-0">
        <div className="flex justify-between items-start mb-2 gap-2">
          <div className="min-w-0">
            <h1 className="text-sm font-bold text-white uppercase tracking-wider truncate">{supplierName}</h1>
            <p className="text-xs text-slate-400 mt-0.5 truncate">
              TVA : {formatDZD(reportedTax)} | Port : {formatDZD(reportedFreight)} | Total Facture : {formatDZD(mathState.targetTotal)}
            </p>
          </div>

          <div
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold tracking-wide border shrink-0 transition-all ${
              isAutoApproveEligible
                ? 'bg-emerald-950/90 border-emerald-500 text-emerald-300 shadow-sm shadow-emerald-950'
                : !mathState.isBalanced
                  ? 'bg-rose-950/90 border-rose-500 text-rose-300 shadow-sm shadow-rose-950'
                  : 'bg-amber-950/90 border-amber-500 text-amber-300 shadow-sm shadow-amber-950'
            }`}
          >
            {isAutoApproveEligible ? (
              <>
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                <span>🟢 Auto-Approve Éligible ({formatDZD(mathState.calculatedTotal)})</span>
              </>
            ) : !mathState.isBalanced ? (
              <>
                <AlertTriangle className="w-3.5 h-3.5 text-rose-400" />
                <span>
                  🔴 Revue par Exception Requise (Δ{' '}
                  {mathState.delta > 0
                    ? `+${formatDZD(mathState.delta)}`
                    : `-${formatDZD(Math.abs(mathState.delta))}`}
                  )
                </span>
              </>
            ) : (
              <>
                <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
                <span>⚠️ Affectation Requise ({unassignedCount} restant{unassignedCount > 1 ? 's' : ''})</span>
              </>
            )}
          </div>
        </div>

        {/* Toolbar Controls */}
        <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-800/80 text-xs">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setExceptionsOnly(!exceptionsOnly)}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md transition cursor-pointer min-h-[32px] ${
                exceptionsOnly
                  ? 'bg-indigo-600 text-white'
                  : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
              }`}
            >
              <Filter className="w-3 h-3" />
              <span>
                Exceptions (
                {mathState.faultyRows.size + lines.filter((l) => !l.selected_product_id).length})
              </span>
            </button>

            {!mathState.isBalanced && (
              <button
                type="button"
                onClick={handleAutoBalance}
                className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-300 border border-emerald-500/40 text-[11px] font-bold cursor-pointer transition min-h-[32px] active:scale-95"
                title="Ajuste automatiquement les montants pour équilibrer la comptabilité"
              >
                <Wand2 className="w-3 h-3 text-emerald-400" />
                <span>Auto-Équilibrer Math</span>
              </button>
            )}

            <button
              type="button"
              onClick={handleAddLine}
              className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-300 text-[11px] font-medium cursor-pointer transition min-h-[32px]"
            >
              <Plus className="w-3 h-3" />
              <span>Ajouter une ligne</span>
            </button>
          </div>

          <span className="text-slate-400 font-mono text-[11px]">
            {lines.filter((l) => l.selected_product_id).length}/{lines.length} Assignés
          </span>
        </div>
      </header>

      {balanceSuccessNotice && (
        <div className="bg-emerald-950/80 border-l-4 border-emerald-500 text-emerald-200 text-xs p-2.5 mx-3 mt-2 rounded-xl flex items-center gap-2 shrink-0 animate-in fade-in">
          <Check className="w-4 h-4 text-emerald-400 shrink-0" />
          <span>{balanceSuccessNotice}</span>
        </div>
      )}

      {errorMessage && (
        <div className="bg-rose-950 border-l-4 border-rose-500 text-rose-200 text-xs p-3 mx-3 mt-3 rounded-xl shrink-0">
          {errorMessage}
        </div>
      )}

      {/* 2. CARD VIEWPORT */}
      <main className="flex-1 overflow-y-auto p-3 space-y-3 pb-24">
        {visibleLines.map((line) => {
          const fault = mathState.faultyRows.get(line.client_id);
          const isFaultyMath = !!fault;
          const isUnassigned = !line.selected_product_id;

          return (
            <div
              key={line.client_id}
              className={`rounded-2xl border p-3.5 bg-slate-900 transition-all ${
                isFaultyMath
                  ? 'border-rose-500 shadow-rose-950/20 shadow-md'
                  : isUnassigned
                    ? 'border-amber-500/80'
                    : 'border-slate-800'
              }`}
            >
              {/* Context Pill, Status Flag & Delete Action */}
              <div className="flex justify-between items-center mb-2 gap-2">
                <span className="text-[10px] font-mono bg-slate-950 text-slate-400 px-2 py-0.5 rounded border border-slate-800 truncate max-w-[240px]">
                  {line.raw_description}
                </span>

                <div className="flex items-center gap-2 shrink-0">
                  {isFaultyMath && fault && (
                    <span className="text-[10px] font-bold text-rose-400 bg-rose-950/80 px-2 py-0.5 rounded border border-rose-800">
                      Écart : attendu {formatDZD(fault.expected)} (reçu {formatDZD(fault.actual)})
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => handleDeleteLine(line.client_id)}
                    className="p-1 rounded-md text-slate-400 hover:text-rose-400 hover:bg-rose-950/30 transition cursor-pointer"
                    title="Supprimer cette ligne"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              {/* Product Match Dropdown with Complete Catalog Fallback */}
              <div className="mb-3">
                <select
                  value={line.selected_product_id ?? ''}
                  onChange={(e) => {
                    const pid = e.target.value || null;
                    const matched = line.candidates.find((c) => c.id === pid);
                    const catalogItem = catalogOptions.find((c) => c.id === pid);
                    const resolvedCost = matched
                      ? matched.current_cost
                      : catalogItem && catalogItem.cost > 0
                        ? catalogItem.cost
                        : line.unit_cost;

                    updateLine(line.client_id, {
                      selected_product_id: pid,
                      unit_cost: resolvedCost,
                    });
                  }}
                  className="w-full bg-slate-950 border border-slate-700 rounded-xl px-2.5 py-2 text-xs text-white focus:outline-none focus:border-indigo-500"
                >
                  <option value="">-- Sélectionner dans le catalogue --</option>
                  {line.candidates.length > 0 && (
                    <optgroup label="Suggestions IA / OCR">
                      {line.candidates.map((c) => (
                        <option key={`cand_${c.id}`} value={c.id}>
                          [{Math.round((1.0 - c.distance) * 100)}%] {c.sku} - {c.name}
                          {c.current_cost > 0 ? ` (${formatDZD(c.current_cost)})` : ''}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  <optgroup label="Tous les produits du catalogue">
                    {catalogOptions.map((c) => (
                      <option key={`cat_${c.id}`} value={c.id}>
                        {c.sku ? `[${c.sku}] ` : ''}{c.name}
                        {c.cost > 0 ? ` (${formatDZD(c.cost)})` : ''}
                      </option>
                    ))}
                  </optgroup>
                </select>
              </div>

              {/* Editable Numeric Inputs */}
              <div className="grid grid-cols-3 gap-2 mb-2">
                <div>
                  <label className="text-[9px] font-medium text-slate-400 uppercase">Quantité</label>
                  <input
                    type="number"
                    inputMode="decimal"
                    value={line.quantity}
                    onChange={(e) =>
                      updateLine(line.client_id, { quantity: parseFloat(e.target.value) || 0 })
                    }
                    className="w-full bg-slate-950 border border-slate-700 rounded-xl px-2 py-1.5 text-xs text-white text-center font-mono focus:border-indigo-500"
                  />
                </div>
                <div>
                  <label className="text-[9px] font-medium text-slate-400 uppercase">
                    Prix Achat (DA)
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    inputMode="decimal"
                    value={line.unit_cost}
                    onChange={(e) =>
                      updateLine(line.client_id, { unit_cost: parseFloat(e.target.value) || 0 })
                    }
                    className="w-full bg-slate-950 border border-slate-700 rounded-xl px-2 py-1.5 text-xs text-white text-center font-mono focus:border-indigo-500"
                  />
                </div>
                <div>
                  <label className="text-[9px] font-medium text-slate-400 uppercase">
                    Total Ligne (DA)
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    inputMode="decimal"
                    value={line.line_total}
                    onChange={(e) =>
                      updateLine(line.client_id, { line_total: parseFloat(e.target.value) || 0 })
                    }
                    className={`w-full bg-slate-950 border rounded-xl px-2 py-1.5 text-xs text-center font-mono focus:border-indigo-500 ${
                      isFaultyMath ? 'border-rose-500 text-rose-300' : 'border-slate-700 text-white'
                    }`}
                  />
                </div>
              </div>

              {/* Alias Persistence */}
              <label className="flex items-center gap-2 pt-1 text-[11px] text-slate-400 cursor-pointer">
                <input
                  type="checkbox"
                  checked={line.save_alias}
                  onChange={(e) => updateLine(line.client_id, { save_alias: e.target.checked })}
                  className="rounded border-slate-700 bg-slate-950 text-indigo-600 focus:ring-0"
                />
                <span>Mémoriser cette correspondance pour les prochains scans</span>
              </label>
            </div>
          );
        })}
      </main>

      {/* 3. STICKY ACTION BAR */}
      <footer className="sticky bottom-0 inset-x-0 bg-slate-900/95 backdrop-blur-md border-t border-slate-800 p-3 sm:p-4 flex flex-col sm:flex-row items-center justify-between gap-3 shadow-2xl shrink-0">
        <div className="flex items-center gap-3 w-full sm:w-auto justify-between sm:justify-start">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-xs font-semibold text-slate-400 hover:text-white cursor-pointer"
          >
            Annuler
          </button>
          {!mathState.isBalanced && (
            <span className="text-[11px] text-rose-400 font-medium">
              Validation bloquée par l'intégrité comptable
            </span>
          )}
        </div>

        <button
          onClick={handleCommit}
          disabled={!isAutoApproveEligible || isSubmitting}
          className="w-full sm:w-auto bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-800 disabled:text-slate-600 text-white text-xs font-bold uppercase tracking-wider px-5 py-2.5 rounded-xl shadow-lg flex items-center justify-center gap-2 active:scale-95 transition cursor-pointer"
        >
          {isSubmitting
            ? 'Enregistrement en cours…'
            : isAutoApproveEligible
              ? 'Valider la Réception en Stock (1-Clic)'
              : 'Validation Bloquée (Écarts Détectés)'}
          <ArrowRight className="w-3.5 h-3.5" />
        </button>
      </footer>
    </div>
  );
};
