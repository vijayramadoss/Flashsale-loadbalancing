// Per-replica traffic counters — makes load balancing VISIBLE.
//
// Every API replica:
//   * stamps each response with `X-Served-By: <replica id>`;
//   * counts its own requests per second in memory (no per-request Redis call);
//   * once a second writes that second's counts to Redis, so the admin
//     dashboard (served by ANY replica) can show how the load balancer
//     spread the traffic across ALL replicas.
//
// Redis layout:  stats:sec:<unix second>  hash  "<replica>|req" / "|2xx" / "|4xx" / "|5xx" / "|ms"
//                stats:replicas           zset  replica → last flush time (ms)
import fp from './fp.js';
import { config } from '../config/env.js';
import { getRedis, keys } from '../lib/redis.js';

const BUCKET_TTL_SEC = 180;

export const trafficPlugin = fp(async function traffic(app) {
  const replica = config.replicaId;
  let current = new Map(); // second → {req, s2xx, s4xx, s5xx, ms}

  app.addHook('onSend', async (_req, reply) => {
    reply.header('X-Served-By', replica);
  });

  app.addHook('onResponse', async (req, reply) => {
    // The dashboard's own polling would otherwise dominate quiet periods.
    if (req.url.startsWith('/api/admin/traffic')) return;
    const sec = Math.floor(Date.now() / 1000);
    let b = current.get(sec);
    if (!b) current.set(sec, (b = { req: 0, s2xx: 0, s4xx: 0, s5xx: 0, ms: 0 }));
    b.req++;
    const code = reply.statusCode;
    if (code >= 500) b.s5xx++;
    else if (code >= 400) b.s4xx++;
    else b.s2xx++;
    b.ms += reply.elapsedTime;
  });

  const flush = async () => {
    const pending = current;
    current = new Map();
    const redis = getRedis();
    const pipe = redis.pipeline();
    for (const [sec, b] of pending) {
      const key = keys.trafficSecond(sec);
      pipe.hincrby(key, `${replica}|req`, b.req);
      pipe.hincrby(key, `${replica}|2xx`, b.s2xx);
      pipe.hincrby(key, `${replica}|4xx`, b.s4xx);
      pipe.hincrby(key, `${replica}|5xx`, b.s5xx);
      pipe.hincrby(key, `${replica}|ms`, Math.round(b.ms));
      pipe.expire(key, BUCKET_TTL_SEC);
    }
    pipe.zadd(keys.trafficReplicas(), Date.now(), replica);
    await pipe.exec().catch(() => {}); // stats are best-effort; never affect requests
  };

  if (!config.isTest) {
    const timer = setInterval(flush, 1000);
    timer.unref();
    app.addHook('onClose', async () => {
      clearInterval(timer);
      await flush();
    });
  }
});

/** Last `seconds` of traffic, per replica — read by the admin dashboard. */
export async function readTraffic(seconds = 60) {
  const redis = getRedis();
  const now = Math.floor(Date.now() / 1000);
  const secs = Array.from({ length: seconds }, (_, i) => now - seconds + i); // excludes the still-filling current second
  const pipe = redis.pipeline();
  for (const s of secs) pipe.hgetall(keys.trafficSecond(s));
  pipe.zrange(keys.trafficReplicas(), 0, -1, 'WITHSCORES');
  const results = await pipe.exec();
  const raw = results.pop()[1];
  const replicas = [];
  for (let i = 0; i < raw.length; i += 2) {
    const lastSeen = Number(raw[i + 1]);
    replicas.push({ id: raw[i], lastSeen, alive: Date.now() - lastSeen < 5000 });
  }
  const series = secs.map((t, i) => {
    const h = results[i][1] || {};
    const per = {};
    for (const [field, value] of Object.entries(h)) {
      const [rep, metric] = field.split('|');
      per[rep] ??= { req: 0, '2xx': 0, '4xx': 0, '5xx': 0, ms: 0 };
      per[rep][metric] = Number(value);
    }
    return { t, replicas: per };
  });
  const totals = {};
  for (const point of series) {
    for (const [rep, m] of Object.entries(point.replicas)) {
      totals[rep] ??= { req: 0, '2xx': 0, '4xx': 0, '5xx': 0, ms: 0 };
      for (const k of Object.keys(totals[rep])) totals[rep][k] += m[k];
    }
  }
  return { now, seconds, replicas: replicas.sort((a, b) => a.id.localeCompare(b.id)), series, totals };
}
