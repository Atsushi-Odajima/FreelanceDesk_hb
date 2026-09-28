import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { ApiError, get, post, setUnauthorizedHandler } from './api';
import { clearAllDrafts } from './hooks';

export interface Account {
  id: string;
  email: string;
  isDemo: boolean;
  demoExpiresAt: string | null;
  businessName: string;
  recoveryCodesLeft: number;
}

interface AuthState {
  account: Account | null;
  loading: boolean;
  setAccount: (a: Account | null) => void;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const Ctx = createContext<AuthState>(null as unknown as AuthState);

/** 端末に残る閲覧キャッシュ・下書きを消す（ログアウト時・アカウント切替時） */
const ACCOUNT_KEY = 'fd-account';

export async function clearLocalData() {
  clearAllDrafts();
  try {
    localStorage.removeItem(ACCOUNT_KEY);
  } catch {
    /* noop */
  }
  try {
    navigator.serviceWorker?.controller?.postMessage('clear-api-cache');
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.endsWith('-api')).map((k) => caches.delete(k)));
    }
  } catch {
    /* noop */
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [account, setAccountState] = useState<Account | null>(null);
  const [loading, setLoading] = useState(true);

  const setAccount = useCallback((a: Account | null) => {
    try {
      if (a) localStorage.setItem(ACCOUNT_KEY, JSON.stringify(a));
    } catch {
      /* noop */
    }
    setAccountState((prev) => {
      if (prev && a && prev.id !== a.id) void clearLocalData();
      return a;
    });
  }, []);

  const refresh = useCallback(async () => {
    try {
      const r = await get<{ account: Account }>('/api/auth/me');
      setAccount(r.account);
    } catch (e) {
      // 通信できない（オフライン）ときは、前回のログイン情報で閲覧キャッシュを表示する
      let cached: Account | null = null;
      if (e instanceof ApiError && (e.status === 0 || e.status === 503)) {
        try {
          cached = JSON.parse(localStorage.getItem(ACCOUNT_KEY) ?? 'null');
        } catch {
          cached = null;
        }
      }
      setAccountState(cached);
    } finally {
      setLoading(false);
    }
  }, [setAccount]);

  useEffect(() => {
    setUnauthorizedHandler(() => setAccountState(null));
    void refresh();
  }, [refresh]);

  const logout = useCallback(async () => {
    try {
      await post('/api/auth/logout');
    } finally {
      await clearLocalData();
      setAccountState(null);
    }
  }, []);

  return <Ctx.Provider value={{ account, loading, setAccount, refresh, logout }}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);
