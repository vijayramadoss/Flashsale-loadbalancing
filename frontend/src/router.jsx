// A ~30-line History-API router. The app has five screens, so React Router
// (~20 KB gzipped) would cost more bundle budget than it saves code.
import { useSyncExternalStore } from 'react';

const listeners = new Set();
const notify = () => listeners.forEach((l) => l());
window.addEventListener('popstate', notify);

export function navigate(to, { replace = false } = {}) {
  if (replace) history.replaceState(null, '', to);
  else history.pushState(null, '', to);
  notify();
  window.scrollTo(0, 0);
}

const subscribe = (l) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function useLocation() {
  const path = useSyncExternalStore(subscribe, () => location.pathname);
  const search = useSyncExternalStore(subscribe, () => location.search);
  return { path, query: new URLSearchParams(search) };
}

export function Link({ to, children, ...rest }) {
  const onClick = (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(to);
  };
  return (
    <a href={to} onClick={onClick} {...rest}>
      {children}
    </a>
  );
}
