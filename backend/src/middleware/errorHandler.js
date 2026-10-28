import mongoose from 'mongoose';
import { AppError, notFound } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

export function notFoundHandler(req, _res, next) {
  next(notFound(`No route for ${req.method} ${req.path}`));
}

// Translates every error into the same JSON shape:
//   { error: { code, message, details? } }
// Unexpected errors are logged with their stack but the client only ever sees
// a generic message — internals never leak.
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  let appErr = err;

  if (!(err instanceof AppError)) {
    if (err.type === 'entity.parse.failed') {
      appErr = new AppError(400, 'INVALID_JSON', 'Request body is not valid JSON');
    } else if (err.type === 'entity.too.large') {
      appErr = new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
    } else if (err instanceof mongoose.Error.ValidationError) {
      const details = Object.values(err.errors).map((e) => ({ field: e.path, message: e.message }));
      appErr = new AppError(400, 'VALIDATION_ERROR', 'Invalid data', details);
    } else if (err instanceof mongoose.Error.CastError) {
      appErr = new AppError(400, 'VALIDATION_ERROR', `Invalid ${err.path}`);
    } else if (err.code === 11000) {
      appErr = new AppError(409, 'DUPLICATE', 'Resource already exists');
    } else if (isUnavailable(err)) {
      appErr = new AppError(503, 'SERVICE_UNAVAILABLE', 'Service temporarily unavailable — please retry');
      res.set('Retry-After', '2');
    } else {
      logger.error('unhandled error', { method: req.method, path: req.path, err: err.message, stack: err.stack });
      appErr = new AppError(500, 'INTERNAL_ERROR', 'Something went wrong');
    }
  }

  const body = { error: { code: appErr.code, message: appErr.message } };
  if (appErr.details) body.error.details = appErr.details;
  res.status(appErr.status).json(body);
}

function isUnavailable(err) {
  return (
    err.name === 'MongoServerSelectionError' ||
    err.name === 'MongoNetworkError' ||
    /Stream isn't writeable|Connection is closed|ECONNREFUSED|MaxRetriesPerRequest/i.test(err.message || '')
  );
}
