import React, { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import {
  CheckCircle2,
  AlertTriangle,
  ArrowRight,
  Wand2,
  Plus,
  Trash2,
  Check,
  Sparkles,
  PackagePlus,
  X,
  Search,
  Table as TableIcon,
  LayoutGrid,
  FileText,
  Printer,
  Download,
  Copy,
  CheckSquare,
  Square,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  FileJson,
  Tag,
  Zap,
  MessageSquareWarning,
} from 'lucide-react';
import { formatDZD, type CategoryType, type BrandName } from '../types/pos';
import { commitStockBatch } from '../api/po';
import { usePosStore } from '../store/usePosStore';
import { newId } from '../utils/ids';
import { utcNowIso } from '../utils/dateUtils';
import { extractScanAttributes } from '../utils/intelligentScanEngine';
import { printCoordinator } from '../utils/printCoordinator';
import { parseTextToBoundingBoxes } from '../utils/documentScanner';
import { generateVendorDisputeBrief, type DisputeBrief } from '../utils/disputeGenerator';
import { calculateBatchVelocity, type BatchVelocitySummary } from '../utils/stockVelocityEngine';
import { DocumentVisualHud } from './po/DocumentVisualHud';
import { VendorDisputeModal } from './po/VendorDisputeModal';

import { BarcodeStagingModal } from './po/BarcodeStagingModal';
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

type FilterTab = 'all' | 'unassigned' | 'faulty' | 'price_delta' | 'ai_suggestions' | 'loss_margin';
type ViewMode = 'cards' | 'table';
type SortField = 'index' | 'desc' | 'product' | 'qty' | 'cost' | 'selling' | 'margin' | 'total';
type SortDirection = 'asc' | 'desc';

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
  const saveProduct = usePosStore((state) => state.saveProduct);

  const [lines, setLines] = useState<EditableReviewLine[]>(() =>
    scanData.resolved_lines.map((l, idx) => {
      const defaultSelling = l.matched_product && l.matched_product.current_cost > 0
        ? Math.round(l.unit_cost * 1.35)
        : Math.round(l.unit_cost * 1.35);

      return {
        client_id: `line_${Date.now()}_${idx}`,
        raw_description: l.raw_description,
        quantity: l.quantity,
        unit_cost: l.unit_cost,
        line_total: l.line_total,
        selected_product_id: l.matched_product?.id ?? null,
        match_tier: l.match_tier,
        save_alias: l.match_tier !== 'tier1exactalias',
        candidates: l.candidate_suggestions,
        selling_price: defaultSelling,
      };
    })
  );

  const [grandTotalState, setGrandTotalState] = useState<number>(() =>
    reportedGrandTotal > 0
      ? reportedGrandTotal
      : Math.round(scanData.invariant_report.calculated_grand_total * 100) / 100
  );

  // Pro Toolbar, Sorting & Filter State
  const [viewMode, setViewMode] = useState<ViewMode>('cards');
  const [activeFilterTab, setActiveFilterTab] = useState<FilterTab>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [showOcrInspector, setShowOcrInspector] = useState(false);
  const [selectedLineIds, setSelectedLineIds] = useState<Set<string>>(new Set());
  const [sortField, setSortField] = useState<SortField>('index');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [hoveredLineId, setHoveredLineId] = useState<string | null>(null);
  const [ocrInspectorTab, setOcrInspectorTab] = useState<'visual' | 'text'>('visual');
  const [showDisputeModal, setShowDisputeModal] = useState<boolean>(false);
  const [showBarcodeModal, setShowBarcodeModal] = useState<boolean>(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Status & Feedback
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [balanceSuccessNotice, setBalanceSuccessNotice] = useState<string | null>(null);

  // Quick Product Creation state
  const [creatingForLine, setCreatingForLine] = useState<EditableReviewLine | null>(null);
  const [quickTitle, setQuickTitle] = useState('');
  const [quickBarcode, setQuickBarcode] = useState('');
  const [quickSku, setQuickSku] = useState('');
  const [quickCategory, setQuickCategory] = useState<CategoryType>('Chargeurs');
  const [quickCost, setQuickCost] = useState(0);
  const [quickPrice, setQuickPrice] = useState(0);
  const [isQuickSaving, setIsQuickSaving] = useState(false);
  const [quickError, setQuickError] = useState<string | null>(null);

  // Full catalog memo for unconstrained assignment
  const catalogOptions = useMemo(() => {
    return products
      .filter((p) => p.isActive !== false)
      .map((p) => ({
        id: p.id,
        sku: p.sku || p.barcode || '',
        name: p.title || 'Produit',
        cost: p.costPrice || 0,
        price: p.price || 0,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [products]);

  // Catalog Lookup Map for instant O(1) matching in dispute & barcode engine
  const catalogLookupMap = useMemo(() => {
    return new Map(
      products.map((p) => [
        p.id,
        {
          id: p.id,
          name: p.title || 'Produit',
          sku: p.sku || p.barcode || '',
          price: p.price || 0,
          cost: p.costPrice || 0,
        },
      ])
    );
  }, [products]);

  // Client-side real-time invariant evaluation (strict tolerance <= 0.01 DA)
  const mathState = useMemo(() => {
    let subtotal = 0;
    const faultyRows = new Map<string, { expected: number; actual: number }>();

    lines.forEach((line) => {
      const q = Number.isFinite(line.quantity) ? Math.max(0, line.quantity) : 0;
      const c = Number.isFinite(line.unit_cost) ? Math.max(0, line.unit_cost) : 0;
      const t = Number.isFinite(line.line_total) ? Math.max(0, line.line_total) : 0;

      const expected = Math.round(q * c * 100) / 100;
      const actual = Math.round(t * 100) / 100;
      if (Math.abs(expected - actual) > 0.01 || q <= 0) {
        faultyRows.set(line.client_id, { expected, actual });
      }
      subtotal += actual;
    });

    const calculatedTotal = Math.round((subtotal + reportedTax + reportedFreight) * 100) / 100;
    const targetTotal = grandTotalState > 0 ? grandTotalState : calculatedTotal;
    const delta = Math.round((calculatedTotal - targetTotal) * 100) / 100;
    const isBalanced = Math.abs(delta) <= 0.01 && faultyRows.size === 0 && lines.length > 0;

    return { subtotal, calculatedTotal, targetTotal, delta, isBalanced, faultyRows };
  }, [lines, reportedTax, reportedFreight, grandTotalState]);

  // Financial Analytics & Projected Margin
  const financialAnalytics = useMemo(() => {
    let totalSellingValue = 0;
    let totalQuantity = 0;

    lines.forEach((l) => {
      const catProd = catalogOptions.find((c) => c.id === l.selected_product_id);
      const sellPrice = l.selling_price && l.selling_price > 0
        ? l.selling_price
        : catProd && catProd.price > 0
          ? catProd.price
          : Math.round(l.unit_cost * 1.35);

      totalSellingValue += l.quantity * sellPrice;
      totalQuantity += l.quantity;
    });

    const grossProfit = Math.round((totalSellingValue - mathState.subtotal) * 100) / 100;
    const marginRate = totalSellingValue > 0
      ? Math.round((grossProfit / totalSellingValue) * 1000) / 10
      : 0;

    return {
      totalSellingValue,
      totalQuantity,
      grossProfit,
      marginRate,
    };
  }, [lines, mathState.subtotal, catalogOptions]);

  // Predictive Stock Absorption & Dynamic Pricing Engine
  const velocitySummary = useMemo<BatchVelocitySummary>(() => {
    return calculateBatchVelocity(lines, products);
  }, [lines, products]);

  // Autonomous Vendor Dispute & Negotiation Defense Brief
  const disputeBrief = useMemo<DisputeBrief>(() => {
    return generateVendorDisputeBrief({
      supplierName,
      reportedGrandTotal: mathState.targetTotal,
      subtotal: mathState.subtotal,
      mathDelta: mathState.delta,
      faultyRows: mathState.faultyRows,
      lines,
      catalogMap: catalogLookupMap,
    });
  }, [supplierName, mathState, lines, catalogLookupMap]);

  // Synchronized bounding boxes for the visual spatial HUD
  const displayBoundingBoxes = useMemo(() => {
    if (scanData.bounding_boxes && scanData.bounding_boxes.length > 0) {
      return scanData.bounding_boxes;
    }
    const textBlob = lines.map((l) => `${l.raw_description} ${l.quantity}x ${l.unit_cost} ${l.line_total}`).join('\n');
    return parseTextToBoundingBoxes(textBlob);
  }, [scanData.bounding_boxes, lines]);

  const unassignedCount = useMemo(
    () => lines.filter((l) => !l.selected_product_id).length,
    [lines]
  );
  const invalidQtyCount = useMemo(
    () => lines.filter((l) => l.quantity <= 0).length,
    [lines]
  );
  const isAutoApproveEligible = mathState.isBalanced && unassignedCount === 0 && invalidQtyCount === 0;

  // Lines eligible for AI match
  const highConfidenceLines = useMemo(() => {
    return lines.filter(
      (l) => !l.selected_product_id && l.candidates.length > 0 && l.candidates[0].distance <= 0.15
    );
  }, [lines]);

  // Cost variance lines
  const costVarianceLines = useMemo(() => {
    return lines.filter((l) => {
      if (!l.selected_product_id) return false;
      const cat = catalogOptions.find((c) => c.id === l.selected_product_id);
      if (!cat || !cat.cost || cat.cost <= 0) return false;
      return Math.abs(l.unit_cost - cat.cost) > 0.01;
    });
  }, [lines, catalogOptions]);

  // Loss margin lines (selling price <= unit cost)
  const lossLines = useMemo(() => {
    return lines.filter(
      (l) => l.unit_cost > 0 && l.selling_price !== undefined && l.selling_price <= l.unit_cost
    );
  }, [lines]);

  const handleToggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
  };

  const handleSetLineMarkup = (id: string, markupPct: number) => {
    setLines((prev) =>
      prev.map((l) => {
        if (l.client_id !== id) return l;
        return {
          ...l,
          selling_price: Math.round(l.unit_cost * (1 + markupPct / 100)),
        };
      })
    );
  };

  // 1-Click Velocity-Driven Dynamic Pricing application across all lines
  const handleApplyDynamicPricing = () => {
    let applied = 0;
    setLines((prev) =>
      prev.map((l) => {
        const vel = velocitySummary.lines.get(l.client_id);
        if (vel && vel.suggestedSellingPrice > 0) {
          applied++;
          return {
            ...l,
            selling_price: vel.suggestedSellingPrice,
          };
        }
        return l;
      })
    );
    setBalanceSuccessNotice(`${applied} prix de vente dynamiques optimisés selon la vélocité.`);
    setTimeout(() => setBalanceSuccessNotice(null), 3500);
  };

  const updateLine = (id: string, updates: Partial<EditableReviewLine>) => {
    setLines((prev) =>
      prev.map((item) => {
        if (item.client_id !== id) return item;
        const next = { ...item, ...updates };
        if (updates.quantity !== undefined || updates.unit_cost !== undefined) {
          const q = Number.isFinite(next.quantity) ? Math.max(0, next.quantity) : 0;
          const c = Number.isFinite(next.unit_cost) ? Math.max(0, next.unit_cost) : 0;
          next.line_total = Math.round(q * c * 100) / 100;
          if (updates.unit_cost !== undefined && (!next.selling_price || updates.unit_cost > next.selling_price)) {
            next.selling_price = Math.round(next.unit_cost * 1.35);
          }
        } else if (updates.line_total !== undefined && next.quantity > 0) {
          const t = Number.isFinite(next.line_total) ? Math.max(0, next.line_total) : 0;
          next.unit_cost = Math.round((t / next.quantity) * 100) / 100;
        }
        return next;
      })
    );
  };

  const handleDeleteLine = (id: string) => {
    setLines((prev) => prev.filter((l) => l.client_id !== id));
    setSelectedLineIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };

  const handleDuplicateLine = (line: EditableReviewLine) => {
    const halfQty = Math.max(1, Math.floor(line.quantity / 2));
    const remQty = Math.max(1, line.quantity - halfQty);

    setLines((prev) => {
      const idx = prev.findIndex((l) => l.client_id === line.client_id);
      if (idx === -1) return prev;

      const updatedOrig: EditableReviewLine = {
        ...line,
        quantity: halfQty,
        line_total: Math.round(halfQty * line.unit_cost * 100) / 100,
      };

      const newLine: EditableReviewLine = {
        ...line,
        client_id: `line_split_${Date.now()}`,
        quantity: remQty,
        line_total: Math.round(remQty * line.unit_cost * 100) / 100,
      };

      const copy = [...prev];
      copy.splice(idx, 1, updatedOrig, newLine);
      return copy;
    });

    setBalanceSuccessNotice('Ligne dédoublée avec répartition des quantités.');
    setTimeout(() => setBalanceSuccessNotice(null), 3000);
  };

  const handleAddLine = () => {
    const newLine: EditableReviewLine = {
      client_id: `line_manual_${Date.now()}`,
      raw_description: 'Nouvel article facture',
      quantity: 1,
      unit_cost: 0,
      line_total: 0,
      selected_product_id: null,
      match_tier: 'tier3unmatched',
      save_alias: false,
      candidates: [],
      selling_price: 0,
    };
    setLines((prev) => [...prev, newLine]);
  };

  // 1-Click Batch AI Match Application
  const handleApplyAllAiMatches = () => {
    let appliedCount = 0;
    setLines((prev) =>
      prev.map((line) => {
        if (line.selected_product_id || line.candidates.length === 0) return line;
        const topCandidate = line.candidates[0];
        if (topCandidate.distance <= 0.15) {
          appliedCount++;
          const catalogItem = catalogOptions.find((c) => c.id === topCandidate.id);
          const resolvedCost =
            topCandidate.current_cost > 0
              ? topCandidate.current_cost
              : catalogItem && catalogItem.cost > 0
                ? catalogItem.cost
                : line.unit_cost;
          return {
            ...line,
            selected_product_id: topCandidate.id,
            unit_cost: resolvedCost,
            line_total: Math.round(line.quantity * resolvedCost * 100) / 100,
            match_tier: 'tier2highconfidence',
            save_alias: true,
          };
        }
        return line;
      })
    );

    if (appliedCount > 0) {
      setBalanceSuccessNotice(`${appliedCount} correspondance(s) IA appliquée(s) en 1-clic.`);
      setTimeout(() => setBalanceSuccessNotice(null), 4000);
    }
  };

  // 1-Tap Auto-Balance
  const handleAutoBalance = useCallback(() => {
    let newSubtotal = 0;
    const updated = lines.map((line) => {
      let qty = Number.isFinite(line.quantity) ? Math.max(0, line.quantity) : 1;
      let unitCost = Number.isFinite(line.unit_cost) ? Math.max(0, line.unit_cost) : 0;
      let lineTotal = Number.isFinite(line.line_total) ? Math.max(0, line.line_total) : 0;

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
  }, [lines, reportedTax, reportedFreight]);

  // Bulk Actions
  const handleToggleSelectAll = () => {
    if (selectedLineIds.size === visibleLines.length) {
      setSelectedLineIds(new Set());
    } else {
      setSelectedLineIds(new Set(visibleLines.map((l) => l.client_id)));
    }
  };

  const handleToggleSelectLine = (id: string) => {
    setSelectedLineIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleBulkApplyAi = () => {
    let count = 0;
    setLines((prev) =>
      prev.map((l) => {
        if (!selectedLineIds.has(l.client_id) || l.selected_product_id || l.candidates.length === 0) {
          return l;
        }
        const top = l.candidates[0];
        count++;
        const cat = catalogOptions.find((c) => c.id === top.id);
        const resolved = top.current_cost > 0 ? top.current_cost : cat?.cost || l.unit_cost;
        return {
          ...l,
          selected_product_id: top.id,
          unit_cost: resolved,
          line_total: Math.round(l.quantity * resolved * 100) / 100,
          match_tier: 'tier2highconfidence',
          save_alias: true,
        };
      })
    );
    setSelectedLineIds(new Set());
    setBalanceSuccessNotice(`${count} ligne(s) sélectionnée(s) affectée(s) par l'IA.`);
    setTimeout(() => setBalanceSuccessNotice(null), 4000);
  };

  const handleBulkSetMargin = (markupPercent: number) => {
    setLines((prev) =>
      prev.map((l) => {
        if (!selectedLineIds.has(l.client_id)) return l;
        const multiplier = 1 + markupPercent / 100;
        return {
          ...l,
          selling_price: Math.round(l.unit_cost * multiplier),
        };
      })
    );
    setBalanceSuccessNotice(`Marge de +${markupPercent}% appliquée à la sélection.`);
    setTimeout(() => setBalanceSuccessNotice(null), 3000);
  };

  const handleBulkBalanceSelected = () => {
    setLines((prev) =>
      prev.map((l) => {
        if (!selectedLineIds.has(l.client_id)) return l;
        const q = Math.max(0, l.quantity);
        const c = Math.max(0, l.unit_cost);
        return {
          ...l,
          line_total: Math.round(q * c * 100) / 100,
        };
      })
    );
    setBalanceSuccessNotice(`${selectedLineIds.size} ligne(s) sélectionnée(s) recalculée(s).`);
    setTimeout(() => setBalanceSuccessNotice(null), 3000);
  };

  const handleBulkDelete = () => {
    if (!confirm(`Supprimer les ${selectedLineIds.size} article(s) sélectionné(s) ?`)) return;
    setLines((prev) => prev.filter((l) => !selectedLineIds.has(l.client_id)));
    setSelectedLineIds(new Set());
  };

  // Bulk Auto-Create All Unassigned Lines
  const handleBulkAutoCreateUnmatched = async () => {
    const unassigned = lines.filter((l) => !l.selected_product_id);
    if (unassigned.length === 0) return;

    let createdCount = 0;
    for (const line of unassigned) {
      const ext = extractScanAttributes(line.raw_description);
      const targetId = newId('prod');
      const title = ext.clean_title || line.raw_description;
      const lower = title.toLowerCase();

      let cat: CategoryType = 'Chargeurs';
      if (lower.includes('cable') || lower.includes('câble')) cat = 'Câbles';
      else if (lower.includes('verre') || lower.includes('film') || lower.includes('ecran') || lower.includes('écran')) cat = 'Protège-Écran';
      else if (lower.includes('etui') || lower.includes('étui') || lower.includes('coque')) {
        cat = lower.includes('sams') || lower.includes('s24') || lower.includes('s23') ? 'Coques Samsung' : 'Coques iPhone';
      }

      const cost = line.unit_cost || 0;
      const sell = cost > 0 ? Math.round(cost * 1.35) : 0;

      const res = await saveProduct(
        {
          id: targetId,
          title,
          barcode: ext.barcode || '',
          sku: ext.sku || `SKU-${Date.now().toString().slice(-6)}`,
          brand: 'Autre' as BrandName,
          compatibleModel: '',
          category: cat,
          costPrice: cost,
          price: sell,
          wholesalePrice: sell,
          stock: 0,
          vendorName: supplierName || 'Fournisseur',
          leadTimeDays: 0,
          dailySalesVelocity: 0,
          reorderPoint: 0,
        },
        { keepModalOpen: true }
      );

      if (res.success) {
        createdCount++;
        updateLine(line.client_id, {
          selected_product_id: targetId,
          unit_cost: cost,
          selling_price: sell,
          line_total: Math.round(line.quantity * cost * 100) / 100,
          match_tier: 'tier1exactalias',
          save_alias: true,
        });
      }
    }

    setBalanceSuccessNotice(`${createdCount} nouveaux produits créés et affectés automatiquement.`);
    setTimeout(() => setBalanceSuccessNotice(null), 4000);
  };

  // Open Quick Product Creation Modal
  const handleOpenQuickCreate = (line: EditableReviewLine) => {
    const extracted = extractScanAttributes(line.raw_description);
    setCreatingForLine(line);
    setQuickTitle(extracted.clean_title || line.raw_description);
    setQuickBarcode(extracted.barcode || '');
    setQuickSku(extracted.sku || `SKU-${Date.now().toString().slice(-6)}`);

    const lowerDesc = line.raw_description.toLowerCase();
    let detectedCat: CategoryType = 'Chargeurs';
    if (lowerDesc.includes('cable') || lowerDesc.includes('câble')) {
      detectedCat = 'Câbles';
    } else if (lowerDesc.includes('verre') || lowerDesc.includes('film') || lowerDesc.includes('ecran') || lowerDesc.includes('écran')) {
      detectedCat = 'Protège-Écran';
    } else if (lowerDesc.includes('etui') || lowerDesc.includes('étui') || lowerDesc.includes('coque')) {
      detectedCat = lowerDesc.includes('sams') || lowerDesc.includes('s24') || lowerDesc.includes('s23') ? 'Coques Samsung' : 'Coques iPhone';
    }
    setQuickCategory(detectedCat);
    setQuickCost(line.unit_cost || 0);
    setQuickPrice(line.unit_cost > 0 ? Math.round(line.unit_cost * 1.35) : 0);
    setQuickError(null);
  };

  const handleSaveQuickProduct = async () => {
    if (!creatingForLine) return;
    if (!quickTitle.trim()) {
      setQuickError('La désignation du produit est obligatoire.');
      return;
    }

    try {
      setIsQuickSaving(true);
      setQuickError(null);

      const targetId = newId('prod');
      const result = await saveProduct(
        {
          id: targetId,
          title: quickTitle.trim(),
          barcode: quickBarcode.trim(),
          sku: quickSku.trim(),
          brand: 'Autre' as BrandName,
          compatibleModel: '',
          category: quickCategory,
          costPrice: quickCost,
          price: quickPrice,
          wholesalePrice: quickPrice,
          stock: 0,
          vendorName: supplierName || 'Fournisseur',
          leadTimeDays: 0,
          dailySalesVelocity: 0,
          reorderPoint: 0,
        },
        { keepModalOpen: true }
      );

      if (!result.success) {
        setQuickError(result.reason || 'Erreur lors de la création du produit.');
        return;
      }

      updateLine(creatingForLine.client_id, {
        selected_product_id: targetId,
        unit_cost: quickCost,
        selling_price: quickPrice,
        line_total: Math.round(creatingForLine.quantity * quickCost * 100) / 100,
        match_tier: 'tier1exactalias',
        save_alias: true,
      });

      setBalanceSuccessNotice(`Produit "${quickTitle.trim()}" créé et affecté avec succès.`);
      setTimeout(() => setBalanceSuccessNotice(null), 4000);
      setCreatingForLine(null);
    } catch (e: unknown) {
      setQuickError(e instanceof Error ? e.message : 'Erreur imprévue');
    } finally {
      setIsQuickSaving(false);
    }
  };

  // Export Table to CSV
  const handleExportCsv = () => {
    const headers = ['Description Source', 'Produit Catalogue', 'SKU', 'Quantite', 'Prix Achat DA', 'Prix Vente DA', 'Total Ligne DA'];
    const rows = lines.map((l) => {
      const cat = catalogOptions.find((c) => c.id === l.selected_product_id);
      return [
        `"${l.raw_description.replace(/"/g, '""')}"`,
        `"${(cat?.name || 'Non assigné').replace(/"/g, '""')}"`,
        `"${cat?.sku || ''}"`,
        l.quantity,
        l.unit_cost,
        l.selling_price || 0,
        l.line_total,
      ].join(';');
    });

    const csvContent = '\uFEFF' + [headers.join(';'), ...rows].join('\r\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `reconciliation_${supplierName.replace(/\s+/g, '_')}_${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  // Export structured payload to JSON
  const handleExportJson = () => {
    const exportPayload = {
      supplier: supplierName,
      exported_at: utcNowIso(),
      reported_tax: reportedTax,
      reported_freight: reportedFreight,
      target_grand_total: mathState.targetTotal,
      calculated_grand_total: mathState.calculatedTotal,
      delta: mathState.delta,
      is_balanced: mathState.isBalanced,
      lines: lines.map((l) => {
        const cat = catalogOptions.find((c) => c.id === l.selected_product_id);
        return {
          description: l.raw_description,
          matched_product_id: l.selected_product_id,
          matched_product_name: cat?.name || null,
          sku: cat?.sku || null,
          quantity: l.quantity,
          unit_cost: l.unit_cost,
          selling_price: l.selling_price || 0,
          line_total: l.line_total,
          match_tier: l.match_tier,
        };
      }),
    };
    const jsonBlob = new Blob([JSON.stringify(exportPayload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(jsonBlob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `reconciliation_${supplierName.replace(/\s+/g, '_')}_${Date.now()}.json`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    setBalanceSuccessNotice('Exportation JSON ERP téléchargée avec succès.');
    setTimeout(() => setBalanceSuccessNotice(null), 3000);
  };

  // Print Summary
  const handlePrintReview = () => {
    printCoordinator.printPurchaseOrder(80);
    setBalanceSuccessNotice('Impression du bon de réconciliation lancée.');
    setTimeout(() => setBalanceSuccessNotice(null), 3000);
  };

  const handleCommit = useCallback(async () => {
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
  }, [mathState.isBalanced, invalidQtyCount, unassignedCount, supplierName, activeShift?.cashierName, lines, onCommitSuccess]);

  // Keyboard Shortcuts (Ctrl+Enter to Commit, Ctrl+B to Auto-Balance)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        if (isAutoApproveEligible && !isSubmitting) {
          e.preventDefault();
          handleCommit();
        }
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        handleAutoBalance();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isAutoApproveEligible, isSubmitting, handleAutoBalance, handleCommit]);

  // Filtering, Search & Sorting
  const visibleLines = useMemo(() => {
    const filtered = lines.filter((l) => {
      // 1. Search Query
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase().trim();
        const descMatch = l.raw_description.toLowerCase().includes(q);
        const cat = catalogOptions.find((c) => c.id === l.selected_product_id);
        const nameMatch = cat?.name.toLowerCase().includes(q);
        const skuMatch = cat?.sku.toLowerCase().includes(q);
        if (!descMatch && !nameMatch && !skuMatch) return false;
      }

      // 2. Tab Filter
      if (activeFilterTab === 'unassigned') return !l.selected_product_id;
      if (activeFilterTab === 'faulty') return mathState.faultyRows.has(l.client_id);
      if (activeFilterTab === 'price_delta') {
        if (!l.selected_product_id) return false;
        const cat = catalogOptions.find((c) => c.id === l.selected_product_id);
        return Boolean(cat && cat.cost > 0 && Math.abs(l.unit_cost - cat.cost) > 0.01);
      }
      if (activeFilterTab === 'ai_suggestions') {
        return !l.selected_product_id && l.candidates.length > 0 && l.candidates[0].distance <= 0.15;
      }
      if (activeFilterTab === 'loss_margin') {
        return l.unit_cost > 0 && l.selling_price !== undefined && l.selling_price <= l.unit_cost;
      }

      return true;
    });

    if (sortField === 'index') {
      return sortDirection === 'asc' ? filtered : [...filtered].reverse();
    }

    return [...filtered].sort((a, b) => {
      let cmp = 0;
      if (sortField === 'desc') {
        cmp = a.raw_description.localeCompare(b.raw_description);
      } else if (sortField === 'product') {
        const nameA = catalogOptions.find((c) => c.id === a.selected_product_id)?.name || '';
        const nameB = catalogOptions.find((c) => c.id === b.selected_product_id)?.name || '';
        cmp = nameA.localeCompare(nameB);
      } else if (sortField === 'qty') {
        cmp = a.quantity - b.quantity;
      } else if (sortField === 'cost') {
        cmp = a.unit_cost - b.unit_cost;
      } else if (sortField === 'selling') {
        const sellA = a.selling_price || 0;
        const sellB = b.selling_price || 0;
        cmp = sellA - sellB;
      } else if (sortField === 'margin') {
        const sellA = a.selling_price || Math.round(a.unit_cost * 1.35);
        const marginA = sellA > 0 ? (sellA - a.unit_cost) / sellA : 0;
        const sellB = b.selling_price || Math.round(b.unit_cost * 1.35);
        const marginB = sellB > 0 ? (sellB - b.unit_cost) / sellB : 0;
        cmp = marginA - marginB;
      } else if (sortField === 'total') {
        cmp = a.line_total - b.line_total;
      }
      return sortDirection === 'asc' ? cmp : -cmp;
    });
  }, [lines, searchQuery, activeFilterTab, catalogOptions, mathState.faultyRows, sortField, sortDirection]);

  // Reconciliation percentage
  const reconciledPercent = lines.length > 0
    ? Math.round(((lines.length - unassignedCount) / lines.length) * 100)
    : 100;

  return (
    <div className="flex flex-col h-full max-h-[96dvh] bg-slate-950 text-slate-100 font-sans relative select-none">
      {/* 1. EXECUTIVE FINANCIAL HEADER */}
      <header className="sticky top-0 z-30 bg-slate-900 border-b border-slate-800 p-3 sm:p-4 shadow-xl shrink-0">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-2.5">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-indigo-950 border border-indigo-800 text-indigo-300">
                Fournisseur
              </span>
              <h1 className="text-sm sm:text-base font-extrabold text-white uppercase tracking-wider truncate">
                {supplierName}
              </h1>
              <div className="hidden lg:flex items-center gap-1.5 text-[10px] text-slate-400 font-mono ml-2">
                <span className="bg-slate-800 px-1.5 py-0.5 rounded border border-slate-700">Ctrl+Enter: Valider</span>
                <span className="bg-slate-800 px-1.5 py-0.5 rounded border border-slate-700">Ctrl+B: Équilibrer</span>
                <span className="bg-slate-800 px-1.5 py-0.5 rounded border border-slate-700">Ctrl+F: Chercher</span>
              </div>
            </div>
            <p className="text-[11px] text-slate-400 mt-0.5 font-mono">
              TVA (19%) : {formatDZD(reportedTax)} | Port : {formatDZD(reportedFreight)} | Total Facture : {formatDZD(mathState.targetTotal)}
            </p>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <div
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold tracking-wide border transition-all ${
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

            {/* Dispute Trigger Button when discrepancies or price variations exist */}
            {(!mathState.isBalanced || costVarianceLines.length > 0) && (
              <button
                type="button"
                onClick={() => setShowDisputeModal(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold tracking-wide border transition-all cursor-pointer bg-rose-950/90 border-rose-500/80 text-rose-300 hover:bg-rose-900 active:scale-95 shadow-sm shadow-rose-950/40"
                title="Générer un dossier de litige et réclamation (WhatsApp & Avoir)"
              >
                <MessageSquareWarning className="w-3.5 h-3.5 text-rose-400" />
                <span>⚠️ Litige Fournisseur (Avoir)</span>
              </button>
            )}

            {/* Quick Export & Print Actions */}
            <div className="flex items-center gap-1 border-l border-slate-800 pl-2">
              <button
                type="button"
                onClick={() => setShowBarcodeModal(true)}
                className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition cursor-pointer"
                title="File d'attente étiquettes thermiques"
              >
                <Tag className="w-3.5 h-3.5 text-indigo-400" />
              </button>
              <button
                type="button"
                onClick={handlePrintReview}
                className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition cursor-pointer"
                title="Imprimer le bon de réception"
              >
                <Printer className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={handleExportCsv}
                className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition cursor-pointer"
                title="Exporter en CSV (Excel)"
              >
                <Download className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={handleExportJson}
                className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition cursor-pointer"
                title="Exporter en JSON (ERP / API)"
              >
                <FileJson className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>

        {/* Financial & Velocity KPI Dashboard Bar */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 mb-2.5 pt-2 border-t border-slate-800/80">
          <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-2 text-center">
            <span className="text-[9px] uppercase tracking-wider text-slate-400 font-bold block">Articles</span>
            <span className="text-xs font-mono font-bold text-white">
              {lines.length} lignes ({financialAnalytics.totalQuantity} pcs)
            </span>
          </div>
          <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-2 text-center">
            <span className="text-[9px] uppercase tracking-wider text-slate-400 font-bold block">Achat HT Total</span>
            <span className="text-xs font-mono font-bold text-slate-200">
              {formatDZD(mathState.subtotal)}
            </span>
          </div>
          <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-2 text-center">
            <span className="text-[9px] uppercase tracking-wider text-slate-400 font-bold block">Vente Estimée</span>
            <span className="text-xs font-mono font-bold text-indigo-300">
              {formatDZD(financialAnalytics.totalSellingValue)}
            </span>
          </div>
          <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-2 text-center">
            <span className="text-[9px] uppercase tracking-wider text-slate-400 font-bold block">Bénéfice Brut Estimé</span>
            <span className="text-xs font-mono font-bold text-emerald-400">
              +{formatDZD(financialAnalytics.grossProfit)} (+{financialAnalytics.marginRate}%)
            </span>
          </div>
          <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-2 text-center">
            <span className="text-[9px] uppercase tracking-wider text-slate-400 font-bold block">Écoulement Estimé</span>
            <span className="text-xs font-mono font-bold text-amber-300" title={`${velocitySummary.fastRunnerCount} rapides, ${velocitySummary.slowMovingCount} lentes`}>
              ~{velocitySummary.averageAbsorptionDays} jours
            </span>
          </div>
          <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-2 text-center">
            <span className="text-[9px] uppercase tracking-wider text-slate-400 font-bold block">Risque Trésorerie</span>
            <span className={`text-xs font-mono font-bold ${velocitySummary.capitalRiskIndex === 'FAIBLE' ? 'text-emerald-400' : velocitySummary.capitalRiskIndex === 'MODÉRÉ' ? 'text-amber-400' : 'text-rose-400'}`}>
              {velocitySummary.capitalRiskIndex} ({formatDZD(velocitySummary.totalCapitalCommitted)})
            </span>
          </div>
        </div>

        {/* Visual Progress Bar */}
        <div className="w-full bg-slate-950 rounded-full h-1.5 overflow-hidden flex mb-2.5">
          <div
            className="bg-emerald-500 h-full transition-all duration-300"
            style={{ width: `${reconciledPercent}%` }}
            title={`${reconciledPercent}% assigné`}
          />
          {unassignedCount > 0 && (
            <div
              className="bg-amber-500/80 h-full transition-all duration-300"
              style={{ width: `${(unassignedCount / lines.length) * 100}%` }}
              title={`${unassignedCount} non assigné(s)`}
            />
          )}
        </div>

        {/* Search, Tabs, and Mode Switcher */}
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
          {/* Filter Pills */}
          <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar py-0.5">
            <button
              onClick={() => setActiveFilterTab('all')}
              className={`px-2.5 py-1 rounded-lg text-[11px] font-bold cursor-pointer transition min-h-[30px] shrink-0 ${
                activeFilterTab === 'all'
                  ? 'bg-indigo-600 text-white shadow-xs'
                  : 'bg-slate-800 text-slate-400 hover:text-white'
              }`}
            >
              Tous ({lines.length})
            </button>
            <button
              onClick={() => setActiveFilterTab('unassigned')}
              className={`px-2.5 py-1 rounded-lg text-[11px] font-bold cursor-pointer transition min-h-[30px] shrink-0 ${
                activeFilterTab === 'unassigned'
                  ? 'bg-amber-600 text-white shadow-xs'
                  : 'bg-slate-800 text-slate-400 hover:text-amber-300'
              }`}
            >
              À affecter ({unassignedCount})
            </button>
            {mathState.faultyRows.size > 0 && (
              <button
                onClick={() => setActiveFilterTab('faulty')}
                className={`px-2.5 py-1 rounded-lg text-[11px] font-bold cursor-pointer transition min-h-[30px] shrink-0 ${
                  activeFilterTab === 'faulty'
                    ? 'bg-rose-600 text-white shadow-xs'
                    : 'bg-rose-950/60 border border-rose-800 text-rose-300'
                }`}
              >
                Erreurs Math ({mathState.faultyRows.size})
              </button>
            )}
            {costVarianceLines.length > 0 && (
              <button
                onClick={() => setActiveFilterTab('price_delta')}
                className={`px-2.5 py-1 rounded-lg text-[11px] font-bold cursor-pointer transition min-h-[30px] shrink-0 ${
                  activeFilterTab === 'price_delta'
                    ? 'bg-sky-600 text-white shadow-xs'
                    : 'bg-slate-800 text-slate-400 hover:text-sky-300'
                }`}
              >
                Écarts Prix ({costVarianceLines.length})
              </button>
            )}
            {highConfidenceLines.length > 0 && (
              <button
                onClick={() => setActiveFilterTab('ai_suggestions')}
                className={`px-2.5 py-1 rounded-lg text-[11px] font-bold cursor-pointer transition min-h-[30px] shrink-0 ${
                  activeFilterTab === 'ai_suggestions'
                    ? 'bg-purple-600 text-white shadow-xs'
                    : 'bg-purple-950/60 border border-purple-800 text-purple-300'
                }`}
              >
                Suggestions IA ({highConfidenceLines.length})
              </button>
            )}
            {lossLines.length > 0 && (
              <button
                onClick={() => setActiveFilterTab('loss_margin')}
                className={`px-2.5 py-1 rounded-lg text-[11px] font-bold cursor-pointer transition min-h-[30px] shrink-0 ${
                  activeFilterTab === 'loss_margin'
                    ? 'bg-rose-600 text-white shadow-xs'
                    : 'bg-rose-950/60 border border-rose-800 text-rose-300'
                }`}
              >
                Vente à Perte ({lossLines.length})
              </button>
            )}
          </div>

          {/* Quick Search & Layout Switcher */}
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                ref={searchInputRef}
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Filtrer... (Ctrl+F)"
                className="w-32 sm:w-44 bg-slate-950 border border-slate-700 rounded-lg pl-8 pr-2.5 py-1 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>

            <div className="flex items-center rounded-lg bg-slate-800 p-0.5 border border-slate-700">
              <button
                type="button"
                onClick={() => setViewMode('cards')}
                className={`p-1 rounded-md transition cursor-pointer ${
                  viewMode === 'cards' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white'
                }`}
                title="Vue Cartes"
              >
                <LayoutGrid className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={() => setViewMode('table')}
                className={`p-1 rounded-md transition cursor-pointer ${
                  viewMode === 'table' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white'
                }`}
                title="Vue Tableau Pro"
              >
                <TableIcon className="w-3.5 h-3.5" />
              </button>
            </div>

            <button
              type="button"
              onClick={() => setShowOcrInspector(!showOcrInspector)}
              className={`p-1.5 rounded-lg border text-xs font-semibold flex items-center gap-1 transition cursor-pointer ${
                showOcrInspector
                  ? 'bg-indigo-600 border-indigo-500 text-white'
                  : 'bg-slate-800 border-slate-700 text-slate-300 hover:text-white'
              }`}
              title="Inspecteur OCR & Document"
            >
              <FileText className="w-3.5 h-3.5 text-indigo-400" />
              <span className="hidden sm:inline">OCR</span>
            </button>
          </div>
        </div>

        {/* Global Toolbar Action Buttons */}
        <div className="flex flex-wrap items-center justify-between gap-2 pt-2 mt-2 border-t border-slate-800/80 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleToggleSelectAll}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-300 text-[11px] font-medium cursor-pointer transition min-h-[30px]"
            >
              {selectedLineIds.size === visibleLines.length && visibleLines.length > 0 ? (
                <CheckSquare className="w-3.5 h-3.5 text-indigo-400" />
              ) : (
                <Square className="w-3.5 h-3.5 text-slate-500" />
              )}
              <span>Sélectionner tout</span>
            </button>

            {highConfidenceLines.length > 0 && (
              <button
                type="button"
                onClick={handleApplyAllAiMatches}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-300 border border-indigo-500/40 text-[11px] font-bold cursor-pointer transition min-h-[30px] active:scale-95"
                title="Appliquer automatiquement les suggestions IA avec confiance ≥ 85%"
              >
                <Sparkles className="w-3.5 h-3.5 text-indigo-400" />
                <span>✨ Appliquer suggestions IA ({highConfidenceLines.length})</span>
              </button>
            )}

            {unassignedCount > 0 && (
              <button
                type="button"
                onClick={handleBulkAutoCreateUnmatched}
                className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-indigo-950/80 hover:bg-indigo-900 border border-indigo-700 text-indigo-200 text-[11px] font-semibold cursor-pointer transition min-h-[30px]"
                title="Créer automatiquement tous les articles non trouvés dans le catalogue"
              >
                <PackagePlus className="w-3.5 h-3.5 text-indigo-400" />
                <span>Auto-Créer Manquants ({unassignedCount})</span>
              </button>
            )}

            {!mathState.isBalanced && (
              <button
                type="button"
                onClick={handleAutoBalance}
                className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-300 border border-emerald-500/40 text-[11px] font-bold cursor-pointer transition min-h-[30px] active:scale-95"
                title="Ajuste automatiquement les montants pour équilibrer la comptabilité (Ctrl+B)"
              >
                <Wand2 className="w-3 h-3 text-emerald-400" />
                <span>Auto-Équilibrer Math</span>
              </button>
            )}

            <button
              type="button"
              onClick={handleApplyDynamicPricing}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-300 border border-emerald-500/40 text-[11px] font-bold cursor-pointer transition min-h-[30px] active:scale-95"
              title="Optimise automatiquement les prix de vente selon la vitesse d'écoulement et rotation de trésorerie"
            >
              <Zap className="w-3.5 h-3.5 text-emerald-400" />
              <span>⚡ Marges Dynamiques</span>
            </button>

            <button
              type="button"
              onClick={() => setShowBarcodeModal(true)}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-indigo-950/80 hover:bg-indigo-900 border border-indigo-700 text-indigo-200 text-[11px] font-bold cursor-pointer transition min-h-[30px]"
              title="Prépare et imprime la file d'étiquettes code-barres thermiques"
            >
              <Tag className="w-3.5 h-3.5 text-indigo-400" />
              <span>🏷️ Étiquettes Thermiques</span>
            </button>

            <button
              type="button"
              onClick={handleAddLine}
              className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-300 text-[11px] font-medium cursor-pointer transition min-h-[30px]"
            >
              <Plus className="w-3 h-3" />
              <span>Ajouter une ligne</span>
            </button>
          </div>

          <span className="text-slate-400 font-mono text-[11px]">
            {lines.length - unassignedCount}/{lines.length} Assignés ({reconciledPercent}%)
          </span>
        </div>
      </header>

      {/* FLOATING BULK ACTIONS BAR (When lines are selected) */}
      {selectedLineIds.size > 0 && (
        <div className="sticky top-[158px] sm:top-[168px] z-20 bg-indigo-950/95 border-y border-indigo-700 px-4 py-2 flex flex-wrap items-center justify-between gap-3 shadow-xl backdrop-blur-md animate-in slide-in-from-top-2">
          <div className="flex items-center gap-2">
            <span className="text-xs font-bold text-white font-mono bg-indigo-900 px-2 py-0.5 rounded border border-indigo-600">
              {selectedLineIds.size} sélectionné(s)
            </span>
            <button
              type="button"
              onClick={() => setSelectedLineIds(new Set())}
              className="text-[11px] text-indigo-300 hover:text-white underline cursor-pointer"
            >
              Désélectionner
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={handleBulkApplyAi}
              className="px-2.5 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-[11px] font-bold cursor-pointer transition active:scale-95"
            >
              ✨ IA Match
            </button>
            <button
              type="button"
              onClick={handleBulkBalanceSelected}
              className="px-2.5 py-1 rounded-lg bg-emerald-700/80 hover:bg-emerald-600 text-white text-[11px] font-bold cursor-pointer transition active:scale-95 flex items-center gap-1"
              title="Recalculer Total Ligne = Qté × P.U. pour les lignes sélectionnées"
            >
              <Wand2 className="w-3 h-3" />
              <span>Équilibrer Sélection</span>
            </button>
            <button
              type="button"
              onClick={() => handleBulkSetMargin(25)}
              className="px-2 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-[11px] font-semibold border border-slate-700 cursor-pointer transition"
            >
              +25%
            </button>
            <button
              type="button"
              onClick={() => handleBulkSetMargin(35)}
              className="px-2 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-[11px] font-semibold border border-slate-700 cursor-pointer transition"
            >
              +35%
            </button>
            <button
              type="button"
              onClick={() => handleBulkSetMargin(50)}
              className="px-2 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-[11px] font-semibold border border-slate-700 cursor-pointer transition"
            >
              +50%
            </button>
            <button
              type="button"
              onClick={() => handleBulkSetMargin(100)}
              className="px-2 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-[11px] font-semibold border border-slate-700 cursor-pointer transition"
            >
              +100%
            </button>
            <button
              type="button"
              onClick={handleBulkDelete}
              className="p-1 rounded-lg bg-rose-950 hover:bg-rose-900 border border-rose-800 text-rose-300 cursor-pointer transition"
              title="Supprimer la sélection"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

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

      {/* 2. MAIN VIEWPORT & SPLIT OCR INSPECTOR */}
      <div className="flex-1 flex overflow-hidden">
        {/* Lines Container */}
        <main className="flex-1 overflow-y-auto p-3 space-y-3 pb-24">
          {visibleLines.length === 0 && (
            <div className="flex flex-col items-center justify-center p-8 text-center bg-slate-900/50 rounded-2xl border border-slate-800 space-y-3">
              <p className="text-sm text-slate-400 font-medium">Aucun article ne correspond à votre filtre.</p>
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  className="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold"
                >
                  Effacer la recherche
                </button>
              )}
            </div>
          )}

          {/* VUE 1: CARTES DÉTAILLÉES */}
          {viewMode === 'cards' && visibleLines.map((line, index) => {
            const fault = mathState.faultyRows.get(line.client_id);
            const isFaultyMath = !!fault;
            const isUnassigned = !line.selected_product_id;
            const topCandidate = line.candidates.length > 0 ? line.candidates[0] : null;
            const topScorePct = topCandidate ? Math.round((1.0 - topCandidate.distance) * 100) : 0;
            const catalogItem = catalogOptions.find((c) => c.id === line.selected_product_id);
            const isSelected = selectedLineIds.has(line.client_id);
            const isHovered = hoveredLineId === line.client_id;
            const velocity = velocitySummary.lines.get(line.client_id);

            const sellPrice = line.selling_price || (catalogItem?.price ? catalogItem.price : Math.round(line.unit_cost * 1.35));
            const unitProfit = Math.max(0, sellPrice - line.unit_cost);
            const marginPct = sellPrice > 0 ? Math.round((unitProfit / sellPrice) * 100) : 0;
            const isLossMargin = line.unit_cost > 0 && line.selling_price !== undefined && line.selling_price <= line.unit_cost;

            return (
              <div
                key={line.client_id}
                onMouseEnter={() => setHoveredLineId(line.client_id)}
                onMouseLeave={() => setHoveredLineId(null)}
                className={`rounded-2xl border p-3.5 bg-slate-900 transition-all ${
                  isHovered
                    ? 'border-indigo-400 ring-2 ring-indigo-500/50 bg-slate-900/95 scale-[1.005]'
                    : isSelected
                      ? 'border-indigo-500 ring-1 ring-indigo-500 bg-slate-900/90'
                      : isFaultyMath
                        ? 'border-rose-500 shadow-rose-950/20 shadow-md'
                        : isUnassigned
                          ? 'border-amber-500/80'
                          : 'border-slate-800 hover:border-slate-700'
                }`}
              >
                {/* Context Pill, Status Flag & Actions */}
                <div className="flex justify-between items-center mb-2 gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <button
                      type="button"
                      onClick={() => handleToggleSelectLine(line.client_id)}
                      className="cursor-pointer text-slate-400 hover:text-white"
                    >
                      {isSelected ? (
                        <CheckSquare className="w-4 h-4 text-indigo-400" />
                      ) : (
                        <Square className="w-4 h-4 text-slate-600" />
                      )}
                    </button>

                    <span className="text-[10px] font-mono text-slate-500 font-bold">#{index + 1}</span>

                    <span className="text-[10px] font-mono bg-slate-950 text-slate-300 px-2 py-0.5 rounded border border-slate-800 truncate max-w-[240px]">
                      {line.raw_description}
                    </span>

                    {velocity && (
                      <span
                        className={`text-[9px] font-bold px-1.5 py-0.5 rounded border shrink-0 ${
                          velocity.tier === 'FAST_RUNNER'
                            ? 'bg-emerald-950/80 text-emerald-400 border-emerald-800'
                            : velocity.tier === 'STEADY'
                              ? 'bg-indigo-950/80 text-indigo-400 border-indigo-800'
                              : 'bg-amber-950/80 text-amber-400 border-amber-800'
                        }`}
                        title={`Écoulement estimé : ~${velocity.absorptionDays} jours | Marge suggérée : +${velocity.recommendedMarkupPct}%`}
                      >
                        {velocity.tier === 'FAST_RUNNER' ? '⚡' : velocity.tier === 'STEADY' ? '🟢' : '⚠️'} ~{velocity.absorptionDays}j
                      </span>
                    )}

                    {line.match_tier === 'tier1exactalias' && (
                      <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-emerald-950/80 text-emerald-400 border border-emerald-800 shrink-0">
                        Tier 1 : Alias
                      </span>
                    )}
                    {(line.match_tier === 'tier2highconfidence' || line.match_tier === 'tier2reviewneeded') && (
                      <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-indigo-950/80 text-indigo-400 border border-indigo-800 shrink-0">
                        Tier 2 : IA
                      </span>
                    )}
                    {line.match_tier === 'tier3unmatched' && isUnassigned && (
                      <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-amber-950/80 text-amber-400 border border-amber-800 shrink-0">
                        Tier 3 : À associer
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={() => handleDuplicateLine(line)}
                      className="p-1 rounded-md text-slate-400 hover:text-indigo-400 hover:bg-indigo-950/30 transition cursor-pointer"
                      title="Dédoubler la ligne (scinder quantités)"
                    >
                      <Copy className="w-3.5 h-3.5" />
                    </button>
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

                {/* Math Discrepancy & Interactive Quick Auto-Repair Chips */}
                {isFaultyMath && fault && (
                  <div className="mb-2 p-2 rounded-xl bg-rose-950/50 border border-rose-800/80 space-y-1.5">
                    <div className="flex items-center justify-between text-[11px] font-semibold text-rose-300">
                      <span>Écart détecté : Qté × P.U. = {formatDZD(fault.expected)} (Total reçu: {formatDZD(fault.actual)})</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                      <span className="text-[10px] text-slate-400 font-medium">Réparations rapides :</span>
                      <button
                        type="button"
                        onClick={() => updateLine(line.client_id, { line_total: fault.expected })}
                        className="text-[10px] px-2 py-0.5 rounded bg-rose-900/80 hover:bg-rose-800 border border-rose-700 text-rose-200 cursor-pointer transition active:scale-95 font-medium"
                      >
                        🔧 Régler Total à {formatDZD(fault.expected)}
                      </button>
                      {line.quantity > 0 && line.line_total > 0 && (
                        <button
                          type="button"
                          onClick={() => {
                            const recalculatedUnit = Math.round((line.line_total / line.quantity) * 100) / 100;
                            updateLine(line.client_id, { unit_cost: recalculatedUnit });
                          }}
                          className="text-[10px] px-2 py-0.5 rounded bg-amber-900/80 hover:bg-amber-800 border border-amber-700 text-amber-200 cursor-pointer transition active:scale-95 font-medium"
                        >
                          🔧 Régler P.U. à {formatDZD(Math.round((line.line_total / line.quantity) * 100) / 100)}
                        </button>
                      )}
                    </div>
                  </div>
                )}

                {/* Top AI Suggestion Quick Accept Banner */}
                {isUnassigned && topCandidate && topScorePct >= 60 && (
                  <div className="mb-2 p-2 rounded-xl bg-indigo-950/50 border border-indigo-800/60 flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 text-xs text-indigo-200 truncate">
                      <Sparkles className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                      <span className="font-semibold text-indigo-300">[{topScorePct}%]</span>
                      <span className="truncate">{topCandidate.name}</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        const resolvedCost =
                          topCandidate.current_cost > 0 ? topCandidate.current_cost : line.unit_cost;
                        updateLine(line.client_id, {
                          selected_product_id: topCandidate.id,
                          unit_cost: resolvedCost,
                          match_tier: 'tier2highconfidence',
                          save_alias: true,
                        });
                      }}
                      className="px-2.5 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-[11px] font-bold shrink-0 cursor-pointer transition active:scale-95 shadow-sm"
                    >
                      Accepter
                    </button>
                  </div>
                )}

                {/* Product Match Dropdown with Complete Catalog & Inline Create Action */}
                <div className="mb-3 flex items-center gap-1.5">
                  <div className="flex-1 min-w-0">
                    <select
                      value={line.selected_product_id ?? ''}
                      onChange={(e) => {
                        const pid = e.target.value || null;
                        const matched = line.candidates.find((c) => c.id === pid);
                        const catOption = catalogOptions.find((c) => c.id === pid);
                        const resolvedCost = matched
                          ? matched.current_cost
                          : catOption && catOption.cost > 0
                            ? catOption.cost
                            : line.unit_cost;

                        updateLine(line.client_id, {
                          selected_product_id: pid,
                          unit_cost: resolvedCost,
                          selling_price: catOption?.price || Math.round(resolvedCost * 1.35),
                        });
                      }}
                      className="w-full bg-slate-950 border border-slate-700 rounded-xl px-2.5 py-2 text-xs text-white focus:outline-none focus:border-indigo-500"
                    >
                      <option value="">-- Sélectionner dans le catalogue --</option>
                      {line.candidates.length > 0 && (
                        <optgroup label="Suggestions IA / Reconnaissance">
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

                  <button
                    type="button"
                    onClick={() => handleOpenQuickCreate(line)}
                    className="px-2.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-xs font-semibold flex items-center gap-1 shrink-0 cursor-pointer transition active:scale-95"
                    title="Créer un nouveau produit pour cette ligne"
                  >
                    <PackagePlus className="w-3.5 h-3.5 text-indigo-400" />
                    <span className="hidden sm:inline">+ Produit</span>
                  </button>
                </div>

                {/* Numeric Inputs & Margin Simulator */}
                <div className="grid grid-cols-4 gap-2 mb-2">
                  <div>
                    <label className="text-[9px] font-medium text-slate-400 uppercase">Quantité</label>
                    <input
                      type="number"
                      inputMode="decimal"
                      value={line.quantity || ''}
                      onChange={(e) =>
                        updateLine(line.client_id, { quantity: parseFloat(e.target.value) || 0 })
                      }
                      className="w-full bg-slate-950 border border-slate-700 rounded-xl px-2 py-1.5 text-xs text-white text-center font-mono focus:border-indigo-500"
                    />
                  </div>
                  <div>
                    <div className="flex items-center justify-between mb-0.5">
                      <label className="text-[9px] font-medium text-slate-400 uppercase">
                        Prix Achat
                      </label>
                      {catalogItem && catalogItem.cost > 0 && (
                        <span className="text-[9px] font-mono">
                          {(() => {
                            const diff = Math.round((line.unit_cost - catalogItem.cost) * 100) / 100;
                            if (Math.abs(diff) < 0.01) {
                              return <span className="text-slate-500">● Stable</span>;
                            }
                            const pct = Math.round((diff / catalogItem.cost) * 100);
                            if (diff > 0) {
                              return <span className="text-amber-400">▲ +{pct}%</span>;
                            }
                            return <span className="text-emerald-400">▼ {pct}%</span>;
                          })()}
                        </span>
                      )}
                    </div>
                    <input
                      type="number"
                      step="0.01"
                      inputMode="decimal"
                      value={line.unit_cost}
                      onChange={(e) => updateLine(line.client_id, { unit_cost: parseFloat(e.target.value) || 0 })}
                      className="w-full bg-slate-950 border border-slate-700 rounded-xl px-2 py-1.5 text-xs text-white text-center font-mono focus:border-indigo-500"
                    />
                  </div>
                  <div>
                    <div className="flex items-center justify-between mb-0.5">
                      <label className="text-[9px] font-medium text-slate-400 uppercase">
                        Prix Vente
                      </label>
                      <span className={`text-[9px] font-bold ${isLossMargin ? 'text-rose-400' : 'text-emerald-400'}`}>
                        {isLossMargin ? '⚠️ Perte' : `+${marginPct}%`}
                      </span>
                    </div>
                    <input
                      type="number"
                      step="0.01"
                      inputMode="decimal"
                      value={line.selling_price}
                      onChange={(e) => updateLine(line.client_id, { selling_price: parseFloat(e.target.value) || 0 })}
                      className={`w-full bg-slate-950 border rounded-xl px-2 py-1.5 text-xs text-center font-mono focus:border-indigo-500 ${
                        isLossMargin ? 'border-rose-500 text-rose-300' : 'border-slate-700 text-emerald-300'
                      }`}
                    />
                    <div className="flex items-center justify-center gap-1 mt-1">
                      {[25, 35, 50].map((m) => (
                        <button
                          key={m}
                          type="button"
                          onClick={() => handleSetLineMarkup(line.client_id, m)}
                          className="text-[9px] px-1 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition cursor-pointer"
                          title={`Fixer prix de vente à +${m}%`}
                        >
                          +{m}%
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <label className="text-[9px] font-medium text-slate-400 uppercase">
                      Total Ligne
                    </label>
                    <input
                      type="number"
                      step="0.01"
                      inputMode="decimal"
                      value={line.line_total}
                      onChange={(e) => updateLine(line.client_id, { line_total: parseFloat(e.target.value) || 0 })}
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

          {/* VUE 2: TABLEAU HAUTE DENSITÉ */}
          {viewMode === 'table' && (
            <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-xl">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs border-collapse">
                  <thead className="bg-slate-950 text-slate-400 text-[10px] uppercase font-bold border-b border-slate-800 tracking-wider">
                    <tr>
                      <th className="p-2.5 text-center w-8">
                        <button
                          type="button"
                          onClick={handleToggleSelectAll}
                          className="cursor-pointer"
                        >
                          {selectedLineIds.size === visibleLines.length && visibleLines.length > 0 ? (
                            <CheckSquare className="w-3.5 h-3.5 text-indigo-400" />
                          ) : (
                            <Square className="w-3.5 h-3.5 text-slate-600" />
                          )}
                        </button>
                      </th>
                      <th
                        onClick={() => handleToggleSort('index')}
                        className="p-2.5 text-left w-10 cursor-pointer hover:text-white"
                      >
                        <div className="flex items-center gap-1">
                          <span>#</span>
                          {sortField === 'index' && (
                            sortDirection === 'asc' ? <ArrowUp className="w-3 h-3 text-indigo-400" /> : <ArrowDown className="w-3 h-3 text-indigo-400" />
                          )}
                        </div>
                      </th>
                      <th
                        onClick={() => handleToggleSort('desc')}
                        className="p-2.5 cursor-pointer hover:text-white"
                      >
                        <div className="flex items-center gap-1">
                          <span>Description Source Facture</span>
                          {sortField === 'desc' ? (
                            sortDirection === 'asc' ? <ArrowUp className="w-3 h-3 text-indigo-400" /> : <ArrowDown className="w-3 h-3 text-indigo-400" />
                          ) : (
                            <ArrowUpDown className="w-2.5 h-2.5 text-slate-600" />
                          )}
                        </div>
                      </th>
                      <th
                        onClick={() => handleToggleSort('product')}
                        className="p-2.5 cursor-pointer hover:text-white"
                      >
                        <div className="flex items-center gap-1">
                          <span>Affectation Catalogue</span>
                          {sortField === 'product' ? (
                            sortDirection === 'asc' ? <ArrowUp className="w-3 h-3 text-indigo-400" /> : <ArrowDown className="w-3 h-3 text-indigo-400" />
                          ) : (
                            <ArrowUpDown className="w-2.5 h-2.5 text-slate-600" />
                          )}
                        </div>
                      </th>
                      <th
                        onClick={() => handleToggleSort('qty')}
                        className="p-2.5 text-center w-16 cursor-pointer hover:text-white"
                      >
                        <div className="flex items-center justify-center gap-1">
                          <span>Qté</span>
                          {sortField === 'qty' && (
                            sortDirection === 'asc' ? <ArrowUp className="w-3 h-3 text-indigo-400" /> : <ArrowDown className="w-3 h-3 text-indigo-400" />
                          )}
                        </div>
                      </th>
                      <th
                        onClick={() => handleToggleSort('cost')}
                        className="p-2.5 text-right w-28 cursor-pointer hover:text-white"
                      >
                        <div className="flex items-center justify-end gap-1">
                          <span>P.U. Achat HT</span>
                          {sortField === 'cost' && (
                            sortDirection === 'asc' ? <ArrowUp className="w-3 h-3 text-indigo-400" /> : <ArrowDown className="w-3 h-3 text-indigo-400" />
                          )}
                        </div>
                      </th>
                      <th
                        onClick={() => handleToggleSort('selling')}
                        className="p-2.5 text-right w-32 cursor-pointer hover:text-white"
                      >
                        <div className="flex items-center justify-end gap-1">
                          <span>P.U. Vente TTC</span>
                          {sortField === 'selling' && (
                            sortDirection === 'asc' ? <ArrowUp className="w-3 h-3 text-indigo-400" /> : <ArrowDown className="w-3 h-3 text-indigo-400" />
                          )}
                        </div>
                      </th>
                      <th
                        onClick={() => handleToggleSort('margin')}
                        className="p-2.5 text-center w-20 cursor-pointer hover:text-white"
                      >
                        <div className="flex items-center justify-center gap-1">
                          <span>Marge</span>
                          {sortField === 'margin' && (
                            sortDirection === 'asc' ? <ArrowUp className="w-3 h-3 text-indigo-400" /> : <ArrowDown className="w-3 h-3 text-indigo-400" />
                          )}
                        </div>
                      </th>
                      <th
                        onClick={() => handleToggleSort('total')}
                        className="p-2.5 text-right w-28 cursor-pointer hover:text-white"
                      >
                        <div className="flex items-center justify-end gap-1">
                          <span>Total Ligne</span>
                          {sortField === 'total' && (
                            sortDirection === 'asc' ? <ArrowUp className="w-3 h-3 text-indigo-400" /> : <ArrowDown className="w-3 h-3 text-indigo-400" />
                          )}
                        </div>
                      </th>
                      <th className="p-2.5 text-center w-12">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/80 font-mono">
                    {visibleLines.map((line, index) => {
                      const fault = mathState.faultyRows.get(line.client_id);
                      const isFaultyMath = !!fault;
                      const isUnassigned = !line.selected_product_id;
                      const catalogItem = catalogOptions.find((c) => c.id === line.selected_product_id);
                      const isSelected = selectedLineIds.has(line.client_id);
                      const isHovered = hoveredLineId === line.client_id;
                      const velocity = velocitySummary.lines.get(line.client_id);

                      const sellPrice = line.selling_price || (catalogItem?.price ? catalogItem.price : Math.round(line.unit_cost * 1.35));
                      const unitProfit = Math.max(0, sellPrice - line.unit_cost);
                      const marginPct = sellPrice > 0 ? Math.round((unitProfit / sellPrice) * 100) : 0;
                      const isLossMargin = line.unit_cost > 0 && line.selling_price !== undefined && line.selling_price <= line.unit_cost;

                      return (
                        <tr
                          key={line.client_id}
                          onMouseEnter={() => setHoveredLineId(line.client_id)}
                          onMouseLeave={() => setHoveredLineId(null)}
                          className={`hover:bg-slate-800/60 transition ${
                            isHovered
                              ? 'bg-indigo-950/60 ring-1 ring-indigo-500/50'
                              : isSelected
                                ? 'bg-indigo-950/40'
                                : isFaultyMath
                                  ? 'bg-rose-950/20'
                                  : ''
                          }`}
                        >
                          <td className="p-2.5 text-center">
                            <button
                              type="button"
                              onClick={() => handleToggleSelectLine(line.client_id)}
                              className="cursor-pointer"
                            >
                              {isSelected ? (
                                <CheckSquare className="w-3.5 h-3.5 text-indigo-400" />
                              ) : (
                                <Square className="w-3.5 h-3.5 text-slate-600" />
                              )}
                            </button>
                          </td>
                          <td className="p-2.5 text-slate-500 font-bold">{index + 1}</td>
                          <td className="p-2.5 font-sans font-medium text-slate-200 max-w-[240px]" title={line.raw_description}>
                            <div className="flex items-center gap-1.5 min-w-0">
                              <span className="truncate">{line.raw_description}</span>
                              {velocity && (
                                <span
                                  className={`text-[8px] font-bold px-1 py-0.2 rounded border shrink-0 ${
                                    velocity.tier === 'FAST_RUNNER'
                                      ? 'bg-emerald-950/80 text-emerald-400 border-emerald-800'
                                      : velocity.tier === 'STEADY'
                                        ? 'bg-indigo-950/80 text-indigo-400 border-indigo-800'
                                        : 'bg-amber-950/80 text-amber-400 border-amber-800'
                                  }`}
                                  title={`~${velocity.absorptionDays} j d'écoulement`}
                                >
                                  {velocity.tier === 'FAST_RUNNER' ? '⚡' : velocity.tier === 'STEADY' ? '🟢' : '⚠️'} ~{velocity.absorptionDays}j
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="p-2.5 font-sans">
                            <div className="flex items-center gap-1">
                              <select
                                value={line.selected_product_id ?? ''}
                                onChange={(e) => {
                                  const pid = e.target.value || null;
                                  const catOption = catalogOptions.find((c) => c.id === pid);
                                  updateLine(line.client_id, {
                                    selected_product_id: pid,
                                    unit_cost: catOption?.cost || line.unit_cost,
                                    selling_price: catOption?.price || Math.round((catOption?.cost || line.unit_cost) * 1.35),
                                  });
                                }}
                                className={`w-full bg-slate-950 border rounded-lg px-2 py-1 text-xs text-white focus:outline-none focus:border-indigo-500 ${
                                  isUnassigned ? 'border-amber-500/80 text-amber-200' : 'border-slate-700'
                                }`}
                              >
                                <option value="">-- À associer --</option>
                                {catalogOptions.map((c) => (
                                  <option key={`tbl_${c.id}`} value={c.id}>
                                    {c.name}
                                  </option>
                                ))}
                              </select>
                              <button
                                type="button"
                                onClick={() => handleOpenQuickCreate(line)}
                                className="p-1 rounded-md bg-slate-800 hover:bg-slate-700 text-indigo-400 shrink-0 cursor-pointer"
                                title="Créer produit"
                              >
                                <PackagePlus className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </td>
                          <td className="p-2.5 text-center">
                            <input
                              type="number"
                              value={line.quantity || ''}
                              onChange={(e) => updateLine(line.client_id, { quantity: parseFloat(e.target.value) || 0 })}
                              className="w-14 bg-slate-950 border border-slate-700 rounded px-1.5 py-1 text-center font-mono text-xs text-white focus:border-indigo-500"
                            />
                          </td>
                          <td className="p-2.5 text-right font-sans">
                            <div className="flex flex-col items-end">
                              <input
                                type="number"
                                step="0.01"
                                value={line.unit_cost}
                                onChange={(e) => updateLine(line.client_id, { unit_cost: parseFloat(e.target.value) || 0 })}
                                className="w-20 bg-slate-950 border border-slate-700 rounded px-1.5 py-1 text-right font-mono text-xs text-white focus:border-indigo-500"
                              />
                              {catalogItem && catalogItem.cost > 0 && (
                                <span className="text-[9px] font-mono mt-0.5">
                                  {(() => {
                                    const diff = Math.round((line.unit_cost - catalogItem.cost) * 100) / 100;
                                    if (Math.abs(diff) < 0.01) {
                                      return <span className="text-slate-500" title="Coût identique au catalogue">● Stable</span>;
                                    }
                                    const pct = Math.round((diff / catalogItem.cost) * 100);
                                    if (diff > 0) {
                                      return <span className="text-amber-400 font-semibold" title={`Hausse de +${formatDZD(diff)} (+${pct}%) par rapport au catalogue`}>▲ +{pct}%</span>;
                                    }
                                    return <span className="text-emerald-400 font-semibold" title={`Baisse de -${formatDZD(Math.abs(diff))} (${pct}%) par rapport au catalogue`}>▼ {pct}%</span>;
                                  })()}
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="p-2.5 text-right font-sans">
                            <div className="flex flex-col items-end gap-1">
                              <input
                                type="number"
                                step="0.01"
                                value={line.selling_price}
                                onChange={(e) => updateLine(line.client_id, { selling_price: parseFloat(e.target.value) || 0 })}
                                className={`w-20 bg-slate-950 border rounded px-1.5 py-1 text-right font-mono text-xs focus:border-indigo-500 ${
                                  isLossMargin ? 'border-rose-500 text-rose-300' : 'border-slate-700 text-emerald-300'
                                }`}
                              />
                              <div className="flex items-center gap-0.5">
                                {[25, 35, 50].map((m) => (
                                  <button
                                    key={m}
                                    type="button"
                                    onClick={() => handleSetLineMarkup(line.client_id, m)}
                                    className="text-[8px] px-1 py-0.2 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition cursor-pointer"
                                    title={`Fixer prix de vente à +${m}%`}
                                  >
                                    +{m}%
                                  </button>
                                ))}
                              </div>
                            </div>
                          </td>
                          <td className="p-2.5 text-center font-sans">
                            <span className={`text-[10px] font-bold ${isLossMargin ? 'text-rose-400' : 'text-emerald-400'}`}>
                              {isLossMargin ? '⚠️ Perte' : `+${marginPct}%`}
                            </span>
                          </td>
                          <td className={`p-2.5 text-right font-bold ${isFaultyMath ? 'text-rose-400' : 'text-slate-200'}`}>
                            {formatDZD(line.line_total)}
                          </td>
                          <td className="p-2.5 text-center">
                            <button
                              type="button"
                              onClick={() => handleDeleteLine(line.client_id)}
                              className="p-1 rounded text-slate-400 hover:text-rose-400 hover:bg-rose-950/40 transition cursor-pointer"
                              title="Supprimer"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </main>

        {/* OCR DOCUMENT INSPECTOR (SIDE DRAWER / SPLIT VIEW) */}
        {showOcrInspector && (
          <aside className="w-80 sm:w-96 border-l border-slate-800 bg-slate-900/95 backdrop-blur-md p-3.5 sm:p-4 flex flex-col space-y-3 shrink-0 overflow-y-auto">
            <div className="flex items-center justify-between border-b border-slate-800 pb-2">
              <div className="flex items-center gap-2">
                <FileText className="w-4 h-4 text-indigo-400" />
                <h3 className="text-xs font-bold text-white uppercase tracking-wider">Inspecteur OCR & Document</h3>
              </div>
              <button
                type="button"
                onClick={() => setShowOcrInspector(false)}
                className="p-1 rounded-md text-slate-400 hover:text-white cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Mode Switcher: HUD Spatial Canvas vs Raw Extracted Text */}
            <div className="grid grid-cols-2 gap-1.5 p-1 bg-slate-950 rounded-xl border border-slate-800 text-[11px] font-bold shrink-0">
              <button
                type="button"
                onClick={() => setOcrInspectorTab('visual')}
                className={`py-1.5 rounded-lg transition cursor-pointer flex items-center justify-center gap-1.5 ${
                  ocrInspectorTab === 'visual'
                    ? 'bg-indigo-600 text-white shadow-xs'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                <Sparkles className="w-3.5 h-3.5 text-emerald-400" />
                <span>HUD Spatial (SVG)</span>
              </button>
              <button
                type="button"
                onClick={() => setOcrInspectorTab('text')}
                className={`py-1.5 rounded-lg transition cursor-pointer flex items-center justify-center gap-1.5 ${
                  ocrInspectorTab === 'text'
                    ? 'bg-indigo-600 text-white shadow-xs'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                <FileText className="w-3.5 h-3.5" />
                <span>Texte Brut ({lines.length})</span>
              </button>
            </div>

            {/* Document Header Detection */}
            <div className="bg-slate-950 p-2.5 rounded-xl border border-slate-800 space-y-1 text-xs shrink-0">
              <span className="text-[10px] uppercase font-bold text-slate-400 block">En-tête Détecté</span>
              <p className="text-slate-200"><span className="text-slate-500">Fournisseur :</span> {supplierName}</p>
              <p className="text-slate-200"><span className="text-slate-500">TVA déclarée :</span> {formatDZD(reportedTax)}</p>
              <p className="text-slate-200"><span className="text-slate-500">Frais port :</span> {formatDZD(reportedFreight)}</p>
              <p className="text-emerald-400 font-bold"><span className="text-slate-500 font-normal">Total Facture :</span> {formatDZD(mathState.targetTotal)}</p>
            </div>

            {/* TAB 1: INTERACTIVE SPATIAL HUD */}
            {ocrInspectorTab === 'visual' ? (
              <div className="flex-1 min-h-[380px] flex flex-col overflow-hidden">
                <DocumentVisualHud
                  boxes={displayBoundingBoxes}
                  lines={lines}
                  hoveredLineId={hoveredLineId}
                  onHoverLine={setHoveredLineId}
                  faultyRows={mathState.faultyRows}
                />
              </div>
            ) : (
              /* TAB 2: RAW TEXT SNIPPETS LIST */
              <div className="space-y-1.5 flex-1 overflow-y-auto">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[10px] uppercase font-bold text-slate-400 block">
                    Lignes Détectées ({lines.length})
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      const fullText = lines.map((l) => l.raw_description).join('\n');
                      navigator.clipboard?.writeText(fullText);
                      setBalanceSuccessNotice('Texte intégral copié dans le presse-papier.');
                      setTimeout(() => setBalanceSuccessNotice(null), 3000);
                    }}
                    className="text-[10px] text-indigo-400 hover:text-indigo-300 font-semibold flex items-center gap-1 cursor-pointer"
                  >
                    <Copy className="w-3 h-3" /> Tout copier
                  </button>
                </div>
                {lines.map((l, i) => (
                  <div
                    key={`ocr_${l.client_id}`}
                    className="p-2 rounded-xl bg-slate-950/70 border border-slate-800/80 hover:border-indigo-500/60 transition text-xs space-y-1"
                  >
                    <div className="flex items-center justify-between text-[10px] text-slate-500 font-mono">
                      <span>Ligne #{i + 1}</span>
                      <button
                        type="button"
                        onClick={() => navigator.clipboard?.writeText(l.raw_description)}
                        className="hover:text-indigo-300 flex items-center gap-1 cursor-pointer"
                      >
                        <Copy className="w-3 h-3" /> Copier
                      </button>
                    </div>
                    <p className="font-mono text-slate-300 text-[11px] leading-tight break-words">
                      {l.raw_description}
                    </p>
                    <div className="flex items-center justify-between text-[10px] text-slate-400 font-mono pt-1 border-t border-slate-900">
                      <span>Qté: {l.quantity} × {formatDZD(l.unit_cost)}</span>
                      <span className="font-bold text-slate-200">{formatDZD(l.line_total)}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* AI Architecture & Invariant Telemetry Card */}
            <div className="bg-slate-950 p-2.5 rounded-xl border border-slate-800 space-y-1.5 text-[10px] shrink-0">
              <span className="uppercase font-bold text-slate-400 block">Télémétrie Moteur IA (Rust)</span>
              <div className="flex items-center justify-between text-slate-300">
                <span className="text-slate-500">Intégrité Invariant :</span>
                <span className={mathState.isBalanced ? 'text-emerald-400 font-mono font-bold' : 'text-rose-400 font-mono font-bold'}>
                  {mathState.isBalanced ? 'Équilibré (Δ = 0.00 DA)' : `Écart: ${formatDZD(mathState.delta)}`}
                </span>
              </div>
              <div className="flex items-center justify-between text-slate-300">
                <span className="text-slate-500">Moteur Résolution :</span>
                <span className="text-indigo-300 font-mono">3-Tier (Alias + BGE + GTIN-10)</span>
              </div>
              <div className="flex items-center justify-between text-slate-300">
                <span className="text-slate-500">Distribution Tiers :</span>
                <span className="text-slate-300 font-mono">
                  T1: {lines.filter((l) => l.match_tier === 'tier1exactalias').length} | T2: {lines.filter((l) => l.match_tier.startsWith('tier2')).length} | T3: {unassignedCount}
                </span>
              </div>
            </div>
          </aside>
        )}
      </div>

      {/* 3. STICKY ACTION BAR */}
      <footer className="sticky bottom-0 inset-x-0 bg-slate-900/95 backdrop-blur-md border-t border-slate-800 p-3 sm:p-4 flex flex-col sm:flex-row items-center justify-between gap-3 shadow-2xl shrink-0 z-30">
        <div className="flex items-center gap-3 w-full sm:w-auto justify-between sm:justify-start">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-xs font-semibold text-slate-400 hover:text-white cursor-pointer"
          >
            Annuler
          </button>
          {!mathState.isBalanced && (
            <span className="text-[11px] text-rose-400 font-medium">
              Validation bloquée par l'intégrité comptable (Δ {formatDZD(mathState.delta)})
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

      {/* 4. MODAL: INLINE QUICK PRODUCT CREATION */}
      {creatingForLine && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-3 sm:p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-md p-4 shadow-2xl space-y-3 animate-in fade-in zoom-in-95">
            <div className="flex items-start justify-between gap-2 border-b border-slate-800 pb-2.5">
              <div>
                <h2 className="text-sm font-bold text-white flex items-center gap-2">
                  <PackagePlus className="w-4 h-4 text-indigo-400" />
                  <span>Nouveau Produit Catalogue</span>
                </h2>
                <p className="text-[10px] text-slate-400 truncate max-w-[280px]">
                  Source : {creatingForLine.raw_description}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setCreatingForLine(null)}
                className="p-1 rounded-md text-slate-400 hover:text-white hover:bg-slate-800 transition cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {quickError && (
              <div className="p-2 rounded-xl bg-rose-950 border border-rose-800 text-rose-200 text-xs">
                {quickError}
              </div>
            )}

            <div className="space-y-2.5 text-xs">
              <div>
                <label className="text-[10px] font-medium text-slate-300 block mb-1">
                  Désignation du produit *
                </label>
                <input
                  type="text"
                  value={quickTitle}
                  onChange={(e) => setQuickTitle(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-white text-xs focus:outline-none focus:border-indigo-500"
                  placeholder="Ex: Adaptateur Secteur 20W USB-C Apple"
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[10px] font-medium text-slate-300 block mb-1">
                    Code-barres / EAN
                  </label>
                  <input
                    type="text"
                    value={quickBarcode}
                    onChange={(e) => setQuickBarcode(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-700 rounded-xl px-2.5 py-1.5 text-white font-mono text-xs focus:outline-none focus:border-indigo-500"
                    placeholder="Ex: 019425208421"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-medium text-slate-300 block mb-1">
                    Référence SKU
                  </label>
                  <input
                    type="text"
                    value={quickSku}
                    onChange={(e) => setQuickSku(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-700 rounded-xl px-2.5 py-1.5 text-white font-mono text-xs focus:outline-none focus:border-indigo-500"
                    placeholder="Ex: SKU-10492"
                  />
                </div>
              </div>

              <div>
                <label className="text-[10px] font-medium text-slate-300 block mb-1">
                  Catégorie
                </label>
                <select
                  value={quickCategory}
                  onChange={(e) => setQuickCategory(e.target.value as CategoryType)}
                  className="w-full bg-slate-950 border border-slate-700 rounded-xl px-2.5 py-1.5 text-white text-xs focus:outline-none focus:border-indigo-500"
                >
                  <option value="Chargeurs">Chargeurs</option>
                  <option value="Câbles">Câbles</option>
                  <option value="Protège-Écran">Protège-Écran</option>
                  <option value="Coques iPhone">Coques iPhone</option>
                  <option value="Coques Samsung">Coques Samsung</option>
                  <option value="Services">Services</option>
                </select>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[10px] font-medium text-slate-300 block mb-1">
                    Prix d'Achat (DA)
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    inputMode="decimal"
                    value={quickCost}
                    onChange={(e) => setQuickCost(parseFloat(e.target.value) || 0)}
                    className="w-full bg-slate-950 border border-slate-700 rounded-xl px-2.5 py-1.5 text-white font-mono text-xs focus:outline-none focus:border-indigo-500"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-medium text-slate-300 block mb-1">
                    Prix de Vente (DA)
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    inputMode="decimal"
                    value={quickPrice}
                    onChange={(e) => setQuickPrice(parseFloat(e.target.value) || 0)}
                    className="w-full bg-slate-950 border border-slate-700 rounded-xl px-2.5 py-1.5 text-white font-mono text-xs focus:outline-none focus:border-indigo-500"
                  />
                </div>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-800">
              <button
                type="button"
                onClick={() => setCreatingForLine(null)}
                className="px-3 py-1.5 text-xs text-slate-400 hover:text-white cursor-pointer"
              >
                Annuler
              </button>
              <button
                type="button"
                disabled={isQuickSaving || !quickTitle.trim()}
                onClick={handleSaveQuickProduct}
                className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-800 disabled:text-slate-600 text-white text-xs font-bold cursor-pointer transition active:scale-95 shadow-md flex items-center gap-1.5"
              >
                {isQuickSaving ? 'Création en cours…' : 'Créer & Assigner (1-Clic)'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 5. MODAL: VENDOR DISPUTE & NEGOTIATION DEFENSE BRIEF (WHATSAPP & AVOIR) */}
      {showDisputeModal && (
        <VendorDisputeModal
          brief={disputeBrief}
          onClose={() => setShowDisputeModal(false)}
        />
      )}

      {/* 6. MODAL: THERMAL BARCODE LABEL STAGING QUEUE */}
      {showBarcodeModal && (
        <BarcodeStagingModal
          lines={lines}
          catalogMap={catalogLookupMap}
          onClose={() => setShowBarcodeModal(false)}
        />
      )}
    </div>
  );
};
