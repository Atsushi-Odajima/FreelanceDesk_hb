import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Context } from 'hono';
import type { Queryable } from '../db';
import { one } from '../db';
import { randomToken, sha256 } from './password';
import type { Services } from '../context';

export const SESSION_COOKIE = 'fd_session';

export async function createSession(q: Queryable, s: Services, c: Context, accountId: string): Promise<void> {
  const token = randomToken(32);
  const expires = new Date(s.now().getTime() + s.config.sessionDays * 86400_000);
  await q.query('INSERT INTO sessions (token_hash, account_id, expires_at) VALUES ($1, $2, $3)', [sha256(token), accountId, expires]);
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: s.config.secureCookies,
    sameSite: 'Lax',
    path: '/',
    expires,
  });
}

export function clearSessionCookie(c: Context, s: Services) {
  deleteCookie(c, SESSION_COOKIE, { path: '/', secure: s.config.secureCookies });
}

export interface SessionInfo {
  accountId: string;
  tokenHash: string;
  isDemo: boolean;
}

export async function readSession(q: Queryable, s: Services, c: Context): Promise<SessionInfo | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token || token.length > 200) return null;
  const hash = sha256(token);
  const row = await one<{ account_id: string; last_seen_at: Date; is_demo: boolean }>(
    q,
    `SELECT s.account_id, s.last_seen_at, a.is_demo FROM sessions s JOIN accounts a ON a.id = s.account_id
     WHERE s.token_hash = $1 AND s.expires_at > $2 AND (NOT a.is_demo OR a.demo_expires_at > $2)`,
    [hash, s.now()],
  );
  if (!row) return null;
  // 1時間ごとに最終利用と有効期限を更新（スライディング）
  if (s.now().getTime() - new Date(row.last_seen_at).getTime() > 3600_000) {
    const expires = new Date(s.now().getTime() + s.config.sessionDays * 86400_000);
    await q.query('UPDATE sessions SET last_seen_at = $2, expires_at = $3 WHERE token_hash = $1', [hash, s.now(), expires]);
    setCookie(c, SESSION_COOKIE, token, { httpOnly: true, secure: s.config.secureCookies, sameSite: 'Lax', path: '/', expires });
  }
  return { accountId: row.account_id, tokenHash: hash, isDemo: row.is_demo };
}
