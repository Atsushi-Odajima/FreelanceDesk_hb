// API クライアント：CSRF用ヘッダ、エラー整形、オフライン判定
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const OFFLINE_MESSAGE = 'オフラインのため保存できません。通信が戻ってから、もう一度「保存」してください（入力内容はこの端末に下書きとして残っています）。';

type Listener = (offlineData: boolean) => void;
const offlineListeners = new Set<Listener>();
export function onOfflineData(fn: Listener) {
  offlineListeners.add(fn);
  return () => offlineListeners.delete(fn);
}

let unauthorizedHandler: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void) {
  unauthorizedHandler = fn;
}

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const isForm = body instanceof FormData;
  if (method !== 'GET' && typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new ApiError(0, OFFLINE_MESSAGE, 'offline');
  }
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: {
        'X-Requested-With': 'FreelanceDesk',
        ...(body !== undefined && !isForm ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, method === 'GET' ? '通信できませんでした。電波状況を確認してください。' : OFFLINE_MESSAGE, 'network');
  }
  if (method === 'GET' && path.startsWith('/api/')) {
    const off = res.headers.get('x-fd-offline') === '1';
    offlineListeners.forEach((l) => l(off));
  }
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    if (res.status === 401 && unauthorizedHandler && !path.startsWith('/api/auth/login')) unauthorizedHandler();
    throw new ApiError(res.status, data?.error?.message ?? `エラーが発生しました（${res.status}）`, data?.error?.code, data?.error?.details);
  }
  return data as T;
}

export const get = <T = any>(p: string) => api<T>('GET', p);
export const post = <T = any>(p: string, b: unknown = {}) => api<T>('POST', p, b);
export const put = <T = any>(p: string, b: unknown) => api<T>('PUT', p, b);
export const patch = <T = any>(p: string, b: unknown) => api<T>('PATCH', p, b);
export const del = <T = any>(p: string) => api<T>('DELETE', p);

export function newRequestId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return `r-${crypto.randomUUID()}`;
  return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

/** バイナリ取得（PDF等） */
export async function fetchBlob(path: string): Promise<Blob> {
  const res = await fetch(path, { credentials: 'same-origin' });
  if (!res.ok) {
    let msg = `取得できませんでした（${res.status}）`;
    try {
      msg = (await res.json()).error.message;
    } catch {
      /* noop */
    }
    throw new ApiError(res.status, msg);
  }
  return res.blob();
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return 'エラーが発生しました';
}
