// Admin catalog editing. Stock changes are DELTAS applied with a conditional
// atomic update (never "read stock, write new number"), so an admin restocking
// while customers are buying can't overwrite their purchases.
import { Product, variantLabel } from '../models/Product.js';
import { AppError, badRequest, notFound } from '../lib/errors.js';
import { invalidateCatalogCache } from './catalogService.js';
import { isObjectId } from './dealService.js';

const dto = (p) => ({
  id: p._id.toString(),
  slug: p.slug,
  brand: p.brand,
  name: p.name,
  tagline: p.tagline,
  description: p.description,
  highlights: p.highlights,
  active: p.active,
  design: p.design,
  rating: p.rating,
  ratingCount: p.ratingCount,
  variants: p.variants.map((v) => ({ ...v, label: variantLabel(v) })),
  totalStock: p.variants.reduce((n, v) => n + v.stock, 0),
});

async function load(id) {
  if (!isObjectId(id)) throw notFound('Product not found');
  const p = await Product.findById(id);
  if (!p) throw notFound('Product not found');
  return p;
}

export async function listProducts() {
  const products = await Product.find().sort({ brand: 1, name: 1 }).lean();
  return products.map(dto);
}

export async function updateProduct(id, changes) {
  const p = await load(id);
  for (const k of ['name', 'tagline', 'description', 'highlights', 'active']) if (changes[k] !== undefined) p[k] = changes[k];
  await p.save();
  await invalidateCatalogCache();
  return dto(p.toObject());
}

export async function updateVariantPrice(id, sku, { priceCents, mrpCents }) {
  const p = await load(id);
  const v = p.variants.find((x) => x.sku === sku);
  if (!v) throw notFound('Variant not found');
  if (priceCents !== undefined) v.priceCents = priceCents;
  if (mrpCents !== undefined) v.mrpCents = mrpCents;
  if (v.priceCents > v.mrpCents) throw badRequest('Price cannot be above MRP', [{ field: 'priceCents', message: 'Must be ≤ MRP' }]);
  await p.save(); // pre-validate hook recomputes minPriceCents
  await invalidateCatalogCache();
  return dto(p.toObject());
}

/** delta > 0 restocks, delta < 0 removes units (refused if that would go below zero). */
export async function adjustStock(id, sku, delta) {
  if (!isObjectId(id)) throw notFound('Product not found');
  const filter = delta < 0 ? { _id: id, variants: { $elemMatch: { sku, stock: { $gte: -delta } } } } : { _id: id, 'variants.sku': sku };
  const res = await Product.updateOne(filter, { $inc: { 'variants.$.stock': delta } });
  if (!res.matchedCount) {
    if (!(await Product.exists({ _id: id, 'variants.sku': sku }))) throw notFound('Variant not found');
    throw new AppError(409, 'INSUFFICIENT_STOCK', 'Cannot remove more units than are in stock');
  }
  await invalidateCatalogCache();
  return dto((await Product.findById(id)).toObject());
}

export async function addVariant(id, { color, colorHex, storage, ram, priceCents, mrpCents, stock }) {
  const p = await load(id);
  const prefix = p.variants[0]?.sku.split('-')[0] || p.slug.replace(/[^a-z0-9]/gi, '').slice(0, 5).toUpperCase();
  const code = color.split(/\s+/).map((w) => w.replace(/[^A-Za-z]/g, '').slice(0, 3)).join('').toUpperCase();
  const sku = `${prefix}-${ram.replace(/\D/g, '')}-${storage.replace(/\D/g, '')}${storage.includes('TB') ? 'T' : ''}-${code}`;
  if (await Product.exists({ 'variants.sku': sku })) throw new AppError(409, 'DUPLICATE', `Variant ${sku} already exists`);
  if (priceCents > mrpCents) throw badRequest('Price cannot be above MRP', [{ field: 'priceCents', message: 'Must be ≤ MRP' }]);
  p.variants.push({ sku, color, colorHex, storage, ram, priceCents, mrpCents, stock });
  await p.save();
  await invalidateCatalogCache();
  return dto(p.toObject());
}
