// Thin wrapper over fetch (no axios → smaller bundle). Every call:
//  * has a timeout, so a stalled request can never freeze the UI;
//  * returns parsed JSON or throws ApiError carrying the server's error code;
//  * attaches the JWT when one is stored.

export class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
}

const TOKEN_KEY = 'fs.token';

export const tokenStore = {
  get: () => {
    try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
  },
  set: (t) => {
    try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch { /* storage unavailable */ }
  },
};

let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

export async function api(path, { method = 'GET', body, headers = {}, timeoutMs = 8000, auth = true } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const h = { Accept: 'application/json', ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const token = auth && tokenStore.get();
  if (token) h.Authorization = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(path.startsWith('/api') ? path : `/api${path}`, {
      method,
      headers: h,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
      credentials: 'same-origin',
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new ApiError(0, 'TIMEOUT', 'The server is taking too long — please retry');
    throw new ApiError(0, 'NETWORK_ERROR', 'Network problem — check your connection');
  } finally {
    clearTimeout(timer);
  }

  const retryAfter = Number(res.headers.get('Retry-After')) || undefined;
  let data = null;
  try { data = await res.json(); } catch { /* empty body (204) or non-JSON */ }

  if (!res.ok) {
    const err = data?.error || {};
    if (res.status === 401 && token) onUnauthorized();
    throw new ApiError(res.status, err.code || 'HTTP_ERROR', err.message || `Request failed (${res.status})`, { details: err.details, retryAfter });
  }
  return { data, status: res.status, retryAfter };
}

export const newIdempotencyKey = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
