import { useEffect, useState } from 'react';
import { VStack } from '@astryxdesign/core/VStack';
import { HStack } from '@astryxdesign/core/HStack';
import { StackItem } from '@astryxdesign/core/Stack';
import { Card } from '@astryxdesign/core/Card';
import { Heading } from '@astryxdesign/core/Heading';
import { Text } from '@astryxdesign/core/Text';
import { Link } from '@astryxdesign/core/Link';
import { Button } from '@astryxdesign/core/Button';
import { Divider } from '@astryxdesign/core/Divider';
import { Banner } from '@astryxdesign/core/Banner';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import { Icon } from '@astryxdesign/core/Icon';
import { ShoppingCart } from 'lucide-react';
import { api } from '../api.js';
import { useCart } from '../cart.jsx';
import { formatPrice, productTitle } from '../lib/format.js';
import PhoneArt from '../components/PhoneArt.jsx';
import Summary from '../components/Summary.jsx';

const ISSUE_TEXT = {
  OUT_OF_STOCK: 'Out of stock — remove it to continue',
  QTY_REDUCED: 'Fewer units available than you asked for',
  NOT_FOUND: 'No longer sold',
};

/** Fetches live prices/availability for the browser-held cart (debounced). */
export function useQuote(items, deliveryMethod = 'STANDARD') {
  const [quote, setQuote] = useState(null);
  const [error, setError] = useState(null);
  const key = JSON.stringify(items);
  useEffect(() => {
    if (!items.length) {
      setQuote(null);
      return undefined;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const { data } = await api('/cart/quote', { method: 'POST', body: { items, deliveryMethod }, auth: false });
        if (!cancelled) {
          setQuote(data);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err);
      }
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, deliveryMethod]);
  return { quote, error };
}

export default function CartPage() {
  const cart = useCart();
  const { quote, error } = useQuote(cart.items);

  if (!cart.items.length) {
    return (
      <EmptyState
        icon={<Icon icon={ShoppingCart} size="lg" />}
        title="Your cart is empty"
        description="Browse the latest phones and add one to get started."
        actions={<Button label="Shop phones" href="/phones" variant="primary" />}
        headingLevel={1}
      />
    );
  }

  const lines = quote?.lines || [];
  const hasIssues = lines.some((l) => l.issue);

  return (
    <div className="two-col">
      <VStack gap={4}>
        <Heading level={1}>Shopping cart</Heading>
        {error && <Banner status="error" title="Couldn’t refresh prices" description={error.message} />}
        {hasIssues && <Banner status="warning" title="Some items need your attention" description="Availability changed since you added them." />}
        <Card padding={0}>
          {!quote
            ? <VStack gap={3} padding={4}><Skeleton height={96} /><Skeleton height={96} index={1} /></VStack>
            : lines.map((l, i) => (
              <div key={l.sku}>
                {i > 0 && <Divider />}
                <CartLine line={l} cart={cart} />
              </div>
            ))}
        </Card>
        <Link href="/phones">← Continue shopping</Link>
      </VStack>

      <Card className="sticky-summary">
        <VStack gap={4}>
          <Heading level={2}>Order summary</Heading>
          {quote ? <Summary pricing={quote.pricing} itemCount={cart.count} /> : <Skeleton height={120} />}
          <Button label="Proceed to checkout" variant="primary" size="lg" width="100%" href="/checkout" isDisabled={!quote?.canCheckout} />
          {hasIssues && <Text type="supporting" size="sm">Resolve the highlighted items to continue.</Text>}
        </VStack>
      </Card>
    </div>
  );
}

function CartLine({ line: l, cart }) {
  if (l.issue === 'NOT_FOUND') {
    return (
      <HStack gap={3} padding={4} vAlign="center" hAlign="between">
        <Text type="supporting">An item ({l.sku}) is no longer sold.</Text>
        <Button label="Remove" variant="ghost" size="sm" onClick={() => cart.remove(l.sku)} />
      </HStack>
    );
  }
  const qty = cart.items.find((i) => i.sku === l.sku)?.qty ?? l.qty;
  return (
    <HStack gap={4} padding={4} vAlign="start">
      <a href={`/phones/${l.slug}`} className="line-art" tabIndex={-1} aria-hidden="true">
        <PhoneArt colorHex={l.colorHex} design={l.design} size="xs" />
      </a>
      <StackItem size="fill">
        <VStack gap={1}>
          <Link href={`/phones/${l.slug}`} color="inherit" weight="semibold">{productTitle(l.brand, l.name)}</Link>
          <Text type="supporting" size="sm">{l.variantLabel}</Text>
          {l.issue && <Text size="sm" className={l.issue === 'OUT_OF_STOCK' ? 'hint-error' : 'hint-warning'}>{ISSUE_TEXT[l.issue]}{l.issue === 'QTY_REDUCED' ? ` (max ${l.maxQty})` : ''}</Text>}
          <HStack gap={2} vAlign="center" wrap="wrap">
            <HStack gap={1} vAlign="center" aria-label="Quantity">
              <Button label={`Decrease quantity of ${l.name}`} isIconOnly icon={<span aria-hidden="true">−</span>} size="sm" onClick={() => cart.setQty(l.sku, qty - 1)} />
              <span className="qty-value">{qty}</span>
              <Button label={`Increase quantity of ${l.name}`} isIconOnly icon={<span aria-hidden="true">+</span>} size="sm" isDisabled={qty >= l.maxQty} onClick={() => cart.setQty(l.sku, qty + 1)} />
            </HStack>
            <Button label="Remove" variant="ghost" size="sm" onClick={() => cart.remove(l.sku)} />
          </HStack>
        </VStack>
      </StackItem>
      <VStack gap={0.5} hAlign="end">
        <Text weight="semibold" hasTabularNumbers>{formatPrice(l.unitPriceCents * qty)}</Text>
        {l.mrpCents > l.unitPriceCents && <Text type="supporting" size="sm" hasStrikethrough hasTabularNumbers>{formatPrice(l.mrpCents * qty)}</Text>}
      </VStack>
    </HStack>
  );
}
