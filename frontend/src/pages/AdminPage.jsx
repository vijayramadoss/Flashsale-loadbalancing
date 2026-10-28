// Admin dashboard (separate lazy chunk — shoppers never download it).
//  Deals:  live consistency counters (Redis vs MongoDB), create, reset (dev only)
//  Orders: filter by status, mark shipped / delivered
import { useEffect, useState } from 'react';
import { VStack } from '@astryxdesign/core/VStack';
import { HStack } from '@astryxdesign/core/HStack';
import { Grid } from '@astryxdesign/core/Grid';
import { Card } from '@astryxdesign/core/Card';
import { Heading } from '@astryxdesign/core/Heading';
import { Text } from '@astryxdesign/core/Text';
import { Badge } from '@astryxdesign/core/Badge';
import { Button } from '@astryxdesign/core/Button';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { Selector } from '@astryxdesign/core/Selector';
import { TextInput } from '@astryxdesign/core/TextInput';
import { FormLayout } from '@astryxdesign/core/FormLayout';
import { Table, pixel, proportional } from '@astryxdesign/core/Table';
import { Pagination } from '@astryxdesign/core/Pagination';
import { Banner } from '@astryxdesign/core/Banner';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import { Link } from '@astryxdesign/core/Link';
import { useToast } from '@astryxdesign/core/Toast';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useApi } from '../hooks/useApi.js';
import { ORDER_STATUS, formatDateTime, formatPrice, productTitle } from '../lib/format.js';

export default function AdminPage() {
  const { user } = useAuth();
  const [tab, setTab] = useState('deals');
  if (user?.role !== 'admin') return <Banner status="error" title="This page is for administrators only." collapsible={false} />;
  return (
    <VStack gap={5}>
      <HStack hAlign="between" vAlign="center" wrap="wrap" gap={3}>
        <Heading level={1}>Store admin</Heading>
        <SegmentedControl label="Admin section" value={tab} onChange={setTab}>
          <SegmentedControlItem value="deals" label="Flash deals" />
          <SegmentedControlItem value="orders" label="Orders" />
        </SegmentedControl>
      </HStack>
      {tab === 'deals' ? <DealsTab /> : <OrdersTab />}
    </VStack>
  );
}

// ---------------- deals ----------------

function DealsTab() {
  const deals = useApi('/admin/deals');
  const [selected, setSelected] = useState(null);
  const list = deals.data?.deals || [];
  const current = selected || list[0]?._id;

  return (
    <VStack gap={5}>
      {deals.error && <Banner status="error" title={deals.error.message} collapsible={false} />}
      {!deals.data && <Skeleton height={120} />}
      {list.length > 0 && (
        <Selector
          label="Deal"
          value={current}
          onChange={setSelected}
          options={list.map((d) => ({ value: d._id, label: `${d.title} — ${productTitle(d.product?.brand, d.product?.name || '')}`, description: `${d.totalStock - d.remainingStock}/${d.totalStock} held or sold · starts ${formatDateTime(d.startsAt)}` }))}
          width={520}
        />
      )}
      {current && <DealStats key={current} dealId={current} onChanged={deals.reload} />}
      <CreateDeal onCreated={(id) => { setSelected(id); deals.reload(); }} />
    </VStack>
  );
}

function DealStats({ dealId, onChanged }) {
  const [stats, setStats] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  useEffect(() => {
    let cancelled = false;
    let timer;
    const load = async () => {
      try {
        const { data } = await api(`/admin/deals/${dealId}/stats`);
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
  }, [dealId]);

  const reset = async () => {
    setBusy(true);
    try {
      const startsAt = new Date(Date.now() + 60_000);
      const { data } = await api(`/admin/deals/${dealId}/reset`, { method: 'POST', body: { startsAt: startsAt.toISOString(), endsAt: new Date(startsAt.getTime() + 3_600_000).toISOString() } });
      setStats(data.stats);
      toast({ body: 'Deal reset — it restarts in 1 minute.' });
      onChanged();
    } catch (err) {
      toast({ body: err.message, type: 'error' });
    } finally {
      setBusy(false);
    }
  };

  if (!stats) return error ? <Banner status="error" title={error} collapsible={false} /> : <Skeleton height={200} />;
  const ok = !stats.consistency.oversold && stats.consistency.countersMatchOrders;

  return (
    <Card>
      <VStack gap={4}>
        <HStack hAlign="between" vAlign="center" wrap="wrap" gap={2}>
          <VStack gap={0.5}>
            <Heading level={2}>{stats.title}</Heading>
            <Text type="supporting" size="sm">{stats.productName} · {stats.sku} · {formatPrice(stats.dealPriceCents)} · live, refreshes every 2 s</Text>
          </VStack>
          <Badge label={ok ? 'Consistent' : 'Check counters'} variant={ok ? 'success' : 'error'} />
        </HStack>
        <Grid columns={{ minWidth: 150, max: 4 }} gap={3}>
          <Stat label="Total units" value={stats.totalStock} />
          <Stat label="Paid orders" value={stats.orders.paid} />
          <Stat label="Awaiting payment" value={stats.orders.pendingPayment} />
          <Stat label="Expired / cancelled" value={stats.orders.expired + stats.orders.cancelled} />
          <Stat label="Remaining (MongoDB)" value={stats.mongo.remainingStock} />
          <Stat label="Tokens left (Redis)" value={stats.redis.remainingTokens ?? '—'} />
          <Stat label="Reservation holders" value={stats.redis.reservationHolders} />
          <Stat label="Queue: unacked" value={stats.queue.pendingUnacked} />
        </Grid>
        <Text size="sm">
          Oversold: <span className={stats.consistency.oversold ? 'hint-error' : 'hint-success-text'}>{stats.consistency.oversold ? 'YES' : 'no'}</span>
          {' · '}Mongo counters match orders: <span className={stats.consistency.countersMatchOrders ? 'hint-success-text' : 'hint-error'}>{stats.consistency.countersMatchOrders ? 'yes' : 'no'}</span>
        </Text>
        <HStack>
          <Button label="Reset & restart in 1 min (dev only)" variant="secondary" isLoading={busy} onClick={reset} />
        </HStack>
      </VStack>
    </Card>
  );
}

function Stat({ label, value }) {
  return (
    <div className="stat">
      <span className="stat-value">{typeof value === 'number' ? value.toLocaleString('en-IN') : value}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}

function CreateDeal({ onCreated }) {
  const products = useApi('/products?limit=48&sort=price_desc', { auth: false });
  const [slug, setSlug] = useState('');
  const product = useApi(slug ? `/products/${slug}` : null, { auth: false });
  const [f, setF] = useState({ sku: '', title: 'Festival Flash Deal', price: '', stock: '500', startsIn: '2', duration: '60', hold: '10' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (v) => setF((c) => ({ ...c, [k]: v }));
  const variant = product.data?.product.variants.find((v) => v.sku === f.sku);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const startsAt = new Date(Date.now() + Number(f.startsIn) * 60_000);
      const { data } = await api('/admin/deals', {
        method: 'POST',
        body: {
          sku: f.sku,
          title: f.title,
          dealPriceCents: Math.round(Number(f.price) * 100),
          totalStock: Number(f.stock),
          startsAt: startsAt.toISOString(),
          endsAt: new Date(startsAt.getTime() + Number(f.duration) * 60_000).toISOString(),
          holdMinutes: Number(f.hold),
        },
      });
      onCreated(data.deal.id);
    } catch (err) {
      setError(err.details ? err.details.map((d) => `${d.field}: ${d.message}`).join(' · ') : err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <form onSubmit={submit}>
        <VStack gap={4}>
          <Heading level={2}>Schedule a flash deal</Heading>
          {error && <Banner status="error" title={error} collapsible={false} />}
          <FormLayout defaultOptionality="required">
            <FormLayout direction="horizontal">
              <Selector label="Phone" hasSearch value={slug || undefined} onChange={(v) => { setSlug(v); set('sku')(''); }} options={(products.data?.items || []).map((p) => ({ value: p.slug, label: productTitle(p.brand, p.name) }))} placeholder="Choose a phone" />
              <Selector label="Variant" value={f.sku || undefined} onChange={set('sku')} isDisabled={!product.data} options={(product.data?.product.variants || []).map((v) => ({ value: v.sku, label: v.label, description: `Regular ${formatPrice(v.priceCents)}` }))} placeholder="Choose a variant" />
            </FormLayout>
            <TextInput label="Title" value={f.title} onChange={set('title')} />
            <FormLayout direction="horizontal">
              <TextInput label="Deal price (₹)" value={f.price} onChange={set('price')} description={variant ? `Must be below ${formatPrice(variant.priceCents)}` : undefined} />
              <TextInput label="Units" value={f.stock} onChange={set('stock')} />
              <TextInput label="Checkout hold (min)" value={f.hold} onChange={set('hold')} />
            </FormLayout>
            <FormLayout direction="horizontal">
              <TextInput label="Starts in (minutes)" value={f.startsIn} onChange={set('startsIn')} />
              <TextInput label="Duration (minutes)" value={f.duration} onChange={set('duration')} />
            </FormLayout>
          </FormLayout>
          <HStack><Button label="Create deal" variant="primary" type="submit" isLoading={busy} isDisabled={!f.sku || !f.price} /></HStack>
        </VStack>
      </form>
    </Card>
  );
}

// ---------------- orders ----------------

const STATUS_FILTERS = [{ value: 'ALL', label: 'All statuses' }, ...Object.entries(ORDER_STATUS).map(([value, s]) => ({ value, label: s.label }))];

function OrdersTab() {
  const [status, setStatus] = useState('ALL');
  const [page, setPage] = useState(1);
  const { data, error, reload } = useApi(`/admin/orders?page=${page}${status !== 'ALL' ? `&status=${status}` : ''}`);
  const toast = useToast();
  const [busyId, setBusyId] = useState(null);

  const advance = async (o, to) => {
    setBusyId(o.id);
    try {
      await api(`/admin/orders/${o.id}/status`, { method: 'POST', body: { status: to } });
      toast({ body: `${o.orderNumber} marked ${to.toLowerCase()}.` });
      reload();
    } catch (err) {
      toast({ body: err.message, type: 'error' });
    } finally {
      setBusyId(null);
    }
  };

  const columns = [
    { key: 'orderNumber', header: 'Order', width: pixel(170), renderCell: (o) => <Link href={`/orders/${o.id}`}>{o.orderNumber}</Link> },
    { key: 'customer', header: 'Customer', width: proportional(2), renderCell: (o) => <VStack gap={0}><Text size="sm">{o.customer?.name}</Text><Text type="supporting" size="sm">{o.customer?.email}</Text></VStack> },
    { key: 'items', header: 'Items', width: proportional(2), renderCell: (o) => <Text size="sm">{o.items.map((i) => `${i.name} ×${i.qty}`).join(', ')}</Text> },
    { key: 'total', header: 'Total', align: 'end', width: pixel(110), renderCell: (o) => <Text size="sm" hasTabularNumbers>{formatPrice(o.pricing.totalCents)}</Text> },
    { key: 'status', header: 'Status', width: pixel(150), renderCell: (o) => <Badge label={ORDER_STATUS[o.status].label} variant={ORDER_STATUS[o.status].badge} /> },
    { key: 'createdAt', header: 'Placed', width: pixel(170), renderCell: (o) => <Text size="sm">{formatDateTime(o.createdAt)}</Text> },
    {
      key: 'actions',
      header: '',
      width: pixel(150),
      renderCell: (o) =>
        o.status === 'CONFIRMED' ? <Button label="Mark shipped" size="sm" isLoading={busyId === o.id} onClick={() => advance(o, 'SHIPPED')} />
        : o.status === 'SHIPPED' ? <Button label="Mark delivered" size="sm" isLoading={busyId === o.id} onClick={() => advance(o, 'DELIVERED')} />
        : null,
    },
  ];

  return (
    <VStack gap={4}>
      <HStack gap={3} vAlign="center" wrap="wrap">
        <Selector label="Status" isLabelHidden variant="secondary" value={status} onChange={(v) => { setStatus(v); setPage(1); }} options={STATUS_FILTERS} width={220} />
        {data && (
          <Text type="supporting" size="sm">
            {Object.entries(data.summary).map(([s, v]) => `${ORDER_STATUS[s]?.label}: ${v.count}`).join(' · ')}
          </Text>
        )}
      </HStack>
      {error && <Banner status="error" title={error.message} collapsible={false} />}
      {!data ? <Skeleton height={240} /> : (
        <Card padding={0} className="table-card">
          <Table data={data.orders} columns={columns} idKey="id" density="compact" hasHover />
        </Card>
      )}
      {data && data.pages > 1 && <Pagination page={page} onChange={setPage} totalItems={data.total} pageSize={20} />}
    </VStack>
  );
}
