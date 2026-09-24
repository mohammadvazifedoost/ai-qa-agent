import { useState } from 'react';
import { Link, NavLink, Outlet } from 'react-router-dom';
import { useCart } from '../cart';

export function Layout() {
  const { count } = useCart();
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <>
      <header className="site-header">
        <Link to="/" className="logo">
          Demo Shop
        </Link>
        <button
          className="menu-toggle"
          aria-label="Open menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((o) => !o)}
        >
          ☰
        </button>
        <nav aria-label="Main" className={`main-nav ${menuOpen ? 'open' : ''}`}>
          <NavLink to="/" end>
            Home
          </NavLink>
          <a href="/#products">Shop all products</a>
          <NavLink to="/checkout">
            Checkout{' '}
            <span className="cart-badge" aria-label={`${count} items in cart`}>
              {count}
            </span>
          </NavLink>
          <NavLink to="/login">Sign in to your account</NavLink>
          <NavLink to="/contact">Contact</NavLink>
        </nav>
      </header>
      <main className="container">
        <Outlet />
      </main>
    </>
  );
}
