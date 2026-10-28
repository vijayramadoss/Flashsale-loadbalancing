import { lazy, Suspense } from 'react';
import { Link, navigate, useLocation } from './router.jsx';
import { useAuth } from './auth.jsx';
import SalePage from './pages/SalePage.jsx';
import AuthPage from './pages/AuthPage.jsx';
import OrdersPage from './pages/OrdersPage.jsx';

// The admin dashboard is code-split: buyers never download it.
const AdminPage = lazy(() => import('./pages/AdminPage.jsx'));

export default function App() {
  const { path } = useLocation();
  const { user, logout } = useAuth();

  let page;
  if (path === '/login' || path === '/register') page = <AuthPage mode={path.slice(1)} />;
  else if (path === '/orders') page = <OrdersPage />;
  else if (path === '/admin') page = <AdminPage />;
  else page = <SalePage />;

  return (
    <>
      <header className="topbar">
        <Link to="/" className="brand" aria-label="FlashSale home">
          <span className="brand-mark" aria-hidden="true">⚡</span> FlashSale
        </Link>
        <nav aria-label="Main">
          {user ? (
            <>
              <Link to="/orders">My orders</Link>
              {user.role === 'admin' && <Link to="/admin">Admin</Link>}
              <span className="who" title={user.email}>Hi, {user.name.split(' ')[0]}</span>
              <button
                type="button"
                className="link-btn"
                onClick={() => {
                  logout();
                  navigate('/');
                }}
              >
                Log out
              </button>
            </>
          ) : (
            <>
              <Link to="/login">Log in</Link>
              <Link to="/register" className="btn btn-small">Sign up</Link>
            </>
          )}
        </nav>
      </header>
      <main className="container">
        <Suspense fallback={<p className="muted center">Loading…</p>}>{page}</Suspense>
      </main>
    </>
  );
}
