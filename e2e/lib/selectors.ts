/**
 * `data-testid` registry (Phase 1). Every entry MUST exist in frontend
 * source — verified by grep (see e2e/DISCOVERY.md §14.2 for the file list).
 * Never select by visible text, class or position: the product copy is
 * French-only today and any future Arabic copy is RTL.
 *
 * Usage: `await $(tid(T.payConfirm)).click()`.
 */
export const T = {
  // Boot / auth
  setupRoot: 'setup-pin-root',
  setupManagerName: 'setup-manager-name',
  setupManagerNew: 'setup-manager-new',
  setupManagerConfirm: 'setup-manager-confirm',
  setupSave: 'setup-save',
  lockScreen: 'lock-screen',
  loginPinPad: 'login-pin-pad',
  loginSubmit: 'login-submit',
  // Catalog / header
  shiftPill: 'shift-pill',
  lockButton: 'lock-button',
  catalogSearch: 'catalog-search',
  productTile: 'product-tile',
  checkoutButton: 'checkout-button',
  cartTotal: 'cart-total',
  // Discount (BottomBar + modal)
  discountButton: 'discount-button',
  discountDialog: 'discount-dialog',
  discountPercent: 'discount-percent',
  discountPin: 'discount-pin',
  discountApply: 'discount-apply',
  refundButton: 'refund-button',
  // Cart
  cartPanel: 'cart-panel',
  cartLine: 'cart-line',
  cartQtyInput: 'cart-qty-input',
  cartClear: 'cart-clear',
  cartLineRemove: 'cart-line-remove',
  priceOverrideOpen: 'price-override-open',
  priceOverrideInput: 'price-override-input',
  priceOverridePin: 'price-override-pin',
  priceOverrideApply: 'price-override-apply',
  // Payment
  payDialog: 'pay-dialog',
  payNet: 'pay-net',
  tenderedInput: 'tendered-input',
  payChange: 'pay-change',
  payExact: 'pay-exact',
  payMixedConfirm: 'pay-mixed-confirm',
  payConfirm: 'pay-confirm',
  payCancel: 'pay-cancel',
  // Refund
  refundDialog: 'refund-dialog',
  refundSearch: 'refund-search',
  refundSaleRow: 'refund-sale-row',
  refundPin: 'refund-pin',
  refundTotal: 'refund-total',
  refundSubmit: 'refund-submit',
  // Shift
  shiftOpenDialog: 'shift-open-dialog',
  shiftOpenDirect: 'shift-open-direct',
  shiftOpenFloat: 'shift-open-float',
  shiftOpenTotal: 'shift-open-total',
  shiftOpenConfirm: 'shift-open-confirm',
  shiftCloseDialog: 'shift-close-dialog',
  shiftBlindDirect: 'shift-blind-direct',
  shiftBlindInput: 'shift-blind-input',
  shiftBlindNext: 'shift-blind-next',
  shiftExpected: 'shift-expected',
  shiftCounted: 'shift-counted',
  shiftVariance: 'shift-variance',
  shiftNoteVariance: 'shift-note-variance',
  shiftClosePin: 'shift-close-pin',
  shiftCloseConfirm: 'shift-close-confirm',
  shiftZDialog: 'shift-z-dialog',
} as const;

export const tid = (id: string): string => `[data-testid="${id}"]`;
