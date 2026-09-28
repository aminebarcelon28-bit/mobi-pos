/**
 * mobilePrinter — Wi-Fi (TCP 9100) + Bluetooth SPP direct printing from the
 * phone to any thermal/label printer (Xprinter, Rongta, Epson, Star,
 * Bixolon, Gprinter, TSC, Zebra…).
 *
 * The config is per-device (localStorage, never synced): a phone pairs with
 * its own counter printer. When no mobile printer is configured/enabled,
 * callers fall back to the Android system print sheet.
 */
import type { MobileLabelProtocol, MobilePrinterConfig } from '../types/pos';
import { EscPosBuilder } from './escpos';

const STORAGE_KEY = 'mobi_pos_mobile_printer_v1';
export const MOBILE_WIFI_DEFAULT_PORT = 9100;

export const DEFAULT_MOBILE_PRINTER: MobilePrinterConfig = {
  enabled: false,
  connection: 'wifi',
  wifiHost: '192.168.1.50',
  wifiPort: MOBILE_WIFI_DEFAULT_PORT,
  bluetoothName: '',
  bluetoothMac: '',
  labelProtocol: 'ESCPOS',
};

export function loadMobilePrinter(): MobilePrinterConfig {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
    if (!raw) return { ...DEFAULT_MOBILE_PRINTER };
    const parsed = JSON.parse(raw) as Partial<MobilePrinterConfig>;
    const labelProtocol: MobileLabelProtocol =
      parsed.labelProtocol === 'TSPL' || parsed.labelProtocol === 'ZPL' ? parsed.labelProtocol : 'ESCPOS';
    return {
      enabled: Boolean(parsed.enabled),
      connection: parsed.connection === 'bluetooth' ? 'bluetooth' : 'wifi',
      wifiHost: typeof parsed.wifiHost === 'string' && parsed.wifiHost.trim() ? parsed.wifiHost.trim() : DEFAULT_MOBILE_PRINTER.wifiHost,
      wifiPort:
        typeof parsed.wifiPort === 'number' && parsed.wifiPort >= 1 && parsed.wifiPort <= 65535
          ? Math.round(parsed.wifiPort)
          : MOBILE_WIFI_DEFAULT_PORT,
      bluetoothName: typeof parsed.bluetoothName === 'string' ? parsed.bluetoothName : '',
      bluetoothMac: typeof parsed.bluetoothMac === 'string' ? parsed.bluetoothMac.toUpperCase() : '',
      labelProtocol,
    };
  } catch {
    return { ...DEFAULT_MOBILE_PRINTER };
  }
}

export function saveMobilePrinter(config: MobilePrinterConfig): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    // Private-mode storage — config simply won't persist.
  }
}

function bytesToBase64(data: Uint8Array): string {
  // String.fromCharCode yields one Latin-1 char per byte: btoa-safe as-is.
  let binary = '';
  const CHUNK = 8192;
  for (let i = 0; i < data.length; i += CHUNK) {
    binary += String.fromCharCode(...data.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

async function getInvoke(): Promise<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>> {
  const mod = await import('../platform/invoke');
  return mod.invokeCommand as (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
}

export interface MobilePrintResult {
  sent: boolean;
  /** Machine reason for logs; user-facing text is built by callers. */
  reason?: string;
}

/**
 * Sends raw printer bytes to the configured mobile printer.
 * Returns `{ sent: false, reason: 'disabled' }` when none is configured —
 * callers then fall back to the Android print sheet.
 */
export async function printBytesViaMobilePrinter(data: Uint8Array): Promise<MobilePrintResult> {
  const config = loadMobilePrinter();
  if (!config.enabled) return { sent: false, reason: 'disabled' };
  if (!data || data.length === 0) return { sent: false, reason: 'empty' };

  try {
    const invokeCommand = await getInvoke();
    const payload = bytesToBase64(data);
    if (config.connection === 'bluetooth') {
      if (!config.bluetoothMac) return { sent: false, reason: 'no-bt-device' };
      // B-055: Tauri v2 deserializes command args as camelCase by default —
      // snake_case `data_base64` is dropped and the Rust command fails
      // missing-key on every mobile Bluetooth print.
      await invokeCommand('mobile_bluetooth_print', { mac: config.bluetoothMac, dataBase64: payload });
    } else {
      if (!config.wifiHost) return { sent: false, reason: 'no-wifi-host' };
      await invokeCommand('mobile_wifi_print', {
        host: config.wifiHost,
        port: config.wifiPort,
        dataBase64: payload,
      });
    }
    return { sent: true };
  } catch (error) {
    console.warn('[mobilePrinter] Direct print failed:', error);
    return { sent: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export interface BondedBtDevice {
  name: string;
  mac: string;
}

/** Printers already paired in Android settings (no scan/location needed). */
export async function listBondedBluetoothPrinters(): Promise<BondedBtDevice[]> {
  try {
    const invokeCommand = await getInvoke();
    const res = (await invokeCommand('mobile_bluetooth_printers')) as unknown as {
      devices?: Array<{ name?: string; mac?: string }>;
    } | null;
    const devices = Array.isArray(res?.devices) ? res.devices : [];
    return devices
      .filter((d) => typeof d?.mac === 'string' && d.mac)
      .map((d) => ({ name: typeof d.name === 'string' && d.name ? d.name : 'Imprimante', mac: (d.mac as string).toUpperCase() }));
  } catch (error) {
    console.warn('[mobilePrinter] Bluetooth list failed:', error);
    throw error;
  }
}

/** Short ESC/POS self-test page (store name + link check + cut). */
export function buildMobileTestPage(storeName: string, connectionLabel: string): Uint8Array {
  const b = new EscPosBuilder();
  b.init()
    .align('center')
    .bold(true)
    .text(storeName || 'MOBI-POS')
    .newline()
    .bold(false)
    .text('*** PAGE DE TEST ***')
    .newline()
    .text(connectionLabel)
    .newline()
    .text(new Date().toLocaleString('fr-DZ'))
    .newline(2)
    .text('Impression mobile OK')
    .newline(2)
    .feedCut();
  return b.build();
}
