import { useState } from 'react';
import { VStack } from '@astryxdesign/core/VStack';
import { HStack } from '@astryxdesign/core/HStack';
import { StackItem } from '@astryxdesign/core/Stack';
import { Card } from '@astryxdesign/core/Card';
import { Heading } from '@astryxdesign/core/Heading';
import { Text } from '@astryxdesign/core/Text';
import { Badge } from '@astryxdesign/core/Badge';
import { Button } from '@astryxdesign/core/Button';
import { Banner } from '@astryxdesign/core/Banner';
import { Stepper, Step } from '@astryxdesign/core/Stepper';
import { Divider } from '@astryxdesign/core/Divider';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { AlertDialog } from '@astryxdesign/core/AlertDialog';
import { Link } from '@astryxdesign/core/Link';
import { useToast } from '@astryxdesign/core/Toast';
import { api } from '../api.js';
import { useApi, invalidateApiCache } from '../hooks/useApi.js';
import { useLocation } from '../router.jsx';
import { ORDER_STATUS, formatDateTime, formatEta, formatPrice, productTitle } from '../lib/format.js';
import Summary from '../components/Summary.jsx';
import PhoneArt from '../components/PhoneArt.jsx';
import Countdown from '../components/Countdown.jsx';

const FLOW = ['PENDING_PAYMENT', 'CONFIRMED', 'SHIPPED', 'DELIVERED'];

export default function OrderPage({ id }) {
  const { query } = useLocation();
  const { data, error, reload } = useApi(`/orders/${id}`);
  const toast = useToast();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [busy, setBusy] = useState(false);
  const order = data?.order;

  if (error) return <EmptyState title="Order not found" description={error.message} actions={<Button label="My orders" href="/orders" />} headingLevel={1} />;
  if (!order) return <VStack gap={4}><Skeleton height={40} width="50%" /><Skeleton height={200} index={1} /><Skeleton height={160} index={2} /></VStack>;

  const status = ORDER_STATUS[order.status];
  const justPlaced = query.get('placed') === '1' && order.status === 'CONFIRMED';
  const active = FLOW.indexOf(order.status);

  const cancel = async () => {
    setBusy(true);
    try {
      await api(`/orders/${order.id}/cancel`, { method: 'POST' });
      invalidateApiCache('/orders');
      toast({ body: order.payment.status === 'PAID' ? 'Order cancelled — your refund is on its way.' : 'Order cancelled.' });
      setConfirmCancel(false);
      reload();
    } catch (err) {
      toast({ body: err.message, type: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <VStack gap={5}>
      {justPlaced && (
        <Banner
          status="success"
          title="Thank you — your order is confirmed!"
          description={`We’ll deliver it ${formatEta(order.delivery.etaFrom, order.delivery.etaTo)}. A copy of this page is always under My orders.`}
          collapsible={false}
        />
      )}
      {order.status === 'PENDING_PAYMENT' && order.canPay && (
        <Banner
          status="warning"
          title={<HStack gap={2} vAlign="center" wrap="wrap"><span>Payment pending — your items are held for</span><Countdown target={Date.parse(order.expiresAt)} format="ms" className="countdown-inline" onZero={reload} /></HStack>}
          endContent={<Button label="Complete payment" variant="primary" href={`/checkout/${order.id}`} />}
          collapsible={false}
        />
      )}
      {order.status === 'EXPIRED' && <Banner status="info" title="This order expired" description="Payment wasn’t completed in time, so the reserved stock was released." collapsible={false} />}
      {order.status === 'CANCELLED' && (
        <Banner
          status="info"
          title="This order was cancelled"
          description={order.payment.status === 'REFUNDED' ? 'Your payment has been refunded to the original method.' : order.payment.status === 'REFUND_PENDING' ? 'Your refund is on its way to the original payment method.' : undefined}
          collapsible={false}
        />
      )}
      {order.status === 'RETURNED' && <Banner status="info" title="This order was returned" description="The refund has been issued to your original payment method." collapsible={false} />}

      <HStack gap={3} hAlign="between" vAlign="center" wrap="wrap">
        <VStack gap={0.5}>
          <Heading level={1}>Order {order.orderNumber}</Heading>
          <Text type="supporting">Placed {formatDateTime(order.createdAt)}{order.type === 'DEAL' ? ' · Flash deal' : ''}</Text>
        </VStack>
        <Badge label={status.label} variant={status.badge} />
      </HStack>

      {active >= 0 && (
        <Card>
          {/* The step AFTER the current status is "in progress" (e.g. confirmed → shipping next). */}
          <Stepper activeStep={Math.min(4, active + 1)} label="Order progress">
            <Step step={0} label="Placed" />
            <Step step={1} label="Confirmed" />
            <Step step={2} label="Shipped" />
            <Step step={3} label="Delivered" description={order.status !== 'DELIVERED' && order.delivery?.etaFrom ? `Expected ${formatEta(order.delivery.etaFrom, order.delivery.etaTo)}` : undefined} />
          </Stepper>
        </Card>
      )}

      <div className="two-col">
        <VStack gap={4}>
          <Card padding={0}>
            {order.items.map((l, i) => (
              <div key={l.sku}>
                {i > 0 && <Divider />}
                <HStack gap={4} padding={4} vAlign="center">
                  <div className="line-art"><PhoneArt colorHex={l.colorHex} design={l.design} size="xs" /></div>
                  <StackItem size="fill">
                    <VStack gap={0.5}>
                      <Link href={`/phones/${l.slug}`} color="inherit" weight="semibold">{productTitle(l.brand, l.name)}</Link>
                      <Text type="supporting" size="sm">{l.variantLabel} · Qty {l.qty}</Text>
                    </VStack>
                  </StackItem>
                  <Text hasTabularNumbers>{formatPrice(l.unitPriceCents * l.qty)}</Text>
                </HStack>
              </div>
            ))}
          </Card>

          <Card>
            <VStack gap={3}>
              <Heading level={3}>Activity</Heading>
              {[...order.history].reverse().map((h, i) => (
                <HStack key={i} gap={3} vAlign="start">
                  <Text type="supporting" size="sm" hasTabularNumbers className="history-time">{formatDateTime(h.at)}</Text>
                  <Text size="sm">{h.note || ORDER_STATUS[h.status]?.label}</Text>
                </HStack>
              ))}
            </VStack>
          </Card>
        </VStack>

        <VStack gap={4}>
          <Card>
            <VStack gap={3}>
              <Heading level={3}>Delivery</Heading>
              {order.shippingAddress ? (
                <VStack gap={0.5}>
                  <Text weight="semibold">{order.shippingAddress.fullName}</Text>
                  <Text size="sm">{order.shippingAddress.line1}{order.shippingAddress.line2 ? `, ${order.shippingAddress.line2}` : ''}</Text>
                  <Text size="sm">{order.shippingAddress.city}, {order.shippingAddress.state} {order.shippingAddress.pincode}</Text>
                  <Text type="supporting" size="sm">{order.shippingAddress.phone} · {order.delivery.method === 'EXPRESS' ? 'Express' : 'Standard'} delivery</Text>
                </VStack>
              ) : <Text type="supporting">Not chosen yet</Text>}
              <Divider />
              <Heading level={3}>Payment</Heading>
              <Text size="sm">{paymentText(order.payment)}</Text>
              <Divider />
              <Summary pricing={order.pricing} />
            </VStack>
          </Card>
          {order.canCancel && <Button label="Cancel order" variant="secondary" onClick={() => setConfirmCancel(true)} />}
          <Button label="Continue shopping" variant="ghost" href="/phones" />
        </VStack>
      </div>

      <AlertDialog
        isOpen={confirmCancel}
        onOpenChange={setConfirmCancel}
        title="Cancel this order?"
        description={order.payment.status === 'PAID' ? 'The items go back on sale and your payment is refunded.' : 'The reserved items go back on sale.'}
        actionLabel="Cancel order"
        cancelLabel="Keep order"
        onAction={cancel}
        isActionLoading={busy}
      />
    </VStack>
  );
}

function paymentText(p) {
  if (p.status === 'COD') return 'Cash on delivery';
  if (p.status === 'PROCESSING') return 'Payment processing — waiting for your bank';
  if (p.status === 'REFUND_PENDING') return 'Refund in progress to the original payment method';
  if (p.status === 'REFUNDED') return `Refunded${p.method === 'CARD' ? ` to ${p.cardBrand} •••• ${p.last4}` : p.vpa ? ` to ${p.vpa}` : ''}`;
  if (p.status === 'PAID') return p.method === 'CARD' ? `Paid with ${p.cardBrand} •••• ${p.last4}` : `Paid via UPI (${p.vpa})`;
  return p.failedAttempts ? `Not paid — ${p.failedAttempts} declined attempt${p.failedAttempts > 1 ? 's' : ''}` : 'Not paid yet';
}
