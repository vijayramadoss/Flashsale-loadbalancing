import { createHash } from 'node:crypto';
import { Product, variantLabel } from '../models/Product.js';
import { Deal } from '../models/Deal.js';
import { config } from '../config/env.js';
import { getRedis, keys } from '../lib/redis.js';
import { notFound } from '../lib/errors.js';
import { discountPct } from './pricing.js';
import { logger } from '../lib/logger.js';

const SORTS = {
  popular: { ratingCount: -1, _id: 1 },
  price_asc: { minPriceCents: 1, _id: 1 },
  price_desc: { minPriceCents: -1, _id: 1 },
  newest: { releaseYear: -1, ratingCount: -1, _id: 1 },
  rating: { rating: -1, ratingCount: -1, _id: 1 },
};

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Live (not ended) deals, keyed by product id — small, so one query per listing. */
async function activeDealsByProduct() {
  const deals = await Deal.find({ endsAt: { $gt: new Date() } }, { product: 1, dealPriceCents: 1, startsAt: 1, endsAt: 1, sku: 1 }).lean();
  return new Map(deals.map((d) => [d.product.toString(), d]));
}

function dealSummary(d) {
  if (!d) return null;
  const now = Date.now();
  return {
    id: d._id.toString(),
    sku: d.sku,
    dealPriceCents: d.dealPriceCents,
    startsAt: d.startsAt,
    endsAt: d.endsAt,
    live: now >= d.startsAt.getTime() && now < d.endsAt.getTime(),
  };
}

function card(p, deal) {
  const cheapest = p.variants.reduce((a, b) => (b.priceCents < a.priceCents ? b : a));
  return {
    slug: p.slug,
    brand: p.brand,
    name: p.name,
    tagline: p.tagline,
    design: p.design,
    priceCents: cheapest.priceCents,
    mrpCents: cheapest.mrpCents,
    discountPct: discountPct(cheapest.priceCents, cheapest.mrpCents),
    colors: [...new Map(p.variants.map((v) => [v.colorHex, { name: v.color, hex: v.colorHex }])).values()],
    storages: [...new Set(p.variants.map((v) => v.storage))],
    inStock: p.variants.some((v) => v.stock > 0),
    rating: p.rating,
    ratingCount: p.ratingCount,
    deal: dealSummary(deal),
  };
}

/**
 * Product listing with search, filters, sort and pagination.
 * Results are cached in Redis for a few seconds: the same popular queries
 * (home page, "all phones") are then served to every replica without Mongo.
 */
export async function listProducts(query) {
  const { q = '', brand = [], minPrice, maxPrice, sort = 'popular', page = 1, limit = 12, inStock = false } = query;
  const cacheKey = keys.catalog(createHash('sha1').update(JSON.stringify({ q, brand, minPrice, maxPrice, sort, page, limit, inStock })).digest('hex'));
  const redis = getRedis();
  const cached = await redis.get(cacheKey).catch(() => null);
  if (cached) return JSON.parse(cached);

  const filter = { active: true };
  if (brand.length) filter.brand = { $in: brand };
  if (minPrice != null || maxPrice != null) {
    filter.minPriceCents = {};
    if (minPrice != null) filter.minPriceCents.$gte = minPrice;
    if (maxPrice != null) filter.minPriceCents.$lte = maxPrice;
  }
  if (inStock) filter['variants.stock'] = { $gt: 0 };
  if (q.trim()) {
    // Prefix-friendly search over name/brand/tagline (the catalog is small;
    // a large catalog would use the text index or Atlas Search instead).
    const rx = new RegExp(escapeRegex(q.trim()), 'i');
    filter.$or = [{ name: rx }, { brand: rx }, { tagline: rx }];
  }

  const [items, total, brandFacets, deals] = await Promise.all([
    Product.find(filter).sort(SORTS[sort] || SORTS.popular).skip((page - 1) * limit).limit(limit).lean(),
    Product.countDocuments(filter),
    Product.aggregate([{ $match: { active: true } }, { $group: { _id: '$brand', count: { $sum: 1 } } }, { $sort: { _id: 1 } }]),
    activeDealsByProduct(),
  ]);

  const result = {
    items: items.map((p) => card(p, deals.get(p._id.toString()))),
    page,
    limit,
    total,
    pages: Math.max(1, Math.ceil(total / limit)),
    facets: { brands: brandFacets.map((b) => ({ name: b._id, count: b.count })) },
  };
  redis.set(cacheKey, JSON.stringify(result), 'EX', config.catalogCacheSec).catch((err) => logger.warn('catalog cache write failed', { err: err.message }));
  return result;
}

export async function getProduct(slug) {
  const p = await Product.findOne({ slug, active: true }).lean();
  if (!p) throw notFound('Product not found');
  const deal = await Deal.findOne({ product: p._id, endsAt: { $gt: new Date() } }).sort({ startsAt: 1 }).lean();
  return {
    id: p._id.toString(),
    slug: p.slug,
    brand: p.brand,
    name: p.name,
    tagline: p.tagline,
    description: p.description,
    highlights: p.highlights,
    specs: p.specs,
    design: p.design,
    rating: p.rating,
    ratingCount: p.ratingCount,
    releaseYear: p.releaseYear,
    variants: p.variants.map((v) => ({
      sku: v.sku,
      color: v.color,
      colorHex: v.colorHex,
      storage: v.storage,
      ram: v.ram,
      label: variantLabel(v),
      priceCents: v.priceCents,
      mrpCents: v.mrpCents,
      discountPct: discountPct(v.priceCents, v.mrpCents),
      // Exact counts are not exposed; the UI only needs availability hints.
      stockLevel: v.stock === 0 ? 'OUT' : v.stock <= 5 ? 'LOW' : 'IN',
      stockLeft: v.stock <= 5 ? v.stock : undefined,
    })),
    deal: deal ? { ...dealSummary(deal), totalStock: deal.totalStock, mrpCents: deal.mrpCents, holdMinutes: deal.holdMinutes } : null,
  };
}

/** Drops cached listings after stock or catalog changes that should show immediately. */
export async function invalidateCatalogCache() {
  const redis = getRedis();
  let cursor = '0';
  do {
    const [next, found] = await redis.scan(cursor, 'MATCH', keys.catalog('*'), 'COUNT', 200);
    if (found.length) await redis.del(...found);
    cursor = next;
  } while (cursor !== '0');
}
