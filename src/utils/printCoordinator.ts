export type PrintChannelType = 
  | 'receipt' 
  | 'label' 
  | 'purchase_order' 
  | 'z_report' 
  | 'repair_work_order' 
  | 'trade_in_voucher';

interface PrintJobOptions {
  delayMs?: number;
  onBeforePrint?: () => void;
  onAfterPrint?: () => void;
}

class PrintCoordinator {
  private isPrinting: boolean = false;
  private activeChannel: PrintChannelType | null = null;
  private cleanupTimer: any = null;

  /**
   * Returns whether a print job is currently underway
   */
  public getIsPrinting(): boolean {
    return this.isPrinting;
  }

  /**
   * Returns the currently active print channel (e.g., 'receipt', 'label', etc.)
   */
  public getActiveChannel(): PrintChannelType | null {
    return this.activeChannel;
  }

  /**
   * Executes an isolated, channel-targeted print job with strict mutex locking
   */
  public executePrint(
    channel: PrintChannelType,
    options: PrintJobOptions = {}
  ): boolean {
    if (this.isPrinting) {
      console.warn(`[PrintCoordinator] Print job rejected: Channel "${this.activeChannel}" is already printing.`);
      return false;
    }

    this.isPrinting = true;
    this.activeChannel = channel;

    // Apply strict target attribute to DOM root and body
    document.documentElement.setAttribute('data-print-channel', channel);
    document.body.setAttribute('data-print-channel', channel);

    if (options.onBeforePrint) {
      options.onBeforePrint();
    }

    const cleanup = () => {
      if (this.cleanupTimer) {
        clearTimeout(this.cleanupTimer);
        this.cleanupTimer = null;
      }
      
      document.documentElement.removeAttribute('data-print-channel');
      document.body.removeAttribute('data-print-channel');
      
      this.isPrinting = false;
      this.activeChannel = null;

      if (options.onAfterPrint) {
        options.onAfterPrint();
      }

      window.removeEventListener('afterprint', cleanup);
    };

    window.addEventListener('afterprint', cleanup, { once: true });

    // Fallback safety cleanup in case afterprint does not fire (some browser webviews)
    this.cleanupTimer = setTimeout(() => {
      cleanup();
    }, 2500);

    const delay = options.delayMs !== undefined ? options.delayMs : 50;

    setTimeout(() => {
      try {
        window.print();
      } catch (err) {
        console.error('[PrintCoordinator] window.print() execution error:', err);
        cleanup();
      }
    }, delay);

    return true;
  }

  /**
   * Explicit channel helpers
   */
  public printReceipt(delayMs: number = 80): boolean {
    return this.executePrint('receipt', { delayMs });
  }

  public printLabels(delayMs: number = 80): boolean {
    return this.executePrint('label', { delayMs });
  }

  public printPurchaseOrder(delayMs: number = 80): boolean {
    return this.executePrint('purchase_order', { delayMs });
  }

  public printZReport(delayMs: number = 80): boolean {
    return this.executePrint('z_report', { delayMs });
  }

  public printRepairWorkOrder(delayMs: number = 80): boolean {
    return this.executePrint('repair_work_order', { delayMs });
  }

  public printTradeInVoucher(delayMs: number = 80): boolean {
    return this.executePrint('trade_in_voucher', { delayMs });
  }
}

export const printCoordinator = new PrintCoordinator();

