import { useMemo, useState } from 'react';
import { VStack } from '@astryxdesign/core/VStack';
import { HStack } from '@astryxdesign/core/HStack';
import { Heading } from '@astryxdesign/core/Heading';
import { Text } from '@astryxdesign/core/Text';
import { Button } from '@astryxdesign/core/Button';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { MetadataList, MetadataListItem } from '@astryxdesign/core/MetadataList';
import { Breadcrumbs, BreadcrumbItem } from '@astryxdesign/core/Breadcrumbs';
import { Divider } from '@astryxdesign/core/Divider';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Icon } from '@astryxdesign/core/Icon';
import { useToast } from '@astryxdesign/core/Toast';
import { Truck, Check } from 'lucide-react';
import { useApi } from '../hooks/useApi.js';
import { useCart, MAX_QTY } from '../cart.jsx';
import { navigate } from '../router.jsx';
import { formatEta } from '../lib/format.js';
import PhoneArt from '../components/PhoneArt.jsx';
import Price from '../components/Price.jsx';
import DealPanel from '../components/DealPanel.jsx';

const SPEC_LABELS = {
  display: 'Display', processor: 'Processor', rearCamera: 'Rear camera', frontCamera: 'Front camera', battery: 'Battery',
  charging: 'Charging', os: 'Software', weight: 'Weight', network: 'Network',
};

const day = 86_400_000;

export default function ProductPage({ slug }) {
  const { data, error } = useApi(`/products/${slug}`, { auth: false });
  const p = data?.product;

  if (error?.status === 404) {
    return <EmptyState title="Phone not found" description="It may have been removed from the catalog." actions={<Button label="Browse phones" href="/phones" variant="primary" />} />;
  }
  if (!p) {
    return (
      <div className="pdp">
        <Skeleton height={420} />
        <VStack gap={3}><Skeleton height={20} width="30%" /><Skeleton height={36} width="70%" index={1} /><Skeleton height={140} index={2} /></VStack>
      </div>
    );
  }
  return <ProductDetail key={p.slug} p={p} />;
}

function ProductDetail({ p }) {
  const cart = useCart();
  const toast = useToast();
  const colors = useMemo(() => [...new Map(p.variants.map((v) => [v.color, v.colorHex])).entries()], [p]);
  const storages = useMemo(() => [...new Set(p.variants.map((v) => `${v.ram} · ${v.storage}`))], [p]);
  const firstInStock = p.variants.find((v) => v.stockLevel !== 'OUT') || p.variants[0];
  const [color, setColor] = useState(firstInStock.color);
  const [storage, setStorage] = useState(`${firstInStock.ram} · ${firstInStock.storage}`);
  const [qty, setQty] = useState(1);

  const variant = p.variants.find((v) => v.color === color && `${v.ram} · ${v.storage}` === storage);
  const available = variant && variant.stockLevel !== 'OUT';
  const maxQty = Math.min(MAX_QTY, variant?.stockLeft ?? MAX_QTY);

  const addToCart = () => {
    const result = cart.add(variant.sku, qty);
    if (result === 'full') return toast({ body: 'Your cart is full (10 different items max).', type: 'error' });
    toast({ body: result === 'max' ? `You already have the maximum (${MAX_QTY}) of this phone in your cart.` : `Added ${p.name} (${variant.storage}, ${variant.color}) to your cart.`, uniqueID: 'cart-add' });
  };
  // Amazon-style "Buy now": checks out just this item, leaving the cart untouched.
  const buyNow = () => navigate(`/checkout?sku=${encodeURIComponent(variant.sku)}&qty=${qty}`);

  return (
    <VStack gap={6}>
      <Breadcrumbs>
        <BreadcrumbItem href="/">Home</BreadcrumbItem>
        <BreadcrumbItem href="/phones">Phones</BreadcrumbItem>
        <BreadcrumbItem href={`/phones?brand=${encodeURIComponent(p.brand)}`}>{p.brand}</BreadcrumbItem>
        <BreadcrumbItem>{p.name}</BreadcrumbItem>
      </Breadcrumbs>

      <div className="pdp">
        <div className="pdp-media">
          <PhoneArt colorHex={variant?.colorHex || colors[0][1]} design={p.design} label={`${p.name} in ${color}`} size="lg" />
        </div>

        <VStack gap={5}>
          <VStack gap={1}>
            <Text type="supporting">{p.brand}</Text>
            <Heading level={1}>{p.name}</Heading>
            <Text type="supporting">{p.tagline}</Text>
            <HStack gap={1} vAlign="center">
              <span className="stars" aria-hidden="true">★</span>
              <Text size="sm" hasTabularNumbers>{p.rating.toFixed(1)}</Text>
              <Text type="supporting" size="sm">· {p.ratingCount.toLocaleString('en-IN')} ratings · {p.releaseYear}</Text>
            </HStack>
          </VStack>

          {variant && <Price priceCents={variant.priceCents} mrpCents={variant.mrpCents} size="lg" />}
          <Text type="supporting" size="sm">Inclusive of all taxes</Text>

          <VStack gap={2}>
            <Text weight="semibold">Colour: <Text weight="normal">{color}</Text></Text>
            <div className="color-picker" role="radiogroup" aria-label="Colour">
              {colors.map(([name, hex]) => (
                <button
                  key={name}
                  type="button"
                  role="radio"
                  aria-checked={color === name}
                  aria-label={name}
                  title={name}
                  className="color-option"
                  onClick={() => setColor(name)}
                >
                  <span className="swatch swatch-lg" style={{ background: hex }} />
                </button>
              ))}
            </div>
          </VStack>

          <VStack gap={2}>
            <Text weight="semibold">Memory &amp; storage</Text>
            <SegmentedControl label="Memory and storage" value={storage} onChange={setStorage}>
              {storages.map((s) => <SegmentedControlItem key={s} value={s} label={s} />)}
            </SegmentedControl>
          </VStack>

          <StockLine variant={variant} />

          <HStack gap={3} vAlign="end" wrap="wrap">
            <div className="qty" aria-label="Quantity">
              <Text weight="semibold" size="sm">Qty</Text>
              <HStack gap={1} vAlign="center">
                <Button label="Decrease quantity" isIconOnly icon={<span aria-hidden="true">−</span>} size="sm" isDisabled={qty <= 1} onClick={() => setQty((q) => q - 1)} />
                <span className="qty-value" aria-live="polite">{qty}</span>
                <Button label="Increase quantity" isIconOnly icon={<span aria-hidden="true">+</span>} size="sm" isDisabled={qty >= maxQty || !available} onClick={() => setQty((q) => q + 1)} />
              </HStack>
            </div>
            <Button label="Add to cart" size="lg" isDisabled={!available} onClick={addToCart} />
            <Button label="Buy now" variant="primary" size="lg" isDisabled={!available} onClick={buyNow} />
          </HStack>

          <HStack gap={2} vAlign="center">
            <Icon icon={Truck} color="secondary" />
            <Text size="sm">Free delivery by <Text weight="semibold" size="sm">{formatEta(Date.now() + 3 * day, Date.now() + 5 * day)}</Text> · Express in 1–2 days</Text>
          </HStack>

          {p.deal && !p.deal.ended && <DealPanel dealId={p.deal.id} compact />}
        </VStack>
      </div>

      <Divider />
      <div className="pdp-details">
        <VStack gap={3}>
          <Heading level={2}>About this phone</Heading>
          <Text as="p">{p.description}</Text>
          <VStack gap={1.5}>
            {p.highlights.map((h) => (
              <HStack key={h} gap={2} vAlign="center"><Icon icon={Check} size="sm" color="success" /><Text>{h}</Text></HStack>
            ))}
          </VStack>
        </VStack>
        <MetadataList title="Specifications" label={{ position: 'start', width: 130 }}>
          {Object.entries(SPEC_LABELS).filter(([k]) => p.specs?.[k]).map(([k, label]) => (
            <MetadataListItem key={k} label={label}>{p.specs[k]}</MetadataListItem>
          ))}
        </MetadataList>
      </div>
    </VStack>
  );
}

function StockLine({ variant }) {
  if (!variant) return <Text className="hint-warning">This combination isn’t available — pick another colour or storage.</Text>;
  if (variant.stockLevel === 'OUT') return <Text className="hint-error">Out of stock in this colour and storage.</Text>;
  if (variant.stockLevel === 'LOW') return <Text className="hint-warning">Only {variant.stockLeft} left — order soon.</Text>;
  return <Text className="hint-success-text">In stock</Text>;
}
