import { lazy, Suspense, useEffect, useState } from 'react';
import { TopNav, TopNavHeading, TopNavItem } from '@astryxdesign/core/TopNav';
import { TextInput } from '@astryxdesign/core/TextInput';
import { Button } from '@astryxdesign/core/Button';
import { Icon } from '@astryxdesign/core/Icon';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import { VStack } from '@astryxdesign/core/VStack';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Text } from '@astryxdesign/core/Text';
import { Link } from '@astryxdesign/core/Link';
import { ShoppingCart, User } from 'lucide-react';
import { matchPath, navigate, useLocation } from './router.jsx';
import { useAuth } from './auth.jsx';
import { useCart } from './cart.jsx';
import HomePage from './pages/HomePage.jsx';

// Route-level code splitting: the first visit downloads only the shell and the
// home page; every other screen is its own chunk. Shopper routes are then
// prefetched while the browser is idle, so later navigation is instant.
const loaders = {
  products: () => import('./pages/ProductsPage.jsx'),
  product: () => import('./pages/ProductPage.jsx'),
  cart: () => import('./pages/CartPage.jsx'),
  checkout: () => import('./pages/CheckoutPage.jsx'),
  order: () => import('./pages/OrderPage.jsx'),
  orders: () => import('./pages/OrdersPage.jsx'),
  account: () => import('./pages/AccountPage.jsx'),
  auth: () => import('./pages/AuthPage.jsx'),
  admin: () => import('./pages/AdminPage.jsx'), // never prefetched: shoppers don't need it
};
const ProductsPage = lazy(loaders.products);
const ProductPage = lazy(loaders.product);
const CartPage = lazy(loaders.cart);
const CheckoutPage = lazy(loaders.checkout);
const OrderPage = lazy(loaders.order);
const OrdersPage = lazy(loaders.orders);
const AccountPage = lazy(loaders.account);
const AuthPage = lazy(loaders.auth);
const AdminPage = lazy(loaders.admin);

function prefetchRoutes() {
  const idle = window.requestIdleCallback || ((cb) => setTimeout(cb, 1500));
  idle(() => ['products', 'product', 'cart', 'auth', 'checkout', 'order', 'orders', 'account'].forEach((k) => loaders[k]().catch(() => {})));
}

const ROUTES = [
  ['/', () => <HomePage />],
  ['/phones', () => <ProductsPage />],
  ['/phones/:slug', ({ slug }) => <ProductPage slug={slug} />],
  ['/cart', () => <CartPage />],
  ['/checkout', () => <CheckoutPage />],
  ['/checkout/:orderId', ({ orderId }) => <CheckoutPage orderId={orderId} />],
  ['/orders', () => <OrdersPage />, { auth: true }],
  ['/orders/:id', ({ id }) => <OrderPage id={id} />, { auth: true }],
  ['/account', () => <AccountPage />, { auth: true }],
  ['/login', () => <AuthPage mode="login" />],
  ['/register', () => <AuthPage mode="register" />],
  ['/admin', () => <AdminPage />, { auth: true }],
];

function resolve(path) {
  for (const [pattern, render, opts = {}] of ROUTES) {
    const params = matchPath(pattern, path);
    if (params) return { render: () => render(params), ...opts };
  }
  return { render: () => <EmptyState title="Page not found" description="The page you’re looking for doesn’t exist." actions={<Button label="Go to the store" href="/" variant="primary" />} headingLevel={1} /> };
}

function RequireAuth({ children }) {
  const { user } = useAuth();
  const { path, search } = useLocation();
  useEffect(() => {
    if (!user) navigate(`/login?next=${encodeURIComponent(path + search)}`, { replace: true });
  }, [user, path, search]);
  return user ? children : null;
}

function SearchBox() {
  const { path, query } = useLocation();
  const [q, setQ] = useState(path === '/phones' ? query.get('q') || '' : '');
  useEffect(() => {
    if (path !== '/phones') setQ('');
  }, [path]);
  const go = () => navigate(q.trim() ? `/phones?q=${encodeURIComponent(q.trim())}` : '/phones');
  return (
    <form role="search" onSubmit={(e) => { e.preventDefault(); go(); }} className="search">
      <TextInput label="Search phones" isLabelHidden startIcon={<Icon icon="search" />} value={q} onChange={setQ} placeholder="Search phones, brands…" hasClear />
    </form>
  );
}

/** True below the given width; follows window resizes. */
function useIsNarrow(px = 720) {
  const query = `(max-width: ${px}px)`;
  const [narrow, setNarrow] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setNarrow(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);
  return narrow;
}

function StoreNav() {
  const { path } = useLocation();
  const { user } = useAuth();
  const { count } = useCart();
  const narrow = useIsNarrow();
  const firstName = user?.name.split(' ')[0];
  const signInHref = path === '/login' || path === '/register' ? '/login' : `/login?next=${encodeURIComponent(path)}`;

  const cartButton = (
    <Button label={count ? `Cart, ${count} item${count === 1 ? '' : 's'}` : 'Cart'} href="/cart" variant="ghost" icon={<Icon icon={ShoppingCart} />} isIconOnly={narrow && !count}>
      {(!narrow || count > 0) && <span className="cart-label">{!narrow && 'Cart'}{count > 0 && <span className="cart-count">{count}</span>}</span>}
    </Button>
  );
  const accountButton = user ? (
    <Button label={`Account (${firstName})`} href="/account" variant="ghost" icon={<Icon icon={User} />} isIconOnly={narrow}>
      {!narrow && firstName}
    </Button>
  ) : (
    <Button label="Sign in" href={signInHref} variant="secondary" size={narrow ? 'sm' : 'md'} />
  );

  if (narrow) {
    // Phones: logo + cart + account on one row, full-width search below.
    return (
      <>
        <TopNav
          heading={<TopNavHeading heading="FlashSale" headingHref="/" logo={<span className="logo" aria-hidden="true">⚡</span>} />}
          endContent={<>{cartButton}{accountButton}</>}
        />
        <div className="mobile-search">
          <SearchBox />
          <nav className="mobile-links" aria-label="Sections">
            <Link href="/phones" color="inherit">Phones</Link>
            {user && <Link href="/orders" color="inherit">Orders</Link>}
            {user?.role === 'admin' && <Link href="/admin" color="inherit">Admin</Link>}
          </nav>
        </div>
      </>
    );
  }

  return (
    <TopNav
      heading={<TopNavHeading heading="FlashSale" headingHref="/" logo={<span className="logo" aria-hidden="true">⚡</span>} />}
      startContent={
        <>
          <TopNavItem label="Phones" href="/phones" isSelected={path.startsWith('/phones')} />
          {user && <TopNavItem label="Orders" href="/orders" isSelected={path.startsWith('/orders')} />}
          {user?.role === 'admin' && <TopNavItem label="Admin" href="/admin" isSelected={path === '/admin'} />}
        </>
      }
      centerContent={<SearchBox />}
      endContent={<>{cartButton}{accountButton}</>}
    />
  );
}

export default function App() {
  const { path } = useLocation();
  useEffect(prefetchRoutes, []);
  const route = resolve(path);
  const page = route.render();
  return (
    <>
      {/* A plain sticky header instead of AppShell keeps the first download small. */}
      <a href="#main" className="skip-link">Skip to content</a>
      <header className="site-header"><StoreNav /></header>
      <main id="main" className="page">
        <Suspense fallback={<VStack gap={3} aria-busy="true" aria-label="Loading"><Skeleton height={32} width="40%" /><Skeleton height={280} index={1} /></VStack>}>
          {route.auth ? <RequireAuth>{page}</RequireAuth> : page}
        </Suspense>
      </main>
      <footer className="footer">
        <Text type="supporting" size="sm">
          FlashSale demo store · <Link href="/phones" color="inherit">All phones</Link> · <Link href="/orders" color="inherit">Orders</Link> · Prices and stock are demo data; payments are simulated.
        </Text>
      </footer>
    </>
  );
}
