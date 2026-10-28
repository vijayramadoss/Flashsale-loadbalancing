// Shopping cart held in the browser (localStorage): guests can shop without
// an account and the server stays stateless. Only SKUs and quantities are
// stored — prices always come from the server (POST /api/cart/quote).
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

const CartContext = createContext(null);
const KEY = 'fs.cart';
export const MAX_QTY = 5;
export const MAX_LINES = 10;

function read() {
  try {
    const items = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(items) ? items.filter((i) => typeof i.sku === 'string' && i.qty > 0) : [];
  } catch {
    return [];
  }
}

export function CartProvider({ children }) {
  const [items, setItems] = useState(read);

  useEffect(() => {
    try { localStorage.setItem(KEY, JSON.stringify(items)); } catch { /* storage unavailable */ }
  }, [items]);

  // Keep several open tabs in sync.
  useEffect(() => {
    const onStorage = (e) => e.key === KEY && setItems(read());
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // Latest items for synchronous decisions (state updaters may run later).
  const itemsRef = useRef(items);
  itemsRef.current = items;

  /** Returns 'added' | 'max' (already at the per-item limit) | 'full' (too many lines). */
  const add = useCallback((sku, qty = 1) => {
    const cur = itemsRef.current;
    const existing = cur.find((i) => i.sku === sku);
    let next;
    let result = 'added';
    if (existing) {
      const q = Math.min(MAX_QTY, existing.qty + qty);
      if (q === existing.qty) result = 'max';
      next = cur.map((i) => (i.sku === sku ? { ...i, qty: q } : i));
    } else if (cur.length >= MAX_LINES) {
      return 'full';
    } else {
      next = [...cur, { sku, qty: Math.min(MAX_QTY, qty) }];
    }
    itemsRef.current = next;
    setItems(next);
    return result;
  }, []);

  const setQty = useCallback((sku, qty) => {
    setItems((cur) => (qty <= 0 ? cur.filter((i) => i.sku !== sku) : cur.map((i) => (i.sku === sku ? { ...i, qty: Math.min(MAX_QTY, qty) } : i))));
  }, []);

  const remove = useCallback((sku) => setItems((cur) => cur.filter((i) => i.sku !== sku)), []);
  const removeMany = useCallback((skus) => setItems((cur) => cur.filter((i) => !skus.includes(i.sku))), []);

  const value = useMemo(
    () => ({ items, count: items.reduce((n, i) => n + i.qty, 0), add, setQty, remove, removeMany }),
    [items, add, setQty, remove, removeMany],
  );
  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export const useCart = () => useContext(CartContext);
