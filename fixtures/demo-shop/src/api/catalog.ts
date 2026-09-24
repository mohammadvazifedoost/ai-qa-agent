export interface Product {
  id: string;
  name: string;
  description: string;
  priceCents: number;
}

export const PRODUCTS: Product[] = [
  { id: 'mug', name: 'Ceramic Mug', description: 'Hand-glazed, 350 ml.', priceCents: 1800 },
  { id: 'tote', name: 'Canvas Tote', description: 'Heavyweight organic cotton.', priceCents: 2400 },
  { id: 'notebook', name: 'Dot Notebook', description: 'A5, 160 pages, lay-flat.', priceCents: 1200 },
];

const COUPONS: Record<string, number> = { SAVE10: 0.1, WELCOME20: 0.2 };

/** Simulated coupon API (async, like a real network call). */
export async function validateCoupon(code: string): Promise<{ valid: true; rate: number } | { valid: false }> {
  await new Promise((r) => setTimeout(r, 300));
  const rate = COUPONS[code.trim().toUpperCase()];
  return rate === undefined ? { valid: false } : { valid: true, rate };
}

/** Simulated login API. */
export async function login(email: string, password: string): Promise<{ ok: boolean; name?: string }> {
  await new Promise((r) => setTimeout(r, 500));
  if (email.toLowerCase() === 'demo@shop.test' && password === 'password123') return { ok: true, name: 'Demo User' };
  return { ok: false };
}

/** Simulated contact API. */
export async function sendMessage(input: { name: string; email: string; message: string }): Promise<{ ok: true }> {
  await new Promise((r) => setTimeout(r, 400));
  void input;
  return { ok: true };
}

export function formatPrice(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
