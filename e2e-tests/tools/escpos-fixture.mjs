/**
 * Deterministic receipt fixture for the ESC/POS sink suite + hardware kit.
 *
 * Fixed ids, fixed timestamps, fixed money: the same input must produce the same
 * bytes on every machine, which is what makes a byte-exact golden meaningful.
 * The Arabic customer name exercises the raster lane; the totals are integer DA.
 */

export const FIXTURE_SETTINGS = {
  storeName: 'MOBI ACCESSORIES',
  storeSubheader: 'Telephonie & Accessoires',
  address: '12 Rue Didouche Mourad, Alger',
  phone: '0550 11 22 33',
  email: 'contact@mobi.dz',
  footerMessage: 'Merci de votre visite',
  paperWidth: '80mm',
  showLogo: false,
  kickCashDrawerOnCash: true,
  receiptFooter: 'Merci de votre visite',
};

/** Arabic customer: "أحمد بن علي" (exercises shaping + bidi inside one run). */
export const FIXTURE_ARABIC_NAME = 'أحمد بن علي';

export function fixtureTransaction(overrides = {}) {
  const items = [
    {
      productId: 'REF-P500',
      quantity: 2,
      unitPriceCharged: 500,
      discount: 0,
      product: { id: 'REF-P500', title: 'Chargeur 20W', price: 500, category: 'Accessoires' },
    },
    {
      productId: 'REF-P700',
      quantity: 1,
      unitPriceCharged: 700,
      discount: 0,
      product: { id: 'REF-P700', title: 'Cable Type-C Braided', price: 700, category: 'Accessoires' },
    },
  ];
  const subtotal = 1700;
  const total = 1700;
  return {
    id: 'TXN-ESC-POS-0001',
    receiptNumber: 'REC-20261103-ESC0001',
    createdAt: '2026-11-03T09:30:00.000Z',
    cashierName: 'E2EGerant',
    shiftId: 'SHIFT-ESC-0001',
    items,
    subtotal,
    discountTotal: 0,
    total,
    paymentMethod: 'Espèces',
    cashTendered: 2000,
    changeDue: 300,
    customer: { id: 'CUST-ESC-1', name: FIXTURE_ARABIC_NAME, phone: '0550112233' },
    pricingTier: 'retail',
    ...overrides,
  };
}
