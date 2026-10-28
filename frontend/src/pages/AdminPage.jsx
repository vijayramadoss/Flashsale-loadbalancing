// Admin dashboard (lazy-loaded chunk). Lets an admin schedule a sale and
// watch the consistency counters live while it runs.
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { Link } from '../router.jsx';
import { formatPrice } from '../lib/format.js';

export default function AdminPage() {
  const { user } = useAuth();
  const [sales, setSales] = useState(null);
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState('');

  const loadSales = useCallback(async () => {
    try {
      const { data } = await api('/admin/sales');
      setSales(data.sales);
      setSelected((cur) => cur || data.sales[0]?._id || null);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    if (user?.role === 'admin') loadSales();
  }, [user, loadSales]);

  if (!user) return <p className="card center"><Link to="/login">Log in</Link> as an admin.</p>;
  if (user.role !== 'admin') return <p className="card err center">This page is for administrators only.</p>;

  return (
    <div className="admin">
      <section className="card">
        <h1>Sales</h1>
        {error && <p className="err">{error}</p>}
        {!sales && !error && <p className="muted">Loading…</p>}
        {sales?.length === 0 && <p className="muted">No sales yet — create one below.</p>}
        {sales?.length > 0 && (
          <ul className="sale-list">
            {sales.map((s) => (
              <li key={s._id}>
                <button type="button" className={`list-btn${selected === s._id ? ' active' : ''}`} onClick={() => setSelected(s._id)}>
                  <strong>{s.title}</strong>
                  <span className="muted small">
                    {s.product?.name} · {s.totalStock - s.remainingStock}/{s.totalStock} sold · starts {new Date(s.startsAt).toLocaleString()}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      {selected && <StatsPanel saleId={selected} onChanged={loadSales} />}
      <CreateSaleForm
        onCreated={(id) => {
          setSelected(id);
          loadSales();
        }}
      />
    </div>
  );
}

function StatsPanel({ saleId, onChanged }) {
  const [stats, setStats] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer;
    const load = async () => {
      try {
        const { data } = await api(`/admin/sales/${saleId}/stats`);
        if (!cancelled) {
          setStats(data.stats);
          setError('');
        }
      } catch (err) {
        if (!cancelled) setError(err.message);
      }
      if (!cancelled) timer = setTimeout(load, 2000);
    };
    load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [saleId]);

  const reset = async () => {
    const minutes = Number(window.prompt('Restart this sale, deleting its orders. Start in how many minutes?', '1'));
    if (!Number.isFinite(minutes) || minutes < 0) return;
    setBusy(true);
    try {
      const startsAt = new Date(Date.now() + minutes * 60_000);
      const endsAt = new Date(startsAt.getTime() + 60 * 60_000);
      const { data } = await api(`/admin/sales/${saleId}/reset`, { method: 'POST', body: { startsAt, endsAt } });
      setStats(data.stats);
      onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (!stats) return <section className="card"><p className="muted">{error || 'Loading stats…'}</p></section>;
  const ok = !stats.consistency.oversold && stats.consistency.countersMatchOrders;

  return (
    <section className="card">
      <div className="row-between">
        <h2>{stats.title}</h2>
        <span className={`badge ${ok ? 'badge-live' : 'badge-ended'}`}>{ok ? 'Consistent' : 'Check counters'}</span>
      </div>
      <p className="muted small">Live — refreshes every 2 s. {stats.productName}</p>
      <div className="stats">
        <Stat label="Total stock" value={stats.totalStock} />
        <Stat label="Confirmed orders (Mongo)" value={stats.mongo.confirmedOrders} />
        <Stat label="Remaining (Mongo)" value={stats.mongo.remainingStock} />
        <Stat label="Tokens left (Redis)" value={stats.redis.remainingTokens ?? '—'} />
        <Stat label="Reservation holders" value={stats.redis.reservationHolders} />
        <Stat label="Queue: unacked" value={stats.queue.pendingUnacked} />
      </div>
      <p className="small">
        Oversold: <strong className={stats.consistency.oversold ? 'err' : 'ok'}>{stats.consistency.oversold ? 'YES' : 'no'}</strong>
      </p>
      {error && <p className="err">{error}</p>}
      <button type="button" className="btn" onClick={reset} disabled={busy}>Reset &amp; restart sale (dev only)</button>
    </section>
  );
}

function Stat({ label, value }) {
  return (
    <div className="stat">
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}

function CreateSaleForm({ onCreated }) {
  const [f, setF] = useState({ title: 'Festival Flash Sale', name: 'Nova X1 5G Smartphone', price: '24999', stock: '500', startsIn: '2', duration: '60' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF((v) => ({ ...v, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const startsAt = new Date(Date.now() + Number(f.startsIn) * 60_000);
      const { data } = await api('/admin/sales', {
        method: 'POST',
        body: {
          title: f.title,
          startsAt,
          endsAt: new Date(startsAt.getTime() + Number(f.duration) * 60_000),
          totalStock: Number(f.stock),
          product: { name: f.name, priceCents: Math.round(Number(f.price) * 100), imageUrl: '/phone.svg', description: '' },
        },
      });
      onCreated(data.sale.id);
    } catch (err) {
      setError(err.details ? err.details.map((d) => `${d.field}: ${d.message}`).join(' · ') : err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card" onSubmit={submit}>
      <h2>Schedule a new sale</h2>
      <div className="grid2">
        <label className="field">Title<input value={f.title} onChange={set('title')} required /></label>
        <label className="field">Product name<input value={f.name} onChange={set('name')} required /></label>
        <label className="field">Price (₹)<input type="number" min="0" value={f.price} onChange={set('price')} required /></label>
        <label className="field">Units<input type="number" min="1" value={f.stock} onChange={set('stock')} required /></label>
        <label className="field">Starts in (minutes)<input type="number" min="0" step="0.5" value={f.startsIn} onChange={set('startsIn')} required /></label>
        <label className="field">Duration (minutes)<input type="number" min="1" value={f.duration} onChange={set('duration')} required /></label>
      </div>
      <p className="muted small">Preview price: {formatPrice(Math.round(Number(f.price || 0) * 100))}</p>
      {error && <p className="err">{error}</p>}
      <button type="submit" className="btn btn-primary" disabled={busy}>Create sale</button>
    </form>
  );
}
