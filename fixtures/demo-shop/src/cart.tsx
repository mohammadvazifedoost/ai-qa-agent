import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { PRODUCTS, type Product } from './api/catalog';

interface CartLine {
  product: Product;
  quantity: number;
}

interface CartValue {
  lines: CartLine[];
  count: number;
  subtotalCents: number;
  add(productId: string): void;
  remove(productId: string): void;
}

const CartContext = createContext<CartValue | null>(null);

export function CartProvider({ children }: { children: ReactNode }) {
  const [quantities, setQuantities] = useState<Record<string, number>>({});

  const value = useMemo<CartValue>(() => {
    const lines = PRODUCTS.filter((p) => quantities[p.id]).map((p) => ({ product: p, quantity: quantities[p.id]! }));
    return {
      lines,
      count: lines.reduce((n, l) => n + l.quantity, 0),
      subtotalCents: lines.reduce((n, l) => n + l.quantity * l.product.priceCents, 0),
      add: (id) => setQuantities((q) => ({ ...q, [id]: (q[id] ?? 0) + 1 })),
      remove: (id) =>
        setQuantities((q) => {
          const next = { ...q };
          delete next[id];
          return next;
        }),
    };
  }, [quantities]);

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartValue {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error('useCart must be used inside CartProvider');
  return ctx;
}
