import { Hono } from 'hono';
import crypto from 'node:crypto';
import { type AppEnv, body, type Services } from '../context';
import { many, one, withTx } from '../db';
import {
  burnPasswordCheck,
  generateRecoveryCode,
  hashPassword,
  normalizeCode,
  sha256,
  verifyPassword,
} from '../auth/password';
import { clearSessionCookie, createSession } from '../auth/session';
import { HttpError } from '../services/errors';
import { RateLimiter } from '../services/ratelimit';
import { clientIp } from '../services/ip';
import {
  changePasswordSchema,
  deleteAccountSchema,
  loginSchema,
  passwordConfirmSchema,
  recoverSchema,
  resetTokenSchema,
  signupSchema,
} from '../schemas';
import { seedSampleData } from '../services/sample';

export async function issueRecoveryCodes(q: any, accountId: string): Promise<string[]> {
  await q.query('DELETE FROM recovery_codes WHERE account_id=$1', [accountId]);
  const codes = Array.from({ length: 8 }, generateRecoveryCode);
  for (const code of codes) {
    await q.query('INSERT INTO recovery_codes (account_id, code_hash) VALUES ($1,$2)', [accountId, sha256(normalizeCode(code))]);
  }
  return codes;
}

async function accountPayload(q: any, accountId: string) {
  const a = await one(q, 'SELECT id, email, is_demo, demo_expires_at, created_at FROM accounts WHERE id=$1', [accountId]);
  const b = await one(q, 'SELECT name FROM business_profiles WHERE account_id=$1', [accountId]);
  const rc = await one(q, 'SELECT count(*)::int AS n FROM recovery_codes WHERE account_id=$1 AND used_at IS NULL', [accountId]);
  return {
    id: a.id,
    email: a.email,
    isDemo: a.is_demo,
    demoExpiresAt: a.demo_expires_at,
    businessName: b?.name ?? '',
    recoveryCodesLeft: rc.n,
  };
}

export function authRoutes(s: Services) {
  const r = new Hono<AppEnv>();
  const ipLimiter = new RateLimiter(s.config.relaxRateLimits ? 1000 : 20, 10 * 60_000); // 認証系: 1IP 10分20回
  const emailLimiter = new RateLimiter(s.config.relaxRateLimits ? 1000 : 10, 15 * 60_000); // 1メール 15分10回失敗
  const signupLimiter = new RateLimiter(s.config.relaxRateLimits ? 1000 : 5, 60 * 60_000);

  const limitIp = (c: any, limiter = ipLimiter) => {
    if (!limiter.hit(clientIp(c, s))) throw new HttpError(429, '試行回数が多すぎます。しばらく待ってから再度お試しください', 'rate_limited');
  };

  r.get('/config', (c) => c.json({ signupCodeRequired: s.config.signupCodeRequired, demoEnabled: s.config.demoEnabled }));

  r.post('/signup', async (c) => {
    limitIp(c, signupLimiter);
    const input = await body(c, signupSchema);
    const result = await withTx(s.pool, async (tx) => {
      if (s.config.signupCodeRequired) {
        const code = normalizeCode(input.signupCode ?? '');
        const row = await one(tx, 'SELECT code_hash FROM signup_codes WHERE code_hash=$1 AND used_at IS NULL FOR UPDATE', [sha256(code)]);
        if (!code || !row) throw new HttpError(400, '購入者コードが正しくないか、使用済みです', 'invalid_signup_code');
      }
      const exists = await one(tx, 'SELECT id FROM accounts WHERE lower(email)=lower($1)', [input.email]);
      if (exists) throw new HttpError(409, 'このメールアドレスはすでに登録されています', 'email_taken');
      const hash = await hashPassword(input.password);
      const a = await tx.query('INSERT INTO accounts (email, password_hash) VALUES ($1,$2) RETURNING id', [input.email, hash]);
      const accountId = a.rows[0].id as string;
      await tx.query('INSERT INTO business_profiles (account_id, name, email) VALUES ($1,$2,$3)', [accountId, input.businessName ?? '', input.email]);
      if (s.config.signupCodeRequired) {
        await tx.query('UPDATE signup_codes SET used_at=now(), used_by=$2 WHERE code_hash=$1', [sha256(normalizeCode(input.signupCode ?? '')), accountId]);
      }
      const codes = await issueRecoveryCodes(tx, accountId);
      await createSession(tx, s, c, accountId);
      return { accountId, codes };
    });
    return c.json({ account: await accountPayload(s.pool, result.accountId), recoveryCodes: result.codes }, 201);
  });

  r.post('/login', async (c) => {
    limitIp(c);
    const input = await body(c, loginSchema);
    if (!emailLimiter.hit(input.email)) throw new HttpError(429, '試行回数が多すぎます。しばらく待ってから再度お試しください', 'rate_limited');
    const a = await one(s.pool, 'SELECT id, password_hash FROM accounts WHERE lower(email)=lower($1)', [input.email]);
    if (!a) {
      await burnPasswordCheck(input.password);
      throw new HttpError(401, 'メールアドレスまたはパスワードが正しくありません', 'invalid_credentials');
    }
    if (!(await verifyPassword(input.password, a.password_hash))) {
      throw new HttpError(401, 'メールアドレスまたはパスワードが正しくありません', 'invalid_credentials');
    }
    emailLimiter.reset(input.email);
    await createSession(s.pool, s, c, a.id);
    return c.json({ account: await accountPayload(s.pool, a.id) });
  });

  r.post('/logout', async (c) => {
    await s.pool.query('DELETE FROM sessions WHERE token_hash=$1', [c.get('sessionHash')]);
    clearSessionCookie(c, s);
    return c.json({ ok: true });
  });

  r.get('/me', async (c) => c.json({ account: await accountPayload(s.pool, c.get('accountId')) }));

  // 復旧コードでパスワード再設定（メール送信なしで復旧可能）
  r.post('/recover', async (c) => {
    limitIp(c);
    const input = await body(c, recoverSchema);
    if (!emailLimiter.hit(`recover:${input.email}`)) throw new HttpError(429, '試行回数が多すぎます。しばらく待ってから再度お試しください', 'rate_limited');
    const accountId = await withTx(s.pool, async (tx) => {
      const a = await one(tx, 'SELECT id FROM accounts WHERE lower(email)=lower($1) FOR UPDATE', [input.email]);
      const codeHash = sha256(normalizeCode(input.recoveryCode));
      const code = a
        ? await one(tx, 'SELECT id FROM recovery_codes WHERE account_id=$1 AND code_hash=$2 AND used_at IS NULL FOR UPDATE', [a.id, codeHash])
        : null;
      if (!a || !code) throw new HttpError(400, 'メールアドレスまたは復旧コードが正しくありません', 'invalid_recovery');
      await tx.query('UPDATE recovery_codes SET used_at=now() WHERE id=$1', [code.id]);
      await tx.query('UPDATE accounts SET password_hash=$2, updated_at=now() WHERE id=$1', [a.id, await hashPassword(input.newPassword)]);
      await tx.query('DELETE FROM sessions WHERE account_id=$1', [a.id]);
      await createSession(tx, s, c, a.id);
      return a.id as string;
    });
    return c.json({ account: await accountPayload(s.pool, accountId) });
  });

  // 運営者が発行した再設定トークンでパスワード再設定（npm run account:reset-link）
  r.post('/reset', async (c) => {
    limitIp(c);
    const input = await body(c, resetTokenSchema);
    const accountId = await withTx(s.pool, async (tx) => {
      const t = await one(tx, 'SELECT * FROM password_reset_tokens WHERE token_hash=$1 AND used_at IS NULL AND expires_at > $2 FOR UPDATE', [
        sha256(input.token),
        s.now(),
      ]);
      if (!t) throw new HttpError(400, '再設定リンクが無効か期限切れです', 'invalid_reset_token');
      await tx.query('UPDATE password_reset_tokens SET used_at=now() WHERE token_hash=$1', [t.token_hash]);
      await tx.query('UPDATE accounts SET password_hash=$2, updated_at=now() WHERE id=$1', [t.account_id, await hashPassword(input.newPassword)]);
      await tx.query('DELETE FROM sessions WHERE account_id=$1', [t.account_id]);
      await createSession(tx, s, c, t.account_id);
      return t.account_id as string;
    });
    return c.json({ account: await accountPayload(s.pool, accountId) });
  });

  r.post('/password', async (c) => {
    const input = await body(c, changePasswordSchema);
    const a = await one(s.pool, 'SELECT password_hash, is_demo FROM accounts WHERE id=$1', [c.get('accountId')]);
    if (a.is_demo) throw new HttpError(403, 'デモアカウントではパスワードを変更できません', 'demo');
    if (!(await verifyPassword(input.currentPassword, a.password_hash))) throw new HttpError(400, '現在のパスワードが正しくありません', 'invalid_password');
    await s.pool.query('UPDATE accounts SET password_hash=$2, updated_at=now() WHERE id=$1', [c.get('accountId'), await hashPassword(input.newPassword)]);
    // 他端末のセッションを無効化
    await s.pool.query('DELETE FROM sessions WHERE account_id=$1 AND token_hash <> $2', [c.get('accountId'), c.get('sessionHash')]);
    return c.json({ ok: true });
  });

  r.post('/recovery-codes', async (c) => {
    const input = await body(c, passwordConfirmSchema);
    const a = await one(s.pool, 'SELECT password_hash FROM accounts WHERE id=$1', [c.get('accountId')]);
    if (!(await verifyPassword(input.password, a.password_hash))) throw new HttpError(400, 'パスワードが正しくありません', 'invalid_password');
    const codes = await withTx(s.pool, (tx) => issueRecoveryCodes(tx, c.get('accountId')));
    return c.json({ recoveryCodes: codes });
  });

  r.post('/logout-all', async (c) => {
    await s.pool.query('DELETE FROM sessions WHERE account_id=$1', [c.get('accountId')]);
    clearSessionCookie(c, s);
    return c.json({ ok: true });
  });

  // アカウント削除（全データを削除。事前にバックアップを推奨）
  r.post('/delete-account', async (c) => {
    const input = await body(c, deleteAccountSchema);
    const accountId = c.get('accountId');
    const a = await one(s.pool, 'SELECT password_hash FROM accounts WHERE id=$1', [accountId]);
    if (!(await verifyPassword(input.password, a.password_hash))) throw new HttpError(400, 'パスワードが正しくありません', 'invalid_password');
    await deleteAccount(s, accountId);
    clearSessionCookie(c, s);
    return c.json({ ok: true });
  });

  // お試し（デモ）：架空データ入りの一時アカウントを作成。本番アカウントとは完全に別
  r.post('/demo', async (c) => {
    if (!s.config.demoEnabled) throw new HttpError(404, 'デモは無効です', 'not_found');
    limitIp(c, signupLimiter);
    await purgeExpiredDemos(s);
    const accountId = await withTx(s.pool, async (tx) => {
      const email = `demo-${crypto.randomUUID()}@demo.invalid`;
      const a = await tx.query('INSERT INTO accounts (email, password_hash, is_demo, demo_expires_at) VALUES ($1,$2,true,$3) RETURNING id', [
        email,
        await hashPassword(crypto.randomUUID()),
        new Date(s.now().getTime() + s.config.demoTtlHours * 3600_000),
      ]);
      const id = a.rows[0].id as string;
      await tx.query('INSERT INTO business_profiles (account_id) VALUES ($1)', [id]);
      await seedSampleData(tx, s, id);
      await createSession(tx, s, c, id);
      return id;
    });
    return c.json({ account: await accountPayload(s.pool, accountId) }, 201);
  });

  return r;
}

export async function deleteAccount(s: Services, accountId: string) {
  await withTx(s.pool, async (tx) => {
    // 循環参照を避けるため、関連の深い順に削除
    await tx.query('DELETE FROM payment_allocations WHERE account_id=$1', [accountId]);
    await tx.query('DELETE FROM payments WHERE account_id=$1', [accountId]);
    await tx.query('DELETE FROM invoices WHERE account_id=$1', [accountId]);
    await tx.query('DELETE FROM attachments WHERE account_id=$1', [accountId]);
    await tx.query('DELETE FROM deliveries WHERE account_id=$1', [accountId]);
    await tx.query('DELETE FROM orders WHERE account_id=$1', [accountId]);
    await tx.query('DELETE FROM projects WHERE account_id=$1', [accountId]);
    await tx.query('DELETE FROM accounts WHERE id=$1', [accountId]);
  });
}

export async function purgeExpiredDemos(s: Services) {
  const rows = await many(s.pool, 'SELECT id FROM accounts WHERE is_demo AND demo_expires_at < $1 LIMIT 20', [s.now()]);
  for (const r of rows) await deleteAccount(s, r.id);
}
