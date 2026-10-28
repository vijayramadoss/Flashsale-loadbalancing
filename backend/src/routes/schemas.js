// Request schemas (zod). Server-side validation is authoritative even though
// the React forms validate too — clients can always be bypassed.
import { z } from 'zod';

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Must be a valid id');

export const registerSchema = z.object({
  name: z.string().trim().min(2, 'Name must be at least 2 characters').max(60),
  email: z.string().trim().toLowerCase().pipe(z.email('Enter a valid email')),
  password: z.string().min(8, 'Password must be at least 8 characters').max(72), // bcrypt uses only 72 bytes
});

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email('Enter a valid email')),
  password: z.string().min(1, 'Password is required').max(72),
});

export const checkoutSchema = z.object({ saleId: objectId });

export const idParamSchema = z.object({ id: z.string().min(1).max(64) });

const productSchema = z.object({
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(2000).default(''),
  imageUrl: z.string().trim().max(500).default(''),
  priceCents: z.number().int().min(0),
  currency: z.string().trim().length(3).default('INR'),
});

export const createSaleSchema = z
  .object({
    title: z.string().trim().min(2).max(120),
    startsAt: z.coerce.date(),
    endsAt: z.coerce.date(),
    totalStock: z.number().int().min(1).max(1_000_000),
    productId: objectId.optional(),
    product: productSchema.optional(),
  })
  .refine((v) => v.endsAt > v.startsAt, { message: 'endsAt must be after startsAt', path: ['endsAt'] })
  .refine((v) => Boolean(v.productId) !== Boolean(v.product), { message: 'Provide exactly one of productId or product', path: ['product'] });

export const resetSaleSchema = z
  .object({ startsAt: z.coerce.date().optional(), endsAt: z.coerce.date().optional() })
  .refine((v) => !v.startsAt || !v.endsAt || v.endsAt > v.startsAt, { message: 'endsAt must be after startsAt', path: ['endsAt'] });
