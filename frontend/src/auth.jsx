import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, setUnauthorizedHandler, tokenStore } from './api.js';

const AuthContext = createContext(null);
const USER_KEY = 'fs.user';

function readUser() {
  try {
    return JSON.parse(localStorage.getItem(USER_KEY) || 'null');
  } catch {
    return null;
  }
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => (tokenStore.get() ? readUser() : null));

  const save = useCallback((token, nextUser) => {
    tokenStore.set(token);
    try {
      nextUser ? localStorage.setItem(USER_KEY, JSON.stringify(nextUser)) : localStorage.removeItem(USER_KEY);
    } catch { /* storage unavailable: session lasts until reload */ }
    setUser(nextUser);
  }, []);

  const logout = useCallback(() => save(null, null), [save]);

  // Any 401 on an authenticated call means the token expired → drop it.
  useEffect(() => setUnauthorizedHandler(logout), [logout]);

  const value = useMemo(
    () => ({
      user,
      login: async (email, password) => {
        const { data } = await api('/auth/login', { method: 'POST', body: { email, password }, auth: false });
        save(data.token, data.user);
        return data.user;
      },
      register: async (name, email, password) => {
        const { data } = await api('/auth/register', { method: 'POST', body: { name, email, password }, auth: false });
        save(data.token, data.user);
        return data.user;
      },
      logout,
    }),
    [user, save, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
