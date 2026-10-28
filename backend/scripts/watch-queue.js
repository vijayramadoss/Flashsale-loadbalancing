// Live view of the flash-deal queue (Redis Streams) — run it while a sale or
// the simulator is running to SEE requests being queued and drained.
//
// Every 250 ms it prints one line when something changed:
//   tokens   = units left in Redis (the admission gate)
//   queued   = jobs waiting in the stream (admitted, not yet picked up)
//   inFlight = jobs picked up by a worker but not yet acknowledged
//   orders   = pending/paid orders already written to MongoDB
//   workers  = each consumer in the group with its in-flight count and idle time
//
// Usage (in backend/):  node --env-file=.env --env-file=.env.sim scripts/watch-queue.js [--seconds=120]
import { connectMongo, disconnectMongo } from '../src/lib/mongo.js';
import { closeRedis, getRedis, keys, ORDER_GROUP, waitForRedis } from '../src/lib/redis.js';
import { Deal } from '../src/models/Deal.js';
import { Order } from '../src/models/Order.js';

const secondsArg = process.argv.find((a) => a.startsWith('--seconds='));
const RUN_MS = (secondsArg ? Number(secondsArg.split('=')[1]) : 120) * 1000;

await connectMongo();
const redis = await waitForRedis(getRedis());
const stream = keys.orderStream();
const t0 = Date.now();
let last = '';
let peakQueued = 0;
let latestDeal = null;
let orderCounts = { pending: 0, paid: 0 };
let lastDbCheck = 0;

const parseConsumers = (rows) =>
  rows.map((r) => {
    const o = {};
    for (let i = 0; i < r.length; i += 2) o[r[i]] = r[i + 1];
    return `${String(o.name).slice(-6)}(inFlight ${o.pending}, idle ${o.idle}ms)`;
  });

console.log('time     tokens  queued  inFlight  orders(pending/paid)  workers');
while (Date.now() - t0 < RUN_MS) {
  if (Date.now() - lastDbCheck > 1000) {
    lastDbCheck = Date.now();
    latestDeal = await Deal.findOne({ endsAt: { $gt: new Date() } }).sort({ createdAt: -1 }).lean();
    if (latestDeal) {
      const [pending, paid] = await Promise.all([
        Order.countDocuments({ deal: latestDeal._id, status: 'PENDING_PAYMENT' }),
        Order.countDocuments({ deal: latestDeal._id, status: 'CONFIRMED' }),
      ]);
      orderCounts = { pending, paid };
    }
  }
  const [queued, summary, consumers, tokens] = await Promise.all([
    redis.xlen(stream),
    redis.xpending(stream, ORDER_GROUP).catch(() => [0]),
    redis.xinfo('CONSUMERS', stream, ORDER_GROUP).catch(() => []),
    latestDeal ? redis.hget(keys.deal(latestDeal._id), 'stock') : null,
  ]);
  // Acked messages are deleted, so XLEN = admitted-but-unfinished jobs; subtract the in-flight ones.
  const inFlight = Number(summary?.[0] ?? 0);
  const waiting = Math.max(0, queued - inFlight);
  peakQueued = Math.max(peakQueued, queued);
  const line = `${String(tokens ?? '-').padStart(6)}  ${String(waiting).padStart(6)}  ${String(inFlight).padStart(8)}  ${String(`${orderCounts.pending}/${orderCounts.paid}`).padStart(20)}  ${parseConsumers(consumers).join('  ')}`;
  const key = line.replace(/idle \d+ms/g, '');
  if (key !== last) {
    console.log(`${new Date().toLocaleTimeString().padEnd(8)} ${line}`);
    last = key;
  }
  await new Promise((r) => setTimeout(r, 250));
}
console.log(`peak stream length: ${peakQueued}`);
await closeRedis();
await disconnectMongo();
