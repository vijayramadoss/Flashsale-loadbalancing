import * as saleService from '../services/saleService.js';
import { config } from '../config/env.js';

export async function list(_req, res) {
  res.set('Cache-Control', 'public, max-age=2');
  res.json({ sales: await saleService.listOpenSales() });
}

export async function status(req, res) {
  // A 1-second shared cache lets a CDN / NGINX absorb most status polls:
  // 100k clients polling every second become ~1 origin request per second per edge.
  res.set('Cache-Control', 'public, max-age=1');
  res.json({ sale: await saleService.getSaleStatus(req.params.id) });
}

// ---------- admin ----------

export async function adminList(_req, res) {
  res.json({ sales: await saleService.listAllSales() });
}

export async function adminCreate(req, res) {
  const sale = await saleService.createSale(req.body);
  res.status(201).json({ sale: await saleService.getSaleStats(sale._id.toString()) });
}

export async function adminStats(req, res) {
  res.set('Cache-Control', 'no-store');
  res.json({ stats: await saleService.getSaleStats(req.params.id) });
}

export async function adminReset(req, res) {
  res.json({ stats: await saleService.resetSale(req.params.id, req.body, { isProduction: config.isProduction }) });
}
