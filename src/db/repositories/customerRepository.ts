import { sqliteAdapter } from '../sqliteAdapter';
import type { Customer } from '../../types/pos';

export const customerRepository = {
  async getAll(): Promise<Customer[]> {
    return await sqliteAdapter.getAllCustomers();
  },

  async findByPhone(phone: string): Promise<Customer | undefined> {
    return await sqliteAdapter.findCustomerByPhone(phone);
  },

  async save(customer: Customer): Promise<void> {
    await sqliteAdapter.saveCustomer(customer);
  },

  async bulkSave(customers: Customer[]): Promise<void> {
    await sqliteAdapter.bulkSaveCustomers(customers);
  },

  async delete(id: string): Promise<void> {
    await sqliteAdapter.deleteCustomer(id);
  },

  async clearAll(): Promise<void> {
    const customers = await sqliteAdapter.getAllCustomers();
    if (customers.length > 0) {
      await Promise.all(customers.map((c) => sqliteAdapter.deleteCustomer(c.id)));
    }
  },
};
