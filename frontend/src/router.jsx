// A small History-API router with path params. The store has ~12 screens;
// this costs ~1 KB instead of ~20 KB for React Router.
import { useSyncExternalStore } from 'react';

const listeners = new Set();
const notify = () => listeners.forEach((l) => l());
window.addEventListener('popstate', notify);

export function navigate(to, { replace = false, keepScroll = false } = {}) {
  if (to === location.pathname + location.search) return;
  if (replace) history.replaceState(null, '', to);
  else history.pushState(null, '', to);
  notify();
  if (!keepScroll) window.scrollTo(0, 0);
}

const subscribe = (l) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function useLocation() {
  const path = useSyncExternalStore(subscribe, () => location.pathname);
  const search = useSyncExternalStore(subscribe, () => location.search);
  return { path, search, query: new URLSearchParams(search) };
}

/** Matches "/phones/:slug" against "/phones/iphone-16" → { slug: "iphone-16" } (or null). */
export function matchPath(pattern, path) {
  const p = pattern.split('/').filter(Boolean);
  const s = path.split('/').filter(Boolean);
  if (p.length !== s.length) return null;
  const params = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(':')) params[p[i].slice(1)] = decodeURIComponent(s[i]);
    else if (p[i] !== s[i]) return null;
  }
  return params;
}

/**
 * Adapter given to Astryx's LinkProvider: every Astryx Link / Button href /
 * TopNavItem / ClickableCard then navigates client-side without a reload.
 */
export function AppLink({ href, target, onClick, ...rest }) {
  return (
    <a
      href={href}
      target={target}
      {...rest}
      onClick={(e) => {
        onClick?.(e);
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        if (target === '_blank' || !href || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) return;
        e.preventDefault();
        navigate(href);
      }}
    />
  );
}
