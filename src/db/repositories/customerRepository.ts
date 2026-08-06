import { db } from '../database';
import type { Customer } from '../../types/pos';

export const customerRepository = {
  async getAll(): Promise<Customer[]> {
    return await db.customers.toArray();
  },

  async findByPhone(phone: string): Promise<Customer | undefined> {
    return await db.customers.where('phone').equals(phone.trim()).first();
  },

  async save(customer: Customer): Promise<void> {
    await db.customers.put(customer);
  },

  async bulkSave(customers: Customer[]): Promise<void> {
    await db.customers.bulkPut(customers);
  },

  async delete(id: string): Promise<void> {
    await db.customers.delete(id);
  },

  async clearAll(): Promise<void> {
    await db.customers.clear();
  },
};
