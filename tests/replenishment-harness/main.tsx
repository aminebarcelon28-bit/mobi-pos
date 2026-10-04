/**
 * Isolated mount point for the Réapprovisionnement modal.
 *
 * Stage 2+3: mounts the live ReplenishmentContainer (real store
 * pipeline) and seeds deterministic products + one waiting-list
 * purchase order so the container derives real alerts, KPIs and
 * line items via calculateStockAlerts, the Commandes view shows
 * a real order, and the "Voir Commande" deep-link + GlobalModalHost
 * (PurchaseOrderModal) can be exercised end to end.
 * The store is exposed as window.__replStore so the Playwright
 * suite can assert live state transitions (customQtyMap,
 * vendorDirectory, purchaseOrders, activeDraftPO, activeModal).
 *
 * Reachable at /tests/replenishment-harness/index.html.
 */
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ReplenishmentContainer } from '../../src/components/replenishment';
import { GlobalModalHost } from '../../src/components/GlobalModalHost';
import { ToastProvider } from '../../src/components/ui/Toast';
import { usePosStore } from '../../src/store/usePosStore';
import type { Product, PurchaseOrder } from '../../src/types/pos';
import '../../src/index.css';

declare global {
  interface Window {
    __replReady: boolean;
    __replError: string | null;
    __replOpen: (open: boolean) => void;
    __replStore: typeof usePosStore;
  }
}

window.__replReady = false;
window.__replError = null;
window.__replStore = usePosStore;

/**
 * Deterministic live seed — 7 products across 3 vendors:
 * - Grossiste Algerien Mobile: 3 alerts (1 rupture, 1 critique, 1 sous seuil)
 * - Distributeur Officiel: 2 alerts (1 critique, 1 sous seuil)
 * - Fournisseur Général: 2 alerts (via '' and explicit vendorName)
 * Derived KPIs: 3 grossistes, 6 sous-seuil, 1 rupture, 92 450 DA budget.
 * Plus one waiting-list PO (PO-2026-0147) for the Commandes view
 * and the "Voir Commande" deep-link.
 */
const seedProduct = (
  id: string,
  sku: string,
  title: string,
  vendorName: string,
  stock: number,
  reorderPoint: number,
  costPrice: number,
  price: number,
): Product => ({
  id,
  sku,
  barcode: `BC-${sku}`,
  title,
  brand: 'Autre',
  compatibleModel: 'Universal',
  category: 'Chargeurs',
  price,
  wholesalePrice: price,
  costPrice,
  stock,
  vendorName,
  leadTimeDays: 7,
  dailySalesVelocity: 2,
  reorderPoint,
});

const SEED_PRODUCTS: Product[] = [
  seedProduct('seed-vA1', 'VC-0001', 'Coque iPhone 15 Pro Algerie', 'Grossiste Algerien Mobile', 0, 10, 1200, 2400),
  seedProduct('seed-vA2', 'VC-0002', 'Cable USB-C 2m Robuste', 'Grossiste Algerien Mobile', 2, 10, 350, 800),
  seedProduct('seed-vA3', 'VC-0003', 'Chargeur Rapide 25W', 'Grossiste Algerien Mobile', 4, 10, 900, 1900),
  seedProduct('seed-vB1', 'VD-0001', 'Verre Trempe iPhone 15', 'Distributeur Officiel', 3, 8, 2500, 5200),
  seedProduct('seed-vB2', 'VD-0002', 'Adaptateur Lightning', 'Distributeur Officiel', 6, 8, 150, 400),
  seedProduct('seed-vB3', 'VD-0003', 'Protège-Écran Verre Trempé', 'Distributeur Officiel', 5, 8, 300, 700),
  seedProduct('seed-vC1', 'VG-0001', 'Support Ventouse Auto', '', 1, 6, 700, 1600),
  seedProduct('seed-vC2', 'VG-0002', 'Kit Nettoyage Ecran', 'Fournisseur Général', 1, 6, 550, 1300),
];

const SEED_PO: PurchaseOrder = {
  id: 'seed-po-001',
  poNumber: 'PO-2026-0147',
  vendorName: 'Grossiste Algerien Mobile',
  createdAt: '2026-10-01T09:00:00.000Z',
  status: 'Waiting List',
  totalAmount: 44700,
  items: [
    { productId: 'seed-vA1', title: 'Coque iPhone 15 Pro Algerie', sku: 'VC-0001', currentStock: 0, suggestedQty: 20, unitCost: 1200, totalCost: 24000 },
    { productId: 'seed-vA2', title: 'Cable USB-C 2m Robuste', sku: 'VC-0002', currentStock: 2, suggestedQty: 18, unitCost: 350, totalCost: 6300 },
    { productId: 'seed-vA3', title: 'Chargeur Rapide 25W', sku: 'VC-0003', currentStock: 4, suggestedQty: 16, unitCost: 900, totalCost: 14400 },
  ],
};

usePosStore.setState({ products: SEED_PRODUCTS, purchaseOrders: [SEED_PO] });

function Harness() {
  const [isOpen, setIsOpen] = useState(true);

  useEffect(() => {
    window.__replOpen = (open: boolean) => setIsOpen(open);
    window.__replReady = true;
    try {
      const urlTheme = new URLSearchParams(location.search).get('theme');
      if (urlTheme === 'dark') {
        localStorage.setItem('mobi_pos_theme', 'dark');
        document.documentElement.classList.add('dark');
      }
    } catch { /* storage unavailable */ }
  }, []);

  return (
    <ToastProvider>
      <div style={{ padding: 24 }}>
        <button
          type="button"
          data-harness-trigger
          onClick={() => setIsOpen(true)}
        >
          Ouvrir le réapprovisionnement
        </button>
        <ReplenishmentContainer
          isOpen={isOpen}
          onClose={() => setIsOpen(false)}
        />
        <GlobalModalHost />
      </div>
    </ToastProvider>
  );
}

createRoot(document.getElementById('harness-root')!).render(
  <StrictMode>
    <Harness />
  </StrictMode>
);
