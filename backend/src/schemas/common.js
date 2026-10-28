// Reusable JSON-schema fragments. Fastify compiles these with Ajv once at
// startup; validation then runs as generated code (much faster than
// interpreting a schema per request), and the same schemas document the API.

export const objectId = { type: 'string', pattern: '^[a-fA-F0-9]{24}$' };
export const idParams = { type: 'object', required: ['id'], properties: { id: objectId } };
export const looseIdParams = { type: 'object', required: ['id'], properties: { id: { type: 'string', minLength: 1, maxLength: 64 } } };
export const email = { type: 'string', format: 'email', maxLength: 120 };
export const sku = { type: 'string', pattern: '^[A-Z0-9-]{3,40}$' };
export const money = { type: 'integer', minimum: 0, maximum: 100_000_000 };

export const addressBody = {
  type: 'object',
  additionalProperties: false,
  required: ['fullName', 'phone', 'line1', 'city', 'state', 'pincode'],
  properties: {
    label: { type: 'string', enum: ['Home', 'Work', 'Other'] },
    fullName: { type: 'string', minLength: 2, maxLength: 80 },
    phone: { type: 'string', pattern: '^[6-9][0-9]{9}$' },
    line1: { type: 'string', minLength: 3, maxLength: 120 },
    line2: { type: 'string', maxLength: 120 },
    city: { type: 'string', minLength: 2, maxLength: 60 },
    state: { type: 'string', minLength: 2, maxLength: 60 },
    pincode: { type: 'string', pattern: '^[0-9]{6}$' },
    isDefault: { type: 'boolean' },
  },
};

export const cartItems = {
  type: 'array',
  minItems: 1,
  maxItems: 10,
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['sku', 'qty'],
    properties: { sku, qty: { type: 'integer', minimum: 1, maximum: 5 } },
  },
};

export const deliveryMethod = { type: 'string', enum: ['STANDARD', 'EXPRESS'] };
