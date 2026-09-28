// Hardware API wrappers for thermal printer and cash drawer (rules.md R6.2)
import { invokeCommand } from '../platform/invoke';

export async function printRawEscpos(printerName: string, data: Uint8Array | number[]): Promise<void> {
  const payload = Array.isArray(data) ? data : Array.from(data);
  await invokeCommand('sqlite_print_raw_escpos', { printerName, data: payload }, 'HARDWARE_ERROR');
}

export async function openCashDrawer(printerName: string): Promise<void> {
  await invokeCommand('sqlite_open_cash_drawer', { printerName }, 'HARDWARE_ERROR');
}

export async function updateCustomerDisplayVfd(
  portName: string,
  line1: string,
  line2: string
): Promise<void> {
  await invokeCommand(
    'hardware_update_vfd',
    {
      // B-055: top-level command args must be camelCase (Tauri default).
      // Nested VfdInterface fields stay snake_case (serde struct names).
      interface: {
        type: 'serial',
        port_name: portName,
        baud_rate: 9600,
      },
      itemTitle: line1.slice(0, 20),
      totalPriceFormatted: line2.slice(0, 20),
    },
    'HARDWARE_ERROR'
  );
}

export async function scanHardwareDevices<T = unknown>(): Promise<T[]> {
  const list = await invokeCommand<T[]>('hardware_scan_devices', undefined, 'HARDWARE_ERROR');
  return list || [];
}