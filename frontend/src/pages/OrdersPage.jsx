import { VStack } from '@astryxdesign/core/VStack';
import { HStack } from '@astryxdesign/core/HStack';
import { StackItem } from '@astryxdesign/core/Stack';
import { ClickableCard } from '@astryxdesign/core/ClickableCard';
import { Heading } from '@astryxdesign/core/Heading';
import { Text } from '@astryxdesign/core/Text';
import { Badge } from '@astryxdesign/core/Badge';
import { Button } from '@astryxdesign/core/Button';
import { Pagination } from '@astryxdesign/core/Pagination';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import { useApi } from '../hooks/useApi.js';
import { navigate, useLocation } from '../router.jsx';
import { ORDER_STATUS, formatDateTime, formatPrice, productTitle } from '../lib/format.js';
import PhoneArt from '../components/PhoneArt.jsx';

export default function OrdersPage() {
  const { query } = useLocation();
  const page = Number(query.get('page')) || 1;
  const { data, error } = useApi(`/orders?page=${page}`);

  return (
    <VStack gap={5}>
      <Heading level={1}>My orders</Heading>
      {error && <Text className="hint-error">{error.message}</Text>}
      {!data && !error && <VStack gap={3}><Skeleton height={110} /><Skeleton height={110} index={1} /></VStack>}
      {data?.orders.length === 0 && (
        <EmptyState title="No orders yet" description="When you buy a phone it will show up here." actions={<Button label="Shop phones" href="/phones" variant="primary" />} />
      )}
      <VStack gap={3}>
        {data?.orders.map((o) => {
          const s = ORDER_STATUS[o.status];
          const first = o.items[0];
          return (
            <ClickableCard key={o.id} label={`Order ${o.orderNumber}, ${s.label}`} href={`/orders/${o.id}`} padding={4}>
              <HStack gap={4} vAlign="center" wrap="wrap">
                <div className="line-art"><PhoneArt colorHex={first.colorHex} design={first.design} size="xs" /></div>
                <StackItem size="fill">
                  <VStack gap={0.5}>
                    <Text weight="semibold">{productTitle(first.brand, first.name)}{o.items.length > 1 ? ` + ${o.items.length - 1} more` : ''}</Text>
                    <Text type="supporting" size="sm">{o.orderNumber} · {formatDateTime(o.createdAt)}</Text>
                  </VStack>
                </StackItem>
                <VStack gap={1} hAlign="end">
                  <Badge label={s.label} variant={s.badge} />
                  <Text hasTabularNumbers weight="semibold">{formatPrice(o.pricing.totalCents)}</Text>
                </VStack>
              </HStack>
            </ClickableCard>
          );
        })}
      </VStack>
      {data && data.pages > 1 && <Pagination page={page} onChange={(p) => navigate(`/orders?page=${p}`)} totalPages={data.pages} />}
    </VStack>
  );
}
