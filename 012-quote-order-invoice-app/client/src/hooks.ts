import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ApiError, errorMessage, get, newRequestId } from './api';

export function useApi<T = any>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const load = useCallback(async () => {
    if (!path) return;
    const n = ++seq.current;
    setLoading(true);
    try {
      const d = await get<T>(path);
      if (n === seq.current) {
        setData(d);
        setError(null);
        setStatus(200);
      }
    } catch (e) {
      if (n === seq.current) {
        setError(errorMessage(e));
        setStatus(e instanceof ApiError ? e.status : 0);
      }
    } finally {
      if (n === seq.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, ...deps]);
  useEffect(() => {
    void load();
  }, [load]);
  return { data, error, loading, status, reload: load, setData };
}

function subscribeMq(q: string) {
  return (cb: () => void) => {
    const m = window.matchMedia(q);
    m.addEventListener('change', cb);
    return () => m.removeEventListener('change', cb);
  };
}
export function useMedia(q: string): boolean {
  return useSyncExternalStore(subscribeMq(q), () => window.matchMedia(q).matches, () => false);
}
export const useIsMobile = () => useMedia('(max-width: 767px)');
export const useIsWide = () => useMedia('(min-width: 1100px)');

export function useOnline(): boolean {
  return useSyncExternalStore(
    (cb) => {
      window.addEventListener('online', cb);
      window.addEventListener('offline', cb);
      return () => {
        window.removeEventListener('online', cb);
        window.removeEventListener('offline', cb);
      };
    },
    () => navigator.onLine,
    () => true,
  );
}

// ---- 端末下書き（localStorage）。「端末下書き」と「サーバー保存済み」を区別して表示する ----
const DRAFT_PREFIX = 'fd-draft:';

export interface LocalDraft<T> {
  value: T;
  savedAt: string;
  requestId: string;
}

export function readDraft<T>(key: string): LocalDraft<T> | null {
  try {
    const raw = localStorage.getItem(DRAFT_PREFIX + key);
    return raw ? (JSON.parse(raw) as LocalDraft<T>) : null;
  } catch {
    return null;
  }
}
export function writeDraft<T>(key: string, value: T, requestId: string) {
  try {
    localStorage.setItem(DRAFT_PREFIX + key, JSON.stringify({ value, savedAt: new Date().toISOString(), requestId }));
  } catch {
    /* 容量超過などは無視 */
  }
}
export function clearDraft(key: string) {
  try {
    localStorage.removeItem(DRAFT_PREFIX + key);
  } catch {
    /* noop */
  }
}
export function clearAllDrafts() {
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith(DRAFT_PREFIX)) localStorage.removeItem(k);
  } catch {
    /* noop */
  }
}

/** 同じ操作の再送で二重登録しないための requestId（成功までは同じ値を使う） */
export function useRequestId(initial?: string) {
  const [id, setId] = useState(() => initial ?? newRequestId());
  return { requestId: id, renew: () => setId(newRequestId()), set: setId };
}
