import React, { useState, useRef, useEffect } from 'react';
import {
  X,
  Upload,
  FileSpreadsheet,
  CheckCircle2,
  AlertTriangle,
  ArrowRight,
  ArrowLeft,
  RefreshCw,
  Sparkles,
  Clipboard,
  FileText,
  Database,
  Info,
  Check,
  AlertCircle,
  Eye,
  ShoppingBag,
  Users,
  Building2,
} from 'lucide-react';
import { usePosStore } from '../../store/usePosStore';
import { useToast } from '../ui/Toast';
import {
  inspectImportFile,
  stageImportFile,
  commitImportBatch,
  type InspectResult,
  type ImportStageResponse,
  type CommitResult,
} from '../../api/import';
import { isTauriEnv } from '../../db/adapters/base';

type ImportStep = 'upload' | 'mapping' | 'staging' | 'success';

const PRODUCT_COLUMN_OPTIONS = [
  { value: 'title', label: 'Désignation / Titre (Obligatoire)' },
  { value: 'barcode', label: 'Code-barres / EAN' },
  { value: 'sku', label: 'Référence (SKU)' },
  { value: 'price', label: 'Prix de vente (DZD)' },
  { value: 'cost_price', label: "Prix d'achat / Coût (DZD)" },
  { value: 'quantity', label: 'Quantité / Stock initial' },
  { value: 'imei', label: 'Numéro IMEI (Téléphone / Produit sérialisé)' },
  { value: 'supplier_name', label: 'Nom du Fournisseur' },
  { value: 'supplier_phone', label: 'Téléphone du Fournisseur' },
  { value: 'brand', label: 'Marque / Fabricant' },
  { value: 'category', label: 'Catégorie' },
  { value: 'compatible_model', label: 'Modèle compatible' },
  { value: 'warranty', label: 'Garantie (mois)' },
  { value: 'ignored', label: '— Ignorer cette colonne —' },
];

const CUSTOMER_COLUMN_OPTIONS = [
  { value: 'customer_name', label: 'Nom complet du client' },
  { value: 'phone', label: 'Numéro de téléphone (Algérie)' },
  { value: 'secondary_phone', label: 'Téléphone secondaire' },
  { value: 'email', label: 'Adresse email' },
  { value: 'debt_balance', label: 'Dette — utiliser la destination Dettes', disabled: true },
  { value: 'address', label: 'Adresse physique' },
  { value: 'notes', label: 'Remarques / Notes' },
  { value: 'ignored', label: '— Ignorer cette colonne —' },
];

const CUSTOMER_DEBT_COLUMN_OPTIONS = [
  { value: 'customer_name', label: 'Nom complet du client' },
  { value: 'phone', label: 'Numéro de téléphone (Algérie)' },
  { value: 'email', label: 'Adresse email' },
  { value: 'debt_balance', label: 'Solde de dette souhaité (DZD)' },
  { value: 'ignored', label: '— Ignorer cette colonne —' },
];

const SUPPLIER_COLUMN_OPTIONS = [
  { value: 'supplier_name', label: 'Nom du Fournisseur / Grossiste (Obligatoire)' },
  { value: 'phone', label: 'Numéro de téléphone (Algérie)' },
  { value: 'email', label: 'Adresse email' },
  { value: 'address', label: 'Adresse physique / Ville' },
  { value: 'notes', label: 'Remarques / Conditions de paiement' },
  { value: 'ignored', label: '— Ignorer cette colonne —' },
];

function stagingRowMessages(row: ImportStageResponse['staged_rows'][number]): string[] {
  if (row.rejection_reason) return [row.rejection_reason];

  try {
    const warnings: Array<{ code?: string; message?: string }> = JSON.parse(row.warnings_json);
    return warnings
      .map((warning) =>
        warning.message
          ? `${warning.code ? `${warning.code} : ` : ''}${warning.message}`
          : '',
      )
      .filter(Boolean);
  } catch {
    return ['Les détails de validation de cette ligne sont illisibles.'];
  }
}

function parseBase64Csv(b64: string): { headers: string[]; rows: string[][] } {
  try {
    let cleanB64 = b64;
    const marker = ';base64,';
    const idx = b64.indexOf(marker);
    if (idx !== -1) {
      cleanB64 = b64.slice(idx + marker.length);
    }
    const binary = atob(cleanB64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    const text = new TextDecoder('utf-8').decode(bytes);
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
    if (lines.length === 0) return { headers: [], rows: [] };

    // Sniff delimiter: count ; vs , vs \t in first line
    const firstLine = lines[0];
    const semiCount = (firstLine.match(/;/g) || []).length;
    const commaCount = (firstLine.match(/,/g) || []).length;
    const tabCount = (firstLine.match(/\t/g) || []).length;
    const delim = tabCount > semiCount && tabCount > commaCount ? '\t' : semiCount >= commaCount ? ';' : ',';

    const headers = lines[0].split(delim).map((h) => h.replace(/^["']|["']$/g, '').trim());
    const rows = lines.slice(1).map((l) => l.split(delim).map((c) => c.replace(/^["']|["']$/g, '').trim()));
    return { headers, rows };
  } catch {
    return { headers: [], rows: [] };
  }
}

function inferCategoryFromTitleWeb(title: string): import('../../types/pos').CategoryType {
  const lower = title.toLowerCase();
  if (lower.includes('câble') || lower.includes('cable') || lower.includes('hdmi') || lower.includes('cordon') || lower.includes('usb-c') || lower.includes('lightning')) {
    return 'Câbles';
  } else if (lower.includes('chargeur') || lower.includes('adaptateur') || lower.includes('secteur') || lower.includes('charger')) {
    return 'Chargeurs';
  } else if (lower.includes('écouteur') || lower.includes('ecouteur') || lower.includes('casque') || lower.includes('audio') || lower.includes('enceinte') || lower.includes('airpod') || lower.includes('bluetooth')) {
    return 'Audio';
  } else if (lower.includes('batterie externe') || lower.includes('power bank') || lower.includes('powerbank') || lower.includes('batterie')) {
    return 'Batteries Externes';
  } else if (lower.includes('support') || lower.includes('refroidissement') || lower.includes('stand') || lower.includes('trépied') || lower.includes('holder')) {
    return 'Supports';
  } else if (lower.includes('verre') || lower.includes('film') || lower.includes('hydrogel') || lower.includes('protection') || lower.includes('protecteur') || lower.includes('vitre')) {
    return 'Protège-Écran';
  } else if (lower.includes('coque') || lower.includes('étui') || lower.includes('etui') || lower.includes('cover') || lower.includes('silicone')) {
    if (lower.includes('samsung') || lower.includes('galaxy')) {
      return 'Coques Samsung';
    } else if (lower.includes('google') || lower.includes('pixel')) {
      return 'Coques Google';
    } else {
      return 'Coques iPhone';
    }
  }
  return 'Tous les produits';
}

function inferBrandFromTitleWeb(title: string): import('../../types/pos').BrandName {
  const lower = title.toLowerCase();
  if (lower.includes('apple') || lower.includes('iphone') || lower.includes('ipad') || lower.includes('macbook') || lower.includes('airpod')) {
    return 'Apple';
  } else if (lower.includes('samsung') || lower.includes('galaxy')) {
    return 'Samsung';
  } else if (lower.includes('xiaomi') || lower.includes('redmi') || lower.includes('poco') || lower.includes('huawei') || lower.includes('honor')) {
    return 'Autre';
  } else if (lower.includes('google') || lower.includes('pixel')) {
    return 'Google';
  }
  return 'Autre';
}

function inferWebColumnMappings(headers: string[], rows: string[][]): import('../../api/import').ColumnMatchScore[] {
  return headers.map((h, i) => {
    const lower = h.toLowerCase().trim();
    let matched_type = 'ignored';
    let confidence = 0.5;

    if (lower.includes('imei') || lower.includes('serial') || lower.includes('série') || lower.includes('serie') || lower.includes('s/n') || lower.startsWith('sn')) {
      matched_type = 'imei';
      confidence = 0.98;
    } else if (lower.includes('code barre') || lower.includes('code-barre') || lower.includes('barcode') || lower.includes('ean') || lower.includes('gtin')) {
      matched_type = 'barcode';
      confidence = 0.96;
    } else if (lower.includes('sku') || lower.includes('réf') || lower.includes('ref') || lower.includes('référence') || lower.includes('reference') || lower.includes('code article') || lower.includes('code produit')) {
      matched_type = 'sku';
      confidence = 0.95;
    } else if (lower.includes('nom') || lower.includes('désignation') || lower.includes('designation') || lower.includes('article') || lower.includes('produit') || lower.includes('libellé') || lower.includes('title') || lower.includes('description')) {
      matched_type = 'title';
      confidence = 0.95;
    } else if (lower.includes('achat') || lower.includes('cost') || lower.includes('cout') || lower.includes('coût') || lower.includes('p.a') || lower.includes('pa')) {
      matched_type = 'cost_price';
      confidence = 0.94;
    } else if (lower.includes('vente') || lower.includes('prix') || lower.includes('price') || lower.includes('p.v') || lower.includes('pv')) {
      matched_type = 'price';
      confidence = 0.94;
    } else if (lower.includes('stock') || lower.includes('qte') || lower.includes('qté') || lower.includes('quantité') || lower.includes('qty')) {
      matched_type = 'quantity';
      confidence = 0.92;
    } else if (lower.includes('fournisseur') || lower.includes('supplier') || lower.includes('grossiste') || lower.includes('vendor')) {
      matched_type = 'supplier_name';
      confidence = 0.92;
    } else if (lower.includes('marque') || lower.includes('brand') || lower.includes('fabricant') || lower.includes('constructeur')) {
      matched_type = 'brand';
      confidence = 0.92;
    } else if (lower.includes('catégorie') || lower.includes('categorie') || lower.includes('category') || lower.includes('rayon') || lower.includes('famille')) {
      matched_type = 'category';
      confidence = 0.92;
    } else if (lower.includes('modèle') || lower.includes('modele') || lower.includes('model') || lower.includes('compatible')) {
      matched_type = 'compatible_model';
      confidence = 0.90;
    } else if (lower.includes('garantie') || lower.includes('warranty')) {
      matched_type = 'warranty';
      confidence = 0.90;
    } else if (lower.includes('tel') || lower.includes('tél') || lower.includes('phone') || lower.includes('mobile')) {
      matched_type = 'phone';
      confidence = 0.95;
    } else if (lower.includes('dette') || lower.includes('solde') || lower.includes('credit') || lower.includes('crédit')) {
      matched_type = 'debt_balance';
      confidence = 0.95;
    } else if (lower.includes('client') || lower.includes('customer')) {
      matched_type = 'customer_name';
      confidence = 0.92;
    } else if (lower.includes('email') || lower.includes('courriel') || lower.includes('mail')) {
      matched_type = 'email';
      confidence = 0.95;
    } else if (lower.includes('adresse') || lower.includes('address') || lower.includes('ville') || lower.includes('city')) {
      matched_type = 'address';
      confidence = 0.90;
    } else if (lower.includes('note') || lower.includes('remarque') || lower.includes('commentaire')) {
      matched_type = 'notes';
      confidence = 0.90;
    }

    const samples = rows.slice(0, 5).map((r) => r[i] || '').filter(Boolean);
    return {
      column_index: i,
      source_header: h,
      original_header: h,
      matched_type,
      mapped_column: matched_type,
      confidence,
      tier: confidence >= 0.85 ? 'Automated' : 'NeedsConfirmation',
      sample_values: samples,
    };
  });
}

export const SmartImportModal: React.FC = () => {
  const { closeModal, activeModal, refreshAfterPull } = usePosStore();
  const { showToast } = useToast();

  const [step, setStep] = useState<ImportStep>('upload');
  const [fileBase64, setFileBase64] = useState<string>('');
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Inspection state
  const [inspectResult, setInspectResult] = useState<InspectResult | null>(null);
  const [selectedSheetIndex, setSelectedSheetIndex] = useState<number | undefined>(undefined);
  const [encodingOverride, setEncodingOverride] = useState<string | undefined>(undefined);
  const [entityType, setEntityType] = useState<
    'products' | 'opening_stock' | 'customers' | 'customer_debts' | 'suppliers'
  >('products');
  const [columnOverrides, setColumnOverrides] = useState<Record<number, string>>({});

  // Staging state
  const [stagingResponse, setStagingResponse] = useState<ImportStageResponse | null>(null);

  // Commit result state
  const [commitResult, setCommitResult] = useState<CommitResult | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Keyboard shortcut listener for Escape
  useEffect(() => {
    if (activeModal !== 'smart_import') return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (step === 'success') {
          void handleFinishAndClose();
        } else {
          closeModal();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [activeModal, closeModal, step]);

  if (activeModal !== 'smart_import') return null;

  // Process File to Base64
  const handleFileSelected = async (file: File) => {
    setErrorMsg(null);
    setEncodingOverride(undefined);
    setIsProcessing(true);

    try {
      const reader = new FileReader();
      reader.onload = async (e) => {
        const rawUrl = e.target?.result as string;
        setFileBase64(rawUrl);
        await runInspection(rawUrl, file.name);
      };
      reader.onerror = () => {
        setErrorMsg('Échec de la lecture du fichier');
        setIsProcessing(false);
      };
      reader.readAsDataURL(file);
    } catch (err: any) {
      setErrorMsg(err.message || 'Erreur lors du chargement');
      setIsProcessing(false);
    }
  };

  // Inspect file content
  const runInspection = async (
    b64: string,
    name: string,
    sheetIdx?: number,
    selectedEncoding?: string,
  ) => {
    setIsProcessing(true);
    setErrorMsg(null);
    try {
      if (!isTauriEnv()) {
        const { headers, rows } = parseBase64Csv(b64);
        if (headers.length === 0 && rows.length === 0) {
          setErrorMsg("Le fichier est vide ou n'a pas pu être lu.");
          setIsProcessing(false);
          return;
        }

        const hasProductFields = headers.some((h) => {
          const l = h.toLowerCase();
          return (
            l.includes('produit') ||
            l.includes('designation') ||
            l.includes('désignation') ||
            l.includes('article') ||
            l.includes('stock') ||
            l.includes('prix') ||
            l.includes('price') ||
            l.includes('vente') ||
            l.includes('achat') ||
            l.includes('cost') ||
            l.includes('imei') ||
            l.includes('barcode') ||
            l.includes('code barre') ||
            l.includes('code-barre') ||
            l.includes('sku') ||
            l.includes('réf') ||
            l.includes('ref')
          );
        });

        const hasSupplierFields = headers.some((h) => {
          const l = h.toLowerCase();
          return l.includes('fournisseur') || l.includes('grossiste') || l.includes('supplier') || l.includes('vendor');
        });

        const hasCustomerFields = headers.some((h) => {
          const l = h.toLowerCase();
          return (
            l.includes('client') ||
            l.includes('customer') ||
            l.includes('dette') ||
            l.includes('solde') ||
            l.includes('crédit') ||
            l.includes('credit')
          );
        });

        const hasDebtFields = headers.some((h) => {
          const l = h.toLowerCase();
          return l.includes('dette') || l.includes('debt') || l.includes('solde');
        });

        let detected_entity: 'products' | 'opening_stock' | 'suppliers' | 'customer_debts' | 'customers' =
          'products';
        if (hasProductFields) {
          detected_entity = 'products';
        } else if (hasSupplierFields) {
          detected_entity = 'suppliers';
        } else if (hasDebtFields) {
          detected_entity = 'customer_debts';
        } else if (hasCustomerFields) {
          detected_entity = 'customers';
        } else {
          detected_entity = 'products';
        }
        const column_mappings = inferWebColumnMappings(headers, rows);

        const mockResult: InspectResult = {
          file_sha256: 'web_sha256_' + Date.now(),
          file_name: name,
          detected_encoding: selectedEncoding ?? 'UTF-8',
          sheets: ['Feuille 1'],
          active_sheet: 'Feuille 1',
          detected_entity,
          headers,
          column_mappings,
          warnings: [],
          preview_rows: rows.slice(0, 100),
          total_rows: rows.length,
        };
        setInspectResult(mockResult);
        setEntityType(detected_entity);

        const initialOverrides: Record<number, string> = {};
        column_mappings.forEach((m) => {
          if (m.matched_type) initialOverrides[m.column_index] = m.matched_type;
        });
        setColumnOverrides(initialOverrides);

        setStep('mapping');
        setIsProcessing(false);
        return;
      }

      const res = await inspectImportFile({
        file_base64: b64,
        file_name: name,
        sheet_index: sheetIdx,
        encoding_override: selectedEncoding,
      });

      setInspectResult(res);
      setSelectedSheetIndex(sheetIdx ?? Math.max(0, res.sheets.indexOf(res.active_sheet)));
      if (res.detected_entity === 'suppliers') {
        setEntityType('suppliers');
      } else if (res.detected_entity === 'customer_debts') {
        setEntityType('customer_debts');
      } else if (res.detected_entity === 'customers') {
        setEntityType('customers');
      } else if (res.detected_entity === 'opening_stock') {
        setEntityType('opening_stock');
      } else {
        setEntityType('products');
      }

      // Initialize mapping overrides from detected scores
      const initialOverrides: Record<number, string> = {};
      res.column_mappings.forEach((m) => {
        const matchedType = m.matched_type ?? m.mapped_column;
        if (matchedType) initialOverrides[m.column_index] = matchedType;
      });
      setColumnOverrides(initialOverrides);

      setStep('mapping');
    } catch (err: any) {
      console.error('Inspection error:', err);
      setErrorMsg(err.message || "Échec de l'inspection du fichier");
    } finally {
      setIsProcessing(false);
    }
  };

  // Stage batch
  const handleStageBatch = async () => {
    if (!inspectResult) return;
    setIsProcessing(true);
    setErrorMsg(null);

    try {
      if (!isTauriEnv()) {
        if (entityType === 'customer_debts') {
          throw new Error("L'import des soldes de dette nécessite l'application de bureau afin de garantir une transaction native.");
        }
        if (entityType === 'opening_stock') {
          throw new Error("L'import d'un instantané de stock nécessite l'application de bureau afin de vérifier les lots FIFO dans une transaction native.");
        }
        const mockStaging: ImportStageResponse = {
          batch: {
            batch_id: 'batch_web_' + Date.now(),
            file_name: inspectResult.file_name,
            file_sha256: inspectResult.file_sha256,
            entity_type: entityType,
            mapping_config_json: '{}',
            row_count: inspectResult.total_rows,
            created_count: inspectResult.total_rows,
            updated_count: 0,
            skipped_count: 0,
            rejected_count: 0,
            status: 'staged',
            created_at: new Date().toISOString(),
          },
          staged_rows: (inspectResult.preview_rows || []).map((row, idx) => ({
            batch_id: 'batch_web',
            row_index: idx,
            raw_row_json: JSON.stringify(row),
            normalized_json: null,
            action: 'create',
            warnings_json: '[]',
            needs_review: false,
            idempotency_key: `web_${idx}`,
          })),
        };
        setStagingResponse(mockStaging);
        setStep('staging');
        setIsProcessing(false);
        return;
      }

      const res = await stageImportFile({
        file_base64: fileBase64,
        file_name: inspectResult.file_name,
        sheet_index: selectedSheetIndex,
        encoding_override: encodingOverride,
        entity_type_override: entityType,
        column_overrides: columnOverrides,
      });

      setStagingResponse(res);
      setStep('staging');
    } catch (err: any) {
      console.error('Staging error:', err);
      setErrorMsg(err.message || 'Échec de la préparation des données');
    } finally {
      setIsProcessing(false);
    }
  };

  // Commit batch
  const handleCommitBatch = async () => {
    if (!stagingResponse) return;
    setIsProcessing(true);
    setErrorMsg(null);

    try {
      if (!isTauriEnv()) {
        const { db: dexieDb } = await import('../../db/database');
        const rows = inspectResult?.preview_rows || [];
        const colMap = columnOverrides;

        if (entityType === 'products' || entityType === 'opening_stock') {
          const { generateUniqueEan13Barcode, generateUniqueSku } = await import('../../utils/barcodeGenerator');
          const existingProds = await dexieDb.products.toArray();
          const existingTracker = existingProds.map((p) => ({ barcode: p.barcode, sku: p.sku }));
          const newProducts: any[] = [];
          const newStockBatches: any[] = [];
          const newLedgerRows: any[] = [];
          const newImeis: any[] = [];
          const currentVendors = { ...usePosStore.getState().vendorDirectory };
          let vendorUpdated = false;

          rows.forEach((row, idx) => {
            let title = '';
            let price = 0;
            let costPrice = 0;
            let stock = 0;
            let barcode = '';
            let sku = '';
            let brand = '';
            let category = '';
            let compatibleModel = '';
            let imei = '';
            let supplierName = '';
            let supplierPhone = '';

            row.forEach((cell, colIdx) => {
              const mapped = colMap[colIdx];
              if (mapped === 'title') title = cell.trim();
              else if (mapped === 'price') price = parseFloat(cell.replace(/[^0-9.-]+/g, '')) || 0;
              else if (mapped === 'cost_price') costPrice = parseFloat(cell.replace(/[^0-9.-]+/g, '')) || 0;
              else if (mapped === 'quantity') stock = parseFloat(cell.replace(/[^0-9.-]+/g, '')) || 0;
              else if (mapped === 'barcode') barcode = cell.trim();
              else if (mapped === 'sku') sku = cell.trim();
              else if (mapped === 'brand') brand = cell.trim();
              else if (mapped === 'category') category = cell.trim();
              else if (mapped === 'compatible_model') compatibleModel = cell.trim();
              else if (mapped === 'imei') imei = cell.trim();
              else if (mapped === 'supplier_name') supplierName = cell.trim();
              else if (mapped === 'supplier_phone') supplierPhone = cell.trim();
            });

            if (title) {
              const cat = category || inferCategoryFromTitleWeb(title);
              const brd = brand || inferBrandFromTitleWeb(title);
              const finalBarcode = barcode || generateUniqueEan13Barcode(existingTracker, '200');
              const finalSku = sku || (imei ? imei : generateUniqueSku(existingTracker, cat, brd));
              existingTracker.push({ barcode: finalBarcode, sku: finalSku });

              const prodId = `prod_web_${Date.now()}_${idx}`;
              const isSerialized = Boolean(imei);
              const finalVendor = supplierName || 'Fournisseur Général';

              newProducts.push({
                id: prodId,
                title,
                sku: finalSku,
                barcode: finalBarcode,
                price,
                costPrice,
                stock,
                category: cat,
                brand: brd,
                compatibleModel: compatibleModel || undefined,
                isSerialized,
                imeiNumber: imei || undefined,
                vendorName: finalVendor,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                deleted: 0,
                version: 1,
              });

              if (stock > 0) {
                const batchId = `sbatch_web_${Date.now()}_${idx}`;
                newStockBatches.push({
                  batchId,
                  productId: prodId,
                  quantityRemaining: stock,
                  unitCost: costPrice,
                  receivedAt: new Date().toISOString(),
                  version: 1,
                });

                newLedgerRows.push({
                  id: `ledg_web_${Date.now()}_${idx}`,
                  productId: prodId,
                  delta: stock,
                  reason: 'SEED',
                  refType: 'import_batch',
                  refId: 'web_batch',
                  createdAt: new Date().toISOString(),
                });
              }

              if (isSerialized && imei) {
                newImeis.push({
                  imei,
                  productId: prodId,
                  receivedAt: new Date().toISOString(),
                });
              }

              if (supplierName && !currentVendors[supplierName]) {
                currentVendors[supplierName] = {
                  phone: supplierPhone || undefined,
                  whatsapp: supplierPhone || undefined,
                  updatedAt: new Date().toISOString(),
                };
                vendorUpdated = true;
              }
            }
          });

          if (newProducts.length > 0) {
            await dexieDb.products.bulkPut(newProducts);
          }
          if (newStockBatches.length > 0 && dexieDb.stockBatches) {
            await dexieDb.stockBatches.bulkPut(newStockBatches);
          }
          if (newLedgerRows.length > 0 && dexieDb.inventoryLedger) {
            await dexieDb.inventoryLedger.bulkPut(newLedgerRows);
          }
          if (newImeis.length > 0 && dexieDb.imeiRecords) {
            await dexieDb.imeiRecords.bulkPut(newImeis);
          }
          if (vendorUpdated) {
            usePosStore.setState({ vendorDirectory: currentVendors });
          }

          const allProds = await dexieDb.products.toArray();
          usePosStore.setState({
            products: allProds,
            selectedCategory: 'Tous les produits',
            searchQuery: '',
          });
          window.dispatchEvent(new CustomEvent('mobi:catalog-reset-filters'));
        } else if (entityType === 'customers') {
          const newCusts: any[] = [];
          rows.forEach((row, idx) => {
            let name = '';
            let phone = '';

            row.forEach((cell, colIdx) => {
              const mapped = colMap[colIdx];
              if (mapped === 'customer_name' || mapped === 'title') name = cell.trim();
              else if (mapped === 'phone') phone = cell.trim();
            });

            if (name || phone) {
              const custId = `cust_web_${Date.now()}_${idx}`;
              newCusts.push({
                id: custId,
                name: name || 'Client',
                phone: phone || '',
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                deleted: 0,
                version: 1,
              });
            }
          });

          if (newCusts.length > 0) {
            await dexieDb.customers.bulkPut(newCusts);
          }
          const allCusts = await dexieDb.customers.toArray();
          const allDebts = await dexieDb.customerDebts.toArray();
          usePosStore.setState({
            customers: allCusts,
            customerDebts: allDebts,
          });
          window.dispatchEvent(new CustomEvent('mobi:catalog-reset-filters'));
        } else if (entityType === 'suppliers') {
          const currentVendors = { ...usePosStore.getState().vendorDirectory };
          rows.forEach((row) => {
            let supplierName = '';
            let phone = '';
            let email = '';
            row.forEach((cell, colIdx) => {
              const mapped = colMap[colIdx];
              if (mapped === 'supplier_name' || mapped === 'title' || mapped === 'customer_name') {
                supplierName = cell.trim();
              } else if (mapped === 'phone' || mapped === 'supplier_phone') {
                phone = cell.trim();
              } else if (mapped === 'email') {
                email = cell.trim();
              }
            });

            if (supplierName) {
              currentVendors[supplierName] = {
                phone: phone || currentVendors[supplierName]?.phone || undefined,
                whatsapp: phone || currentVendors[supplierName]?.whatsapp || undefined,
                email: email || currentVendors[supplierName]?.email || undefined,
                updatedAt: new Date().toISOString(),
              };
            }
          });
          usePosStore.setState({ vendorDirectory: currentVendors });
        }

        const mockCommit: CommitResult = {
          batch_id: stagingResponse.batch.batch_id,
          parsed_count: stagingResponse.batch.row_count,
          created_count: stagingResponse.batch.created_count,
          updated_count: stagingResponse.batch.updated_count,
          skipped_count: stagingResponse.batch.skipped_count,
          rejected_count: stagingResponse.batch.rejected_count,
        };
        setCommitResult(mockCommit);
        setStep('success');
        showToast('Données importées avec succès !', 'success');
        setIsProcessing(false);
        return;
      }

      let commitCompleted = false;
      try {
        const res = await commitImportBatch(stagingResponse.batch.batch_id);
        commitCompleted = true;

        const { productAdapter } = await import('../../db/adapters/productAdapter');
        const { customerAdapter } = await import('../../db/adapters/customerAdapter');
        const [freshProducts, freshCustomers, freshDebts] = await Promise.all([
          productAdapter.getAllProducts(),
          customerAdapter.getAllCustomers(),
          customerAdapter.getAllCustomerDebts(),
        ]);
        usePosStore.setState({
          products: freshProducts,
          customers: freshCustomers,
          customerDebts: freshDebts,
          selectedCategory: 'Tous les produits',
          searchQuery: '',
        });
        window.dispatchEvent(new CustomEvent('mobi:catalog-reset-filters'));
        await refreshAfterPull();

        setCommitResult(res);
        setStep('success');
        showToast(`${res.created_count} créés, ${res.updated_count} mis à jour avec succès !`, 'success');
      } catch (err: any) {
        if (commitCompleted) {
          throw new Error(`Import enregistré, mais le rafraîchissement des données de l'interface a échoué : ${err.message || err}`);
        }
        throw err;
      }
    } catch (err: any) {
      console.error('Commit error:', err);
      setErrorMsg(err.message || "Échec de l'importation finale dans la base de données");
    } finally {
      setIsProcessing(false);
    }
  };

  const handleFinishAndClose = async () => {
    try {
      const { productAdapter } = await import('../../db/adapters/productAdapter');
      const freshProducts = await productAdapter.getAllProducts();
      const { customerAdapter } = await import('../../db/adapters/customerAdapter');
      const freshCustomers = await customerAdapter.getAllCustomers();
      const freshDebts = await customerAdapter.getAllCustomerDebts();
      usePosStore.setState({
        products: freshProducts,
        customers: freshCustomers,
        customerDebts: freshDebts,
        selectedCategory: 'Tous les produits',
        searchQuery: '',
      });
      window.dispatchEvent(new CustomEvent('mobi:catalog-reset-filters'));
    } catch (err) {
      console.warn('Direct store refresh failed on finish:', err);
    }
    closeModal();
  };

  const handleSwitchEntityType = (
    newType: 'products' | 'opening_stock' | 'customers' | 'customer_debts' | 'suppliers',
  ) => {
    if (newType === entityType) return;
    setEntityType(newType);
    if (!inspectResult) return;
    const newOverrides: Record<number, string> = {};
    (inspectResult.column_mappings || []).forEach((m) => {
      const h = (m.original_header || '').toLowerCase().trim();
      if (newType === 'customers' || newType === 'customer_debts') {
        if (h.includes('nom') || h.includes('client') || h.includes('customer') || h.includes('prenom')) {
          newOverrides[m.column_index] = 'customer_name';
        } else if (h.includes('tel') || h.includes('tél') || h.includes('phone') || h.includes('mobile')) {
          newOverrides[m.column_index] = 'phone';
        } else if (h.includes('dette') || h.includes('debt') || h.includes('solde') || h.includes('reste')) {
          newOverrides[m.column_index] = 'debt_balance';
        } else if (h.includes('mail')) {
          newOverrides[m.column_index] = 'email';
        } else if (h.includes('adr')) {
          newOverrides[m.column_index] = 'address';
        } else if (h.includes('note') || h.includes('remarque')) {
          newOverrides[m.column_index] = 'notes';
        } else {
          newOverrides[m.column_index] = 'ignored';
        }
      } else if (newType === 'suppliers') {
        if (h.includes('fourn') || h.includes('supplier') || h.includes('nom') || h.includes('grossiste') || h.includes('societe') || h.includes('ets')) {
          newOverrides[m.column_index] = 'supplier_name';
        } else if (h.includes('tel') || h.includes('tél') || h.includes('phone') || h.includes('mobile')) {
          newOverrides[m.column_index] = 'phone';
        } else if (h.includes('mail')) {
          newOverrides[m.column_index] = 'email';
        } else if (h.includes('adr') || h.includes('ville')) {
          newOverrides[m.column_index] = 'address';
        } else if (h.includes('note') || h.includes('remarque')) {
          newOverrides[m.column_index] = 'notes';
        } else {
          newOverrides[m.column_index] = 'ignored';
        }
      } else {
        if (h.includes('title') || h.includes('design') || h.includes('désign') || h.includes('produit') || h.includes('titre') || h.includes('libell') || h.includes('article') || h.includes('item') || h.includes('description')) {
          newOverrides[m.column_index] = 'title';
        } else if (h.includes('barre') || h.includes('barcode') || h.includes('ean') || h.includes('cb') || h.includes('upc')) {
          newOverrides[m.column_index] = 'barcode';
        } else if (h.includes('imei') || h.includes('série') || h.includes('serie')) {
          newOverrides[m.column_index] = 'imei';
        } else if (h.includes('achat') || h.includes('purchase') || h.includes('buy') || h.includes('cost') || h.includes('cout') || h.includes('coût') || h.includes('pa')) {
          newOverrides[m.column_index] = 'cost_price';
        } else if (h.includes('vente') || h.includes('selling') || h.includes('sale') || h.includes('price') || h.includes('prix') || h.includes('pv') || h.includes('tarif')) {
          newOverrides[m.column_index] = 'price';
        } else if (h.includes('stock') || h.includes('quantity') || h.includes('qty') || h.includes('qte') || h.includes('quantit') || h.includes('dispo')) {
          newOverrides[m.column_index] = 'quantity';
        } else if (h.includes('ref') || h.includes('réf') || h.includes('sku')) {
          newOverrides[m.column_index] = 'sku';
        } else if (h.includes('fourn') && (h.includes('tel') || h.includes('phone'))) {
          newOverrides[m.column_index] = 'supplier_phone';
        } else if (h.includes('fourn') || h.includes('supplier')) {
          newOverrides[m.column_index] = 'supplier_name';
        } else if (h.includes('marque') || h.includes('brand')) {
          newOverrides[m.column_index] = 'brand';
        } else if (h.includes('cat')) {
          newOverrides[m.column_index] = 'category';
        } else if (h.includes('model') || h.includes('modèle')) {
          newOverrides[m.column_index] = 'compatible_model';
        } else if (h.includes('garanti')) {
          newOverrides[m.column_index] = 'warranty';
        } else {
          newOverrides[m.column_index] = 'ignored';
        }
      }
    });
    setColumnOverrides(newOverrides);
  };

  const handlePasteClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text || !text.trim()) {
        showToast('Presse-papiers vide', 'warning');
        return;
      }
      const blob = new Blob([text], { type: 'text/tab-separated-values' });
      const file = new File([blob], 'presse_papiers.tsv', { type: 'text/tab-separated-values' });
      handleFileSelected(file);
    } catch {
      showToast('Impossible de lire le presse-papiers', 'error');
    }
  };

  const optionsList =
    entityType === 'products' || entityType === 'opening_stock'
      ? PRODUCT_COLUMN_OPTIONS
      : entityType === 'suppliers'
      ? SUPPLIER_COLUMN_OPTIONS
      : entityType === 'customer_debts'
      ? CUSTOMER_DEBT_COLUMN_OPTIONS
      : CUSTOMER_COLUMN_OPTIONS;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Import intelligent de données"
      className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-2 sm:p-4 select-none animate-in fade-in"
    >
      <div className="bg-pos-panel border border-pos-border rounded-2xl w-full max-w-5xl shadow-2xl flex flex-col h-[92dvh] overflow-hidden">
        {/* ═══ Header ═══ */}
        <div className="p-4 border-b border-pos-border flex items-center justify-between bg-pos-card shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-cyan-500/20 flex items-center justify-center border border-cyan-500/30 shadow-md">
              <FileSpreadsheet className="w-5 h-5 text-cyan-400 stroke-[2.5]" />
            </div>
            <div>
              <h2 className="text-base font-extrabold text-pos-text tracking-wide flex items-center gap-2">
                <span>IMPORT INTELLIGENT DE DONNÉES</span>
                <span className="bg-cyan-500/20 text-cyan-400 text-[10px] font-bold px-2 py-0.5 rounded-full border border-cyan-500/30 flex items-center gap-1">
                  <Sparkles className="w-3 h-3" /> Multi-Formats
                </span>
              </h2>
              <p className="text-xs text-pos-muted">
                Importation sans effort depuis Excel (.xlsx, .xls), CSV, TSV, vCard, JSON ou SQL
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={step === 'success' ? handleFinishAndClose : closeModal}
            className="p-2 hover:bg-pos-hover text-pos-muted hover:text-pos-text rounded-xl transition cursor-pointer min-h-[44px] min-w-[44px] flex items-center justify-center"
            title="Fermer (Échap)"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* ═══ Wizard Steps Indicator ═══ */}
        <div className="px-6 py-3 bg-pos-bg border-b border-pos-border/40 flex items-center justify-between text-xs font-bold shrink-0">
          <div className={`flex items-center gap-2 ${step === 'upload' ? 'text-cyan-400' : 'text-pos-muted'}`}>
            <span className="w-6 h-6 rounded-full border flex items-center justify-center text-xs">1</span>
            <span>Sélection du Fichier</span>
          </div>
          <ArrowRight className="w-4 h-4 text-pos-muted/40" />
          <div className={`flex items-center gap-2 ${step === 'mapping' ? 'text-cyan-400' : 'text-pos-muted'}`}>
            <span className="w-6 h-6 rounded-full border flex items-center justify-center text-xs">2</span>
            <span>Mappage & Détection</span>
          </div>
          <ArrowRight className="w-4 h-4 text-pos-muted/40" />
          <div className={`flex items-center gap-2 ${step === 'staging' ? 'text-cyan-400' : 'text-pos-muted'}`}>
            <span className="w-6 h-6 rounded-full border flex items-center justify-center text-xs">3</span>
            <span>Préparation & Conflits</span>
          </div>
          <ArrowRight className="w-4 h-4 text-pos-muted/40" />
          <div className={`flex items-center gap-2 ${step === 'success' ? 'text-emerald-400' : 'text-pos-muted'}`}>
            <span className="w-6 h-6 rounded-full border flex items-center justify-center text-xs">4</span>
            <span>Terminé</span>
          </div>
        </div>

        {/* ═══ Error Banner ═══ */}
        {errorMsg && (
          <div className="m-4 mb-0 p-3 bg-red-500/10 border border-red-500/30 rounded-xl flex items-center gap-3 text-red-400 text-xs font-bold shrink-0">
            <AlertCircle className="w-5 h-5 shrink-0" />
            <span className="flex-1">{errorMsg}</span>
            <button
              type="button"
              onClick={() => setErrorMsg(null)}
              className="hover:underline text-red-300"
            >
              Fermer
            </button>
          </div>
        )}

        {/* ═══ Content Body ═══ */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-6 flex flex-col">
          {/* STEP 1: Upload */}
          {step === 'upload' && (
            <div className="flex-1 flex flex-col items-center justify-center max-w-xl mx-auto w-full text-center space-y-6">
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                accept=".xlsx,.xls,.csv,.tsv,.txt,.vcf,.json,.jsonl,.sql,.dbf"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleFileSelected(file);
                }}
              />

              <div
                onClick={() => fileInputRef.current?.click()}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  const file = e.dataTransfer.files?.[0];
                  if (file) handleFileSelected(file);
                }}
                className="w-full border-2 border-dashed border-pos-border hover:border-cyan-500/50 bg-pos-card/50 hover:bg-pos-card rounded-2xl p-8 sm:p-12 transition-all cursor-pointer flex flex-col items-center justify-center group"
              >
                <div className="w-16 h-16 rounded-2xl bg-cyan-500/10 group-hover:bg-cyan-500/20 text-cyan-400 flex items-center justify-center mb-4 transition-all">
                  <Upload className="w-8 h-8 stroke-[2.2]" />
                </div>
                <h3 className="text-base font-bold text-pos-text mb-1">
                  Glissez-déposez votre fichier ici
                </h3>
                <p className="text-xs text-pos-muted mb-4">
                  ou cliquez pour parcourir les dossiers de votre ordinateur
                </p>
                <div className="flex flex-wrap gap-1.5 justify-center max-w-md">
                  {['.XLSX', '.XLS', '.CSV', '.TSV', '.VCF', '.JSON', '.SQL', '.DBF'].map((ext) => (
                    <span
                      key={ext}
                      className="text-[10px] font-bold px-2 py-0.5 rounded bg-pos-bg border border-pos-border text-pos-muted"
                    >
                      {ext}
                    </span>
                  ))}
                </div>
              </div>

              <div className="flex items-center gap-3 w-full">
                <div className="h-px bg-pos-border flex-1" />
                <span className="text-xs text-pos-muted font-bold">OU</span>
                <div className="h-px bg-pos-border flex-1" />
              </div>

              <button
                type="button"
                onClick={handlePasteClipboard}
                className="w-full py-3 px-4 rounded-xl border border-pos-border hover:border-cyan-500/40 bg-pos-card hover:bg-pos-hover text-pos-text text-xs font-bold flex items-center justify-center gap-2 transition cursor-pointer"
              >
                <Clipboard className="w-4 h-4 text-cyan-400" />
                <span>Coller le contenu du presse-papiers (tableau Excel copié)</span>
              </button>
            </div>
          )}

          {/* STEP 2: Mapping & Preview */}
          {step === 'mapping' && inspectResult && (
            <div className="space-y-6">
              {/* File Info Bar & Sheet selector */}
              <div className="p-4 bg-pos-card border border-pos-border rounded-xl flex flex-wrap items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <FileText className="w-6 h-6 text-cyan-400" />
                  <div>
                    <h4 className="text-sm font-bold text-pos-text">{inspectResult.file_name}</h4>
                    <p className="text-xs text-pos-muted">
                      {inspectResult.total_rows} ligne(s) détectée(s) • SHA-256 : {inspectResult.file_sha256.slice(0, 12)}…
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-4">
                  {inspectResult.detected_encoding && (
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-bold text-pos-muted">Encodage :</span>
                      <span data-testid="import-detected-encoding" className="text-xs text-pos-text">
                        {inspectResult.detected_encoding}
                      </span>
                      <select
                        aria-label="Remplacer l'encodage du fichier"
                        value={encodingOverride ?? 'auto'}
                        onChange={(event) => {
                          const selected = event.target.value === 'auto' ? undefined : event.target.value;
                          setEncodingOverride(selected);
                          runInspection(
                            fileBase64,
                            inspectResult.file_name,
                            selectedSheetIndex,
                            selected,
                          );
                        }}
                        className="bg-pos-bg border border-pos-border text-xs rounded-lg px-2.5 py-1.5 text-pos-text"
                      >
                        <option value="auto">Auto</option>
                        <option value="UTF-8">UTF-8</option>
                        <option value="UTF-16LE">UTF-16LE</option>
                        <option value="UTF-16BE">UTF-16BE</option>
                        <option value="WINDOWS-1252">Windows-1252</option>
                        <option value="WINDOWS-1256">Windows-1256</option>
                      </select>
                    </div>
                  )}
                  {/* Sheets dropdown if multi-sheet */}
                  {inspectResult.sheets.length > 1 && (
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-bold text-pos-muted">Feuille :</span>
                      <select
                        value={selectedSheetIndex}
                        onChange={(e) => {
                          const idx = parseInt(e.target.value, 10);
                          setSelectedSheetIndex(idx);
                          runInspection(fileBase64, inspectResult.file_name, idx, encodingOverride);
                        }}
                        className="bg-pos-bg border border-pos-border text-xs rounded-lg px-2.5 py-1.5 text-pos-text font-bold"
                      >
                        {inspectResult.sheets.map((sheet, idx) => (
                          <option key={idx} value={idx}>
                            {sheet}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  {/* Entity Type Selector */}
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-pos-muted">Type de données :</span>
                    <div className="flex flex-wrap rounded-lg border border-pos-border overflow-hidden">
                      <button
                        type="button"
                        onClick={() => handleSwitchEntityType('products')}
                        className={`px-3 py-1.5 text-xs font-bold flex items-center gap-1.5 transition ${
                          entityType === 'products'
                            ? 'bg-cyan-500 text-black'
                            : 'bg-pos-bg text-pos-muted hover:text-pos-text'
                        }`}
                      >
                        <ShoppingBag className="w-3.5 h-3.5" />
                        <span>Produits</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => handleSwitchEntityType('opening_stock')}
                        className={`px-3 py-1.5 text-xs font-bold flex items-center gap-1.5 transition ${
                          entityType === 'opening_stock'
                            ? 'bg-cyan-500 text-black'
                            : 'bg-pos-bg text-pos-muted hover:text-pos-text'
                        }`}
                      >
                        <Database className="w-3.5 h-3.5" />
                        <span>Stock</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => handleSwitchEntityType('customers')}
                        className={`px-3 py-1.5 text-xs font-bold flex items-center gap-1.5 transition ${
                          entityType === 'customers'
                            ? 'bg-cyan-500 text-black'
                            : 'bg-pos-bg text-pos-muted hover:text-pos-text'
                        }`}
                      >
                        <Users className="w-3.5 h-3.5" />
                        <span>Clients</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => handleSwitchEntityType('customer_debts')}
                        className={`px-3 py-1.5 text-xs font-bold flex items-center gap-1.5 transition ${
                          entityType === 'customer_debts'
                            ? 'bg-cyan-500 text-black'
                            : 'bg-pos-bg text-pos-muted hover:text-pos-text'
                        }`}
                      >
                        <FileText className="w-3.5 h-3.5" />
                        <span>Dettes</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => handleSwitchEntityType('suppliers')}
                        className={`px-3 py-1.5 text-xs font-bold flex items-center gap-1.5 transition ${
                          entityType === 'suppliers'
                            ? 'bg-cyan-500 text-black'
                            : 'bg-pos-bg text-pos-muted hover:text-pos-text'
                        }`}
                      >
                        <Building2 className="w-3.5 h-3.5" />
                        <span>Fournisseurs</span>
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              {/* Warnings Pill Box */}
              {inspectResult.warnings.length > 0 && (
                <div className="p-3.5 bg-amber-500/10 border border-amber-500/30 rounded-xl space-y-1">
                  <div className="text-xs font-bold text-amber-400 flex items-center gap-1.5">
                    <AlertTriangle className="w-4 h-4" />
                    <span>Avertissements de détection ({inspectResult.warnings.length})</span>
                  </div>
                  <ul className="text-[11px] text-amber-300/90 pl-5 list-disc space-y-0.5">
                    {inspectResult.warnings.map((w, idx) => (
                      <li key={idx}>
                        <strong className="font-semibold">{w.code} :</strong> {w.message}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Auto-Generation Intelligence Callout */}
              {(entityType === 'products' || entityType === 'opening_stock') && (
                <div className="p-3 bg-cyan-500/10 border border-cyan-500/30 rounded-xl flex items-center gap-3 text-cyan-300 text-xs">
                  <Sparkles className="w-4 h-4 text-cyan-400 shrink-0" />
                  <div>
                    <span className="font-bold">Génération Automatique Intelligente : </span>
                    <span>
                      {!Object.values(columnOverrides).includes('barcode') && !Object.values(columnOverrides).includes('sku')
                        ? 'Aucun code-barres ni référence SKU détecté dans votre fichier. Des codes-barres EAN-13 GS1 conformes et des références SKU structurées sont automatiquement générés pour chaque article.'
                        : !Object.values(columnOverrides).includes('barcode')
                        ? 'Des codes-barres EAN-13 GS1 uniques sont automatiquement générés pour tous les produits sans code-barres.'
                        : 'Des références SKU structurées par catégorie sont automatiquement générées pour tous les articles sans SKU.'}
                    </span>
                  </div>
                </div>
              )}

              {entityType === 'customers' &&
                Object.values(columnOverrides).includes('debt_balance') && (
                  <div
                    role="alert"
                    className="p-3 bg-amber-500/10 border border-amber-500/30 rounded-xl flex items-start gap-3 text-amber-200 text-xs"
                  >
                    <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                    <span>
                      Cette feuille contient un solde de dette. Il ne sera pas appliqué à une fiche client;
                      les lignes seront mises en quarantaine. Pour importer un solde d'ouverture vérifié,
                      choisissez <strong>Dettes</strong>.
                    </span>
                  </div>
                )}

              {entityType === 'customer_debts' && (
                <div className="p-3 bg-amber-500/10 border border-amber-500/30 rounded-xl flex items-start gap-3 text-amber-200 text-xs">
                  <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                  <span>
                    Import de soldes d'ouverture, pas d'historique de paiements. Le solde cible est vérifié
                    contre le registre client; les registres non nuls ou incohérents sont refusés. Cette
                    opération ne crée ni encaissement ni effet de caisse.
                  </span>
                </div>
              )}

              {entityType === 'opening_stock' && (
                <div className="p-3 bg-amber-500/10 border border-amber-500/30 rounded-xl flex items-start gap-3 text-amber-200 text-xs">
                  <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                  <span>
                    La quantité est un instantané absolu, pas une réception. Toute hausse exige un coût unitaire
                    connu et une concordance avec les lots FIFO. Pour enregistrer une facture fournisseur,
                    utilisez une destination de réception dédiée lorsqu'elle est disponible.
                  </span>
                </div>
              )}

              {/* Column Mapping Grid */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="text-sm font-bold text-pos-text flex items-center gap-2">
                    <span>Mappage des Colonnes</span>
                    <span className="text-xs font-normal text-pos-muted">
                      (Vérifiez ou modifiez la destination de chaque colonne)
                    </span>
                  </h4>
                </div>

                <div className="border border-pos-border rounded-xl overflow-hidden divide-y divide-pos-border bg-pos-card">
                  {inspectResult.column_mappings.map((col) => {
                    const currentVal = columnOverrides[col.column_index] ?? col.matched_type ?? col.mapped_column ?? 'ignored';
                    const isAutomated = col.tier === 'Automated';

                    return (
                      <div
                        key={col.column_index}
                        className="p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:bg-pos-hover/30 transition"
                      >
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="text-xs font-extrabold text-pos-text truncate">
                              {col.source_header || `Colonne ${col.column_index + 1}`}
                            </span>
                            {isAutomated ? (
                              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 flex items-center gap-1">
                                <Check className="w-2.5 h-2.5" /> {Math.round(col.confidence * 100)}%
                              </span>
                            ) : (
                              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 border border-amber-500/30">
                                À confirmer
                              </span>
                            )}
                          </div>
                          <div className="text-[11px] text-pos-muted truncate">
                            Exemples : {(col.sample_values || []).slice(0, 3).join(', ') || '—'}
                          </div>
                        </div>

                        <div className="w-full sm:w-72 shrink-0">
                          <select
                            value={currentVal}
                            onChange={(e) => {
                              setColumnOverrides((prev) => ({
                                ...prev,
                                [col.column_index]: e.target.value,
                              }));
                            }}
                            className={`w-full text-xs font-bold rounded-lg px-3 py-2 border ${
                              currentVal !== 'ignored'
                                ? 'bg-pos-bg border-cyan-500/40 text-cyan-400'
                                : 'bg-pos-card border-pos-border text-pos-muted'
                            }`}
                          >
                            {optionsList.map((opt) => (
                              <option
                                key={opt.value}
                                value={opt.value}
                                disabled={opt.value === 'debt_balance' && entityType === 'customers'}
                              >
                                {opt.label}
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Data Preview Table */}
              <div className="space-y-3">
                <h4 className="text-sm font-bold text-pos-text flex items-center gap-2">
                  <Eye className="w-4 h-4 text-cyan-400" />
                  <span>Aperçu des 3 premières lignes</span>
                </h4>
                <div className="border border-pos-border rounded-xl overflow-x-auto bg-pos-card">
                  <table className="w-full text-left text-xs border-collapse">
                    <thead>
                      <tr className="border-b border-pos-border bg-pos-bg">
                        {inspectResult.headers.map((h, i) => (
                          <th key={i} className="p-2.5 font-bold text-pos-text whitespace-nowrap">
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-pos-border">
                      {inspectResult.preview_rows.map((row, rowIdx) => (
                        <tr key={rowIdx} className="hover:bg-pos-hover/30">
                          {row.map((cell, cellIdx) => (
                            <td key={cellIdx} className="p-2.5 text-pos-muted whitespace-nowrap">
                              {cell || '—'}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* STEP 3: Staging Review */}
          {step === 'staging' && stagingResponse && (
            <div className="space-y-6 max-w-2xl mx-auto w-full py-4">
              {stagingResponse.staged_rows.some(
                (row) => row.action === 'reject' || row.needs_review,
              ) && (
                <section
                  aria-label="Lignes à vérifier ou mises en quarantaine"
                  className="p-4 bg-amber-500/10 border border-amber-500/30 rounded-xl space-y-3"
                >
                  <h4 className="text-sm font-bold text-amber-300">
                    Lignes à vérifier ou mises en quarantaine (
                    {
                      stagingResponse.staged_rows.filter(
                        (row) => row.action === 'reject' || row.needs_review,
                      ).length
                    }
                    )
                  </h4>
                  <ul className="max-h-56 overflow-y-auto space-y-2 text-xs">
                    {stagingResponse.staged_rows
                      .filter((row) => row.action === 'reject' || row.needs_review)
                      .map((row) => (
                        <li
                          key={row.row_index}
                          className="rounded-lg border border-amber-500/20 bg-pos-card/70 p-2.5"
                        >
                          <div className="font-bold text-pos-text">
                            Ligne source {row.row_index + 1}
                            <span className="ml-2 text-[10px] uppercase text-amber-300">
                              {row.action === 'reject' ? 'Quarantaine' : 'À vérifier'}
                            </span>
                          </div>
                          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-amber-200/90">
                            {stagingRowMessages(row).map((message, index) => (
                              <li key={`${row.row_index}-${index}`}>{message}</li>
                            ))}
                          </ul>
                        </li>
                      ))}
                  </ul>
                </section>
              )}

              <div className="text-center space-y-2">
                <div className="w-12 h-12 rounded-2xl bg-cyan-500/20 text-cyan-400 flex items-center justify-center mx-auto border border-cyan-500/30">
                  <Database className="w-6 h-6" />
                </div>
                <h3 className="text-base font-extrabold text-pos-text">
                  Données Préparées & Vérifiées
                </h3>
                <p className="text-xs text-pos-muted">
                  Vérification des conflits avec la base de données terminée. Prêt à appliquer les modifications.
                </p>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="p-4 rounded-xl bg-pos-card border border-pos-border text-center">
                  <div className="text-2xl font-black text-pos-text">{stagingResponse.batch.row_count}</div>
                  <div className="text-[11px] font-bold text-pos-muted uppercase tracking-wider mt-1">Total Lignes</div>
                </div>
                <div className="p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-center">
                  <div className="text-2xl font-black text-emerald-400">{stagingResponse.batch.created_count}</div>
                  <div className="text-[11px] font-bold text-emerald-400 uppercase tracking-wider mt-1">À Créer</div>
                </div>
                <div className="p-4 rounded-xl bg-blue-500/10 border border-blue-500/30 text-center">
                  <div className="text-2xl font-black text-blue-400">{stagingResponse.batch.updated_count}</div>
                  <div className="text-[11px] font-bold text-blue-400 uppercase tracking-wider mt-1">Mises à Jour</div>
                </div>
                <div className="p-4 rounded-xl bg-pos-card border border-pos-border text-center">
                  <div className="text-2xl font-black text-pos-muted">{stagingResponse.batch.skipped_count + stagingResponse.batch.rejected_count}</div>
                  <div className="text-[11px] font-bold text-pos-muted uppercase tracking-wider mt-1">Ignorés / Rejetés</div>
                </div>
              </div>

              <div className="p-4 bg-pos-card border border-pos-border rounded-xl space-y-2 text-xs text-pos-muted">
                <div className="flex items-center gap-2 font-bold text-pos-text">
                  <Info className="w-4 h-4 text-cyan-400" />
                  <span>Détails de l'application</span>
                </div>
                {entityType === 'customer_debts' ? (
                  <p>
                    • Les soldes importés sont enregistrés comme historique d'ouverture et ne modifient ni la caisse,
                    ni les paiements, ni le crédit magasin.
                  </p>
                ) : entityType === 'opening_stock' ? (
                  <p>
                    • Le stock cible remplace l'instantané actuel; le système vérifie les lots FIFO et ne crée
                    jamais de réception, dette fournisseur ou mouvement de caisse.
                  </p>
                ) : (
                  <>
                    <p>
                      • Les nouveaux produits seront créés avec leurs prix, codes-barres et quantités en stock initial (lot de stock traçable).
                    </p>
                    <p>
                      • Les produits existants (même code-barres) seront mis à jour sans écraser les données non renseignées.
                    </p>
                  </>
                )}
                <p>
                  • La transaction est strictement atomique : tout réussit ou rien n'est modifié.
                </p>
              </div>
            </div>
          )}

          {/* STEP 4: Success */}
          {step === 'success' && commitResult && (
            <div className="flex-1 flex flex-col items-center justify-center max-w-lg mx-auto text-center space-y-6">
              <div className="w-16 h-16 rounded-3xl bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 flex items-center justify-center animate-in zoom-in-75">
                <CheckCircle2 className="w-10 h-10 stroke-[2.5]" />
              </div>

              <div className="space-y-2">
                <h3 className="text-lg font-black text-pos-text">
                  Importation Terminée avec Succès !
                </h3>
                <p className="text-xs text-pos-muted">
                  Toutes les données ont été validées et enregistrées de manière permanente dans votre caisse.
                </p>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 w-full">
                <div className="p-4 rounded-xl bg-pos-card border border-pos-border">
                  <div className="text-2xl font-extrabold text-pos-text">{commitResult.parsed_count}</div>
                  <div className="text-xs font-bold text-pos-muted mt-1">Total analysé</div>
                </div>
                <div className="p-4 rounded-xl bg-pos-card border border-pos-border">
                  <div className="text-2xl font-extrabold text-emerald-400">{commitResult.created_count}</div>
                  <div className="text-xs font-bold text-pos-muted mt-1">Nouveaux</div>
                </div>
                <div className="p-4 rounded-xl bg-pos-card border border-pos-border">
                  <div className="text-2xl font-extrabold text-blue-400">{commitResult.updated_count}</div>
                  <div className="text-xs font-bold text-pos-muted mt-1">Mis à jour</div>
                </div>
                <div className="p-4 rounded-xl bg-pos-card border border-pos-border">
                  <div className="text-2xl font-extrabold text-pos-muted">{commitResult.skipped_count}</div>
                  <div className="text-xs font-bold text-pos-muted mt-1">Ignorés</div>
                </div>
                <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/30">
                  <div className="text-2xl font-extrabold text-rose-400">{commitResult.rejected_count}</div>
                  <div className="text-xs font-bold text-rose-400 mt-1">Mis en quarantaine</div>
                </div>
              </div>

              <button
                type="button"
                onClick={handleFinishAndClose}
                className="w-full py-3.5 px-6 rounded-xl bg-cyan-500 hover:bg-cyan-400 active:scale-95 text-black font-extrabold text-xs tracking-wide transition shadow-lg cursor-pointer"
              >
                Fermer et retourner au logiciel
              </button>
            </div>
          )}
        </div>

        {/* ═══ Footer Action Buttons ═══ */}
        {step !== 'success' && (
          <div className="p-4 border-t border-pos-border bg-pos-card flex items-center justify-between shrink-0">
            {step === 'upload' ? (
              <div />
            ) : (
              <button
                type="button"
                onClick={() => {
                  if (step === 'mapping') setStep('upload');
                  if (step === 'staging') setStep('mapping');
                }}
                disabled={isProcessing}
                className="px-4 py-2.5 rounded-xl border border-pos-border hover:bg-pos-hover text-pos-text text-xs font-bold flex items-center gap-2 transition cursor-pointer disabled:opacity-50"
              >
                <ArrowLeft className="w-4 h-4" />
                <span>Retour</span>
              </button>
            )}

            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={closeModal}
                disabled={isProcessing}
                className="px-4 py-2.5 rounded-xl text-pos-muted hover:text-pos-text text-xs font-bold transition cursor-pointer"
              >
                Annuler
              </button>

              {step === 'mapping' && (
                <button
                  type="button"
                  onClick={handleStageBatch}
                  disabled={isProcessing}
                  className="px-6 py-2.5 rounded-xl bg-cyan-500 hover:bg-cyan-400 active:scale-95 text-black font-extrabold text-xs flex items-center gap-2 transition shadow-md cursor-pointer disabled:opacity-50"
                >
                  {isProcessing ? (
                    <>
                      <RefreshCw className="w-4 h-4 animate-spin" />
                      <span>Analyse en cours...</span>
                    </>
                  ) : (
                    <>
                      <span>Préparer l'importation</span>
                      <ArrowRight className="w-4 h-4" />
                    </>
                  )}
                </button>
              )}

              {step === 'staging' && (
                <button
                  type="button"
                  onClick={handleCommitBatch}
                  disabled={isProcessing}
                  className="px-6 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 active:scale-95 text-black font-extrabold text-xs flex items-center gap-2 transition shadow-md cursor-pointer disabled:opacity-50"
                >
                  {isProcessing ? (
                    <>
                      <RefreshCw className="w-4 h-4 animate-spin" />
                      <span>Importation en cours...</span>
                    </>
                  ) : (
                    <>
                      <Check className="w-4 h-4 stroke-[3]" />
                      <span>Confirmer et Importer dans la Caisse</span>
                    </>
                  )}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
