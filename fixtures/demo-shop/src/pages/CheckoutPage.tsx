import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { formatPrice, validateCoupon } from '../api/catalog';
import { Button } from '../components/Button';
import { useCart } from '../cart';

type CouponState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'applied'; code: string; rate: number }
  | { status: 'error'; message: string };

export function CheckoutPage() {
  const { lines, subtotalCents, remove } = useCart();
  const [code, setCode] = useState('');
  const [coupon, setCoupon] = useState<CouponState>({ status: 'idle' });

  if (lines.length === 0) {
    return (
      <section className="empty-state">
        <h1>Your cart is empty</h1>
        <p className="muted">Add a product to start checking out.</p>
        <Link to="/">Browse products</Link>
      </section>
    );
  }

  const discountCents = coupon.status === 'applied' ? Math.round(subtotalCents * coupon.rate) : 0;
  const totalCents = subtotalCents;

  async function applyCoupon(e: FormEvent) {
    e.preventDefault();
    if (!code.trim()) {
      setCoupon({ status: 'error', message: 'Enter a coupon code' });
      return;
    }
    setCoupon({ status: 'checking' });
    const res = await validateCoupon(code);
    setCoupon(
      res.valid
        ? { status: 'applied', code: code.trim().toUpperCase(), rate: res.rate }
        : { status: 'error', message: 'Invalid coupon code' },
    );
  }

  return (
    <section className="checkout">
      <h1>Checkout</h1>
      <ul className="order-lines" aria-label="Order items">
        {lines.map((l) => (
          <li key={l.product.id}>
            <span>
              {l.product.name} × {l.quantity}
            </span>
            <span>{formatPrice(l.quantity * l.product.priceCents)}</span>
            <button className="link" onClick={() => remove(l.product.id)} aria-label={`Remove ${l.product.name}`}>
              Remove
            </button>
          </li>
        ))}
      </ul>

      <form className="coupon" onSubmit={applyCoupon} noValidate>
        <label htmlFor="coupon">Coupon code</label>
        <div className="row">
          <input id="coupon" value={code} onChange={(e) => setCode(e.target.value)} placeholder="e.g. SAVE10" />
          <Button type="submit" variant="secondary" disabled={coupon.status === 'checking'}>
            {coupon.status === 'checking' ? 'Applying…' : 'Apply'}
          </Button>
        </div>
        {coupon.status === 'applied' && (
          <p role="status" className="success">
            Coupon {coupon.code} applied: {Math.round(coupon.rate * 100)}% off
          </p>
        )}
        {coupon.status === 'error' && (
          <p role="alert" className="error">
            {coupon.message}
          </p>
        )}
      </form>

      <dl className="summary">
        <div>
          <dt>Subtotal</dt>
          <dd data-testid="subtotal">{formatPrice(subtotalCents)}</dd>
        </div>
        {discountCents > 0 && (
          <div>
            <dt>Discount</dt>
            <dd data-testid="discount">−{formatPrice(discountCents)}</dd>
          </div>
        )}
        <div className="total">
          <dt>Total</dt>
          <dd data-testid="total">{formatPrice(totalCents)}</dd>
        </div>
      </dl>
      <Button className="place-order">Place order</Button>
    </section>
  );
}
