// Multi-step checkout: Address → Delivery → Payment.
//
//  /checkout                 cart checkout (or ?sku=&qty= for "Buy now" on one item)
//  /checkout/:orderId        resume a pending order — flash-deal orders start here,
//                            and cart orders move here once placed (so refresh resumes)
//
// The order is created only at "Pay": stock is then held for a few minutes, and a
// declined payment can be retried on the same order until the hold expires.
import { useEffect, useMemo, useRef, useState } from 'react';
import { VStack } from '@astryxdesign/core/VStack';
import { HStack } from '@astryxdesign/core/HStack';
import { StackItem } from '@astryxdesign/core/Stack';
import { Card } from '@astryxdesign/core/Card';
import { Heading } from '@astryxdesign/core/Heading';
import { Text } from '@astryxdesign/core/Text';
import { Button } from '@astryxdesign/core/Button';
import { Stepper, Step } from '@astryxdesign/core/Stepper';
import { RadioList, RadioListItem } from '@astryxdesign/core/RadioList';
import { TextInput } from '@astryxdesign/core/TextInput';
import { FormLayout } from '@astryxdesign/core/FormLayout';
import { Banner } from '@astryxdesign/core/Banner';
import { Divider } from '@astryxdesign/core/Divider';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Link } from '@astryxdesign/core/Link';
import { api, newIdempotencyKey } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useCart } from '../cart.jsx';
import { navigate, useLocation } from '../router.jsx';
import { useApi, invalidateApiCache } from '../hooks/useApi.js';
import { useQuote } from './CartPage.jsx';
import { formatEta, formatPrice, productTitle } from '../lib/format.js';
import Summary from '../components/Summary.jsx';
import PhoneArt from '../components/PhoneArt.jsx';
import Countdown from '../components/Countdown.jsx';
import AddressDialog from '../components/AddressDialog.jsx';

const DAY = 86_400_000;
const DELIVERY = {
  STANDARD: { label: 'Standard delivery', feeCents: 0, min: 3, max: 5 },
  EXPRESS: { label: 'Express delivery', feeCents: 14900, min: 1, max: 2 },
};

export default function CheckoutPage({ orderId }) {
  const { user } = useAuth();
  const { path, search } = useLocation();
  useEffect(() => {
    if (!user) navigate(`/login?next=${encodeURIComponent(path + search)}`, { replace: true });
  }, [user, path, search]);
  if (!user) return null;
  // An order created on this page moves the URL to /checkout/:id (so a refresh
  // resumes it) without remounting the form mid-payment.
  const key = orderId && orderId !== createdHere.id ? orderId : 'new';
  return <Checkout key={key} initialOrderId={orderId} />;
}

const createdHere = { id: null };

function Checkout({ initialOrderId }) {
  const { query } = useLocation();
  const cart = useCart();
  const buyNowSku = query.get('sku');
  // What is being bought before an order exists: one "Buy now" item, or the cart.
  const items = useMemo(
    () => (buyNowSku ? [{ sku: buyNowSku, qty: Math.max(1, Math.min(5, Number(query.get('qty')) || 1)) }] : cart.items),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [buyNowSku, buyNowSku ? query.get('qty') : JSON.stringify(cart.items)],
  );

  const [orderId, setOrderId] = useState(initialOrderId);
  const [order, setOrder] = useState(null);
  const [orderError, setOrderError] = useState(null);
  const [step, setStep] = useState(0);
  const [addressId, setAddressId] = useState(null);
  const [delivery, setDelivery] = useState('STANDARD');
  const [method, setMethod] = useState('UPI');
  const [upi, setUpi] = useState('');
  const [cardForm, setCardForm] = useState({ number: '', expiry: '', cvc: '', name: '' });
  const [fieldErrors, setFieldErrors] = useState({});
  const [payError, setPayError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  // One idempotency key per payment attempt: a double click or a retried
  // request reuses it (the server answers with the first result, no double charge).
  const payKey = useRef(newIdempotencyKey());

  const addresses = useApi('/account/addresses');
  const { quote } = useQuote(orderId ? [] : items, delivery);

  // Load an existing order (deal orders, or a cart order after "Pay").
  useEffect(() => {
    if (!orderId) return;
    api(`/orders/${orderId}`)
      .then(({ data }) => {
        setOrder(data.order);
        if (data.order.delivery?.method) setDelivery(data.order.delivery.method);
      })
      .catch(setOrderError);
  }, [orderId]);

  // Default to the saved default address (or the order's).
  useEffect(() => {
    if (addressId || !addresses.data) return;
    const list = addresses.data.addresses;
    const match = order?.shippingAddress && list.find((a) => a.line1 === order.shippingAddress.line1 && a.pincode === order.shippingAddress.pincode);
    setAddressId((match || list.find((a) => a.isDefault) || list[0])?.id || null);
  }, [addresses.data, order, addressId]);

  // Already paid, cancelled or expired → the order page explains the state.
  const closed = Boolean(orderId && order && !order.canPay && !busy);
  useEffect(() => {
    if (closed) navigate(`/orders/${order.id}`, { replace: true });
  }, [closed, order]);

  if (orderError) {
    return <EmptyState title="Order not found" description={orderError.message} actions={<Button label="My orders" href="/orders" />} headingLevel={1} />;
  }
  if (closed) return null;
  if (!orderId && !items.length) {
    return <EmptyState title="Nothing to check out" description="Your cart is empty." actions={<Button label="Shop phones" href="/phones" variant="primary" />} headingLevel={1} />;
  }

  const lines = order ? order.items : quote?.lines || [];
  const fee = DELIVERY[delivery].feeCents;
  const pricing = order
    ? { ...order.pricing, deliveryCents: fee, totalCents: order.pricing.subtotalCents + fee }
    : quote && { ...quote.pricing, deliveryCents: fee, totalCents: quote.pricing.subtotalCents + fee };
  const quoteProblem = !order && quote && !quote.canCheckout;
  const codAllowed = order ? order.codAllowed : true;
  const addressList = addresses.data?.addresses || [];

  const goToPayment = async () => {
    setPayError(null);
    if (order) {
      // Deal / resumed order: save address + delivery on the order now.
      setBusy(true);
      try {
        const { data } = await api(`/orders/${order.id}/shipping`, { method: 'PUT', body: { addressId, deliveryMethod: delivery } });
        setOrder(data.order);
      } catch (err) {
        setBusy(false);
        return setPayError(err);
      }
      setBusy(false);
    }
    setStep(2);
  };

  const validatePayment = () => {
    const e = {};
    if (method === 'UPI' && !/^[a-z0-9._-]{2,}@[a-z]{2,}$/i.test(upi.trim())) e.upi = 'Enter a UPI ID like name@bank';
    if (method === 'CARD') {
      if (cardForm.number.replace(/\D/g, '').length < 12) e.number = 'Enter the card number';
      if (!/^(0[1-9]|1[0-2])\/\d{2}$/.test(cardForm.expiry)) e.expiry = 'Use MM/YY';
      if (!/^\d{3,4}$/.test(cardForm.cvc)) e.cvc = '3 or 4 digits';
      if (cardForm.name.trim().length < 2) e.name = 'Name on the card';
    }
    setFieldErrors(e);
    return !Object.keys(e).length;
  };

  const pay = async () => {
    setPayError(null);
    if (!validatePayment()) return;
    setBusy(true);
    try {
      let current = order;
      if (!current) {
        const { data } = await api('/orders', { method: 'POST', body: { items, addressId, deliveryMethod: delivery } });
        current = data.order;
        setOrder(current);
        setOrderId(current.id);
        createdHere.id = current.id;
        navigate(`/checkout/${current.id}`, { replace: true, keepScroll: true });
        // The stock is now held for this order — take the items out of the cart.
        if (!buyNowSku) cart.removeMany(items.map((i) => i.sku));
      }
      const body = method === 'UPI' ? { method, upi: { vpa: upi.trim() } } : method === 'CARD' ? { method, card: { ...cardForm, number: cardForm.number.replace(/\s/g, '') } } : { method };
      const { data } = await api(`/orders/${current.id}/pay`, { method: 'POST', body, headers: { 'Idempotency-Key': payKey.current }, timeoutMs: 15000 });
      invalidateApiCache('/orders');
      navigate(`/orders/${data.order.id}?placed=1`, { replace: true });
    } catch (err) {
      // Declined / failed: a new attempt gets a new key (the old one is "used up").
      if (err.status !== 0) payKey.current = newIdempotencyKey();
      setPayError(err);
      setBusy(false);
    }
  };

  return (
    <div className="two-col">
      <VStack gap={5}>
        <Heading level={1}>Checkout</Heading>
        {order?.expiresAt && (
          <Banner
            status={order.type === 'DEAL' ? 'success' : 'info'}
            title={
              <HStack gap={2} vAlign="center" wrap="wrap">
                <span>{order.type === 'DEAL' ? 'Your flash-deal unit is reserved.' : 'Your items are reserved.'} Complete payment within</span>
                <Countdown target={Date.parse(order.expiresAt)} format="ms" className="countdown-inline" label="Time left to pay" onZero={() => setPayError({ code: 'ORDER_EXPIRED', message: 'Time is up — the reservation has been released.' })} />
              </HStack>
            }
            collapsible={false}
          />
        )}

        <Stepper activeStep={step} onStepClick={(i) => i < step && !busy && setStep(i)}>
          <Step step={0} label="Address" />
          <Step step={1} label="Delivery" />
          <Step step={2} label="Payment" />
        </Stepper>

        {step === 0 && (
          <Card>
            <VStack gap={4}>
              <Heading level={2}>Where should we deliver?</Heading>
              {addresses.loading && !addresses.data && <Skeleton height={120} />}
              {addresses.data && addressList.length === 0 && (
                <Text type="supporting">You have no saved addresses yet.</Text>
              )}
              {addressList.length > 0 && (
                <RadioList label="Saved addresses" isLabelHidden value={addressId || ''} onChange={setAddressId}>
                  {addressList.map((a) => (
                    <RadioListItem
                      key={a.id}
                      value={a.id}
                      label={<HStack gap={2} vAlign="center"><Text weight="semibold">{a.fullName}</Text><span className="tag">{a.label}</span>{a.isDefault && <span className="tag">Default</span>}</HStack>}
                      description={`${a.line1}${a.line2 ? `, ${a.line2}` : ''}, ${a.city}, ${a.state} ${a.pincode} · ${a.phone}`}
                      align="start"
                    />
                  ))}
                </RadioList>
              )}
              <HStack gap={2} hAlign="between" wrap="wrap">
                <Button label="Add a new address" variant="secondary" onClick={() => setAddOpen(true)} />
                <Button label="Deliver here" variant="primary" isDisabled={!addressId} onClick={() => setStep(1)} />
              </HStack>
            </VStack>
          </Card>
        )}

        {step === 1 && (
          <Card>
            <VStack gap={4}>
              <Heading level={2}>Choose delivery speed</Heading>
              <RadioList label="Delivery speed" isLabelHidden value={delivery} onChange={setDelivery}>
                {Object.entries(DELIVERY).map(([key, d]) => (
                  <RadioListItem
                    key={key}
                    value={key}
                    label={d.label}
                    description={`Arrives ${formatEta(Date.now() + d.min * DAY, Date.now() + d.max * DAY)}`}
                    endContent={<Text hasTabularNumbers weight="semibold">{d.feeCents ? formatPrice(d.feeCents) : 'Free'}</Text>}
                  />
                ))}
              </RadioList>
              {payError && <Banner status="error" title={payError.message} />}
              <HStack gap={2} hAlign="between">
                <Button label="Back" variant="ghost" onClick={() => setStep(0)} />
                <Button label="Continue to payment" variant="primary" isLoading={busy} onClick={goToPayment} />
              </HStack>
            </VStack>
          </Card>
        )}

        {step === 2 && (
          <Card>
            <VStack gap={4}>
              <Heading level={2}>Payment</Heading>
              <RadioList label="Payment method" isLabelHidden value={method} onChange={(m) => { setMethod(m); setFieldErrors({}); }}>
                <RadioListItem value="UPI" label="UPI" description="Pay from any UPI app" />
                <RadioListItem value="CARD" label="Credit or debit card" description="Visa, Mastercard, RuPay, Amex" />
                <RadioListItem value="COD" label="Cash on delivery" description={codAllowed ? 'Pay when your phone arrives' : 'Not available for flash deals'} isDisabled={!codAllowed} />
              </RadioList>

              {method === 'UPI' && (
                <TextInput label="UPI ID" value={upi} onChange={setUpi} placeholder="name@bank" autoComplete="off" status={fieldErrors.upi && { type: 'error', message: fieldErrors.upi }} />
              )}
              {method === 'CARD' && (
                <FormLayout defaultOptionality="required">
                  <TextInput
                    label="Card number"
                    value={cardForm.number}
                    onChange={(v) => setCardForm((c) => ({ ...c, number: v.replace(/[^\d]/g, '').slice(0, 19).replace(/(\d{4})(?=\d)/g, '$1 ') }))}
                    autoComplete="cc-number"
                    placeholder="1234 5678 9012 3456"
                    status={fieldErrors.number && { type: 'error', message: fieldErrors.number }}
                  />
                  <FormLayout direction="horizontal">
                    <TextInput
                      label="Expiry (MM/YY)"
                      value={cardForm.expiry}
                      onChange={(v) => setCardForm((c) => ({ ...c, expiry: v.replace(/[^\d]/g, '').slice(0, 4).replace(/^(\d{2})(\d)/, '$1/$2') }))}
                      autoComplete="cc-exp"
                      placeholder="MM/YY"
                      status={fieldErrors.expiry && { type: 'error', message: fieldErrors.expiry }}
                    />
                    <TextInput
                      label="CVC"
                      type="password"
                      value={cardForm.cvc}
                      onChange={(v) => setCardForm((c) => ({ ...c, cvc: v.replace(/\D/g, '').slice(0, 4) }))}
                      autoComplete="cc-csc"
                      status={fieldErrors.cvc && { type: 'error', message: fieldErrors.cvc }}
                    />
                  </FormLayout>
                  <TextInput label="Name on card" value={cardForm.name} onChange={(v) => setCardForm((c) => ({ ...c, name: v }))} autoComplete="cc-name" status={fieldErrors.name && { type: 'error', message: fieldErrors.name }} />
                </FormLayout>
              )}

              <Text type="supporting" size="sm" className="demo-note">
                Demo payments — no real money moves. Card 4242 4242 4242 4242 (any future expiry, any CVC) is approved; 4000 0000 0000 0002 is declined. UPI: any name@bank is approved, fail@bank is declined.
              </Text>

              {payError && (
                <Banner
                  status="error"
                  title={payError.status === 402 ? 'Payment declined' : 'Couldn’t complete the order'}
                  description={
                    <VStack gap={1}>
                      <Text>{payError.message}</Text>
                      {['CART_CHANGED', 'OUT_OF_STOCK'].includes(payError.code) && <Link href="/cart">Review your cart</Link>}
                      {payError.status === 402 && <Text size="sm">Your items are still reserved — try another method.</Text>}
                    </VStack>
                  }
                  collapsible={false}
                />
              )}

              <HStack gap={2} hAlign="between">
                <Button label="Back" variant="ghost" isDisabled={busy} onClick={() => setStep(1)} />
                <Button
                  label={method === 'COD' ? 'Place order' : pricing ? `Pay ${formatPrice(pricing.totalCents)}` : 'Pay'}
                  variant="primary"
                  size="lg"
                  isLoading={busy}
                  isDisabled={!pricing || quoteProblem || payError?.code === 'ORDER_EXPIRED'}
                  onClick={pay}
                />
              </HStack>
            </VStack>
          </Card>
        )}
      </VStack>

      <Card className="sticky-summary">
        <VStack gap={4}>
          <Heading level={2}>Order summary</Heading>
          {!lines.length && <Skeleton height={80} />}
          {lines.map((l) => (
            <HStack key={l.sku} gap={3} vAlign="center">
              <div className="line-art"><PhoneArt colorHex={l.colorHex} design={l.design} size="xs" /></div>
              <StackItem size="fill">
                <VStack gap={0.5}>
                  <Text weight="semibold" size="sm">{productTitle(l.brand, l.name)}</Text>
                  <Text type="supporting" size="sm">{l.variantLabel} · Qty {l.qty}</Text>
                </VStack>
              </StackItem>
              <Text size="sm" hasTabularNumbers>{formatPrice(l.unitPriceCents * l.qty)}</Text>
            </HStack>
          ))}
          {quoteProblem && <Banner status="warning" title="Some items are unavailable" description={<Link href="/cart">Review your cart</Link>} collapsible={false} />}
          <Divider />
          {pricing ? <Summary pricing={pricing} /> : <Skeleton height={100} />}
        </VStack>
      </Card>

      {addOpen && (
        <AddressDialog
          isOpen={addOpen}
          onOpenChange={setAddOpen}
          onSaved={(a) => {
            invalidateApiCache('/account/addresses');
            addresses.reload();
            setAddressId(a.id);
          }}
        />
      )}
    </div>
  );
}
