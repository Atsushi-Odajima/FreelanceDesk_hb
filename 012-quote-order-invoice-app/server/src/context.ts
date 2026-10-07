import type { Context } from 'hono';
import type pg from 'pg';
import { z } from 'zod';
import type { AppConfig } from './config';
import { todayIn } from '../../shared/dates';
import { HttpError } from './services/errors';

export interface Deps {
  pool: pg.Pool;
  config: AppConfig;
  /** テスト用に現在時刻を差し替え可能 */
  now?: () => Date;
}

export interface Services extends Deps {
  now: () => Date;
  today: () => string;
}

export type AppEnv = {
  Variables: {
    accountId: string;
    sessionHash: string;
    isDemo: boolean;
    /** クライアントポータル（顧客セッション）。/api/portal/* でのみ設定される */
    portal: PortalSession;
  };
};

export interface PortalSession {
  accountId: string;
  customerId: string;
  tokenHash: string;
  clientName: string;
}

export type AppContext = Context<AppEnv>;

export function makeServices(deps: Deps): Services {
  const now = deps.now ?? (() => new Date());
  return { ...deps, now, today: () => todayIn(deps.config.tz, now()) };
}

/** JSON本文を zod で検証。失敗時は 400 */
export async function body<T extends z.ZodTypeAny>(c: AppContext, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new HttpError(400, 'リクエスト本文がJSONではありません', 'invalid_json');
  }
  const r = schema.safeParse(raw);
  if (!r.success) {
    throw new HttpError(400, formatZodError(r.error), 'validation', r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  }
  return r.data;
}

export function query<T extends z.ZodTypeAny>(c: AppContext, schema: T): z.infer<T> {
  const r = schema.safeParse(c.req.query());
  if (!r.success) throw new HttpError(400, formatZodError(r.error), 'validation');
  return r.data;
}

export function formatZodError(e: z.ZodError): string {
  const first = e.issues[0];
  if (!first) return '入力内容を確認してください';
  const path = first.path.join('.');
  return path ? `入力内容を確認してください（${path}: ${first.message}）` : first.message;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** パスパラメータのUUIDを検証（不正な形式は404扱いにして存在有無を漏らさない） */
export function idParam(c: AppContext, name = 'id'): string {
  const v = c.req.param(name) ?? '';
  if (!UUID_RE.test(v)) throw new HttpError(404, 'データが見つかりません', 'not_found');
  return v.toLowerCase();
}

export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}
