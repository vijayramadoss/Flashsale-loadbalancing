import { ClickableCard } from '@astryxdesign/core/ClickableCard';
import { VStack } from '@astryxdesign/core/VStack';
import { HStack } from '@astryxdesign/core/HStack';
import { Text } from '@astryxdesign/core/Text';
import { Badge } from '@astryxdesign/core/Badge';
import PhoneArt from './PhoneArt.jsx';
import Price from './Price.jsx';
import { formatPrice, productTitle } from '../lib/format.js';

export default function ProductCard({ p }) {
  const color = p.colors[0];
  return (
    <ClickableCard label={`${productTitle(p.brand, p.name)}, from ${formatPrice(p.priceCents)}`} href={`/phones/${p.slug}`} padding={4}>
      <VStack gap={3}>
        <div className="card-media">
          <PhoneArt colorHex={color?.hex} design={p.design} size="sm" />
          {p.deal?.live && <span className="deal-flag">Flash deal</span>}
        </div>
        <VStack gap={1}>
          <Text type="supporting" size="sm">{p.brand}</Text>
          <Text weight="semibold" maxLines={1}>{p.name}</Text>
          <HStack gap={1} vAlign="center">
            <span className="stars" aria-hidden="true">★</span>
            <Text type="supporting" size="sm" hasTabularNumbers>
              {p.rating.toFixed(1)} · {p.ratingCount.toLocaleString('en-IN')} ratings
            </Text>
          </HStack>
        </VStack>
        <Price priceCents={p.priceCents} mrpCents={p.mrpCents} />
        <HStack gap={1.5} vAlign="center" hAlign="between">
          <span className="swatches" aria-label={`${p.colors.length} colours`}>
            {p.colors.slice(0, 5).map((c) => (
              <span key={c.hex} className="swatch" style={{ background: c.hex }} title={c.name} />
            ))}
          </span>
          {!p.inStock && <Badge label="Out of stock" />}
        </HStack>
      </VStack>
    </ClickableCard>
  );
}
