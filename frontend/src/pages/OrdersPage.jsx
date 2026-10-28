import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { Link } from '../router.jsx';
import { formatPrice } from '../lib/format.js';

export default function OrdersPage() {
  const { user } = useAuth();
  const [orders, setOrders] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!user) return undefined;
    let cancelled = false;
    api('/orders/mine')
      .then(({ data }) => !cancelled && setOrders(data.orders))
      .catch((err) => !cancelled && setError(err.message));
    return () => { cancelled = true; };
  }, [user]);

  if (!user) {
    return (
      <p className="card center">
        <Link to="/login">Log in</Link> to see your orders.
      </p>
    );
  }

  return (
    <section className="card">
      <h1>My orders</h1>
      {error && <p className="err">{error}</p>}
      {!orders && !error && <p className="muted">Loading…</p>}
      {orders && orders.length === 0 && (
        <p className="muted">
          No orders yet. <Link to="/">Go to the sale</Link>
        </p>
      )}
      {orders && orders.length > 0 && (
        <ul className="orders">
          {orders.map((o) => (
            <li key={o.id}>
              <img src={o.imageUrl || '/phone.svg'} alt="" width="48" height="64" loading="lazy" />
              <div>
                <strong>{o.productName}</strong>
                <span className="muted small">{o.saleTitle} · {new Date(o.createdAt).toLocaleString()}</span>
                <span className="muted small">Order {o.id}</span>
              </div>
              <div className="right">
                <span className="badge badge-live">{o.status}</span>
                <span>{formatPrice(o.priceCents)}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
