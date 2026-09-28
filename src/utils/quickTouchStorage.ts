import type { Product, CategoryType } from '../types/pos';

export interface QuickTouchItem {
  id: string;
  title: string;
  price: number;
  costPrice?: number;
  category?: string;
  icon: string;
  color: string;
}

export const DEFAULT_QUICK_TOUCHES: QuickTouchItem[] = [
  {
    id: 'qt-hydrogel',
    title: 'Pose Film Hydrogel',
    price: 1000,
    costPrice: 200,
    category: 'Services',
    icon: '🛡️',
    color: 'from-cyan-500/20 to-blue-500/20 border-cyan-500/40 text-cyan-300',
  },
  {
    id: 'qt-verre',
    title: 'Pose Verre Trempé',
    price: 500,
    costPrice: 100,
    category: 'Services',
    icon: '📱',
    color: 'from-emerald-500/20 to-teal-500/20 border-emerald-500/40 text-emerald-300',
  },
  {
    id: 'qt-flash',
    title: 'Flash & Formatage',
    price: 1500,
    costPrice: 0,
    category: 'Services',
    icon: '🔄',
    color: 'from-purple-500/20 to-indigo-500/20 border-purple-500/40 text-purple-300',
  },
  {
    id: 'qt-deblocage',
    title: 'Déblocage FRP / Google',
    price: 2500,
    costPrice: 0,
    category: 'Services',
    icon: '🔓',
    color: 'from-rose-500/20 to-pink-500/20 border-rose-500/40 text-rose-300',
  },
  {
    id: 'qt-clean',
    title: 'Nettoyage Connecteur & HP',
    price: 500,
    costPrice: 0,
    category: 'Services',
    icon: '🧹',
    color: 'from-amber-500/20 to-yellow-500/20 border-amber-500/40 text-amber-300',
  },
  {
    id: 'qt-reparation',
    title: 'Réparation SAV Express',
    price: 1500,
    costPrice: 0,
    category: 'Services',
    icon: '🔧',
    color: 'from-orange-500/20 to-amber-500/20 border-orange-500/40 text-orange-300',
  },
  {
    id: 'qt-chargeur',
    title: 'Chargeur 20W Fast',
    price: 1800,
    costPrice: 900,
    category: 'Accessoires',
    icon: '⚡',
    color: 'from-teal-500/20 to-emerald-500/20 border-teal-500/40 text-teal-300',
  },
  {
    id: 'qt-cable',
    title: 'Câble Type-C Braided',
    price: 600,
    costPrice: 250,
    category: 'Accessoires',
    icon: '🔌',
    color: 'from-blue-500/20 to-indigo-500/20 border-blue-500/40 text-blue-300',
  },
];

const STORAGE_KEY = 'mobi_pos_quick_touch_items';

export function getQuickTouches(): QuickTouchItem[] {
  if (typeof window === 'undefined') return DEFAULT_QUICK_TOUCHES;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(DEFAULT_QUICK_TOUCHES));
      return DEFAULT_QUICK_TOUCHES;
    }
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed;
    }
    return DEFAULT_QUICK_TOUCHES;
  } catch (e) {
    console.warn('[quickTouches] Failed to read from localStorage:', e);
    return DEFAULT_QUICK_TOUCHES;
  }
}

/**
 * Loud quota/write failure reporter. localStorage is the ONLY copy of the
 * quick-touch layout, so a failed write must never be warn-only: the caller
 * keeps the previous persisted state (returned) instead of an in-memory list
 * that vanishes on reload.
 */
function reportQuickTouchWriteFailure(op: string, e: unknown): boolean {
  const isQuota =
    (typeof DOMException !== 'undefined' && e instanceof DOMException &&
      (e.name === 'QuotaExceededError' || e.code === 22)) ||
    (e instanceof Error && /quota|exceeded/i.test(e.message));
  console.error(`[quickTouches] ${op} FAILED${isQuota ? ' (quota exceeded — localStorage is the only copy)' : ''}:`, e);
  try {
    window.dispatchEvent(
      new CustomEvent('mobi:storage-quota', { detail: { area: 'quickTouches', op, isQuota } }),
    );
  } catch {
    // Event bus unavailable — console error above is the loud signal.
  }
  return isQuota;
}

export function saveQuickTouch(item: QuickTouchItem): QuickTouchItem[] {
  const current = getQuickTouches();
  const existingIdx = current.findIndex((t) => t.id === item.id);
  let updated: QuickTouchItem[];

  if (existingIdx >= 0) {
    updated = [...current];
    updated[existingIdx] = item;
  } else {
    updated = [...current, item];
  }

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
    window.dispatchEvent(new CustomEvent('mobi:quicktouches-change', { detail: updated }));
  } catch (e) {
    reportQuickTouchWriteFailure('save', e);
    // Persist failed: return the previous persisted list so in-memory state
    // never claims items that storage does not hold.
    return current;
  }

  return updated;
}

export function deleteQuickTouch(id: string): QuickTouchItem[] {
  const current = getQuickTouches();
  const updated = current.filter((t) => t.id !== id);

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
    window.dispatchEvent(new CustomEvent('mobi:quicktouches-change', { detail: updated }));
  } catch (e) {
    reportQuickTouchWriteFailure('delete', e);
    return current;
  }

  return updated;
}

export function resetQuickTouches(): QuickTouchItem[] {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(DEFAULT_QUICK_TOUCHES));
    window.dispatchEvent(new CustomEvent('mobi:quicktouches-change', { detail: DEFAULT_QUICK_TOUCHES }));
  } catch (e) {
    reportQuickTouchWriteFailure('reset', e);
    return getQuickTouches();
  }
  return DEFAULT_QUICK_TOUCHES;
}

export function createServiceProductFromTouch(item: QuickTouchItem): Product {
  const sanitizedId = item.id.replace(/^qt-/, '');
  return {
    id: `qt-${sanitizedId}`,
    title: item.title,
    price: Math.round(item.price),
    wholesalePrice: Math.round(item.price * 0.8),
    costPrice: Math.round(item.costPrice || 0),
    category: (item.category as CategoryType) || 'Services',
    brand: 'Autre',
    stock: 999999, // Infinite stock invariant: services cannot go out of stock
    isService: true, // Guarantees no stock decrement or out-of-stock blocking
    sku: `SRV-${sanitizedId.toUpperCase().replace(/[^A-Z0-9]/g, '')}`,
    barcode: '',
    compatibleModel: 'Tous modèles',
    imageUrl: '',
    reorderPoint: 0,
    vendorName: 'Prestation Interne',
    leadTimeDays: 0,
    dailySalesVelocity: 0,
  };
}
