import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useSaleStatus } from '../hooks.js';
import { formatPrice } from '../lib/format.js';
import Countdown from '../components/Countdown.jsx';
import StockBar from '../components/StockBar.jsx';
import CheckoutPanel from '../components/CheckoutPanel.jsx';

export default function SalePage() {
  const [saleId, setSaleId] = useState(null);
  const [listState, setListState] = useState('loading'); // loading | ready | empty | error

  useEffect(() => {
    let cancelled = false;
    api('/sales', { auth: false })
      .then(({ data }) => {
        if (cancelled) return;
        if (data.sales.length) {
          setSaleId(data.sales[0].id);
          setListState('ready');
        } else setListState('empty');
      })
      .catch(() => !cancelled && setListState('error'));
    return () => { cancelled = true; };
  }, []);

  if (listState === 'loading') return <SaleSkeleton />;
  if (listState === 'error') return <p className="card err center">Couldn't load the sale. Please refresh in a moment.</p>;
  if (listState === 'empty') return <p className="card muted center">No flash sale is scheduled right now. Check back soon!</p>;
  return <SaleView saleId={saleId} />;
}

function SaleView({ saleId }) {
  const { sale, error, offset } = useSaleStatus(saleId);
  const [startedLocally, setStartedLocally] = useState(false);
  const [optimistic, setOptimistic] = useState(false);
  const onZero = useCallback(() => setStartedLocally(true), []);
  const onOptimistic = useCallback((v) => setOptimistic((prev) => (prev === v ? prev : v)), []);

  if (!sale) return error ? <p className="card err center">{error.message}</p> : <SaleSkeleton />;

  // Flip UPCOMING → LIVE the instant the synced countdown hits zero, without waiting for the next poll.
  const state = sale.state === 'UPCOMING' && startedLocally ? 'LIVE' : sale.state;
  const remaining = Math.max(0, sale.remainingStock - (optimistic ? 1 : 0));

  return (
    <article className="sale card">
      <div className="sale-media">
        <img src={sale.product.imageUrl || '/phone.svg'} alt={sale.product.name} width="240" height="320" fetchpriority="high" />
      </div>
      <div className="sale-body">
        <p className={`badge badge-${state.toLowerCase()}`}>{badgeText(state)}</p>
        <h1>{sale.product.name}</h1>
        <p className="muted">{sale.title}</p>
        <p className="price">{formatPrice(sale.priceCents, sale.currency)}</p>
        {sale.product.description && <p>{sale.product.description}</p>}

        {state === 'UPCOMING' && (
          <div className="starts">
            <span>Sale starts in</span>
            <Countdown target={Date.parse(sale.startsAt)} offset={offset} onZero={onZero} />
            <span className="muted small">{new Date(sale.startsAt).toLocaleString()}</span>
          </div>
        )}

        <StockBar remaining={remaining} total={sale.totalStock} />
        <CheckoutPanel saleId={saleId} saleState={state} onOptimistic={onOptimistic} />
        {error && <p className="muted small">Live updates paused — reconnecting…</p>}
      </div>
    </article>
  );
}

function badgeText(state) {
  return { UPCOMING: 'Coming soon', LIVE: 'Live now', SOLD_OUT: 'Sold out', ENDED: 'Ended' }[state] || state;
}

function SaleSkeleton() {
  return (
    <div className="sale card skeleton" aria-busy="true" aria-label="Loading sale">
      <div className="sale-media"><div className="sk sk-img" /></div>
      <div className="sale-body">
        <div className="sk sk-line w40" />
        <div className="sk sk-line w80 tall" />
        <div className="sk sk-line w60" />
        <div className="sk sk-line w100" />
      </div>
    </div>
  );
}
