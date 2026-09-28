import type { Customer } from '../../types/pos';

// P11.3: resolve the sqliteAdapter barrel lazily — a static import pins the whole
// DB graph (adapters -> dexie + libsql) into the importing chunk.
async function getSqlite() {
  const { sqliteAdapter } = await import('../sqliteAdapter');
  return sqliteAdapter;
}

export const customerRepository = {
  async getAll(): Promise<Customer[]> {
   return await (await getSqlite()).getAllCustomers();
  },

  async findByPhone(phone: string): Promise<Customer | undefined> {
   return await (await getSqlite()).findCustomerByPhone(phone);
  },

  async save(customer: Customer): Promise<void> {
   await (await getSqlite()).saveCustomer(customer);
  },

  async bulkSave(customers: Customer[]): Promise<void> {
   await (await getSqlite()).bulkSaveCustomers(customers);
  },

  async delete(id: string): Promise<void> {
   await (await getSqlite()).deleteCustomer(id);
  },

  async clearAll(): Promise<void> {
   const sqlite = await getSqlite();
   const customers = await sqlite.getAllCustomers();
    if (customers.length > 0) {
    await Promise.all(customers.map((c) => sqlite.deleteCustomer(c.id)));
    }
  },
};
