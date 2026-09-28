import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { Client, makeApp, pool, rid, setupInvoice, signup } from '../helpers';
import { normalizeCode, randomToken, sha256 } from '../../server/src/auth/password';

describe('ロゴ・パスワード再設定リンク', () => {
  it('ロゴを設定すると以後の確定書類PDFに埋め込まれ、ロゴ変更後も過去書類は旧ロゴのまま', async () => {
    const { client: c } = await signup();
    const png = fs.readFileSync('client/public/icons/icon-192.png');
    const fd = new FormData();
    fd.append('file', new File([png], 'logo.png'));
    fd.append('purpose', 'logo');
    const up = await c.json('POST', '/api/attachments', fd);
    expect(up._status).toBe(201);
    const a = await setupInvoice(c);
    const pdf = new Uint8Array(await (await c.req('GET', `/api/pdf/invoice-versions/${a.invoiceVersionId}`)).arrayBuffer());
    expect(Buffer.from(pdf).toString('latin1')).toContain('/Subtype /Image');
    // ロゴを外しても、確定済みPDFの参照ロゴは削除されない
    await c.del(`/api/attachments/${up.attachment.id}`);
    const pdf2 = new Uint8Array(await (await c.req('GET', `/api/pdf/invoice-versions/${a.invoiceVersionId}`)).arrayBuffer());
    expect(Buffer.from(pdf2).toString('latin1')).toContain('/Subtype /Image');
    // SVG等はロゴに使えない
    const fd2 = new FormData();
    fd2.append('file', new File(['<svg/>'], 'x.svg'));
    fd2.append('purpose', 'logo');
    expect((await c.json('POST', '/api/attachments', fd2))._status).toBe(415);
  });

  it('運営者発行の再設定リンク：1回限り・期限付き', async () => {
    const { email, account } = await signup();
    const token = randomToken(32);
    await pool.query("INSERT INTO password_reset_tokens (token_hash, account_id, expires_at) VALUES ($1,$2, now() + interval '1 hour')", [sha256(token), account.id]);
    const c = new Client();
    await c.post('/api/auth/reset', { token, newPassword: 'reset-pass-12345' }, 200);
    expect((await new Client().post('/api/auth/reset', { token, newPassword: 'again-pass-12345' }))._status).toBe(400);
    await new Client().post('/api/auth/login', { email, password: 'reset-pass-12345' }, 200);
    const expired = randomToken(32);
    await pool.query("INSERT INTO password_reset_tokens (token_hash, account_id, expires_at) VALUES ($1,$2, now() - interval '1 minute')", [sha256(expired), account.id]);
    expect((await new Client().post('/api/auth/reset', { token: expired, newPassword: 'expired-pass-123' }))._status).toBe(400);
  });

  it('期限切れデモアカウントは削除される', async () => {
    const demo = new Client();
    const r = await demo.post('/api/auth/demo', {}, 201);
    await pool.query("UPDATE accounts SET demo_expires_at = now() - interval '1 hour' WHERE id=$1", [r.account.id]);
    await new Client().post('/api/auth/demo', {}, 201); // 作成時に期限切れを掃除
    const n = await pool.query('SELECT count(*)::int AS n FROM projects WHERE account_id=$1', [r.account.id]);
    expect(n.rows[0].n).toBe(0);
    expect((await demo.get('/api/auth/me', 401))._status).toBe(401);
  });

  it('ログにパスワード・トークン・本文を出さない（リクエストログはメソッド・パス・状態のみ）', async () => {
    const src = fs.readFileSync('server/src/app.ts', 'utf8');
    expect(src).toMatch(/console\.log\(`\$\{c\.req\.method\} \$\{c\.req\.path\} \$\{c\.res\.status\}/);
    expect(rid()).toBeTruthy();
  });

  it('購入者コード：1回だけ使える', async () => {
    const code = `FD-${rid().slice(-8).toUpperCase()}-TEST`;
    await pool.query('INSERT INTO signup_codes (code_hash) VALUES ($1)', [sha256(normalizeCode(code))]);
    const strict = makeApp({ signupCodeRequired: true });
    const ok = await new Client(strict).post('/api/auth/signup', { email: `${rid()}@example.com`, password: 'password-1234', signupCode: code.toLowerCase() });
    expect(ok._status).toBe(201);
    const ng = await new Client(strict).post('/api/auth/signup', { email: `${rid()}@example.com`, password: 'password-1234', signupCode: code });
    expect(ng._status).toBe(400);
  });
});
