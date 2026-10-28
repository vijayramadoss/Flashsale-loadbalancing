# FlashSale — 500 phones, 100,000 buyers, zero overselling

A phone store with a high-concurrency **flash-sale** path: 500 units go on sale at an exact time and thousands of buyers hit "Buy" at once. Built for the *Fullstack Placement Case Study*.

**Stack:** React 19 + Astryx UI · Node 24 + Fastify 5 · MongoDB 8 (replica set) · Redis (Lua + Streams) · NGINX · Docker

## How it works

```
Browser ──▶ CDN edge (JS/CSS) 
   │
   └──▶ NGINX (load balancer, rate limit, bot block) ──▶ 3 stateless API servers
                                                              │ 1. Redis Lua script: atomic "stock > 0 → -1"
                                                              │ 2. 202 Accepted + tracking URL (instant)
                                                              ▼
                                                        Redis Stream (queue) ──▶ workers ──▶ MongoDB transaction
                                                                                           (conditional decrement)
```

- **Never oversells:** one atomic Redis script decides who wins; MongoDB's `stock > 0` conditional update inside a transaction is the second safety net.
- **Fast:** the API only touches Redis and answers `202`; workers write to the database in the background.
- **Resilient:** idempotent clicks and payments, crashed-worker recovery, unpaid holds expire and restock.

## Start here (core files)

| Case-study requirement | File |
|---|---|
| Atomic stock, no overselling | `backend/src/redis/scripts.js`, `services/reservationService.js` |
| 202 + tracking URL | `backend/src/routes/deals.js` |
| Queue + ACID writes | `backend/src/worker.js`, `services/orderWorker.js`, `services/orderProcessor.js` |
| Data model | `backend/src/models/Deal.js`, `Order.js` |
| Load balancer / edge | `infra/nginx.conf` |
| UI click lock, loading/failed states | `frontend/src/hooks/useDeal.js`, `lib/checkout.js`, `components/DealPanel.jsx` |
| Proof | `backend/test/concurrency.test.js`, `integrity.test.js` |

The rest is a complete store around it: catalog, cart, checkout, payments (simulated gateway with signed webhooks), orders, admin.

## Run it

**Docker (everything, one command set):**
```bash
cp .env.docker.example .env      # then fill in the secrets
docker compose up -d --build
docker compose run --rm seed
```
Store `http://localhost:8080` · CDN `:8081` · Grafana `:3000`

**Without Docker:** needs Node 24, MongoDB as a replica set, Redis. 
```bash
npm install && npm run seed -- --fresh --starts-in-min=2
npm run dev:api & npm run dev:worker & npm run dev:web
```

## Results (real runs on one laptop)

| Requirement | Result |
|---|---|
| Exactly 500 sold | **500 / 500** in every test; 1,500 buyers for 100 units → exactly 100 |
| 0 % dropped requests | 10,000 simulated users, 83,195 requests, **0 errors** |
| Load balancing | 3 servers, even split; one server killed → 0 errors |
| Bundle < 200 KB | **170 KB** (Brotli) |
| Queue | 500 admitted in ~1 s, saved in ~9 s |
| Automated tests | backend **56/56**, frontend **9/9** |
| Docker stack | 11 containers; end-to-end smoke test **32/32** |
| CDN edge | **17/17** checks; 200 concurrent cold requests → 1 origin fetch |

```bash
npm test
```

## Limits (stated honestly)

- 100,000 requests in 10 s can't be produced on one laptop (peak ≈ 4,400 req/s here); the design targets it, it isn't measured at that scale.
- Page-load time was measured on localhost only. The CDN is a local NGINX edge, not a commercial CDN. Payments are simulated.

Full design notes, API reference, test evidence and troubleshooting: **`CLAUDE.md`**.
