export type PrintChannelType =
  | 'receipt'
  | 'label'
  | 'purchase_order'
  | 'z_report'
  | 'repair_work_order'
  | 'trade_in_voucher'
  | 'debt_statement'
  | 'loyalty_card'
  | 'credit_voucher'
  | 'text_doc';

/**
 * Hardware channels go to native drivers (ESC/POS spooler on desktop, PNG
 * sheet on mobile) BEFORE the coordinator runs — calling window.print() for
 * them would double-print. Document channels are HTML-only and must always
 * reach window.print(), including inside the desktop app.
 */
const HARDWARE_CHANNELS: ReadonlySet<PrintChannelType> = new Set(['receipt', 'label']);

function isMobileWebView(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || (navigator as Navigator & { vendor?: string }).vendor || '';
  return /android|iphone|ipad|ipod/i.test(ua);
}

interface PrintJobOptions {
  delayMs?: number;
  onBeforePrint?: () => void;
  onAfterPrint?: () => void;
}

class PrintCoordinator {
  private isPrinting: boolean = false;
  private activeChannel: PrintChannelType | null = null;
  private cleanupTimer: ReturnType<typeof setTimeout> | null = null;

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

    const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

    // Window.print() is suppressed ONLY for hardware channels inside Tauri
    // (already printed via spooler/native) and for every channel inside the
    // mobile WebView (no print dialog there — callers use native paths first).
    // Document channels inside the desktop app MUST reach window.print():
    // WebView2 opens the system dialog (any printer model, Save as PDF).
    const suppress =
      isTauri && (HARDWARE_CHANNELS.has(channel) || isMobileWebView());

    setTimeout(() => {
      try {
        if (!suppress) {
          window.print();
        } else {
          if (HARDWARE_CHANNELS.has(channel)) {
            console.log(`[PrintCoordinator] Direct hardware mode in Tauri for channel: ${channel} (window.print suppressed)`);
          }
          cleanup();
        }
      } catch (err) {
        console.error('[PrintCoordinator] print execution error:', err);
        cleanup();
      }
    }, delay);

    return true;
  }

  /**
   * Direct channel print that always calls window.print() — for HTML
   * documents (statements, cards) with no ESC/POS hardware route, including
   * inside the Tauri desktop WebView where `executePrint` stays silent.
   */
  public printChannelDirect(
    channel: PrintChannelType,
    delayMs: number = 150
  ): boolean {
    if (this.isPrinting) {
      console.warn(`[PrintCoordinator] Print job rejected: Channel "${this.activeChannel}" is already printing.`);
      return false;
    }

    this.isPrinting = true;
    this.activeChannel = channel;

    document.documentElement.setAttribute('data-print-channel', channel);
    document.body.setAttribute('data-print-channel', channel);

    const cleanup = () => {
      if (this.cleanupTimer) {
        clearTimeout(this.cleanupTimer);
        this.cleanupTimer = null;
      }
      document.documentElement.removeAttribute('data-print-channel');
      document.body.removeAttribute('data-print-channel');
      this.isPrinting = false;
      this.activeChannel = null;
      window.removeEventListener('afterprint', cleanup);
    };

    window.addEventListener('afterprint', cleanup, { once: true });
    this.cleanupTimer = setTimeout(cleanup, 5000);

    setTimeout(() => {
      try {
        window.print();
      } catch (err) {
        console.error('[PrintCoordinator] direct print execution error:', err);
        cleanup();
      }
    }, delayMs);

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

  /**
   * SAV restitution / quote A4 documents. Strict channel reuse: both render
   * inside the shared print-repair-target (selected by the caller's
   * printingDocKind state), so no new PrintChannelType or CSS is required.
   */
  public printRepairRestitution(delayMs: number = 80): boolean {
    return this.executePrint('repair_work_order', { delayMs });
  }

  public printRepairQuote(delayMs: number = 80): boolean {
    return this.executePrint('repair_work_order', { delayMs });
  }

  public printTradeInVoucher(delayMs: number = 80): boolean {
    return this.executePrint('trade_in_voucher', { delayMs });
  }

  public printDebtStatement(delayMs: number = 150): boolean {
    return this.executePrint('debt_statement', { delayMs });
  }

  public printLoyaltyCard(delayMs: number = 150): boolean {
    return this.executePrint('loyalty_card', { delayMs });
  }
}

export const printCoordinator = new PrintCoordinator();

