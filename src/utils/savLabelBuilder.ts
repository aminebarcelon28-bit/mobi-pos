/**
 * Professional Chassis Identification Sticker Generator (50x25mm / 40x20mm)
 * Supports: Native TSPL (TSC/Xprinter), ZPL (Zebra), and ESC/POS Fallback.
 * Author: Principal Systems Architect
 */
import type { RepairOrder } from '../types/pos';
import { EscPosBuilder } from './escpos';

export class SavLabelBuilder {
  public static buildTsplChassisLabel(order: RepairOrder): Uint8Array {
    const encoder = new TextEncoder();
    const cleanModel = order.deviceModel.slice(0, 22);
    const cleanCustomer = `${order.customerName.slice(0, 14)} (${(order.customerPhone || '').slice(-4)})`;
    const cleanDate = new Date(order.createdAt).toLocaleDateString('fr-DZ');

    const tsplCommands = [
      'SIZE 50 mm, 25 mm',
      'GAP 2 mm, 0 mm',
      'DIRECTION 1',
      'CLS',
      `TEXT 20,15,"2",0,1,1,"SAV: ${order.ticketNumber}"`,
      `TEXT 260,15,"1",0,1,1,"${cleanDate}"`,
      `TEXT 20,40,"3",0,1,1,"${cleanModel}"`,
      `BARCODE 20,70,"128",50,1,0,2,2,"${order.ticketNumber}"`,
      `TEXT 20,155,"1",0,1,1,"Client: ${cleanCustomer}"`,
      'PRINT 1,1',
      '',
    ].join('\r\n');

    return encoder.encode(tsplCommands);
  }

  public static buildZplChassisLabel(order: RepairOrder): Uint8Array {
    const encoder = new TextEncoder();
    const cleanModel = order.deviceModel.slice(0, 22);
    const cleanCustomer = `${order.customerName.slice(0, 14)} (${(order.customerPhone || '').slice(-4)})`;

    const zpl = [
      '^XA',
      '^PW400',
      '^LL200',
      '^FO20,15^A0N,25,25^FDSAV: ' + order.ticketNumber + '^FS',
      '^FO20,45^A0N,28,28^FD' + cleanModel + '^FS',
      '^FO20,80^BCN,45,Y,N,N^FD' + order.ticketNumber + '^FS',
      '^FO20,155^A0N,20,20^FDClient: ' + cleanCustomer + '^FS',
      '^XZ',
    ].join('\n');

    return encoder.encode(zpl);
  }

  public static buildEscPosMiniTag(order: RepairOrder): Uint8Array {
    const builder = new EscPosBuilder();
    builder
      .init()
      .align('center')
      .bold(true)
      .text('--- ÉTIQUETTE CHÂSSIS / BAC ---')
      .newline()
      .text(`TICKET : ${order.ticketNumber}`)
      .newline()
      .bold(false)
      .text(`${order.deviceModel} | ${order.customerName}`)
      .newline()
      .barcode(order.ticketNumber)
      .newline(2)
      .cut(false);

    return builder.build();
  }
}
