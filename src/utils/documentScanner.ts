import { isTauriEnvironment, isAndroid, isIOS, isMobileDevice } from './platform';
import { invokeCommand } from '../platform/invoke';
import type { OcrBoundingBox, ProcessRawScanRequest } from '../types/po';

export interface NativeScanResult {
  success: boolean;
  isCancelled?: boolean;
  isPluginMissing?: boolean;
  error?: string;
  blocks?: OcrBoundingBox[];
}

/**
 * Returns true if the device environment supports native ML Kit / VisionKit camera document scanning.
 */
export function isNativeScannerSupported(): boolean {
  return isTauriEnvironment() && (isAndroid() || isIOS() || isMobileDevice());
}

/**
 * Helper to identify plugin missing or permission gate errors from Tauri.
 */
function isPluginMissingError(msg: string): boolean {
  return /plugin not found|not allowed|non disponible|unknown command|command not found/i.test(msg);
}

/**
 * Triggers the native Document Scanner UI on mobile (Android GMS / iOS VisionKit).
 * First calls the registered root Tauri command `mobile_scan_document`, then falls back
 * to `plugin:scanner|scanDocument`, with graceful error classification if uninstalled.
 */
export async function scanNativeDocument(): Promise<NativeScanResult> {
  if (!isTauriEnvironment()) {
    return {
      success: false,
      isPluginMissing: true,
      error: "Le scanner de documents natif nécessite l'application installée sur Android ou iOS.",
    };
  }

  // 1. Invoke direct root Tauri command `mobile_scan_document` (permitted by core:default)
  try {
    const res = await invokeCommand<{ blocks?: OcrBoundingBox[] } | OcrBoundingBox[]>(
      'mobile_scan_document',
      undefined,
      'HARDWARE_ERROR'
    );

    const blocks = Array.isArray(res) ? res : res?.blocks;
    if (Array.isArray(blocks) && blocks.length > 0) {
      return {
        success: true,
        blocks,
      };
    }

    return {
      success: false,
      error: 'Aucun texte ni tableau détecté sur le document.',
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err) || '';
    if (/cancel|annul|user cancel/i.test(msg)) {
      return {
        success: false,
        isCancelled: true,
      };
    }

    const isMissing = isPluginMissingError(msg);
    return {
      success: false,
      isPluginMissing: isMissing,
      error: isMissing
        ? "Le module caméra ML Kit n'est pas actif sur cet appareil (Google Play Services requis). Vous pouvez utiliser le bouton 'Facture Démo' ou saisir directement les lignes."
        : (msg || 'Échec de numérisation caméra'),
    };
  }
}

/**
 * Parses raw text or OCR string output into structured bounding boxes
 * positioned linearly along the Y-axis so `SpatialLayoutParser` can reconstruct
 * horizontal tabular lines and extract quantities, unit costs, and GTIN barcodes.
 */
export function parseTextToBoundingBoxes(rawText: string): OcrBoundingBox[] {
  const lines = rawText
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length === 0) {
    return [];
  }

  const boxes: OcrBoundingBox[] = [];
  const lineSpacing = 0.04;
  const initialY = 0.1;

  lines.forEach((lineStr, lineIdx) => {
    const y = initialY + lineIdx * lineSpacing;
    const h = 0.03;

    // Emitting the full trimmed line keeps all inner delimiters (pipes |, tabs \t, multi-spaces) intact
    boxes.push({
      text: lineStr,
      x: 0.05,
      y,
      w: 0.9,
      h,
      confidence: 0.99,
    });
  });

  return boxes;
}

/**
 * Generates a mathematically balanced demo invoice request for testing
 * invariant validation and GTIN matching on both desktop and mobile.
 *
 * Invariant Math:
 * Line 1: 5x @ 12,500.00 = 62,500.00 (GTIN: 4006381333931)
 * Line 2: 10x @ 3,200.00 = 32,000.00 (GTIN: 012000000133)
 * Line 3: 15x @ 2,500.00 = 37,500.00
 * Subtotal = 132,000.00
 * Freight = 3,250.00
 * Tax = 0.00
 * Grand Total = 135,250.00 (Delta = 0.00 -> Balanced!)
 */
export function generateDemoInvoiceScan(): ProcessRawScanRequest {
  const sampleLines = [
    'Écran OLED iPhone 13 4006381333931 5x 12500.00 62500.00',
    'Batterie Origine Samsung S21 012000000133 10x 3200.00 32000.00',
    'Chargeur Rapide 25W Type-C 15x 2500.00 37500.00',
  ];

  const boundingBoxes = parseTextToBoundingBoxes(sampleLines.join('\n'));

  return {
    supplier_name: 'Grossiste Mobile Alger',
    bounding_boxes: boundingBoxes,
    reported_tax: 0,
    reported_freight: 3250,
    reported_grand_total: 135250,
  };
}
