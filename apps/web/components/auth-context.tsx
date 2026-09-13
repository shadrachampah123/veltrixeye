'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import type { UserDto } from '@veltrixeye/contracts';
import { api } from '@/lib/api';
import { Spinner } from '@/components/ui';

interface AuthContextValue {
  user: UserDto | null;
  loading: boolean;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = React.createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = React.useState<UserDto | null>(null);
  const [loading, setLoading] = React.useState(true);

  const refresh = React.useCallback(async () => {
    try {
      const { user: u } = await api.me();
      setUser(u);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const logout = React.useCallback(async () => {
    try {
      await api.logout();
    } catch {
      // redirect regardless of API outcome
    }
    setUser(null);
  }, []);

  const value = React.useMemo(
    () => ({ user, loading, refresh, logout }),
    [user, loading, refresh, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = React.useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}

/** Client-side guard: redirects to /login when there is no valid session. */
export function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const router = useRouter();
  React.useEffect(() => {
    if (!loading && !user) router.replace('/login');
  }, [loading, user, router]);
  if (loading) return <Spinner />;
  if (!user) return null;
  return <>{children}</>;
}
