/**
 * Professional DZD Cash Tender & Change Calculation Engine
 * Author: Principal Systems Architect
 */
import type { CashTenderBreakdown } from '../types/pos';

export class CashTenderEngine {
  public static generateSmartShortcuts(totalDue: number): number[] {
    if (totalDue <= 0) return [0];
    const shortcuts: Set<number> = new Set();

    shortcuts.add(totalDue);

    const next500 = Math.ceil(totalDue / 500) * 500;
    if (next500 > totalDue) shortcuts.add(next500);

    const next1000 = Math.ceil(totalDue / 1000) * 1000;
    if (next1000 > totalDue) shortcuts.add(next1000);

    const next2000 = Math.ceil(totalDue / 2000) * 2000;
    if (next2000 > totalDue) shortcuts.add(next2000);

    if (totalDue < 5000) shortcuts.add(5000);
    if (totalDue < 10000 && totalDue > 5000) shortcuts.add(10000);

    return Array.from(shortcuts).sort((a, b) => a - b).slice(0, 5);
  }

  public static calculateTender(totalDue: number, cashTendered: number): CashTenderBreakdown {
    const safeTendered = Math.max(0, isNaN(cashTendered) ? 0 : cashTendered);
    const changeDue = Math.max(0, safeTendered - totalDue);
    const isFullyPaid = safeTendered >= totalDue && totalDue > 0;

    let remainingChange = changeDue;
    const denominations = [2000, 1000, 500, 200, 100];
    const changeDenominationBreakdown: Record<number, number> = {};

    for (const note of denominations) {
      if (remainingChange >= note) {
        const count = Math.floor(remainingChange / note);
        changeDenominationBreakdown[note] = count;
        remainingChange %= note;
      }
    }

    return {
      totalDue,
      cashTendered: safeTendered,
      changeDue,
      isFullyPaid,
      suggestedShortcuts: this.generateSmartShortcuts(totalDue),
      changeDenominationBreakdown,
    };
  }
}
