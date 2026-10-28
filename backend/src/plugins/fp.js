// Minimal stand-in for `fastify-plugin`: marks a plugin so Fastify does NOT
// encapsulate it, i.e. its hooks apply to the whole app instead of only to
// routes registered inside it.
export default function fp(plugin) {
  plugin[Symbol.for('skip-override')] = true;
  return plugin;
}
