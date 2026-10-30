/**
 * UPGRADE-04 — Price Books management surface (contract pricing).
 *
 * Dedicated modal opened from CustomersModal ("Grilles Tarifaires"). Manages
 * `price_books` + `price_book_items` (migration v119) through
 * priceBookAdapter: create/edit books (customer scope, validity window,
 * priority, status) and per-product negotiated prices with a minimum
 * quantity ladder.
 *
 * Money: every price input is a <MoneyInput> (integer minor units in, legacy
 * REAL dinars out — the same conversion as ProductEditorModal). Storage is
 * merchant-local; outside Tauri the modal explains and disables.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Plus, Trash2, Tag, CheckCircle2, Pencil, Search, Users, AlertTriangle } from 'lucide-react';
import { usePosStore } from '../../store/usePosStore';
import { formatDZD } from '../../types/pos';
import type { Product } from '../../types/pos';
import { toLegacyReal, dinarsToMinor } from '../../utils/money';
import { MoneyInput } from '../ui/MoneyInput';
import { useToast } from '../ui/Toast';
import {
  isPriceBookStorageAvailable,
  listPriceBooks,
  listPriceBookItems,
  savePriceBook,
  deletePriceBook,
  savePriceBookItem,
  deletePriceBookItem,
  type PriceBookRecord,
  type PriceBookItemRecord,
} from '../../db/adapters/priceBookAdapter';

interface PriceBooksModalProps {
  isOpen: boolean;
  onClose: () => void;
}

import { foldForSearch } from '../../utils/catalogSearch';

export const PriceBooksModal: React.FC<PriceBooksModalProps> = ({ isOpen, onClose }) => {
  const { showToast } = useToast();
  const customers = usePosStore((s) => s.customers);
  const products = usePosStore((s) => s.products);
  const refreshCustomerPriceBook = usePosStore((s) => s.refreshCustomerPriceBook);

  const storageOk = isPriceBookStorageAvailable();

  const [loading, setLoading] = useState(false);
  const [books, setBooks] = useState<PriceBookRecord[]>([]);
  const [selectedBookId, setSelectedBookId] = useState<string | null>(null);
  const [items, setItems] = useState<PriceBookItemRecord[]>([]);

  // ── Book form ──────────────────────────────────────────────────────────
  const [bookFormOpen, setBookFormOpen] = useState(false);
  const [editingBookId, setEditingBookId] = useState<string | null>(null);
  const [formName, setFormName] = useState('');
  const [formCustomerId, setFormCustomerId] = useState('');
  const [formValidFrom, setFormValidFrom] = useState('');
  const [formValidTo, setFormValidTo] = useState('');
  const [formPriority, setFormPriority] = useState(0);
  const [formStatus, setFormStatus] = useState<'active' | 'inactive'>('active');
  const [formNotes, setFormNotes] = useState('');

  // ── Item form ──────────────────────────────────────────────────────────
  const [itemFormOpen, setItemFormOpen] = useState(false);
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [itemQuery, setItemQuery] = useState('');
  const [itemProductId, setItemProductId] = useState('');
  const [itemMinQty, setItemMinQty] = useState(1);
  /** Negotiated unit price in legacy REAL dinars (converted at MoneyInput edges). */
  const [itemUnitPrice, setItemUnitPrice] = useState(0);

  const selectedBook = books.find((b) => b.id === selectedBookId) ?? null;

  const reloadBooks = useCallback(async () => {
    setLoading(true);
    try {
      const list = await listPriceBooks();
      setBooks(list);
      setSelectedBookId((prev) => {
        if (prev && list.some((b) => b.id === prev)) return prev;
        return list[0]?.id ?? null;
      });
    } finally {
      setLoading(false);
    }
  }, []);

  const reloadItems = useCallback(async (bookId: string | null) => {
    if (!bookId) {
      setItems([]);
      return;
    }
    setItems(await listPriceBookItems(bookId));
  }, []);

  useEffect(() => {
    if (isOpen) {
      void reloadBooks();
    }
  }, [isOpen, reloadBooks]);

  useEffect(() => {
    void reloadItems(selectedBookId);
  }, [selectedBookId, reloadItems]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  const productById = useMemo(() => {
    const map = new Map<string, Product>();
    for (const p of products || []) map.set(p.id, p);
    return map;
  }, [products]);

  const filteredProducts = useMemo(() => {
    const q = foldForSearch(itemQuery);
    const all = products || [];
    if (!q) return all.slice(0, 8);
    return all
      .filter(
        (p) =>
          foldForSearch(p.title).includes(q) ||
          foldForSearch(p.sku).includes(q) ||
          foldForSearch(p.barcode).includes(q)
      )
      .slice(0, 8);
  }, [products, itemQuery]);

  const openCreateBook = () => {
    setEditingBookId(null);
    setFormName('');
    setFormCustomerId('');
    setFormValidFrom('');
    setFormValidTo('');
    setFormPriority(0);
    setFormStatus('active');
    setFormNotes('');
    setBookFormOpen(true);
  };

  const openEditBook = (book: PriceBookRecord) => {
    setEditingBookId(book.id);
    setFormName(book.name);
    setFormCustomerId(book.customerId ?? '');
    setFormValidFrom(book.validFrom ?? '');
    setFormValidTo(book.validTo ?? '');
    setFormPriority(book.priority);
    setFormStatus(book.status);
    setFormNotes(book.notes ?? '');
    setBookFormOpen(true);
  };

  const handleSaveBook = async () => {
    if (!formName.trim()) {
      showToast('Nom de la grille requis.', 'warning');
      return;
    }
    const id = await savePriceBook({
      id: editingBookId ?? undefined,
      name: formName.trim(),
      customerId: formCustomerId || null,
      validFrom: formValidFrom || null,
      validTo: formValidTo || null,
      priority: formPriority,
      status: formStatus,
      notes: formNotes.trim() || null,
    });
    if (!id) {
      showToast("Écriture de la grille impossible (base locale indisponible).", 'error');
      return;
    }
    setBookFormOpen(false);
    await reloadBooks();
    setSelectedBookId(id);
    // A book edit can change the attached customer's contract prices.
    void refreshCustomerPriceBook();
    showToast(editingBookId ? 'Grille tarifaire mise à jour.' : 'Grille tarifaire créée.', 'success');
  };

  const handleDeleteBook = async (book: PriceBookRecord) => {
    if (!window.confirm(`Supprimer la grille « ${book.name} » et tous ses prix négociés ?`)) return;
    const ok = await deletePriceBook(book.id);
    if (!ok) {
      showToast('Suppression impossible.', 'error');
      return;
    }
    if (selectedBookId === book.id) setSelectedBookId(null);
    await reloadBooks();
    void refreshCustomerPriceBook();
    showToast('Grille tarifaire supprimée.', 'info');
  };

  const openCreateItem = () => {
    setEditingItemId(null);
    setItemQuery('');
    setItemProductId('');
    setItemMinQty(1);
    setItemUnitPrice(0);
    setItemFormOpen(true);
  };

  const openEditItem = (item: PriceBookItemRecord) => {
    const product = productById.get(item.productId);
    setEditingItemId(item.id);
    setItemQuery(product?.title ?? '');
    setItemProductId(item.productId);
    setItemMinQty(item.minQty);
    setItemUnitPrice(item.unitPrice);
    setItemFormOpen(true);
  };

  const handleSaveItem = async () => {
    if (!selectedBookId) return;
    if (!itemProductId) {
      showToast('Sélectionnez un produit.', 'warning');
      return;
    }
    if (!(itemUnitPrice > 0)) {
      showToast('Prix négocié requis (supérieur à 0).', 'warning');
      return;
    }
    const id = await savePriceBookItem({
      id: editingItemId ?? undefined,
      bookId: selectedBookId,
      productId: itemProductId,
      unitPrice: itemUnitPrice,
      minQty: itemMinQty,
    });
    if (!id) {
      showToast("Écriture du prix négocié impossible (base locale indisponible).", 'error');
      return;
    }
    setItemFormOpen(false);
    await reloadItems(selectedBookId);
    void refreshCustomerPriceBook();
    showToast(editingItemId ? 'Prix négocié mis à jour.' : 'Prix négocié ajouté.', 'success');
  };

  const handleDeleteItem = async (item: PriceBookItemRecord) => {
    const ok = await deletePriceBookItem(item.id);
    if (!ok) {
      showToast('Suppression impossible.', 'error');
      return;
    }
    await reloadItems(selectedBookId);
    void refreshCustomerPriceBook();
    showToast('Prix négocié retiré.', 'info');
  };

  if (!isOpen) return null;

  const customerNameOf = (customerId: string | null): string => {
    if (!customerId) return 'Partagée (tous clients)';
    return customers.find((c) => c.id === customerId)?.name ?? customerId;
  };

  return createPortal(
    <div
      className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[70] flex items-center justify-center p-0 sm:p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Grilles tarifaires — prix négociés clients"
        onClick={(e) => e.stopPropagation()}
        className="bg-pos-panel border border-pos-border rounded-t-[28px] sm:rounded-xl w-full max-w-3xl max-h-[92dvh] flex flex-col shadow-2xl animate-in zoom-in-95 relative overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-pos-border px-4 py-3 shrink-0">
          <div className="flex items-center gap-2 text-emerald-400">
            <Tag className="w-5 h-5" aria-hidden="true" />
            <h3 className="text-sm font-black text-pos-text">Grilles Tarifaires — Prix Négociés</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fermer les grilles tarifaires"
            className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg hover:bg-pos-hover text-pos-muted hover:text-pos-text transition shrink-0"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        {!storageOk && (
          <div className="mx-4 mt-3 p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-300 text-xs font-bold flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />
            Les grilles tarifaires sont disponibles uniquement dans l'application de bureau (base locale).
          </div>
        )}

        {/* Body */}
        <div className="flex-1 overflow-y-auto overscroll-contain p-4 flex flex-col md:flex-row gap-4">
          {/* Books column */}
          <div className="md:w-2/5 flex flex-col gap-2 min-w-0">
            <div className="flex items-center justify-between">
              <span className="text-[10px] uppercase font-bold text-pos-muted">Grilles ({books.length})</span>
              <button
                type="button"
                onClick={openCreateBook}
                disabled={!storageOk}
                className="px-2.5 py-1.5 min-h-[36px] rounded-lg bg-emerald-500 hover:bg-emerald-400 disabled:opacity-40 text-slate-950 text-[11px] font-black flex items-center gap-1 transition cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" aria-hidden="true" /> Nouvelle grille
              </button>
            </div>

            {loading ? (
              <p className="text-xs text-pos-muted py-6 text-center">Chargement…</p>
            ) : books.length === 0 ? (
              <p className="text-xs text-pos-muted py-6 text-center">
                Aucune grille tarifaire. Créez-en une pour appliquer des prix négociés à un client.
              </p>
            ) : (
              <div className="space-y-1.5">
                {books.map((book) => (
                  <button
                    key={book.id}
                    type="button"
                    onClick={() => setSelectedBookId(book.id)}
                    className={`w-full text-left px-3 py-2.5 rounded-xl border transition cursor-pointer ${
                      selectedBookId === book.id
                        ? 'border-emerald-500/50 bg-emerald-500/10'
                        : 'border-pos-border bg-pos-card hover:border-emerald-500/30'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-black text-pos-text truncate">{book.name}</span>
                      <span
                        className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full border shrink-0 ${
                          book.status === 'active'
                            ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
                            : 'bg-pos-hover text-pos-muted border-pos-border'
                        }`}
                      >
                        {book.status === 'active' ? 'Active' : 'Inactive'}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 mt-1 text-[10px] text-pos-muted min-w-0">
                      <Users className="w-3 h-3 shrink-0" aria-hidden="true" />
                      <span className="truncate">{customerNameOf(book.customerId)}</span>
                      <span className="shrink-0">• P{book.priority}</span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Detail column */}
          <div className="md:flex-1 min-w-0 flex flex-col gap-2 border-t md:border-t-0 md:border-l border-pos-border md:pl-4 pt-4 md:pt-0">
            {selectedBook ? (
              <>
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div className="min-w-0">
                    <p className="text-xs font-black text-pos-text truncate">{selectedBook.name}</p>
                    <p className="text-[10px] text-pos-muted">
                      {customerNameOf(selectedBook.customerId)} • priorité {selectedBook.priority}
                      {selectedBook.validFrom ? ` • du ${selectedBook.validFrom}` : ''}
                      {selectedBook.validTo ? ` au ${selectedBook.validTo}` : ''}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => openEditBook(selectedBook)}
                      className="px-2.5 py-1.5 min-h-[36px] rounded-lg bg-pos-hover hover:bg-pos-border text-pos-text text-[11px] font-bold flex items-center gap-1 transition cursor-pointer"
                    >
                      <Pencil className="w-3.5 h-3.5" aria-hidden="true" /> Modifier
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleDeleteBook(selectedBook)}
                      className="px-2.5 py-1.5 min-h-[36px] rounded-lg bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/30 text-[11px] font-bold flex items-center gap-1 transition cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" aria-hidden="true" /> Supprimer
                    </button>
                  </div>
                </div>

                <div className="flex items-center justify-between mt-1">
                  <span className="text-[10px] uppercase font-bold text-pos-muted">
                    Prix négociés ({items.length})
                  </span>
                  <button
                    type="button"
                    onClick={openCreateItem}
                    disabled={!storageOk}
                    className="px-2.5 py-1.5 min-h-[36px] rounded-lg bg-pos-card border border-emerald-500/40 hover:bg-emerald-500/10 text-emerald-500 text-[11px] font-black flex items-center gap-1 transition cursor-pointer disabled:opacity-40"
                  >
                    <Plus className="w-3.5 h-3.5" aria-hidden="true" /> Ajouter un prix
                  </button>
                </div>

                {items.length === 0 ? (
                  <p className="text-xs text-pos-muted py-4 text-center">
                    Aucun prix négocié dans cette grille.
                  </p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs border-collapse">
                      <thead>
                        <tr className="border-b border-pos-border text-[10px] text-pos-muted uppercase font-bold">
                          <th className="py-1.5 px-2">Produit</th>
                          <th className="py-1.5 px-2 text-right">Qté min</th>
                          <th className="py-1.5 px-2 text-right">Prix négocié</th>
                          <th className="py-1.5 px-2 text-right">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-pos-border/40">
                        {items.map((item) => {
                          const product = productById.get(item.productId);
                          return (
                            <tr key={item.id} className="hover:bg-pos-bg/50 transition">
                              <td className="py-2 px-2 min-w-0">
                                <span className="font-bold text-pos-text block truncate max-w-[220px]">
                                  {product?.title ?? item.productId}
                                </span>
                                {product && (
                                  <span className="text-[10px] text-pos-muted font-mono">{product.sku}</span>
                                )}
                              </td>
                              <td className="py-2 px-2 text-right font-mono">{item.minQty}</td>
                              <td className="py-2 px-2 text-right font-mono font-black text-emerald-400">
                                {formatDZD(item.unitPrice)}
                              </td>
                              <td className="py-2 px-2 text-right whitespace-nowrap">
                                <button
                                  type="button"
                                  onClick={() => openEditItem(item)}
                                  aria-label={`Modifier le prix négocié — ${product?.title ?? item.productId}`}
                                  className="p-1.5 min-h-[32px] rounded-lg hover:bg-pos-hover text-pos-muted hover:text-pos-text transition cursor-pointer"
                                >
                                  <Pencil className="w-3.5 h-3.5" aria-hidden="true" />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => void handleDeleteItem(item)}
                                  aria-label={`Retirer le prix négocié — ${product?.title ?? item.productId}`}
                                  className="p-1.5 min-h-[32px] rounded-lg hover:bg-rose-500/10 text-rose-400 transition cursor-pointer"
                                >
                                  <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}

                {/* ── Item form ── */}
                {itemFormOpen && (
                  <div className="mt-2 p-3 rounded-xl border border-pos-border bg-pos-card space-y-3">
                    <p className="text-[11px] font-black text-pos-text">
                      {editingItemId ? 'Modifier le prix négocié' : 'Nouveau prix négocié'}
                    </p>

                    <div>
                      <label
                        htmlFor="pb-item-search"
                        className="text-[10px] uppercase font-bold text-pos-muted block mb-1"
                      >
                        Produit
                      </label>
                      <div className="relative">
                        <Search
                          className="w-3.5 h-3.5 text-pos-muted absolute left-2.5 top-1/2 -translate-y-1/2"
                          aria-hidden="true"
                        />
                        <input
                          id="pb-item-search"
                          type="text"
                          value={itemQuery}
                          onChange={(e) => {
                            setItemQuery(e.target.value);
                            setItemProductId('');
                          }}
                          placeholder="Rechercher (titre, SKU, code-barres)…"
                          className="w-full bg-pos-bg border border-pos-border rounded-lg pl-8 pr-3 py-2 text-xs text-pos-text focus:border-emerald-400 focus:outline-none"
                        />
                      </div>
                      {!itemProductId && (
                        <div className="mt-1.5 space-y-1 max-h-40 overflow-y-auto overscroll-contain">
                          {filteredProducts.length === 0 ? (
                            <p className="text-[10px] text-pos-muted py-1">Aucun produit trouvé.</p>
                          ) : (
                            filteredProducts.map((p) => (
                              <button
                                key={p.id}
                                type="button"
                                onClick={() => {
                                  setItemProductId(p.id);
                                  setItemQuery(p.title);
                                }}
                                className="w-full text-left px-2 py-1.5 rounded-lg hover:bg-emerald-500/10 text-[11px] text-pos-text flex items-center justify-between gap-2 cursor-pointer"
                              >
                                <span className="truncate">{p.title}</span>
                                <span className="text-[9px] text-pos-muted font-mono shrink-0">{p.sku}</span>
                              </button>
                            ))
                          )}
                        </div>
                      )}
                      {itemProductId && (
                        <p className="mt-1.5 text-[10px] text-emerald-400 font-bold flex items-center gap-1">
                          <CheckCircle2 className="w-3 h-3" aria-hidden="true" />
                          {productById.get(itemProductId)?.title ?? itemProductId}
                        </p>
                      )}
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label
                          htmlFor="pb-item-minqty"
                          className="text-[10px] uppercase font-bold text-pos-muted block mb-1"
                        >
                          Quantité minimum
                        </label>
                        <input
                          id="pb-item-minqty"
                          type="number"
                          min={1}
                          step={1}
                          value={itemMinQty}
                          onChange={(e) => setItemMinQty(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
                          className="w-full bg-pos-bg border border-pos-border rounded-lg px-3 py-2 text-xs font-mono text-pos-text focus:border-emerald-400 focus:outline-none"
                        />
                      </div>
                      <div>
                        <MoneyInput
                          label="Prix négocié unitaire (DA)"
                          valueMinor={dinarsToMinor(itemUnitPrice || 0)}
                          onChangeMinor={(minor) => setItemUnitPrice(toLegacyReal(minor))}
                          placeholder="0"
                          className="w-full bg-pos-bg border border-pos-border rounded-lg px-3 py-2 text-sm font-mono font-black text-pos-text focus:border-emerald-400 focus:outline-none"
                        />
                      </div>
                    </div>

                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => setItemFormOpen(false)}
                        className="px-3 py-2 min-h-[38px] rounded-lg bg-pos-hover text-pos-muted hover:text-pos-text text-[11px] font-bold cursor-pointer"
                      >
                        Annuler
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleSaveItem()}
                        className="px-4 py-2 min-h-[38px] rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-[11px] font-black flex items-center gap-1 cursor-pointer"
                      >
                        <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />
                        {editingItemId ? 'Enregistrer' : 'Ajouter'}
                      </button>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <p className="text-xs text-pos-muted py-8 text-center">
                Sélectionnez ou créez une grille tarifaire pour gérer ses prix négociés.
              </p>
            )}
          </div>
        </div>

        {/* ── Book form overlay ── */}
        {bookFormOpen && (
          <div
            className="absolute inset-0 bg-black/50 rounded-xl flex items-center justify-center p-4"
            onClick={() => setBookFormOpen(false)}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-label={editingBookId ? 'Modifier la grille tarifaire' : 'Créer une grille tarifaire'}
              onClick={(e) => e.stopPropagation()}
              className="bg-pos-panel border border-pos-border rounded-xl w-full max-w-md p-4 space-y-3 shadow-2xl"
            >
              <p className="text-xs font-black text-pos-text">
                {editingBookId ? 'Modifier la grille tarifaire' : 'Créer une grille tarifaire'}
              </p>

              <div>
                <label htmlFor="pb-book-name" className="text-[10px] uppercase font-bold text-pos-muted block mb-1">
                  Nom de la grille *
                </label>
                <input
                  id="pb-book-name"
                  type="text"
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  placeholder="Ex: Contrat Grossiste Alger"
                  className="w-full bg-pos-bg border border-pos-border rounded-lg px-3 py-2 text-xs text-pos-text focus:border-emerald-400 focus:outline-none"
                />
              </div>

              <div>
                <label htmlFor="pb-book-customer" className="text-[10px] uppercase font-bold text-pos-muted block mb-1">
                  Client (laisser vide = partagée)
                </label>
                <select
                  id="pb-book-customer"
                  value={formCustomerId}
                  onChange={(e) => setFormCustomerId(e.target.value)}
                  className="w-full bg-pos-bg border border-pos-border rounded-lg px-3 py-2 text-xs text-pos-text focus:border-emerald-400 focus:outline-none"
                >
                  <option value="">— Partagée (tous clients) —</option>
                  {(customers || []).map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} — {c.phone}
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label htmlFor="pb-book-from" className="text-[10px] uppercase font-bold text-pos-muted block mb-1">
                    Valide du
                  </label>
                  <input
                    id="pb-book-from"
                    type="date"
                    value={formValidFrom}
                    onChange={(e) => setFormValidFrom(e.target.value)}
                    className="w-full bg-pos-bg border border-pos-border rounded-lg px-3 py-2 text-xs text-pos-text focus:border-emerald-400 focus:outline-none"
                  />
                </div>
                <div>
                  <label htmlFor="pb-book-to" className="text-[10px] uppercase font-bold text-pos-muted block mb-1">
                    Valide au
                  </label>
                  <input
                    id="pb-book-to"
                    type="date"
                    value={formValidTo}
                    onChange={(e) => setFormValidTo(e.target.value)}
                    className="w-full bg-pos-bg border border-pos-border rounded-lg px-3 py-2 text-xs text-pos-text focus:border-emerald-400 focus:outline-none"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label htmlFor="pb-book-priority" className="text-[10px] uppercase font-bold text-pos-muted block mb-1">
                    Priorité (plus haut = prioritaire)
                  </label>
                  <input
                    id="pb-book-priority"
                    type="number"
                    step={1}
                    value={formPriority}
                    onChange={(e) => setFormPriority(Math.round(Number(e.target.value) || 0))}
                    className="w-full bg-pos-bg border border-pos-border rounded-lg px-3 py-2 text-xs font-mono text-pos-text focus:border-emerald-400 focus:outline-none"
                  />
                </div>
                <div>
                  <label htmlFor="pb-book-status" className="text-[10px] uppercase font-bold text-pos-muted block mb-1">
                    Statut
                  </label>
                  <select
                    id="pb-book-status"
                    value={formStatus}
                    onChange={(e) => setFormStatus(e.target.value === 'inactive' ? 'inactive' : 'active')}
                    className="w-full bg-pos-bg border border-pos-border rounded-lg px-3 py-2 text-xs text-pos-text focus:border-emerald-400 focus:outline-none"
                  >
                    <option value="active">Active</option>
                    <option value="inactive">Inactive</option>
                  </select>
                </div>
              </div>

              <div>
                <label htmlFor="pb-book-notes" className="text-[10px] uppercase font-bold text-pos-muted block mb-1">
                  Notes (facultatif)
                </label>
                <input
                  id="pb-book-notes"
                  type="text"
                  value={formNotes}
                  onChange={(e) => setFormNotes(e.target.value)}
                  placeholder="Ex: accord signé le 01/10"
                  className="w-full bg-pos-bg border border-pos-border rounded-lg px-3 py-2 text-xs text-pos-text focus:border-emerald-400 focus:outline-none"
                />
              </div>

              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setBookFormOpen(false)}
                  className="px-3 py-2 min-h-[38px] rounded-lg bg-pos-hover text-pos-muted hover:text-pos-text text-[11px] font-bold cursor-pointer"
                >
                  Annuler
                </button>
                <button
                  type="button"
                  onClick={() => void handleSaveBook()}
                  disabled={!storageOk}
                  className="px-4 py-2 min-h-[38px] rounded-lg bg-emerald-500 hover:bg-emerald-400 disabled:opacity-40 text-slate-950 text-[11px] font-black flex items-center gap-1 cursor-pointer"
                >
                  <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />
                  {editingBookId ? 'Enregistrer' : 'Créer'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
};
