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
 * Rust command that bridges to the native scanner.
 *
 * This is the app-level `#[tauri::command]`, NOT `plugin:scanner|scanDocument`.
 * The `scanner` Tauri plugin exists only to register the Android/iOS native
 * module — it declares no commands of its own, so the plugin-namespaced form
 * can never resolve and the ACL rejects it with
 * "Scanner.scanDocument not allowed. Plugin not found". Calling the app-level
 * command also keeps this out of the capability permission system entirely,
 * which is exactly why `scanner.rs` exposes both. See the module doc there.
 */
const SCAN_COMMAND = 'mobile_scan_document';

/** Command this build used before `mobile_scan_document` existed. */
const LEGACY_SCAN_COMMAND = 'plugin:scanner|scanDocument';

/**
 * True for the ACL/plugin-resolution failures that are a build wiring problem
 * rather than anything the operator did.
 */
function isPluginUnavailable(message: string): boolean {
  return /plugin not found|not allowed|plugin:\w+\|\w+.*not found/i.test(message);
}

/**
 * Triggers the native Document Scanner UI on mobile (Android GMS / iOS VisionKit).
 * Returns normalized bounding boxes for invoice reconciliation.
 */
export async function scanNativeDocument(): Promise<NativeScanResult> {
  if (!isTauriEnvironment()) {
    return {
      success: false,
      isPluginMissing: true,
      error: 'Le scanner de documents natif nécessite l\'exécution sur l\'application mobile installée.',
    };
  }

  try {
    const res = await invokeCommand<{ blocks: OcrBoundingBox[] }>(
      SCAN_COMMAND,
      undefined,
      'HARDWARE_ERROR'
    );

    if (!res || !Array.isArray(res.blocks) || res.blocks.length === 0) {
      return {
        success: false,
        error: 'Aucun texte ni tableau détecté sur le document.',
      };
    }

    return {
      success: true,
      blocks: res.blocks,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err) || 'Échec de numérisation';
    if (/cancel|annul|user cancel/i.test(message)) {
      return {
        success: false,
        isCancelled: true,
      };
    }
    // A native command that is absent is a build/wiring fault, not an operator
    // error. Say so plainly instead of surfacing a raw ACL string.
    const isPluginMissing = isPluginUnavailable(message);
    if (isPluginMissing) {
      if (import.meta.env.DEV) {
        console.error(
          `[scanner] « ${SCAN_COMMAND} » indisponible (${message}). ` +
            `Vérifier l'enregistrement de scanner::mobile_scan_document dans generate_handler! (src-tauri/src/lib.rs) ` +
            `et scanner::plugin() (src-tauri/src/scanner.rs). ` +
            `Lancienne commande « ${LEGACY_SCAN_COMMAND} » ne peut pas fonctionner : ` +
            `le plugin « scanner » ne déclare aucune commande.`,
        );
      }
      return {
        success: false,
        isPluginMissing: true,
        error:
          'Scanner natif indisponible sur ce build. Utilisez l’import de photo ou saisissez la facture manuellement.',
      };
    }
    return {
      success: false,
      error: message,
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
    const tokens = lineStr.split(/\s+/).filter((t) => t.length > 0);
    if (tokens.length === 0) return;

    const y = initialY + lineIdx * lineSpacing;
    const h = 0.03;
    const tokenCount = tokens.length;

    tokens.forEach((tok, tokIdx) => {
      const x = 0.05 + (tokIdx / Math.max(1, tokenCount)) * 0.88;
      const w = Math.min(0.2, Math.max(0.04, tok.length * 0.012));

      boxes.push({
        text: tok,
        x,
        y,
        w,
        h,
        confidence: 0.98,
      });
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

/**
 * Generates a real-world high-volume accessories invoice scan:
 * 5 accessory items (Apple 20W, iPhone 15 PM Case, Belkin Cable, Anker 735 GaN, Spigen Glass)
 * Total: 128,000.00 DA (Mathematically balanced)
 */
export function generateAccessoriesInvoiceScan(): ProcessRawScanRequest {
  const sampleLines = [
    'Apple Adaptateur Secteur 20W USB-C 194252157022 10x 3500.00 35000.00',
    'Coque Silicone iPhone 15 Pro Max MagSafe 15x 1800.00 27000.00',
    'Belkin Cable BoostCharge USB-C vers USB-C 2M 745883818310 20x 1200.00 24000.00',
    'Anker 735 Chargeur GaNPrime 65W 3-Ports 5x 6000.00 30000.00',
    'Protection Verre Trempé Galaxy S24 Ultra 10x 1200.00 12000.00',
  ];

  const boundingBoxes = parseTextToBoundingBoxes(sampleLines.join('\n'));

  return {
    supplier_name: 'Accessoires Express Bab El Oued',
    bounding_boxes: boundingBoxes,
    reported_tax: 0,
    reported_freight: 0,
    reported_grand_total: 128000,
  };
}

