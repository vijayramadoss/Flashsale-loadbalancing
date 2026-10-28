import { verifyToken } from '../services/authService.js';
import { forbidden, unauthorized } from '../lib/errors.js';

// Stateless authentication: the JWT signature is verified with the shared
// secret, so ANY replica can authenticate ANY request without a session store
// or a database round-trip. This is what keeps the checkout path DB-free.
export function requireAuth(req, _res, next) {
  const header = req.get('authorization') || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) return next(unauthorized());
  try {
    req.user = verifyToken(token);
    next();
  } catch {
    next(unauthorized('Session expired or invalid — please log in again'));
  }
}

export const requireRole = (role) => (req, _res, next) => {
  if (!req.user) return next(unauthorized());
  if (req.user.role !== role) return next(forbidden());
  next();
};
