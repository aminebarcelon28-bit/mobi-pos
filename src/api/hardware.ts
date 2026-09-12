// Hardware API wrappers for thermal printer and cash drawer (rules.md R6.2)
import { invoke } from '@tauri-apps/api/core';
import { toApiError } from './error';

export async function printRawEscpos(printerName: string, data: Uint8Array | number[]): Promise<void> {
  try {
    const payload = Array.isArray(data) ? data : Array.from(data);
    await invoke('sqlite_print_raw_escpos', { printerName, data: payload });
  } catch (error) {
    throw toApiError(error, 'HARDWARE_ERROR');
  }
}

export async function openCashDrawer(printerName: string): Promise<void> {
  try {
    await invoke('sqlite_open_cash_drawer', { printerName });
  } catch (error) {
    throw toApiError(error, 'HARDWARE_ERROR');
  }
}

export async function updateCustomerDisplayVfd(
  portName: string,
  line1: string,
  line2: string
): Promise<void> {
  try {
    await invoke('hardware_update_vfd', {
      interface: {
        type: 'serial',
        port_name: portName,
        baud_rate: 9600,
      },
      item_title: line1.slice(0, 20),
      total_price_formatted: line2.slice(0, 20),
    });
  } catch (error) {
    throw toApiError(error, 'HARDWARE_ERROR');
  }
}

export async function scanHardwareDevices<T = unknown>(): Promise<T[]> {
  try {
    const list = await invoke<T[]>('hardware_scan_devices');
    return list || [];
  } catch (error) {
    throw toApiError(error, 'HARDWARE_ERROR');
  }
}

