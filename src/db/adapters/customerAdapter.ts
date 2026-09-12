import type { Customer, CustomerDebtEntry } from '../../types/pos';
import { db as dexieDb } from '../database';
import { fireSync, fireSyncDelete } from './base';

export const customerAdapter = {
  async saveCustomer(customer: Customer): Promise<void> {
    await dexieDb.customers.put(customer);
    void fireSync('customer', customer.id, customer);
  },

  async bulkSaveCustomers(customers: Customer[]): Promise<void> {
    await dexieDb.customers.bulkPut(customers);
    for (const c of customers) void fireSync('customer', c.id, c);
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

