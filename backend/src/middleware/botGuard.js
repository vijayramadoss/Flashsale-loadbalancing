import { forbidden } from '../lib/errors.js';

// First, cheap line of bot defence on sensitive endpoints: reject requests
// that do not even pretend to be a browser. Determined bots can spoof headers,
// which is why this is layered with authentication, the per-user purchase
// limit and rate limiting (a CAPTCHA/WAF would be the next layer in production).
const AUTOMATION_UA = /(curl|wget|python-requests|python-urllib|aiohttp|httpie|go-http-client|java\/|okhttp|libwww|scrapy|headlesschrome|phantomjs|bot\b|spider|crawler)/i;

export function botGuard(req, _res, next) {
  const ua = req.get('user-agent') || '';
  if (ua.length < 10 || AUTOMATION_UA.test(ua)) {
    return next(forbidden('Automated traffic is not allowed'));
  }
  next();
}
