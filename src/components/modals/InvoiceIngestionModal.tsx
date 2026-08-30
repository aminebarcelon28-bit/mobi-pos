import React, { useState, useRef } from 'react';
import { X, FileText, CheckCircle2, Upload, AlertCircle, Check, X as XIcon } from 'lucide-react';
import { usePosStore } from '../../store/usePosStore';

export const InvoiceIngestionModal: React.FC = () => {
  const { activeModal, closeModal, products, saveProduct } = usePosStore();
  const [rawText, setRawText] = useState<string>('');
  const [ingestStatus, setIngestStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [parsedLines, setParsedLines] = useState<{ sku: string; qty: number; cost?: number; imei?: string; matched: boolean }[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  if (activeModal !== 'invoice_ingestion') return null;

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      if (event.target?.result) {
        setRawText(event.target.result as string);
        setIngestStatus(null);
        setParsedLines([]);
      }
    };
    reader.onerror = () => {
      setIngestStatus({ type: 'error', message: 'Erreur lors de la lecture du fichier.' });
    };
    reader.readAsText(file);
  };

  const handleProcessIngestion = () => {
    try {
      const lines = rawText.split('\n').filter(line => line.trim() !== '');
      const newParsedLines: typeof parsedLines = [];

      lines.forEach((line) => {
        const delimiter = line.includes(';') ? ';' : line.includes('\t') ? '\t' : ',';
        const parts = line.split(delimiter).map((p) => p.trim().replace(/^["']|["']$/g, ''));
        if (parts.length >= 2) {
          const sku = parts[0];
          const rawQty = parts[1].replace(/[^\d-]/g, '');
          const qty = Math.max(0, parseInt(rawQty, 10) || 0);

          let cost: number | undefined = undefined;
          if (parts[2]) {
            const rawCost = parts[2].replace(/\s/g, '').replace(',', '.').replace(/[^\d.-]/g, '');
            const parsedCost = parseFloat(rawCost);
            if (!isNaN(parsedCost) && parsedCost >= 0) {
              cost = parsedCost;
            }
          }

          const imei = parts[3] ? parts[3].trim() : undefined;

          const existing = products.find((p) => p.sku.toLowerCase() === sku.toLowerCase() || p.barcode.toLowerCase() === sku.toLowerCase());
          if (existing && qty > 0) {
            saveProduct({
              ...existing,
              stock: existing.stock + qty,
              costPrice: cost !== undefined ? cost : existing.costPrice,
            });
            newParsedLines.push({ sku, qty, cost, imei, matched: true });
          } else {
            newParsedLines.push({ sku, qty, cost, imei, matched: false });
          }
        }
      });

      setParsedLines(newParsedLines);
      
      const matchedCount = newParsedLines.filter(l => l.matched).length;
      const unmatchedCount = newParsedLines.length - matchedCount;

      setIngestStatus({ 
        type: 'success', 
        message: `Succès ! ${matchedCount} références mises à jour. ${unmatchedCount} non trouvées.` 
      });
    } catch {
      setIngestStatus({ type: 'error', message: 'Erreur lors du traitement des données.' });
    }
  };

  const triggerFileInput = () => {
    fileInputRef.current?.click();
  };

  const matchedCount = parsedLines.filter(l => l.matched).length;
  const unmatchedCount = parsedLines.length - matchedCount;

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4 select-none">
      <div className="bg-pos-panel border border-pos-border rounded-2xl w-full max-w-2xl overflow-hidden shadow-2xl animate-in fade-in zoom-in-95 flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="p-4 border-b border-pos-border flex items-center justify-between bg-pos-card shrink-0">
          <div className="flex items-center gap-2 text-emerald-400">
            <FileText className="w-5 h-5" />
            <h2 className="text-sm font-bold text-pos-text">
              Ingestion Automatique de Facture Fournisseur
            </h2>
          </div>
          <button onClick={closeModal} className="p-1 hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-lg">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Form Body */}
        <div className="p-5 space-y-4 overflow-y-auto">
          <div className="flex justify-between items-start">
            <p className="text-xs text-pos-muted max-w-md">
              Collez le texte ou importez un fichier CSV/TXT (Format: <code className="text-emerald-400">SKU, Quantité, PrixAchat, IMEI (optionnel)</code>) pour incrémenter directement les stocks.
            </p>
            <input
              type="file"
              accept=".csv,.txt"
              className="hidden"
              ref={fileInputRef}
              onChange={handleFileUpload}
            />
            <button
              onClick={triggerFileInput}
              className="px-3 py-1.5 rounded-lg bg-pos-card border border-pos-border hover:border-emerald-500 text-pos-text text-xs font-semibold flex items-center gap-1.5 transition-colors"
            >
              <Upload className="w-4 h-4" /> Importer Fichier
            </button>
          </div>

          <textarea
            rows={6}
            value={rawText}
            onChange={(e) => {
              setRawText(e.target.value);
              setIngestStatus(null);
            }}
            placeholder="Ex: SKU-123, 10, 1500, IMEI-987654321..."
            className="w-full bg-pos-bg border border-pos-border rounded-xl p-3 text-xs font-mono text-pos-text focus:border-emerald-400 focus:outline-none placeholder-pos-muted/50"
          />

          {ingestStatus && (
            <div className={`p-3 border rounded-xl text-xs flex items-center gap-2 ${
              ingestStatus.type === 'success' 
                ? 'bg-emerald-950/40 border-emerald-500/40 text-emerald-300' 
                : 'bg-red-950/40 border-red-500/40 text-red-300'
            }`}>
              {ingestStatus.type === 'success' ? (
                <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-400" />
              ) : (
                <AlertCircle className="w-4 h-4 shrink-0 text-red-400" />
              )}
              <span>{ingestStatus.message}</span>
            </div>
          )}

          {parsedLines.length > 0 && (
            <div className="mt-4">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-semibold text-pos-text">Résultats d'analyse</h3>
                <div className="text-xs flex gap-3">
                  <span className="text-emerald-400">{matchedCount} trouvés</span>
                  <span className="text-red-400">{unmatchedCount} introuvables</span>
                </div>
              </div>
              <div className="bg-pos-bg rounded-xl border border-pos-border overflow-hidden">
                <div className="max-h-48 overflow-y-auto p-1">
                  <table className="w-full text-xs text-left">
                    <thead className="text-pos-muted sticky top-0 bg-pos-bg">
                      <tr>
                        <th className="px-3 py-2 font-medium">Statut</th>
                        <th className="px-3 py-2 font-medium">SKU</th>
                        <th className="px-3 py-2 font-medium">Qté</th>
                        <th className="px-3 py-2 font-medium">Prix</th>
                        <th className="px-3 py-2 font-medium">IMEI</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-pos-border/50">
                      {parsedLines.map((line, idx) => (
                        <tr key={idx} className={line.matched ? 'text-pos-text' : 'text-pos-muted'}>
                          <td className="px-3 py-2">
                            {line.matched ? (
                              <Check className="w-4 h-4 text-emerald-500" />
                            ) : (
                              <XIcon className="w-4 h-4 text-red-500" />
                            )}
                          </td>
                          <td className="px-3 py-2 font-mono">{line.sku}</td>
                          <td className="px-3 py-2">{line.qty}</td>
                          <td className="px-3 py-2">{line.cost || '-'}</td>
                          <td className="px-3 py-2 font-mono text-[10px]">{line.imei || '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="p-4 border-t border-pos-border bg-pos-card flex justify-end gap-2 shrink-0">
          <button onClick={closeModal} className="px-4 py-2 rounded-xl text-xs font-semibold text-pos-muted hover:text-pos-text transition-colors">
            Fermer
          </button>
          <button
            onClick={handleProcessIngestion}
            disabled={!rawText.trim()}
            className="px-5 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 disabled:cursor-not-allowed text-slate-950 font-bold text-xs flex items-center gap-1.5 shadow-lg shadow-emerald-500/20 transition-all"
          >
            <CheckCircle2 className="w-4 h-4" /> Ingestion & Mise à Jour
          </button>
        </div>
      </div>
    </div>
  );
};
