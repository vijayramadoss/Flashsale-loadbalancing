import { badRequest } from '../lib/errors.js';

// Validates req[source] against a zod schema and replaces it with the parsed
// (trimmed/coerced) value, so controllers only ever see clean data.
export const validate = (schema, source = 'body') => (req, _res, next) => {
  const result = schema.safeParse(req[source] ?? {});
  if (!result.success) {
    const details = result.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message }));
    return next(badRequest('Invalid request', details));
  }
  // req.query is a getter in Express 5, so parsed values are stored separately.
  if (source === 'body') req.body = result.data;
  else req.valid = { ...req.valid, [source]: result.data };
  next();
};
