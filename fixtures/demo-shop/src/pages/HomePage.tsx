import { PRODUCTS, formatPrice } from '../api/catalog';
import { Button } from '../components/Button';
import { useCart } from '../cart';

export function HomePage() {
  const { add } = useCart();
  return (
    <>
      <section className="hero">
        <h1>Everyday goods, made well</h1>
        <p className="muted">Small-batch essentials for your desk and kitchen.</p>
      </section>
      <section id="products" aria-labelledby="products-heading">
        <h2 id="products-heading">Products</h2>
        <ul className="product-grid">
          {PRODUCTS.map((p) => (
            <li key={p.id} className="card">
              <h3>{p.name}</h3>
              <p className="muted">{p.description}</p>
              <p className="price">{formatPrice(p.priceCents)}</p>
              <Button onClick={() => add(p.id)} aria-label={`Add ${p.name} to cart`}>
                Add to cart
              </Button>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
