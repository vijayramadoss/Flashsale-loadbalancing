// Lua scripts executed atomically inside Redis.
//
// Redis runs one command (and one whole Lua script) at a time on a single
// thread, so everything inside a script happens with no other client able to
// interleave. That is what makes "check stock, then decrement" safe here,
// whereas the same two steps as separate network round-trips would race.

// Admission gate for a checkout. In ONE atomic step it:
//   1. rejects users who already hold a reservation (returns their existing one),
//   2. checks the deal window against Redis' own clock (one clock for all replicas),
//   3. takes an inventory token (decrements stock) only if stock > 0,
//   4. records the reservation and enqueues a job on the order stream.
// Because the token and the job are created together, there can never be a
// taken token without a queued job (or vice versa).
//
// KEYS: 1 deal hash, 2 buyers hash, 3 order stream, 4 reservation hash
// ARGV: 1 userId, 2 reservationId, 3 dealId, 4 reservation TTL (seconds)
const RESERVE = `
redis.replicate_commands()
if redis.call('EXISTS', KEYS[1]) == 0 then return {'NO_SALE'} end
local existing = redis.call('HGET', KEYS[2], ARGV[1])
if existing then return {'DUPLICATE', existing} end
local t = redis.call('TIME')
local nowMs = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local deal = redis.call('HMGET', KEYS[1], 'stock', 'startsAt', 'endsAt')
if nowMs < tonumber(deal[2]) then return {'NOT_STARTED'} end
if nowMs >= tonumber(deal[3]) then return {'ENDED'} end
if tonumber(deal[1]) <= 0 then return {'SOLD_OUT'} end
local remaining = redis.call('HINCRBY', KEYS[1], 'stock', -1)
redis.call('HSET', KEYS[2], ARGV[1], ARGV[2])
redis.call('HSET', KEYS[4], 'status', 'QUEUED', 'userId', ARGV[1], 'dealId', ARGV[3], 'createdAt', tostring(nowMs))
redis.call('EXPIRE', KEYS[4], tonumber(ARGV[4]))
redis.call('XADD', KEYS[3], '*', 'reservationId', ARGV[2], 'dealId', ARGV[3], 'userId', ARGV[1], 'createdAt', tostring(nowMs))
return {'OK', ARGV[2], tostring(remaining)}
`;

// Compensation when a reservation will not become a paid order (worker failure,
// unpaid hold expired, or cancelled).
// Optionally returns the token to stock and frees the user's slot (so they
// may try again). Guarded so a stale message can't touch someone else's slot.
//
// KEYS: 1 deal hash, 2 buyers hash, 3 reservation hash
// ARGV: 1 userId, 2 reservationId, 3 reason, 4 restock ('1'|'0'), 5 free slot ('1'|'0')
// The reservation record is marked FAILED with the reason (if it still exists).
const RELEASE = `
if redis.call('HGET', KEYS[2], ARGV[1]) == ARGV[2] then
  if ARGV[5] == '1' then redis.call('HDEL', KEYS[2], ARGV[1]) end
  if ARGV[4] == '1' and redis.call('EXISTS', KEYS[1]) == 1 then
    redis.call('HINCRBY', KEYS[1], 'stock', 1)
  end
end
redis.call('HSET', KEYS[3], 'status', 'FAILED', 'reason', ARGV[3])
return 1
`;

// Loads a deal into Redis. Metadata (title, times, price...) is always
// refreshed, but the live stock counter and buyer list are written ONLY when
// the deal key does not exist yet. Doing this check-and-set inside one script
// means two replicas priming at the same moment can never reset a counter
// that customers are already decrementing.
//
// KEYS: 1 deal hash, 2 buyers hash
// ARGV: 1 stock, 2 JSON object of metadata fields, 3 JSON object {userId: reservationId}
const PRIME = `
local created = 0
if redis.call('EXISTS', KEYS[1]) == 0 then
  redis.call('DEL', KEYS[2])
  redis.call('HSET', KEYS[1], 'stock', ARGV[1])
  for userId, reservationId in pairs(cjson.decode(ARGV[3])) do
    redis.call('HSET', KEYS[2], userId, reservationId)
  end
  created = 1
end
for field, value in pairs(cjson.decode(ARGV[2])) do
  redis.call('HSET', KEYS[1], field, value)
end
return created
`;

// Fixed-window rate limiter: O(1) per request. Returns {count, ttlMs}.
// KEYS: 1 counter key   ARGV: 1 window (ms)
const RATE_LIMIT = `
local c = redis.call('INCR', KEYS[1])
if c == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return {c, redis.call('PTTL', KEYS[1])}
`;

export function defineScripts(client) {
  client.defineCommand('fsReserve', { numberOfKeys: 4, lua: RESERVE });
  client.defineCommand('fsRelease', { numberOfKeys: 3, lua: RELEASE });
  client.defineCommand('fsPrime', { numberOfKeys: 2, lua: PRIME });
  client.defineCommand('fsRateLimit', { numberOfKeys: 1, lua: RATE_LIMIT });
}
