// Server-side pricing. The client never sends prices — every total is
// recomputed here from the database so a tampered request can't change what is charged.

const DAY = 24 * 60 * 60 * 1000;

export const DELIVERY_OPTIONS = {
  STANDARD: { method: 'STANDARD', label: 'Standard delivery', feeCents: 0, minDays: 3, maxDays: 5 },
  EXPRESS: { method: 'EXPRESS', label: 'Express delivery', feeCents: 14900, minDays: 1, maxDays: 2 },
};

export function deliveryQuote(method = 'STANDARD', from = new Date()) {
  const opt = DELIVERY_OPTIONS[method] || DELIVERY_OPTIONS.STANDARD;
  return {
    ...opt,
    etaFrom: new Date(from.getTime() + opt.minDays * DAY),
    etaTo: new Date(from.getTime() + opt.maxDays * DAY),
  };
}

/** items: [{ qty, unitPriceCents, mrpCents }]; couponDiscountCents comes from couponService. */
export function priceOrder(items, deliveryMethod = 'STANDARD', couponDiscountCents = 0) {
  const subtotalCents = items.reduce((sum, i) => sum + i.unitPriceCents * i.qty, 0);
  const mrpTotal = items.reduce((sum, i) => sum + i.mrpCents * i.qty, 0);
  const delivery = deliveryQuote(deliveryMethod);
  const coupon = Math.min(couponDiscountCents, subtotalCents);
  return {
    subtotalCents,
    savingsCents: Math.max(0, mrpTotal - subtotalCents),
    couponDiscountCents: coupon,
    deliveryCents: delivery.feeCents,
    totalCents: subtotalCents - coupon + delivery.feeCents,
  };
}

/** GST is included in Indian retail prices; phones attract 18 %. Returns the split for invoices. */
export function gstBreakup(totalCents, ratePct = 18) {
  const taxable = Math.round((totalCents * 100) / (100 + ratePct));
  const gst = totalCents - taxable;
  return { ratePct, taxableCents: taxable, cgstCents: Math.floor(gst / 2), sgstCents: gst - Math.floor(gst / 2) };
}

export const discountPct = (priceCents, mrpCents) => (mrpCents > priceCents ? Math.round(((mrpCents - priceCents) / mrpCents) * 100) : 0);
