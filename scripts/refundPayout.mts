/**
 * Invariant (vii) PAYOUT CONSERVATION - the money that physically leaves the
 * business must equal the refund row total:
 *
 *   drawer(integer DA) + wallet(avoir + clamp overflow) + voucher + digital + debt
 *     == netRefund
 *
 * It runs the split output through the REAL payout layer
 * (`clampCashRefund` + the `Math.round` the slice applies at
 * createOrderSlice.ts:~2815), because that is where a fractional cash lane can
 * vanish.
 */
import {
  computeRefundFundingSplit,
  type RefundLaneTotals,
} from '../src/utils/receiptMath.ts';
import { clampCashRefund } from '../src/utils/cashTerms.ts';

const M = (v: number) => Math.round(Number(v) * 100);

export interface PayoutCheck {
  net: number;
  cashOut: number;
  wallet: number;
  voucher: number;
  digital: number;
  debt: number;
  residue: number;
  anomalies: string[];
}

/** Split -> the payout the operator actually receives (cash method). */
export function payoutOf(
  split: ReturnType<typeof computeRefundFundingSplit>,
  cashTenderedNetDa: number,
  priorCashOutDa = 0,
  method: 'Espèces' | 'Avoir Client' = 'Espèces',
  prior?: RefundLaneTotals | null
): PayoutCheck {
  const netM = M(split.netRefund);
  if (method === 'Avoir Client') {
    return {
      net: netM,
      cashOut: 0,
      wallet: netM,
      voucher: 0,
      digital: 0,
      debt: 0,
      residue: 0,
      anomalies: split.anomalies ?? [],
    };
  }
  const clamped = clampCashRefund({
    cashShare: split.cashShare,
    cashTenderedNet: cashTenderedNetDa,
    priorCashOut: priorCashOutDa,
  });
  // createOrderSlice.ts:~2815 rounds the drawer amount to whole DA.
  const cashOutM = Math.round(clamped.cashOut) * 100;
  const overflowM = M(clamped.avoirOverflow);
  const walletM = M(split.avoirShare) + overflowM;
  const voucherM = M(split.voucherShare);
  const digitalM = M(split.digitalShare);
  const debtM = M(split.debtShare);
  void prior;
  const sum = cashOutM + walletM + voucherM + digitalM + debtM;
  return {
    net: netM,
    cashOut: cashOutM,
    wallet: walletM,
    voucher: voucherM,
    digital: digitalM,
    debt: debtM,
    residue: netM - sum,
    anomalies: split.anomalies ?? [],
  };
}
