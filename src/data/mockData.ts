import type { Product, Customer } from '../types/pos';

export const INITIAL_PRODUCTS: Product[] = [];

export const INITIAL_CUSTOMERS: Customer[] = [];

/** @deprecated Use INITIAL_CUSTOMERS[0] instead */
export const MOCK_CUSTOMER: Customer = {
  id: '',
  name: '',
  phone: '',
  email: '',
  registeredDevice: '',
  loyaltyPoints: 0,
  storeCredit: 0,
  pricingTier: 'Retail',
};

