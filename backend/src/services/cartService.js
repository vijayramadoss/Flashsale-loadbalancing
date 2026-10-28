// The cart itself lives in the browser (localStorage), so guests can shop
// without an account and the API stays stateless. The server is still the
// authority on prices and availability: the cart page asks for a quote, and
// order placement re-validates everything inside a transaction.
import { Product, variantLabel } from '../models/Product.js';
import { config } from '../config/env.js';
import { badRequest } from '../lib/errors.js';
import { DELIVERY_OPTIONS, priceOrder } from './pricing.js';
import { previewCoupon } from './couponService.js';

/** Resolves [{sku, qty}] against the catalog. Returns lines + issues, never throws for stock problems. */
export async function resolveLines(items) {
  if (items.length > config.orders.maxLines) throw badRequest(`A cart can hold at most ${config.orders.maxLines} different items`);
  const merged = new Map();
  for (const { sku, qty } of items) merged.set(sku, (merged.get(sku) || 0) + qty);

  const skus = [...merged.keys()];
  const products = await Product.find({ 'variants.sku': { $in: skus }, active: true }).lean();
  const bySku = new Map();
  for (const p of products) for (const v of p.variants) bySku.set(v.sku, { p, v });

  return skus.map((sku) => {
    const hit = bySku.get(sku);
    const requested = merged.get(sku);
    if (!hit) return { sku, qty: requested, issue: 'NOT_FOUND' };
    const { p, v } = hit;
    const maxQty = Math.min(config.orders.maxQtyPerLine, v.stock);
    const qty = Math.min(requested, maxQty);
    return {
      product: p._id,
      productId: p._id.toString(),
      slug: p.slug,
      sku,
      brand: p.brand,
      name: p.name,
      variantLabel: variantLabel(v),
      colorHex: v.colorHex,
      design: p.design,
      unitPriceCents: v.priceCents,
      mrpCents: v.mrpCents,
      qty,
      requestedQty: requested,
      maxQty,
      issue: v.stock === 0 ? 'OUT_OF_STOCK' : qty < requested ? 'QTY_REDUCED' : null,
    };
  });
}

export async function quote(items, deliveryMethod = 'STANDARD', couponCode, userId) {
  const lines = await resolveLines(items);
  const buyable = lines.filter((l) => !l.issue || l.issue === 'QTY_REDUCED');
  const subtotal = buyable.reduce((n, l) => n + l.unitPriceCents * l.qty, 0);
  const coupon = couponCode ? await previewCoupon(couponCode, subtotal, userId) : null;
  return {
    lines: lines.map(({ product, ...l }) => l),
    coupon,
    pricing: priceOrder(buyable, deliveryMethod, coupon?.discountCents || 0),
    deliveryOptions: Object.values(DELIVERY_OPTIONS),
    canCheckout: buyable.length > 0 && lines.every((l) => !l.issue),
  };
}
