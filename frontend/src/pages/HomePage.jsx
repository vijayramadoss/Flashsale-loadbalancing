import { VStack } from '@astryxdesign/core/VStack';
import { HStack } from '@astryxdesign/core/HStack';
import { Grid } from '@astryxdesign/core/Grid';
import { Heading } from '@astryxdesign/core/Heading';
import { Text } from '@astryxdesign/core/Text';
import { Link } from '@astryxdesign/core/Link';
import { Button } from '@astryxdesign/core/Button';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import { Icon } from '@astryxdesign/core/Icon';
import { Truck, ShieldCheck, RotateCcw, Zap } from 'lucide-react';
import { useApi } from '../hooks/useApi.js';
import ProductCard from '../components/ProductCard.jsx';
import DealPanel from '../components/DealPanel.jsx';

const PERKS = [
  [Truck, 'Free standard delivery', 'Express in 1–2 days for ₹149'],
  [ShieldCheck, 'Secure checkout', 'UPI, cards or cash on delivery'],
  [RotateCcw, 'Cancel before shipping', 'Full refund to your payment method'],
  [Zap, 'Flash deals', 'Limited units, one per customer'],
];

export default function HomePage() {
  const deals = useApi('/deals', { auth: false });
  const popular = useApi('/products?sort=popular&limit=8', { auth: false });
  const deal = deals.data?.deals.find((d) => d.state === 'LIVE' || d.state === 'UPCOMING');

  return (
    <VStack gap={10}>
      {deal && <DealPanel dealId={deal.id} />}

      <VStack gap={3}>
        <Heading level={2}>Shop by brand</Heading>
        <HStack gap={2} wrap="wrap">
          {(popular.data?.facets.brands || []).map((b) => (
            <Button key={b.name} label={`${b.name} (${b.count})`} href={`/phones?brand=${encodeURIComponent(b.name)}`} variant="secondary" />
          ))}
        </HStack>
      </VStack>

      <VStack gap={4}>
        <HStack hAlign="between" vAlign="center">
          <Heading level={2}>Popular phones</Heading>
          <Link href="/phones">See all phones</Link>
        </HStack>
        <Grid columns={{ minWidth: 220, max: 4 }} gap={4}>
          {popular.data
            ? popular.data.items.map((p) => <ProductCard key={p.slug} p={p} />)
            : Array.from({ length: 4 }, (_, i) => <Skeleton key={i} height={360} index={i} />)}
        </Grid>
        {popular.error && <Text className="hint-error">Couldn’t load phones — {popular.error.message}</Text>}
      </VStack>

      <Grid columns={{ minWidth: 200, max: 4 }} gap={4} className="perks">
        {PERKS.map(([icon, title, desc]) => (
          <HStack key={title} gap={3} vAlign="start">
            <Icon icon={icon} size="lg" color="secondary" />
            <VStack gap={0.5}>
              <Text weight="semibold">{title}</Text>
              <Text type="supporting" size="sm">{desc}</Text>
            </VStack>
          </HStack>
        ))}
      </Grid>
    </VStack>
  );
}
