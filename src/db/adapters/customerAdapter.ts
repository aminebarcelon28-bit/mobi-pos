import type { Customer, CustomerDebtEntry } from '../../types/pos';
import { db as dexieDb } from '../database';
import { fireSync, fireSyncDelete } from './base';

export const customerAdapter = {
  async saveCustomer(customer: Customer): Promise<void> {
    await dexieDb.customers.put(customer);
    try {
      const { getLocalDb, utcNowIso } = await import('../sqlPluginAdapter');
      const db = await getLocalDb();
      const now = utcNowIso();
      await db.execute(
        `INSERT INTO customers (id, name, phone, email, loyalty_points, store_credit, pricing_tier, total_spent, json_payload, updated_at, deleted)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 0)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, phone=excluded.phone, email=excluded.email,
           loyalty_points=excluded.loyalty_points, store_credit=excluded.store_credit,
           pricing_tier=excluded.pricing_tier, total_spent=excluded.total_spent,
           json_payload=excluded.json_payload, updated_at=excluded.updated_at, deleted=0`,
        [
          customer.id,
          customer.name,
          customer.phone,
          customer.email || null,
          customer.loyaltyPoints || 0,
          customer.storeCredit || 0,
          customer.pricingTier || 'Retail',
          customer.totalSpent || 0,
          JSON.stringify(customer),
          now,
        ],
      ).catch(() => {});
    } catch {
      // ignore web mode fallback
    }
    void fireSync('customer', customer.id, customer);
  },

  async bulkSaveCustomers(customers: Customer[]): Promise<void> {
    await dexieDb.customers.bulkPut(customers);
    for (const c of customers) {
      await customerAdapter.saveCustomer(c);
    }
  },

  async getAllCustomers(): Promise<Customer[]> {
    return await dexieDb.customers.toArray();
  },

  async findCustomerByPhone(phone: string): Promise<Customer | undefined> {
    const trimmed = phone.trim();
    if (!trimmed) return undefined;
    return await dexieDb.customers.where('phone').equals(trimmed).first();
  },

  async deleteCustomer(id: string): Promise<void> {
    await dexieDb.customers.delete(id);
    try {
      const { getLocalDb } = await import('../sqlPluginAdapter');
      const db = await getLocalDb();
      await db.execute('UPDATE customers SET deleted = 1 WHERE id = $1', [id]).catch(() => {});
    } catch {
      // ignore web mode fallback
    }
    void fireSyncDelete('customer', id);
  },

  async saveCustomerDebt(debt: CustomerDebtEntry): Promise<void> {
    await dexieDb.customerDebts.put(debt);
    void fireSync('customer_debt', debt.id, debt);
  },

  async getAllCustomerDebts(): Promise<CustomerDebtEntry[]> {
    return await dexieDb.customerDebts.toArray();
  },
};

