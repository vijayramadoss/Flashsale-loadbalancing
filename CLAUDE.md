# FlashSale — High-Concurrency Flash-Sale Checkout (MERN + Redis)

> **For future Claude sessions:** this file is the project's instruction file *and* its study guide. Keep it in sync with the code. Conventions: ES modules everywhere, Express 5 (async errors propagate automatically — no `asyncHandler`), business logic in `backend/src/services/`, all Redis keys built via `keys.*` in `backend/src/lib/redis.js`, all atomic Redis logic in Lua in `backend/src/redis/scripts.js`. Never read `process.env` outside `backend/src/config/env.js`. Tests run against real MongoDB + Redis (see §6). **C: drive on this machine is full — keep npm cache / temp on E: (§12, E1).**

Status (2026-10-28): **all mandatory requirements implemented and verified** except the infrastructure-only items marked *Provided, not verified* (NGINX / CDN deployment). See §3 and §15.

---

## 1. Project Overview

**Problem.** A festival flash sale releases **500 smartphones at exactly 8:00 PM**; **>100,000 concurrent checkout requests** are expected in the first 10 s. Earlier trials had high latency, DB row-lock timeouts, API timeouts and **oversold (540 orders for 500 phones)**.

**Target users.** Shoppers (buy one phone during the sale) and admins (schedule sales, watch consistency).

**Objectives.** Zero overselling; every request answered quickly; the UI never freezes or double-submits; abusive traffic limited.

**Outcome (verified).** 40,000 checkout requests from 10,000 buyers against a 4-process cluster → exactly **500** orders, **0** errors/timeouts/5xx, p99 458 ms (§11).

**Technology stack.**
| Layer | Tech | Why |
|---|---|---|
| Frontend | React 18.3 + Vite 6, plain CSS, `fetch` | Small bundle (no router/axios/UI kit) |
| API | Node.js 24, Express 5, zod 4, helmet, compression | Stateless REST, validated input |
| Fast path state | **Redis** (Lua scripts, Streams) | Atomic inventory tokens, queue, rate limits |
| Durable store | **MongoDB 8.3** (replica set) + Mongoose 8 | ACID transactions, conditional decrement |
| Auth | JWT (HS256) + bcryptjs | Stateless — any replica verifies any request |
| Tests | `node:test`, supertest, autocannon | No extra test framework needed |

## 2. Original Problem Statement

Source: `Fullstack_Placement_Case_Study.docx` — read completely (scenario, technical core requirements table, evaluation framework, model reference solution phases A/B/C, grading scorecard).

### Requirements summary (from the document)
| Layer | Challenge | Target metric |
|---|---|---|
| Frontend | Prevent API spamming from rapid clicks; graceful loading/failed queues without freezing | Bundle < 200 KB, TTI < 1.5 s |
| API gateway & routing | Ingest parallel traffic without drops; block bots; distribute load across replicas | Rate-limit bad actors; 0 % dropped requests |
| Application logic | Decouple heavy DB writes from the HTTP cycle; high concurrency | Stateless clusters; event-loop safety |
| Database | Exactly 500 sold; no app-level double counters / row-lock timeouts | ACID; atomic decrements |

Reference solution: UI lock on first click; CDN for static assets; polling/SSE for wait status · NGINX/ALB → stateless servers; Redis inventory token (atomic); queue → `202 Accepted` + polling URL · queue consumers run a strict transaction with `UPDATE … SET stock = stock - 1 WHERE id = :id AND stock > 0`.

**Functional:** schedule a sale; show live status/countdown; checkout with one-click lock; async order processing; order-status polling; order history; admin monitoring.
**Non-functional:** consistency (no oversell), latency, availability under spike, abuse resistance, small/fast frontend, horizontal scalability.

### Constraints, assumptions & ambiguities
| # | Ambiguity | Interpretation (decision) |
|---|---|---|
| A1 | The doc is an interview case study, not an app spec | Build a working app implementing the reference architecture; design discussion lives in §4/§16 |
| A2 | "RabbitMQ / Kafka (e.g.)" | **Redis Streams + consumer groups** (durable, acked, replayable). RabbitMQ was not installed; Redis was already required. Reservation **and** enqueue happen in one Lua script — a token can never be taken without a job |
| A3 | SQL conditional `UPDATE` | Mongo equivalent `findOneAndUpdate({_id, remainingStock:{$gt:0}}, {$inc:{remainingStock:-1}})` inside a multi-document **transaction** (needs a replica set → single-node `rs0` locally) |
| A4 | Per-user limit unstated | **1 unit per user per sale** (Redis buyers hash + unique Mongo index) |
| A5 | "Bundle < 200 KB" raw or gzip? | Enforced on the stricter **raw** size of the initial JS+CSS (build fails otherwise) |
| A6 | 100k requests in 10 s | Not reproducible on one laptop; strongest local test is reported honestly (§11) |
| A7 | CDN / NGINX / auto-scaling | Infra, not app code: immutable hashed assets + cache headers implemented; `infra/nginx.conf` provided **unverified** |
| A8 | Authentication not mentioned | Needed for 1-per-user and bot defence → email/password + JWT, roles `customer`/`admin` |
| A9 | Polling vs SSE vs WebSockets | **Adaptive polling** (CDN/NGINX-cacheable, stateless, no sticky sessions or 100k open sockets) — rationale in §16 |

## 3. Requirement Traceability Matrix

Legend: **Verified** = implemented + evidence in §11. *Provided, not verified* = artefact exists but could not be run here.

| ID | Requirement | Pri. | Implementation | Key files | Test / evidence | Status |
|---|---|---|---|---|---|---|
| R1 | Sale opens at exact time; closed before/after | Must | Lua checks window with Redis `TIME` (one clock for all replicas); client countdown synced to server clock | `redis/scripts.js` RESERVE, `components/Countdown.jsx`, `lib/polling.js` clockOffset | checkout.test "sale window…"; browser: button enabled at 10:57:31 for 10:57:30 start | **Verified** |
| R2 | Exactly N sold, zero oversell | Must | Redis Lua atomic token + Mongo conditional decrement in transaction + unique indexes | `scripts.js`, `orderProcessor.js`, `models/Order.js` | concurrency.test (1,500→100), integrity.test (Redis drift → still 10), loadtests 1–3 (exactly 500) | **Verified** |
| R3 | Decouple DB write; `202` + tracking URL | Must | Lua `XADD`s the job; controller returns 202 + `Location` + `Retry-After` | `checkoutController.js`, `checkoutService.js` | checkout.test happy path (no order before worker runs) | **Verified** |
| R4 | Async consumers, ACID persistence, sequential | Must | `worker.js` consumer group; `withTransaction`; idempotent; retries; reclaim; compensation | `worker.js`, `services/orderWorker.js`, `orderProcessor.js` | integrity.test (idempotency, race on last unit, crash reclaim) | **Verified** |
| R5 | Client polls order status | Must | `GET /api/checkout/:id` (Redis first, Mongo fallback), backoff honouring `Retry-After` | `checkoutService.getReservation`, `hooks.js` useCheckout | checkout.test; browser queued→confirmed in 1 poll | **Verified** |
| R6 | Cheap live sale status | Must | Redis-only `GET /api/sales/:id`, `Cache-Control: max-age=1`, adaptive jittered polling, pauses when hidden | `saleService.getSaleStatus`, `hooks.js` useSaleStatus | sales.test; lib.test polling | **Verified** |
| R7 | Rate-limit bad actors; block bots | Must | Redis fixed-window limiter (per IP, per user on checkout, per IP on auth); UA bot guard; auth required | `middleware/rateLimit.js`, `botGuard.js` | checkout.test 429 + 403; live server: 60×200 then 10×429 | **Verified** |
| R8 | Stateless horizontally scalable servers | Must | JWT auth; all state in Redis/Mongo; `cluster.js` | `cluster.js`, `middleware/auth.js` | loadtests on a 4-process cluster | **Verified** |
| R9 | Event-loop safety | Must | Hot path = 1 JWT verify + 2 Redis round trips; DB writes in separate worker process; no sync I/O | `checkoutService.reserve` | loadtest p99 232–458 ms under burst | **Verified** |
| R10 | 0 % dropped requests | Must | Large listen backlog, keep-alive, fast definitive answers (202/200/409/429), no blocking | `server.js` | loadtests: 20,000/20,000 and 40,000/40,000 answered, 0 errors/timeouts | **Verified** (locally) |
| R11 | UI locks on first click | Must | Synchronous `useRef` lock + disabled button + server idempotency | `hooks.js`, `CheckoutPanel.jsx` | browser: 5 same-tick clicks → 1 POST; concurrency.test 25 parallel → 1 reservation | **Verified** |
| R12 | Graceful loading/queued/failed states | Must | Explicit reducer state machine, auto-retry with countdown, timeouts, skeletons | `lib/checkout.js`, `api.js` | lib.test (9 tests); browser journey | **Verified** |
| R13 | Optimistic UI | Should | "Reserving…" + stock −1 instantly, rolled back on rejection | `lib/checkout.js`, `SalePage.jsx` | lib.test "sold out rolls back" | **Verified** |
| R14 | Asset pre-fetching, CDN-friendly assets | Should | `<link rel=preload>` hero image, `fetchpriority`, hashed assets `immutable, max-age=1y`, `index.html` `no-cache` | `index.html`, `app.js` | browser resource timing; CDN itself not deployed | **Verified** (CDN: *not verified*) |
| R15 | Bundle < 200 KB, TTI < 1.5 s | Must | No router/axios; admin code-split; budget check fails build | `scripts/check-bundle.js` | 163.9 KB raw / 53.6 KB gzip; localhost domInteractive 76 ms | **Verified** (TTI on localhost only) |
| R16 | Load balancing across replicas | Should | `node:cluster` (verified) + `infra/nginx.conf` (least_conn, keepalive, edge limits, micro-cache) | `cluster.js`, `infra/nginx.conf` | cluster used in loadtests; NGINX not run | Cluster **Verified**; NGINX *Provided, not verified* |
| R17 | Auth & admin authorization | Must (implicit) | bcrypt + JWT, `requireRole('admin')`, role never from request | `authService.js`, `middleware/auth.js` | auth.test (6), sales.test 401/403; browser customer blocked from admin | **Verified** |
| R18 | Admin schedules sale, monitors consistency | Must (implicit) | Admin API + lazy dashboard with Redis vs Mongo counters | `saleService.js`, `AdminPage.jsx` | sales.test; browser create + live stats | **Verified** |
| R19 | Validation & central error handling | Must (implicit) | zod schemas, uniform `{error:{code,message,details}}`, no stack traces | `routes/schemas.js`, `middleware/errorHandler.js` | auth.test (invalid JSON, validation) | **Verified** |

## 4. System Architecture

```mermaid
flowchart LR
  subgraph Client
    B[React SPA<br/>163 KB, hashed assets]
  end
  B -- static assets --> CDN[(CDN / NGINX static)]
  B -- /api --> LB[NGINX / ALB<br/>or node:cluster]
  LB --> A1[API process 1]
  LB --> A2[API process N]
  A1 & A2 -- "Lua: rate limit" --> R[(Redis)]
  A1 & A2 -- "Lua: reserve token + XADD job" --> R
  A1 & A2 -- "HGETALL sale / reservation" --> R
  R -- "XREADGROUP (consumer group)" --> W[Order worker(s)]
  W -- "transaction: conditional decrement + insert order" --> M[(MongoDB replica set)]
  W -- "HSET reservation CONFIRMED / FAILED" --> R
  A1 & A2 -. "admin, auth, order history" .-> M
```

**Key idea: 100,000 requests hit Redis; only 500 jobs ever reach MongoDB.** Redis answers "is there a unit for you?" in microseconds with a single-threaded atomic script; MongoDB only performs the 500 writes, sequentially, so there is no lock contention.

### Checkout sequence
```mermaid
sequenceDiagram
  participant U as Browser
  participant A as API (any replica)
  participant R as Redis
  participant W as Worker
  participant M as MongoDB
  U->>A: POST /api/checkout {saleId} (JWT)
  A->>R: fsRateLimit (per user)
  A->>R: fsReserve (Lua: dup? window? stock>0? → HINCRBY -1, HSET buyer, XADD job)
  R-->>A: OK, reservationId
  A-->>U: 202 Accepted, Location: /api/checkout/{id}, Retry-After: 1
  W->>R: XREADGROUP
  W->>M: withTransaction{ findOne(reservationId)?; findOneAndUpdate(stock>0, $inc -1); Order.create }
  W->>R: HSET res:{id} status=CONFIRMED orderId ; XACK + XDEL
  U->>A: GET /api/checkout/{id} (polling)
  A->>R: HGETALL res:{id}
  A-->>U: {status: CONFIRMED, orderId}
```

### Responsibilities
- **Frontend:** render sale, sync clock, adaptive polling, lock the button, show every checkout state, retry transient failures.
- **API (Express):** authenticate (JWT), validate, rate-limit, run the admission Lua script, answer immediately. Never writes orders.
- **Redis:** inventory tokens, buyer set, reservation status, order queue (stream), rate-limit counters, cached sale metadata.
- **Worker:** the only writer of orders; turns reservations into durable orders; compensates failures.
- **MongoDB:** durable truth — users, products, sales (remaining stock), orders.

### Design decisions & alternatives
| Decision | Alternatives considered | Why |
|---|---|---|
| Redis Lua admission gate | SQL/Mongo `SELECT then UPDATE`; pessimistic row locks; optimistic version checks | Lua runs atomically in one thread → no race and no lock waits; 100k lock waits on one DB row is exactly what caused the timeouts |
| Reserve + enqueue in **one** script | Decrement in Redis, then publish to RabbitMQ | Two systems = a crash in between loses or duplicates a unit; one script is all-or-nothing |
| Mongo conditional decrement in a transaction | Trusting Redis alone | Defence in depth: even if Redis is wrong (data loss, bug), Mongo cannot go below 0 (proven by integrity.test) |
| Redis Streams | RabbitMQ / Kafka | Not installed; Streams give consumer groups, acks, redelivery; fewer moving parts |
| Polling (adaptive, jittered, cacheable) | SSE / WebSockets | 100k long-lived sockets need sticky/connection-aware LB and memory; a 1-s cached GET is absorbed by CDN/NGINX |
| JWT | Server sessions | No session store lookup on the hot path; any replica can serve any user |
| One unit per user | Configurable quantity | Fairness and makes hoarding bots pointless; enforced at both layers |

## 5. Project Folder Structure

```
E:\goMl
├─ package.json             npm workspaces (backend, frontend) + root scripts
├─ CLAUDE.md                this file
├─ infra/nginx.conf         reference LB/edge config (unverified)
├─ backend/
│  ├─ .env.example          every env var with safe placeholders (copy to .env)
│  ├─ .env                  local secrets (git-ignored; generated)
│  ├─ .env.test             test-only settings (separate DB + Redis prefix)
│  ├─ .env.loadtest         overrides for load testing (separate DB + prefix, port 4100)
│  ├─ src/
│  │  ├─ server.js          API entry: connect, listen (backlog 4096), graceful shutdown
│  │  ├─ cluster.js         forks one API process per core, restarts crashed ones
│  │  ├─ worker.js          order-writer entry: loop over consumer group, reclaim stale
│  │  ├─ app.js             Express app factory (security headers, JSON limit, routes, static SPA)
│  │  ├─ config/env.js      the only place env vars are read; fails fast on weak JWT_SECRET
│  │  ├─ lib/               errors (AppError), logger (JSON lines), mongo, redis (+ key builders)
│  │  ├─ redis/scripts.js   Lua: RESERVE, RELEASE, PRIME, RATE_LIMIT
│  │  ├─ models/            User, Product, FlashSale, Order (Mongoose schemas + indexes)
│  │  ├─ middleware/        auth (JWT, roles), validate (zod), rateLimit, botGuard, errorHandler
│  │  ├─ routes/            index.js (all routes + middleware chains), schemas.js (zod)
│  │  ├─ controllers/       thin HTTP handlers: auth, sale, checkout
│  │  └─ services/          business logic: auth, sale (prime/status/stats/reset), checkout
│  │                        (reserve/track/history), orderProcessor (transaction), orderWorker (stream mechanics)
│  ├─ scripts/              init-replset.js, seed.js, loadtest.js
│  └─ test/                 helpers + auth, sales, checkout, concurrency, integrity tests
└─ frontend/
   ├─ index.html            preload hints
   ├─ public/               phone.svg (hero), favicon.svg
   ├─ scripts/check-bundle.js  bundle budget gate (runs after vite build)
   └─ src/
      ├─ main.jsx, App.jsx  bootstrap, layout, page switch, lazy admin chunk
      ├─ router.jsx         30-line History-API router (instead of React Router)
      ├─ api.js             fetch wrapper: timeout, ApiError, JWT, 401 handling
      ├─ auth.jsx           AuthContext (login/register/logout, localStorage)
      ├─ hooks.js           useSaleStatus (adaptive polling + clock sync), useCheckout (lock, retry, tracking)
      ├─ lib/               pure logic: checkout reducer, polling math, formatting (+ unit tests)
      ├─ components/        Countdown, StockBar, CheckoutPanel
      └─ pages/             SalePage, AuthPage, OrdersPage, AdminPage (lazy)
```
Runtime data (git-ignored): `E:\goMl\.data\{mongo,redis,logs}`. Portable Redis binaries: `E:\tools\redis` (outside the repo).

## 6. Environment Setup

**Prerequisites (versions used):** Node.js 24.15 / npm 11.12 · MongoDB 8.3 server (`C:\Program Files\MongoDB\Server\8.3\bin\mongod.exe`) · Redis 5.0.14.1 Windows port at `E:\tools\redis` (any Redis ≥ 5 works; Lua + Streams required).

> This machine's **C: drive is full**, which is why the MongoDB Windows *service* fails to start (exit 1067) and why npm needs its cache on E:. Our setup does not use the service — it runs its own `mongod` with data on E:.

**1. Install dependencies** (from `E:\goMl`, PowerShell):
```bash
npm install --cache E:/_claude_tmp/npm-cache
```
**2. Start MongoDB as a single-node replica set** (separate terminal; port 27018 so it never clashes with the stopped service on 27017):
```bash
"C:/Program Files/MongoDB/Server/8.3/bin/mongod.exe" --dbpath E:/goMl/.data/mongo --replSet rs0 --port 27018 --bind_ip 127.0.0.1 --logpath E:/goMl/.data/logs/mongod.log
```
**3. Start Redis** (separate terminal):
```bash
E:/tools/redis/redis-server.exe --port 6379 --bind 127.0.0.1 --dir E:/goMl/.data/redis --appendonly yes
```
**4. One-time:** initialise the replica set, configure env, seed:
```bash
npm run init-replset --workspace backend
```
Copy `backend/.env.example` → `backend/.env` and set `JWT_SECRET` (≥ 32 random chars) and `ADMIN_PASSWORD` (already done on this machine with generated values). Then:
```bash
npm run seed -- --starts-in-min=2
```

### Environment variables (`backend/.env`)
| Name | Example / default | Purpose |
|---|---|---|
| `NODE_ENV` | development | `production` disables sale reset |
| `PORT` | 4000 | API port |
| `LISTEN_BACKLOG` | 4096 | accept queue for connection bursts |
| `MONGO_URI` | `mongodb://127.0.0.1:27018/flashsale?replicaSet=rs0` | must be a replica set |
| `REDIS_URL` / `REDIS_PREFIX` | `redis://127.0.0.1:6379/0` / `fs:` | Redis + key namespace |
| `JWT_SECRET` / `JWT_EXPIRES_IN` | *random ≥32 chars* / 2h | token signing |
| `BCRYPT_ROUNDS` | 10 | password hashing cost |
| `TRUST_PROXY` | 0 (1 behind NGINX) | how `req.ip` is derived |
| `RATE_LIMIT_WINDOW_SEC`, `RATE_LIMIT_IP_MAX`, `RATE_LIMIT_CHECKOUT_USER_MAX`, `RATE_LIMIT_AUTH_IP_MAX` | 10, 60, 5, 20 | limiter settings |
| `WORKER_BATCH_SIZE`, `WORKER_BLOCK_MS`, `WORKER_MAX_DELIVERIES`, `WORKER_CLAIM_IDLE_MS` | 50, 2000, 5, 30000 | worker tuning |
| `WEB_CONCURRENCY` | 0 (= cores) | processes in cluster mode |
| `SERVE_FRONTEND` | false | serve `frontend/dist` from the API |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | admin@flashsale.test / *set locally* | seeded admin |

## 7. Database Design

### MongoDB collections
**users** — accounts. `name` (String, 2–60, required) · `email` (String, lowercase, **unique index**) · `passwordHash` (bcrypt, `select:false`) · `role` (`customer`|`admin`, default customer) · timestamps.
Example: `{ name: "Priya Buyer", email: "priya@example.test", role: "customer" }`

**products** — catalog. `name`, `description`, `imageUrl`, `priceCents` (integer minor units — avoids float rounding), `currency`.

**flashsales** — the durable inventory. `product` (ref Product) · `title` · `startsAt` / `endsAt` (validated `endsAt > startsAt`) · `totalStock` (int ≥ 1) · `remainingStock` (int ≥ 0, ≤ total) · `soldCount` · `priceCents` (snapshot at creation). Index `{endsAt:1, startsAt:1}` for "open sales" queries.
`remainingStock` is **only** changed by the conditional atomic update in the worker.
Example: `{ title: "Festival Flash Sale", totalStock: 500, remainingStock: 499, soldCount: 1, priceCents: 2499900 }`

**orders** — one per successful purchase. `reservationId` (**unique** — makes queue redelivery harmless) · `sale`, `product`, `user` (refs) · `quantity` (fixed 1) · `priceCents` · `status` (`CONFIRMED`). Indexes: `{reservationId:1}` unique · `{sale:1,user:1}` **unique** (DB backstop for one-per-user) · `{user:1, createdAt:-1}` (order history).

Why this shape: inventory lives on the sale (not product) so one product can have several sales; orders are only created for successful purchases (failed attempts live briefly in Redis), keeping the collection exactly equal to units sold — which makes the consistency check trivial (`orders == total − remaining`).

### Redis keys (prefix `fs:`; tests `fstest:`; load tests `fsload:`)
| Key | Type | Content |
|---|---|---|
| `sale:{saleId}` | Hash | `stock` (live tokens), `total`, `startsAt`/`endsAt` (ms), display fields |
| `sale:{saleId}:buyers` | Hash | `userId → reservationId` (one-per-user + idempotent retries) |
| `res:{reservationId}` | Hash (TTL 24 h) | `status` QUEUED/CONFIRMED/FAILED, `userId`, `saleId`, `orderId`, `reason` |
| `orders:stream` | Stream | jobs `{reservationId, saleId, userId}`; group `order-writers`; entries deleted after ack |
| `rl:{bucket}:{id}` | String (TTL) | fixed-window counters |

## 8. API Documentation

All responses are JSON. Errors: `{ "error": { "code": "SOLD_OUT", "message": "…", "details"?: [...] } }`. Every `/api` route except health is under the per-IP limit (60 / 10 s default) and may return **429** `RATE_LIMITED` with `Retry-After`.

| Method & route | Auth | Purpose | Success | Errors |
|---|---|---|---|---|
| GET `/api/health` | – | liveness | 200 `{status:"ok"}` | – |
| GET `/api/health/ready` | – | Mongo + Redis reachable | 200 / 503 `{mongo,redis}` | – |
| POST `/api/auth/register` | – (bot guard, 20/10 s/IP) | create customer | 201 `{token,user}` | 400 VALIDATION_ERROR, 409 EMAIL_TAKEN, 403 |
| POST `/api/auth/login` | – (bot guard) | log in | 200 `{token,user}` | 401 INVALID_CREDENTIALS (same for unknown email) |
| GET `/api/auth/me` | Bearer | current user | 200 `{user}` | 401 |
| GET `/api/sales` | – | open/upcoming sales (2 s micro-cache) | 200 `{sales:[{id,title,startsAt,endsAt}]}` | – |
| GET `/api/sales/:id` | – | live status from Redis, `Cache-Control: max-age=1` | 200 `{sale:{…,remainingStock,state,serverTime}}` | 404 |
| POST `/api/checkout` | Bearer + bot guard + 5/10 s/user | reserve a unit | **202** `{reservationId,status:"QUEUED",trackingUrl,remaining}` + `Location`, `Retry-After`; **200** same reservation if repeated | 400, 401, 403, 404, 409 SALE_NOT_STARTED / SALE_ENDED / SOLD_OUT, 429, 503 |
| GET `/api/checkout/:id` | Bearer (owner only) | reservation status | 200 `{reservation:{status,orderId?,reason?}}` (+`Retry-After` while QUEUED) | 404 (also for other users' ids) |
| GET `/api/orders/mine` | Bearer | order history | 200 `{orders:[…]}` | 401 |
| GET `/api/admin/sales` | admin | list sales | 200 | 401/403 |
| POST `/api/admin/sales` | admin | create + prime sale | 201 `{sale: stats}` | 400 (zod: title, dates, `totalStock` 1–1e6, exactly one of `productId`/`product`) |
| GET `/api/admin/sales/:id/stats` | admin | Redis vs Mongo counters | 200 `{stats}` | 404 |
| POST `/api/admin/sales/:id/reset` | admin, **non-production only** | delete that sale's orders, restore stock, new times | 200 `{stats}` | 403 in production, 409 QUEUE_BUSY |

Example (fictional):
```http
POST /api/checkout
Authorization: Bearer eyJ…
{"saleId":"6ae1870e2f410c1d213ad3f7"}

HTTP/1.1 202 Accepted
Location: /api/checkout/0b6c…
Retry-After: 1
{"reservationId":"0b6c…","status":"QUEUED","duplicate":false,"remaining":499,"trackingUrl":"/api/checkout/0b6c…"}
```
Frontend ↔ backend map: SalePage → `/sales`, `/sales/:id`; CheckoutPanel/useCheckout → `/checkout`, `/checkout/:id`; OrdersPage → `/orders/mine`; AuthPage → `/auth/*`; AdminPage → `/admin/*`.

## 9. Feature-by-Feature Implementation Journal

### F1 Foundation & authentication (R8, R17, R19)
1–3. Every later feature needs identity (one per user) and a safe, uniform error model. Flow: register/login → token stored → sent as `Authorization: Bearer`.
4. Design: stateless JWT so the hot path never touches the DB; role is never taken from input (zod strips unknown keys); bcrypt with a dummy-hash compare for unknown emails (no timing-based account enumeration).
5–6. `config/env.js` (validated config), `lib/errors.js` (AppError → status+code), `middleware/errorHandler.js` (maps zod/mongoose/JSON/duplicate/connection errors; hides internals), `services/authService.js`, `middleware/auth.js`, `AuthPage.jsx`, `auth.jsx`, `api.js`.
7–8. React form → `POST /api/auth/login` → zod → `login()` → `User.findOne` (Mongo) → bcrypt compare → `jwt.sign` → React stores token.
13. Validation server-side (zod) and client-side (instant feedback). 401 on any authed call clears the session in the UI.
14. auth.test (6 tests) ✔; browser: empty form showed 3 field errors; wrong password → "Incorrect email or password"; admin login redirected to /admin.

### F2 Sales & live status (R1, R6, R18)
Admin creates a sale (`POST /api/admin/sales`) → Mongo document → **`primeSale`** copies it to Redis via the `PRIME` Lua script, which writes stock/buyers *only if the key is missing* (two replicas priming simultaneously can never reset a live counter). If Redis loses the key, the next request re-primes from Mongo: stock = `remainingStock`, buyers rebuilt from orders (integrity.test proves previous buyers still can't rebuy).
Public `GET /api/sales/:id` is one `HGETALL` — Mongo is never touched by pollers. The client computes `serverTime − clientTime` (half-RTT corrected) so the countdown flips at the server's moment, then polls adaptively (30 s far away → 3 s near launch → 2 s live → stop when sold out/ended; ×4 slower in background tabs; ±20 % jitter).
Tests: sales.test (6) ✔. Browser: countdown accurate to the second; flipped to "Live now" at 10:57:31 for a 10:57:30 start.

### F3 Checkout admission (R2, R3, R5, R11)
`POST /api/checkout` → botGuard → requireAuth → per-user limiter → zod → `reserve()` → **one `RESERVE` Lua call**: already a buyer? return existing id · outside window? reject · stock ≤ 0? SOLD_OUT · else `HINCRBY stock -1`, record buyer + reservation, `XADD` job — all atomic. Returns 202 + tracking URL. Repeat clicks return the same reservation (200). `redis.replicate_commands()` is required because the script calls `TIME` before writing.
Tests: checkout.test (7) ✔, concurrency.test (2) ✔.

### F4 Order worker (R4, R2)
`worker.js` → `processBatch`: `XREADGROUP … BLOCK` on a dedicated connection; for each job, sequentially, `persistReservation` runs a Mongo transaction (idempotency check → conditional decrement → insert order). Outcome is written back to the Redis reservation, then `XACK` + `XDEL`. Transient errors retry 3× in-process; still failing → left pending; `reclaimStale` (`XPENDING`/`XCLAIM`) takes over messages idle > 30 s from crashed consumers; after 5 deliveries the job is FAILED with compensation (`RELEASE` script: return token, free slot). If Mongo says sold out, the worker zeroes the Redis counter so no more doomed reservations are admitted.
Tests: integrity.test (6) ✔ — drift, failure reason, idempotency, last-unit race, crash reclaim, Redis rebuild.

### F5 Abuse protection (R7)
Redis Lua fixed-window counters keyed per IP (all routes), per user (checkout) and per IP (auth) — shared by all replicas. `RateLimit-*` + `Retry-After` headers. Fails open if Redis is down (checkout itself will 503). `botGuard` rejects missing/automation user agents on auth & checkout. Limitation: header-based bot detection is spoofable → layered with auth, 1-per-user, limits; CAPTCHA/WAF recommended for production.
Tests: checkout.test 429/403 ✔; live: 70 requests → 60×200, 10×429.

### F6 Frontend (R11–R14)
`useCheckout` keeps a **ref lock** (synchronous — React state is async, so a second click in the same frame would otherwise slip through), drives the `checkoutReducer` state machine (idle → submitting → queued → confirmed | failed | soldOut | retrying | error), auto-retries transient failures (429/503/network/timeout/SALE_NOT_STARTED) up to 3× with a visible countdown, polls the tracking URL with backoff, and resumes tracking after a refresh (sessionStorage, per user). Every fetch has an 8 s timeout so nothing can hang. Optimistic −1 on the stock bar while submitting.
Tests: lib.test (9) ✔. Browser: 5 same-tick clicks → 1 POST; queued → confirmed; refresh kept "Order confirmed ✓"; mobile 375 px without horizontal scroll.

### F7 Performance & deployment shape (R14–R16)
Bundle gate `check-bundle.js` (fails the build above 200 KB raw initial JS+CSS). Hashed `/assets/*` served `immutable, max-age=1y`; `index.html` `no-cache`. `cluster.js` for multi-core; `infra/nginx.conf` for multi-host (least_conn, upstream keepalive, edge `limit_req`, 1 s micro-cache with `proxy_cache_lock`).

### F8 Load & integrity testing (R2, R10)
`scripts/loadtest.js` creates an isolated sale, mints JWTs for thousands of synthetic buyers, waits for the start, fires the burst with autocannon (X-Forwarded-For per buyer, as NGINX would send), waits for the queue to drain and asserts the invariants. Results in §11.

## 10. Authentication and Security

Implemented & verified: bcrypt password hashes (never returned; `select:false`) · HS256 JWT with ≥32-char secret enforced at boot, algorithm pinned on verify · role-based admin routes · ownership checks on reservations (others' ids → 404) · server-side zod validation everywhere · 10 KB JSON body limit · helmet security headers (CSP etc.) · `x-powered-by` off · rate limits (IP, user, auth) · bot UA guard · uniform errors without stack traces · secrets only in git-ignored `backend/.env` · destructive reset disabled when `NODE_ENV=production` · Redis/Mongo bound to 127.0.0.1.

Known gaps / risks: JWT stored in `localStorage` (readable by XSS; mitigated by CSP + React escaping; httpOnly cookies + CSRF protection would be stronger) · no refresh tokens/revocation (2 h expiry) · no email verification/CAPTCHA (account farming possible) · Redis and Mongo run without auth/TLS locally (must be enabled in production) · the API listens on all interfaces (`0.0.0.0:4000`, needed in containers) — on a laptop it is reachable from the LAN unless the firewall blocks it · `TRUST_PROXY` must equal the real proxy count or clients could spoof IPs via `X-Forwarded-For` · `npm audit`: 3 moderate advisories via `uuid` inside **autocannon** (dev-only load-test tool, never shipped).

## 11. Testing and Quality Assurance

Commands: `npm test` (both workspaces) — backend needs MongoDB + Redis running.

| Suite | Tests | Result (2026-10-28) |
|---|---|---|
| backend `auth.test.js` | register, role escalation, duplicates/validation, login/enumeration, token tamper, bad JSON | 6/6 ✔ |
| backend `sales.test.js` | admin create+prime, 401/403, validation, Redis status, 404s, re-prime after loss | 6/6 ✔ |
| backend `checkout.test.js` | happy path 202→CONFIRMED, idempotent repeat, window, sold out, auth/bot/400/404, ownership, 429 | 7/7 ✔ |
| backend `concurrency.test.js` | **1,500 concurrent buyers / 100 units → 100 orders**, 25 parallel clicks → 1 reservation | 2/2 ✔ |
| backend `integrity.test.js` | Redis drift (50 admitted, 10 in DB → 10 orders), failure reason, idempotency, last-unit race, crash reclaim, Redis rebuild | 6/6 ✔ |
| frontend `lib.test.js` | jitter, adaptive polling, backoff, clock offset, state machine (happy, rollback, bounded retries, duplicate) | 9/9 ✔ |
| **Total** | | **36/36 pass** |

**Build:** `npm run build` ✔ — initial load **163.9 KB raw / 53.6 KB gzip** (JS 158.1 KB + CSS 5.8 KB); admin chunk 5.4 KB lazy.

**Load tests** (`npm run loadtest`, 4-process cluster + 1 worker + Redis + Mongo + load generator all on one Windows laptop):
| Run | Requests / buyers / conns | Status counts | Errors / timeouts | Throughput | Latency p50 / p99 / max | Orders | Mongo remaining | Oversold |
|---|---|---|---|---|---|---|---|---|
| 1 | 20,000 / 5,000 / 200 | 202×500, 200×1,500, 409×18,000 | 0 / 0 | 1,796 req/s | 94 / 232 / 444 ms | **500** | 0 | no |
| 2 | 40,000 / 10,000 / 500 | 202×500, 200×1,500, 409×38,000 | 0 / 0 | 2,319 req/s | 178 / 458 / 608 ms | **500** | 0 | no |
| 3 (after XDEL change) | 20,000 / 5,000 / 200 | 202×500, 200×1,500, 409×18,000 | 0 / 0 | 2,187 req/s | 50 / 265 ms | **500** | 0 | no |
The worker kept pace during the burst (queue drained ≤ 0.03 s after it ended). 100k req/10 s (10k req/s) was **not** reached on one laptop — that needs several hosts behind a load balancer; the design scales horizontally because API processes share nothing.

**Manual / browser (built-in browser against `SERVE_FRONTEND=true` API):** registration validation; register → sale page; countdown → live flip on time; 5 same-tick clicks → 1 POST; queued → confirmed; My orders; reload keeps state; customer blocked from /admin; wrong admin password message; admin dashboard counters consistent; create sale from UI; mobile 375 px layout; console clean except the intentional 401. Vite dev proxy `/api` ✔. Per-IP limit live: 60×200 + 10×429.

**Performance (localhost, warm cache):** domInteractive 76 ms, load 85 ms, sale data on screen ≈ 120 ms. *TTI on a real mobile network was not measured* (no Lighthouse/throttling available); expected to stay < 1.5 s given 54 KB gzip and a CDN.

**Not covered:** no React component tests (DOM test env not installed — logic is extracted to pure modules and tested; UI verified in-browser); NGINX/CDN not exercised; no multi-host test.

## 12. Errors, Debugging, and Troubleshooting

| # | Symptom | Cause | Fix | Verified |
|---|---|---|---|---|
| E1 | "Disk full … 0 MB free" from tools; MongoDB service stopped (exit 1067) | C: drive full | All data, temp and npm cache on E: (`--cache E:/_claude_tmp/npm-cache`, `TEMP=E:/_claude_tmp`); run own `mongod` on port 27018 | ✔ |
| E2 | `redis-server` exit: `unknown argument: maxheap` | Option exists only in old MS port | Removed the flag | ✔ |
| E3 | zod 3 high-severity advisory | GHSA-mrhx-c7xc-m3w5 | Upgraded to zod 4 | ✔ `npm audit` |
| E4 | `npm test` hung for minutes | `server.close()` waits for keep-alive sockets; leftover in-flight requests after a failed `Promise.all` | `closeAllConnections()`; network errors counted not thrown | ✔ |
| E5 | `ECONNREFUSED` with 1,500 simultaneous connects | Windows client caps the TCP accept backlog (~200) | `listen({backlog: 4096})` for Linux; test uses a 200-socket keep-alive pool (as NGINX does) | ✔ |
| E6 | `node --test test/` didn't find files / would run helpers | Node ≥ 21 treats args as globs | `"test/*.test.js"` | ✔ |
| E7 | Stream grows forever | Acked messages stayed in stream | `XACK` + `XDEL` in a pipeline; reclaim acks dangling ids | ✔ loadtest 3 |
| E8 | Stopping an `npm run …` background task left `node` children running (Windows) | npm wrapper killed, child not | Kill by command line (`Get-CimInstance Win32_Process`) | ✔ |

Debugging tips: `GET /api/health/ready`; admin dashboard consistency badge; `redis-cli -p 6379 hgetall fs:sale:<id>`, `xpending fs:orders:stream order-writers`; logs are JSON lines (`.data/logs/*.log` when started as documented); Mongo log `.data/logs/mongod.log`.

## 13. Commands Reference
Run from `E:\goMl` unless noted.
```bash
npm install --cache E:/_claude_tmp/npm-cache        # install all workspaces
npm run init-replset --workspace backend             # once, after first mongod start
npm run seed -- --starts-in-min=2 --stock=500        # admin + demo product + sale
npm run dev:api                                      # API with --watch (port 4000)
npm run dev:worker                                   # order worker (required for orders to confirm!)
npm run dev:web                                      # Vite on http://localhost:5173 (proxies /api)
npm run build                                        # frontend build + bundle budget gate
npm test                                             # backend (needs Mongo+Redis) + frontend tests
npm start                                            # cluster mode API (WEB_CONCURRENCY processes)
```
Single-origin production-like run: `npm run build`, then in `backend/`: `SERVE_FRONTEND=true npm start` + `npm run worker` → http://localhost:4000.
Load test (3 terminals, in `backend/`): `npm run start:loadtest` · `npm run worker:loadtest` · `npm run loadtest -- --requests=20000 --buyers=5000 --connections=200`.

## 14. Deployment Guide (reference — not executed)
1. MongoDB replica set (Atlas or 3-node) with auth/TLS; Redis with AOF `everysec`, auth/TLS, ideally a primary + replica (managed). Redis Cluster would require hash-tagging the per-sale keys and a per-sale stream (current scripts touch one global stream).
2. Build frontend (`npm run build`), upload `frontend/dist` to a CDN/object storage: `/assets/*` immutable for 1 year, `index.html` no-cache.
3. Run N API containers (`node src/server.js`, `NODE_ENV=production`, `TRUST_PROXY=1`) behind NGINX (`infra/nginx.conf`) or an ALB; autoscale on CPU. Run ≥ 2 worker containers (`node src/worker.js`) — the consumer group shares work and reclaims after crashes.
4. Secrets via the platform's secret manager; never in images.
5. Pre-sale: create the sale ahead of time (primes Redis), warm the CDN, check `/api/health/ready` on every replica.
*Unverified here:* NGINX config, Docker, CDN, multi-host.

## 15. Current Progress and Completion Status
- **Verified (17/19 rows fully, 2 partially):** R1–R13, R15 (TTI on localhost only), R17–R19; R14 app side; R16 cluster side.
- **Provided, not verified:** NGINX load balancer/edge config, CDN deployment (R14/R16 infrastructure halves).
- **Not started:** none of the mandatory items. Optional ideas: SSE for sale status, CAPTCHA, httpOnly-cookie auth, Docker Compose, Lighthouse/throttled TTI measurement.
- **Failing tests / known bugs:** none.
- **Pending decisions:** none blocking. Git repository initialised on branch `main` (initial commit `5dd1b7b`); no remote configured.
- **Next recommended action:** free space on C:, then optionally verify `infra/nginx.conf` with Docker; run the throttled TTI measurement.

## 16. Study Guide

**Request → Redis → queue → MongoDB → response (trace it):** `CheckoutPanel` button → `useCheckout.submit` (`hooks.js`) → `api('/checkout')` (`api.js`) → `routes/index.js` chain → `checkoutController.checkout` → `checkoutService.reserve` → `RESERVE` Lua (`redis/scripts.js`) → 202 → `useCheckout` polling → `checkoutController.trackReservation` → … meanwhile `worker.js` → `orderWorker.processBatch` → `orderProcessor.persistReservation` (transaction) → `publishOutcome` → Redis → next poll shows CONFIRMED.

**Concepts:** atomicity (Lua scripts run with nothing interleaved); race condition (two readers see stock=1 and both decrement — "SELECT then UPDATE"); pessimistic locking (lock the row while deciding: correct but 100k waiters → timeouts); optimistic locking (version check + retry: correct but 100k retries on one hot row → wasted work); conditional atomic update (`WHERE stock > 0` decided inside the DB in one step); idempotency (unique `reservationId`, buyers hash); at-least-once delivery + idempotent consumer = effectively-once; backpressure (only N jobs ever enter the queue); stateless services; clock synchronisation; thundering herd & jitter; optimistic UI.

**Why this architecture fits:** the scarce resource is 500 units, not CPU. Deciding "who gets a unit" must be fast and atomic → Redis. Recording the sale must be durable → MongoDB, but only 500 times, sequentially. Everything else (status, retries) is cheap reads.

**Why Lua/atomic beats SELECT-then-UPDATE:** between the SELECT and the UPDATE other requests run; with 100k in flight, many read the same "1 left" (this is exactly how 540 orders happened). In Redis the whole check-and-decrement is one script on one thread; in Mongo the filter and `$inc` are evaluated together on the document.

**How to trace any feature:** start at `frontend/src/pages/*` → find the `api()` call → match the route in `backend/src/routes/index.js` → controller → service → model / Lua script.

**Common errors:** `Transaction numbers are only allowed on a replica set member` → run `init-replset` / use `?replicaSet=rs0`. Orders stay QUEUED → the worker isn't running. 429 during local experiments → wait `Retry-After` or raise limits in `.env`. `JWT_SECRET must be set` → create `backend/.env`.

**Questions you should be able to answer:**
1. Why can the system never sell 501 units even if Redis is wrong? (§9 F4, integrity.test)
2. What happens if a worker crashes after reading a message but before acking? (XPENDING/XCLAIM, idempotency)
3. Why is the button lock a `useRef` and not state?
4. Why return 202 instead of waiting for the order?
5. Why polling instead of WebSockets for 100k users?
6. Why must reservation and enqueue be in the same Lua script?
7. How do rate limits stay correct across many API processes?
8. What is the role of `TRUST_PROXY` and what breaks if it's wrong?
9. Pessimistic vs optimistic locking — when would each be fine?
10. How does the countdown stay correct when the user's clock is wrong?

## 17. Change Log
**Session 1 — 2026-10-28**
- Read the full case study; inspected an empty `E:\goMl`; found C: full, MongoDB service stopped, no Redis; user chose portable Redis on E: (`E:\tools\redis`, Redis 5.0.14.1 Windows port).
- Implemented F1–F8: backend (Express/Mongo/Redis/Lua/Streams worker), React frontend, seed, load test, NGINX reference config.
- Tests: 36/36 pass; build within budget; 3 load tests pass integrity checks; browser journeys verified.
- Decisions: Redis Streams instead of RabbitMQ; one unit per user; adaptive polling; JWT; Mongo on port 27018 with own data dir.
- Fixes: E1–E8 (§12).
- Outstanding: NGINX/CDN unverified; real-network TTI unmeasured.
- Git: initialised `main`, initial commit `5dd1b7b` (71 files; `backend/.env`, `node_modules`, `dist`, `.data` excluded).
- Next: free C: space; optional Docker/NGINX verification.
