import { useCallback, useEffect, useState } from 'react';
import { Card } from '@astryxdesign/core/Card';
import { VStack } from '@astryxdesign/core/VStack';
import { HStack } from '@astryxdesign/core/HStack';
import { StackItem } from '@astryxdesign/core/Stack';
import { Heading } from '@astryxdesign/core/Heading';
import { Text } from '@astryxdesign/core/Text';
import { Button } from '@astryxdesign/core/Button';
import { Badge } from '@astryxdesign/core/Badge';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import { Link } from '@astryxdesign/core/Link';
import { useAuth } from '../auth.jsx';
import { navigate, useLocation } from '../router.jsx';
import { useDealStatus, useReserve } from '../hooks/useDeal.js';
import { canSubmit } from '../lib/checkout.js';
import { formatPrice, productTitle } from '../lib/format.js';
import Countdown from './Countdown.jsx';
import PhoneArt from './PhoneArt.jsx';

const STATE_BADGE = { UPCOMING: ['Starts soon', 'neutral'], LIVE: ['Live now', 'success'], SOLD_OUT: ['Sold out', 'neutral'], ENDED: ['Ended', 'neutral'] };

/**
 * Flash-deal block (home hero and product page). Shows the live countdown and
 * units left, and runs the reservation flow: one click → unit held for N
 * minutes → straight to checkout.
 */
export default function DealPanel({ dealId, compact = false }) {
  const { deal, error, offset } = useDealStatus(dealId);
  const [startedLocally, setStartedLocally] = useState(false);
  const onZero = useCallback(() => setStartedLocally(true), []);

  if (!deal) {
    return error ? null : (
      <Card padding={6}>
        <VStack gap={3}><Skeleton height={20} width="40%" /><Skeleton height={36} width="70%" index={1} /><Skeleton height={44} index={2} /></VStack>
      </Card>
    );
  }

  // Flip UPCOMING → LIVE the instant the synced countdown hits zero, without waiting for a poll.
  const state = deal.state === 'UPCOMING' && startedLocally ? 'LIVE' : deal.state;
  const claimed = deal.totalStock - deal.remainingStock;
  const [badgeLabel, badgeVariant] = STATE_BADGE[state];

  return (
    <Card padding={compact ? 5 : 6} className="deal-card">
      <HStack gap={6} vAlign="center" wrap="wrap">
        {!compact && (
          <div className="deal-art">
            <PhoneArt colorHex={deal.product.colorHex} design={deal.product.design} label={deal.product.name} />
          </div>
        )}
        <StackItem size="fill">
          <VStack gap={3}>
            <HStack gap={2} vAlign="center">
              <span className="deal-flag-inline">⚡ {deal.title}</span>
              <Badge label={badgeLabel} variant={badgeVariant} />
            </HStack>
            {!compact && (
              <Heading level={2}>
                <Link href={`/phones/${deal.product.slug}`} color="inherit">{productTitle(deal.product.brand, deal.product.name)}</Link>
              </Heading>
            )}
            <Text type="supporting">{deal.product.variantLabel} · one per customer · prepaid only</Text>
            <HStack gap={2} vAlign="center" wrap="wrap">
              <Text type="display-3" weight="semibold" hasTabularNumbers>{formatPrice(deal.dealPriceCents)}</Text>
              <Text type="supporting" hasStrikethrough hasTabularNumbers>{formatPrice(deal.mrpCents)}</Text>
              <span className="hint-success">{deal.discountPct}% off</span>
            </HStack>

            {state === 'UPCOMING' && (
              <HStack gap={2} vAlign="center">
                <Text type="supporting">Starts in</Text>
                <Countdown target={Date.parse(deal.startsAt)} offset={offset} onZero={onZero} label="Time until the deal starts" />
              </HStack>
            )}
            {state === 'LIVE' && (
              <HStack gap={2} vAlign="center">
                <Text type="supporting">Ends in</Text>
                <Countdown target={Date.parse(deal.endsAt)} offset={offset} className="countdown countdown-sm" label="Time until the deal ends" />
              </HStack>
            )}

            <ClaimBar claimed={claimed} total={deal.totalStock} />
            <ReserveButton dealId={dealId} state={state} holdMinutes={deal.holdMinutes} price={deal.dealPriceCents} />
          </VStack>
        </StackItem>
      </HStack>
    </Card>
  );
}

function ReserveButton({ dealId, state, holdMinutes, price }) {
  const { user } = useAuth();
  const { path } = useLocation();
  const { state: r, submit, retryIn } = useReserve(dealId);

  // Won a unit → the pending order exists → continue to checkout.
  useEffect(() => {
    if (r.phase === 'reserved' && r.orderId) navigate(`/checkout/${r.orderId}`);
  }, [r.phase, r.orderId]);

  if (!user) {
    return (
      <VStack gap={1}>
        <Button label="Log in to grab this deal" variant="primary" size="lg" href={`/login?next=${encodeURIComponent(path)}`} width="100%" />
        <Text type="supporting" size="sm">You need an account — one unit per customer.</Text>
      </VStack>
    );
  }

  let label = `Buy now at ${formatPrice(price)}`;
  let disabled = !canSubmit(r.phase);
  if (state === 'UPCOMING') { label = 'Opens soon'; disabled = true; }
  if (state === 'ENDED' && r.phase === 'idle') { label = 'Deal ended'; disabled = true; }
  if (state === 'SOLD_OUT' && canSubmit(r.phase)) { label = 'Sold out'; disabled = true; }
  if (r.phase === 'submitting') label = 'Reserving…';
  if (r.phase === 'queued') label = 'Securing your unit…';
  if (r.phase === 'reserved') label = 'Reserved — opening checkout';
  if (r.phase === 'retrying') label = `High demand — retrying in ${retryIn}s`;
  if (r.phase === 'soldOut') label = 'Sold out';
  if (r.phase === 'error' || r.phase === 'failed') label = 'Try again';

  return (
    <VStack gap={1.5}>
      <Button
        label={label}
        variant="primary"
        size="lg"
        width="100%"
        isDisabled={disabled}
        isLoading={r.phase === 'submitting' || r.phase === 'queued' || r.phase === 'reserved'}
        onClick={submit}
      />
      <div role="status" aria-live="polite" className="deal-status">
        {(r.phase === 'idle' || r.phase === 'submitting') && state === 'LIVE' && (
          <Text type="supporting" size="sm">Your unit is held for {holdMinutes} minutes while you check out.</Text>
        )}
        {r.phase === 'queued' && <Text type="supporting" size="sm">You're in — creating your order…</Text>}
        {r.phase === 'retrying' && <Text size="sm" className="hint-warning">{r.message}</Text>}
        {(r.phase === 'error' || r.phase === 'failed' || r.phase === 'soldOut') && r.message && (
          <Text size="sm" className={r.phase === 'soldOut' ? '' : 'hint-error'}>{r.message}</Text>
        )}
      </div>
    </VStack>
  );
}

/** "N of M claimed" bar (lighter than the design system's ProgressBar + tooltip). */
function ClaimBar({ claimed, total }) {
  const pct = total ? Math.min(100, (claimed / total) * 100) : 0;
  return (
    <VStack gap={1}>
      <div className="claim-track" role="progressbar" aria-label="Units claimed" aria-valuemin={0} aria-valuemax={total} aria-valuenow={claimed}>
        <div className="claim-fill" style={{ width: `${pct}%` }} />
      </div>
      <Text type="supporting" size="sm" hasTabularNumbers>
        {claimed.toLocaleString('en-IN')} of {total.toLocaleString('en-IN')} claimed
      </Text>
    </VStack>
  );
}
