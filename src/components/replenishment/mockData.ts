import type { SupplierItem, ReplenishmentKPIs } from './types';

export const mockSuppliers: SupplierItem[] = [
  {
    id: 'sup-001',
    name: 'Fournisseur Général',
    totalReferences: 146,
    outOfStockCount: 12,
    contact: {
      phone: '023 45 67 89',
      whatsapp: '0550 12 34 56',
      email: 'commande@fournisseur-general.dz',
    },
    isOfficial: false,
    activeOrders: [
      {
        reference: 'PO-2026-0147',
        status: 'EN_COURS',
        date: '2026-09-28',
        totalFormatted: '1 240 000 DA',
      },
    ],
  },
  {
    id: 'sup-002',
    name: 'Distributeur Officiel Apple Algérie',
    totalReferences: 3,
    outOfStockCount: 0,
    contact: {
      phone: '021 34 56 78',
      whatsapp: '0560 23 45 67',
      email: 'orders@apple-distrib.dz',
    },
    isOfficial: true,
  },
  {
    id: 'sup-003',
    name: 'Grossiste Accessoires Mobiles',
    totalReferences: 87,
    outOfStockCount: 5,
    contact: {
      phone: '031 56 78 90',
      whatsapp: '0570 34 56 78',
      email: 'achats@grossiste-mobile.dz',
    },
    isOfficial: false,
    activeOrders: [
      {
        reference: 'PO-2026-0152',
        status: 'PARTIELLE',
        date: '2026-09-30',
        totalFormatted: '386 500 DA',
      },
    ],
  },
  {
    id: 'sup-004',
    name: 'Samsung Authorized Partner',
    totalReferences: 24,
    outOfStockCount: 2,
    contact: {
      phone: '041 23 45 67',
      whatsapp: '0580 45 67 89',
      email: 'procurement@samsung-partner.dz',
    },
    isOfficial: true,
  },
  {
    id: 'sup-005',
    name: 'Fournisseur Coques & Protections',
    totalReferences: 56,
    outOfStockCount: 8,
    contact: {
      phone: '051 67 89 01',
      whatsapp: '0590 56 78 90',
      email: 'commandes@coques-protections.dz',
    },
    isOfficial: false,
  },
  {
    id: 'sup-006',
    name: 'Distributeur Anker & Belkin',
    totalReferences: 31,
    outOfStockCount: 1,
    contact: {
      phone: '061 78 90 12',
      whatsapp: '0660 67 89 01',
      email: 'sales@anker-belkin-distrib.dz',
    },
    isOfficial: true,
    activeOrders: [
      {
        reference: 'PO-2026-0155',
        status: 'EXPEDIEE',
        date: '2026-10-01',
        totalFormatted: '742 900 DA',
      },
    ],
  },
  {
    id: 'sup-007',
    name: 'Grossiste Câbles & Chargeurs',
    totalReferences: 42,
    outOfStockCount: 3,
    contact: {
      phone: '071 89 01 23',
      whatsapp: '0770 78 90 12',
      email: 'achats@cables-chargeurs.dz',
    },
    isOfficial: false,
  },
  {
    id: 'sup-008',
    name: 'Fournisseur Écran & Verre',
    totalReferences: 19,
    outOfStockCount: 4,
    contact: {},
    isOfficial: false,
  },
];

export const mockKPIs: ReplenishmentKPIs = {
  wholesalersCount: 8,
  underThresholdCount: 80,
  outOfStockCount: 70,
  totalBudgetFormatted: '6 843 146 DA',
};
