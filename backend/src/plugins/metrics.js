// Prometheus metrics in the standard text exposition format (no extra
// dependency). Each replica exposes GET /metrics; Prometheus scrapes every
// replica and Grafana sums them (see infra/prometheus, infra/grafana).
//
// Exposed:
//   flashsale_http_requests_total{method,route,status}        counter
//   flashsale_http_request_duration_seconds{route,...}         histogram
//   flashsale_queue_backlog / flashsale_queue_pending          gauges (Redis Streams)
//   flashsale_event_loop_delay_seconds{quantile}               gauge (event-loop health)
//   process_resident_memory_bytes, process_heap_used_bytes     gauges
import { monitorEventLoopDelay } from 'node:perf_hooks';
import fp from './fp.js';
import { config } from '../config/env.js';
import { getRedis, keys, ORDER_GROUP } from '../lib/redis.js';

const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];

export const metricsPlugin = fp(async function metrics(app) {
  const counters = new Map(); // `${method}|${route}|${status}` → n
  const histos = new Map(); // `${method}|${route}` → {buckets[], sum, count}
  const loop = monitorEventLoopDelay({ resolution: 20 });
  loop.enable();

  app.addHook('onResponse', async (req, reply) => {
    // Label by route PATTERN (/api/orders/:id), never the raw URL, to keep cardinality bounded.
    const route = req.routeOptions?.url || 'unmatched';
    if (route === '/metrics') return;
    const ck = `${req.method}|${route}|${reply.statusCode}`;
    counters.set(ck, (counters.get(ck) || 0) + 1);
    const hk = `${req.method}|${route}`;
    let h = histos.get(hk);
    if (!h) histos.set(hk, (h = { buckets: BUCKETS.map(() => 0), sum: 0, count: 0 }));
    const sec = reply.elapsedTime / 1000;
    BUCKETS.forEach((b, i) => {
      if (sec <= b) h.buckets[i]++;
    });
    h.sum += sec;
    h.count++;
  });

  app.get('/metrics', async (req, reply) => {
    // Internal endpoint: a bearer token when configured, otherwise loopback / private networks only.
    const token = (req.headers.authorization || '').replace(/^Bearer /, '');
    const internal = /^(127\.|::1|::ffff:127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(req.socket.remoteAddress || '');
    if (config.metricsToken ? token !== config.metricsToken : !internal) return reply.code(403).send('forbidden\n');

    const esc = (v) => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const lines = [];
    lines.push('# HELP flashsale_http_requests_total HTTP requests handled by this replica.', '# TYPE flashsale_http_requests_total counter');
    for (const [k, n] of counters) {
      const [method, route, status] = k.split('|');
      lines.push(`flashsale_http_requests_total{replica="${esc(config.replicaId)}",method="${method}",route="${esc(route)}",status="${status}"} ${n}`);
    }
    lines.push('# HELP flashsale_http_request_duration_seconds Server-side request latency.', '# TYPE flashsale_http_request_duration_seconds histogram');
    for (const [k, h] of histos) {
      const [method, route] = k.split('|');
      const labels = `replica="${esc(config.replicaId)}",method="${method}",route="${esc(route)}"`;
      BUCKETS.forEach((b, i) => lines.push(`flashsale_http_request_duration_seconds_bucket{${labels},le="${b}"} ${h.buckets[i]}`));
      lines.push(`flashsale_http_request_duration_seconds_bucket{${labels},le="+Inf"} ${h.count}`);
      lines.push(`flashsale_http_request_duration_seconds_sum{${labels}} ${h.sum.toFixed(6)}`);
      lines.push(`flashsale_http_request_duration_seconds_count{${labels}} ${h.count}`);
    }
    const redis = getRedis();
    const [backlog, pending] = await Promise.all([
      redis.xlen(keys.orderStream()).catch(() => 0),
      redis.xpending(keys.orderStream(), ORDER_GROUP).then((p) => Number(p?.[0] ?? 0)).catch(() => 0),
    ]);
    lines.push('# HELP flashsale_queue_backlog Reservations in the order stream not yet processed.', '# TYPE flashsale_queue_backlog gauge', `flashsale_queue_backlog ${backlog}`);
    lines.push('# HELP flashsale_queue_pending Reservations taken by a worker but not yet acknowledged.', '# TYPE flashsale_queue_pending gauge', `flashsale_queue_pending ${pending}`);
    lines.push('# HELP flashsale_event_loop_delay_seconds Event-loop delay of this replica.', '# TYPE flashsale_event_loop_delay_seconds gauge');
    for (const q of [50, 99]) lines.push(`flashsale_event_loop_delay_seconds{replica="${esc(config.replicaId)}",quantile="0.${q}"} ${(loop.percentile(q) / 1e9).toFixed(6)}`);
    const mem = process.memoryUsage();
    lines.push('# TYPE process_resident_memory_bytes gauge', `process_resident_memory_bytes{replica="${esc(config.replicaId)}"} ${mem.rss}`);
    lines.push('# TYPE process_heap_used_bytes gauge', `process_heap_used_bytes{replica="${esc(config.replicaId)}"} ${mem.heapUsed}`);
    reply.header('Content-Type', 'text/plain; version=0.0.4').header('Cache-Control', 'no-store');
    return `${lines.join('\n')}\n`;
  });
});
