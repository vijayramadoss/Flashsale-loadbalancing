import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

// Session-lifetime cache of GET responses: going "back" to a page shows the
// last data instantly while a fresh copy loads (stale-while-revalidate).
const cache = new Map();

export function invalidateApiCache(prefix = '') {
  for (const key of cache.keys()) if (key.startsWith(prefix)) cache.delete(key);
}

/**
 * Minimal data-fetching hook: { data, error, loading, reload }.
 * Pass path = null to skip fetching (e.g. until the user is logged in).
 */
export function useApi(path, { auth = true } = {}) {
  const [state, setState] = useState(() => ({ data: path ? cache.get(path) : undefined, error: null, loading: Boolean(path) }));
  const seq = useRef(0);

  const load = useCallback(async () => {
    if (!path) return;
    const id = ++seq.current;
    setState((s) => ({ data: cache.get(path) ?? (s.path === path ? s.data : undefined), error: null, loading: true, path }));
    try {
      const { data } = await api(path, { auth });
      cache.set(path, data);
      if (id === seq.current) setState({ data, error: null, loading: false, path });
    } catch (error) {
      if (id === seq.current) setState((s) => ({ ...s, error, loading: false }));
    }
  }, [path, auth]);

  useEffect(() => {
    load();
  }, [load]);

  return { ...state, reload: load };
}
