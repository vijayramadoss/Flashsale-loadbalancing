import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Theme } from '@astryxdesign/core/theme';
import { LinkProvider } from '@astryxdesign/core/Link';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import './styles.css';
import { AppLink } from './router.jsx';
import { AuthProvider } from './auth.jsx';
import { CartProvider } from './cart.jsx';
import App from './App.jsx';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Theme theme={neutralTheme} mode="system">
      <LinkProvider component={AppLink}>
        {/* No ToastViewport: useToast() mounts its own viewport on first use, so the toast code loads lazily. */}
        <AuthProvider>
          <CartProvider>
            <App />
          </CartProvider>
        </AuthProvider>
      </LinkProvider>
    </Theme>
  </StrictMode>,
);
