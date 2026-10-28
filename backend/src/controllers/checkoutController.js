import * as checkoutService from '../services/checkoutService.js';

// POST /api/checkout
// Never waits for the database. Responds 202 Accepted with a tracking URL the
// client polls — the HTTP request is decoupled from the heavy write.
export async function checkout(req, res) {
  const result = await checkoutService.reserve(req.user.id, req.body.saleId);
  const trackingUrl = `/api/checkout/${result.reservationId}`;
  res.set('Location', trackingUrl);
  res.set('Cache-Control', 'no-store');
  if (result.status === 'QUEUED') res.set('Retry-After', '1');
  // 202 = new work was queued; 200 = this user's existing reservation was returned (idempotent retry).
  res.status(result.duplicate ? 200 : 202).json({ ...result, trackingUrl });
}

// GET /api/checkout/:id — polled by the client until CONFIRMED or FAILED.
export async function trackReservation(req, res) {
  const reservation = await checkoutService.getReservation(req.params.id, req.user.id);
  res.set('Cache-Control', 'no-store');
  if (reservation.status === 'QUEUED') res.set('Retry-After', '1');
  res.json({ reservation });
}

export async function myOrders(req, res) {
  res.set('Cache-Control', 'no-store');
  res.json({ orders: await checkoutService.listMyOrders(req.user.id) });
}
