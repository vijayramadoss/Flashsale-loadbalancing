import { VStack } from '@astryxdesign/core/VStack';
import { HStack } from '@astryxdesign/core/HStack';
import { Text } from '@astryxdesign/core/Text';
import { Divider } from '@astryxdesign/core/Divider';
import { formatPrice } from '../lib/format.js';

/** Price breakdown used by the cart, checkout and order pages. */
export default function Summary({ pricing, itemCount }) {
  return (
    <VStack gap={2}>
      <Row label={`Price${itemCount ? ` (${itemCount} item${itemCount === 1 ? '' : 's'})` : ''}`} value={formatPrice(pricing.subtotalCents + pricing.savingsCents)} />
      {pricing.savingsCents > 0 && <Row label="Discount" value={`− ${formatPrice(pricing.savingsCents)}`} hint />}
      <Row label="Delivery" value={pricing.deliveryCents ? formatPrice(pricing.deliveryCents) : 'Free'} />
      <Divider />
      <HStack hAlign="between">
        <Text weight="semibold">Total</Text>
        <Text weight="semibold" hasTabularNumbers>{formatPrice(pricing.totalCents)}</Text>
      </HStack>
      {pricing.savingsCents > 0 && <Text size="sm" className="hint-success-text">You save {formatPrice(pricing.savingsCents)} on this order</Text>}
    </VStack>
  );
}

function Row({ label, value, hint }) {
  return (
    <HStack hAlign="between">
      <Text type="supporting">{label}</Text>
      <Text hasTabularNumbers className={hint ? 'hint-success-text' : undefined}>{value}</Text>
    </HStack>
  );
}
