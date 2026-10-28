import mongoose from 'mongoose';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

// Turns an Ajv (JSON-schema) validation error into our field/message list.
function validationDetails(err) {
  return err.validation.map((v) => {
    const path = (v.instancePath || '').replace(/^\//, '').replace(/\//g, '.');
    const field = v.params?.missingProperty ? [path, v.params.missingProperty].filter(Boolean).join('.') : path || v.params?.additionalProperty || '';
    return { field, message: v.message };
  });
}

function isUnavailable(err) {
  return (
    err.name === 'MongoServerSelectionError' ||
    err.name === 'MongoNetworkError' ||
    /Stream isn't writeable|Connection is closed|ECONNREFUSED|MaxRetriesPerRequest/i.test(err.message || '')
  );
}

/**
 * Every error leaves the API in one shape: { error: { code, message, details? } }.
 * Unexpected errors are logged with their stack; the client only sees a generic message.
 */
export function errorHandler(err, request, reply) {
  let appErr = err;
  if (!(err instanceof AppError)) {
    if (err.validation) {
      appErr = new AppError(400, 'VALIDATION_ERROR', 'Invalid request', validationDetails(err));
    } else if (err.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      appErr = new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
    } else if (err instanceof SyntaxError || /^FST_ERR_CTP_/.test(err.code || '')) {
      appErr = new AppError(400, 'INVALID_JSON', 'Request body is not valid JSON');
    } else if (err instanceof mongoose.Error.ValidationError) {
      const details = Object.values(err.errors).map((e) => ({ field: e.path, message: e.message }));
      appErr = new AppError(400, 'VALIDATION_ERROR', 'Invalid data', details);
    } else if (err instanceof mongoose.Error.CastError) {
      appErr = new AppError(400, 'VALIDATION_ERROR', `Invalid ${err.path}`);
    } else if (err.code === 11000) {
      appErr = new AppError(409, 'DUPLICATE', 'Resource already exists');
    } else if (isUnavailable(err)) {
      appErr = new AppError(503, 'SERVICE_UNAVAILABLE', 'Service temporarily unavailable — please retry');
      reply.header('Retry-After', '2');
    } else if (err.statusCode && err.statusCode < 500) {
      appErr = new AppError(err.statusCode, err.code || 'BAD_REQUEST', err.message);
    } else {
      logger.error('unhandled error', { method: request.method, url: request.url, err: err.message, stack: err.stack });
      appErr = new AppError(500, 'INTERNAL_ERROR', 'Something went wrong');
    }
  }
  const body = { error: { code: appErr.code, message: appErr.message } };
  if (appErr.details) body.error.details = appErr.details;
  reply.code(appErr.status).send(body);
}
