import { HStack } from '@astryxdesign/core/HStack';
import { Text } from '@astryxdesign/core/Text';
import { formatPrice } from '../lib/format.js';

/** Selling price, struck-through MRP and the discount as a small green hint. */
export default function Price({ priceCents, mrpCents, size = 'md' }) {
  const off = mrpCents > priceCents ? Math.round(((mrpCents - priceCents) / mrpCents) * 100) : 0;
  const big = size === 'lg';
  return (
    <HStack gap={2} vAlign="center" wrap="wrap">
      <Text type={big ? 'display-3' : 'large'} weight="semibold" hasTabularNumbers>
        {formatPrice(priceCents)}
      </Text>
      {off > 0 && (
        <>
          <Text type="supporting" hasStrikethrough hasTabularNumbers>
            {formatPrice(mrpCents)}
          </Text>
          <span className="hint-success">{off}% off</span>
        </>
      )}
    </HStack>
  );
}
