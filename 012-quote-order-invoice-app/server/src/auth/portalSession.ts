// FreelanceDesk クライアントポータル：顧客（customers）用の端末セッション。
// 運営者の fd_session とは別の Cookie（fd_portal, Path=/api/portal）で、/api/portal/* でのみ参照する。
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Context } from 'hono';
import type { Queryable } from '../db';
import { one } from '../db';
import { randomToken, sha256 } from './password';
import type { PortalSession, Services } from '../context';

export const PORTAL_COOKIE = 'fd_portal';
const COOKIE_PATH = '/api/portal';

export async function createPortalSession(q: Queryable, s: Services, c: Context, accountId: string, customerId: string, inviteId: string): Promise<void> {
  const token = randomToken(32);
  const expires = new Date(s.now().getTime() + s.config.sessionDays * 86400_000);
  // 同じ端末で別の顧客として入り直した場合に備え、旧セッションは破棄
  const old = getCookie(c, PORTAL_COOKIE);
  if (old && old.length <= 200) await q.query('DELETE FROM portal_sessions WHERE token_hash=$1', [sha256(old)]);
  await q.query('INSERT INTO portal_sessions (token_hash, account_id, customer_id, invite_id, expires_at) VALUES ($1,$2,$3,$4,$5)', [
    sha256(token),
    accountId,
    customerId,
    inviteId,
    expires,
  ]);
  setCookie(c, PORTAL_COOKIE, token, { httpOnly: true, secure: s.config.secureCookies, sameSite: 'Lax', path: COOKIE_PATH, expires });
}

export function clearPortalCookie(c: Context, s: Services) {
  deleteCookie(c, PORTAL_COOKIE, { path: COOKIE_PATH, secure: s.config.secureCookies });
}

export async function readPortalSession(q: Queryable, s: Services, c: Context): Promise<PortalSession | null> {
  const token = getCookie(c, PORTAL_COOKIE);
  if (!token || token.length > 200) return null;
  const hash = sha256(token);
  const row = await one(
    q,
    `SELECT ps.account_id, ps.customer_id, ps.last_seen_at, cu.name, cu.contact_name
     FROM portal_sessions ps
     JOIN customers cu ON cu.account_id = ps.account_id AND cu.id = ps.customer_id
     JOIN accounts a ON a.id = ps.account_id
     WHERE ps.token_hash = $1 AND ps.expires_at > $2 AND (NOT a.is_demo OR a.demo_expires_at > $2)`,
    [hash, s.now()],
  );
  if (!row) return null;
  if (s.now().getTime() - new Date(row.last_seen_at).getTime() > 3600_000) {
    const expires = new Date(s.now().getTime() + s.config.sessionDays * 86400_000);
    await q.query('UPDATE portal_sessions SET last_seen_at=$2, expires_at=$3 WHERE token_hash=$1', [hash, s.now(), expires]);
    setCookie(c, PORTAL_COOKIE, token, { httpOnly: true, secure: s.config.secureCookies, sameSite: 'Lax', path: COOKIE_PATH, expires });
  }
  return { accountId: row.account_id, customerId: row.customer_id, tokenHash: hash, clientName: row.contact_name || row.name };
}
