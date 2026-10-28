// Minimal structured (JSON-lines) logger. console.* writes are asynchronous for
// pipes on most platforms, so this is safe on the hot path in moderation; we
// still avoid logging per-request in the checkout path.
import { config } from '../config/env.js';

const write = (level, msg, extra) => {
  if (config.isTest && level !== 'error') return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, pid: process.pid, msg, ...extra });
  (level === 'error' ? console.error : console.log)(line);
};

export const logger = {
  info: (msg, extra) => write('info', msg, extra),
  warn: (msg, extra) => write('warn', msg, extra),
  error: (msg, extra) => write('error', msg, extra),
};
