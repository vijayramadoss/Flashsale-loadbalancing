# FlashSale — 500 phones, 100,000 buyers, zero overselling

A phone store with a high-concurrency **flash-sale** path: 500 units go on sale at an exact time and thousands of buyers hit "Buy" at once. 

**Stack:** React 19 + Astryx UI · Node 24 + Fastify 5 · MongoDB 8 (replica set) · Redis (Lua + Streams) · NGINX · Docker

## How to run

Needs **Docker Desktop** (running) and **Node 24**. Open a terminal in the project folder, then run these in order:

```bash
npm run setup
```
```bash
docker compose up -d --build
```
```bash
docker compose run --rm seed
```
```bash
npm install
```
```bash
node --env-file=backend/.env backend/scripts/smoke-test.js --base=http://localhost:8080 --metrics=skip
```
```bash
node backend/scripts/cdn-check.js --site=http://localhost:8080
```

- `npm run setup` creates the `.env` files with random secrets and prints the admin login (`admin@flashsale.test` + a generated password).
- Open the store at **http://localhost:8080**. The flash deal goes live about 2 minutes after the seed step. Admin screens: `/admin`.
- Expected: smoke test **32/32 checks passed**, CDN check **ALL CDN CHECKS PASSED**.
- If port 8080 is busy, change `WEB_PORT` in `.env`, rerun the second command, and use that port in the URLs.

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

## Run without Docker

Needs Node 24, MongoDB as a replica set, and Redis.
```bash
npm install && npm run setup && npm run seed -- --fresh --starts-in-min=2
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


