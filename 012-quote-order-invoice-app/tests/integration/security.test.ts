// 認証・認可・ユーザー間のデータ分離・CSRF・アップロード
import { describe, expect, it } from 'vitest';
import { app, Client, customerInput, rid, setupInvoice, signup, makeApp } from '../helpers';

async function upload(c: Client, projectId: string, name: string, bytes: Uint8Array, purpose = 'project') {
  const fd = new FormData();
  fd.append('file', new File([bytes], name));
  fd.append('purpose', purpose);
  fd.append('projectId', projectId);
  fd.append('requestId', rid());
  return c.json('POST', '/api/attachments', fd);
}
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

describe('認証', () => {
  it('未ログインは401', async () => {
    const c = new Client();
    expect((await c.get('/api/projects', 401))._status).toBe(401);
  });

  it('登録→ログアウト→ログイン→誤パスワード', async () => {
    const { client, email, password } = await signup();
    await client.post('/api/auth/logout', {}, 200);
    expect((await client.get('/api/auth/me', 401))._status).toBe(401);
    const c2 = new Client();
    expect((await c2.post('/api/auth/login', { email, password: 'wrong-password' }))._status).toBe(401);
    await c2.post('/api/auth/login', { email: email.toUpperCase(), password }, 200);
    const me = await c2.get('/api/auth/me');
    expect(me.account.email).toBe(email);
  });

  it('同じメールで二重登録不可・短いパスワード拒否', async () => {
    const { email } = await signup();
    const c = new Client();
    expect((await c.post('/api/auth/signup', { email, password: 'password-1234' }))._status).toBe(409);
    expect((await c.post('/api/auth/signup', { email: 'x' + email, password: 'short' }))._status).toBe(400);
  });

  it('復旧コードでパスワード再設定（1回限り・他セッション失効）', async () => {
    const { client, email, recoveryCodes } = await signup();
    expect(recoveryCodes).toHaveLength(8);
    const c = new Client();
    await c.post('/api/auth/recover', { email, recoveryCode: recoveryCodes[0].toLowerCase(), newPassword: 'new-password-999' }, 200);
    expect((await client.get('/api/auth/me', 401))._status).toBe(401); // 旧セッション失効
    const again = await new Client().post('/api/auth/recover', { email, recoveryCode: recoveryCodes[0], newPassword: 'another-pass-000' });
    expect(again._status).toBe(400);
    await new Client().post('/api/auth/login', { email, password: 'new-password-999' }, 200);
    const me = await c.get('/api/auth/me');
    expect(me.account.recoveryCodesLeft).toBe(7);
  });

  it('パスワード変更で他端末のセッションを失効', async () => {
    const { client: a, email, password } = await signup();
    const b = new Client();
    await b.post('/api/auth/login', { email, password }, 200);
    await a.post('/api/auth/password', { currentPassword: password, newPassword: 'changed-pass-123' }, 200);
    expect((await b.get('/api/auth/me', 401))._status).toBe(401);
    expect((await a.get('/api/auth/me'))._status).toBe(200);
  });

  it('購入者コード必須設定', async () => {
    const strict = makeApp({ signupCodeRequired: true });
    const c = new Client(strict);
    const r = await c.post('/api/auth/signup', { email: `${rid()}@example.com`, password: 'password-1234' });
    expect(r._status).toBe(400);
    expect(r.error.code).toBe('invalid_signup_code');
  });

  it('アカウント削除：全データ削除・ログイン不可', async () => {
    const { client, email, password } = await signup();
    await setupInvoice(client);
    expect((await client.post('/api/auth/delete-account', { password, confirm: 'ちがう' }))._status).toBe(400);
    await client.post('/api/auth/delete-account', { password, confirm: '削除します' }, 200);
    expect((await new Client().post('/api/auth/login', { email, password }))._status).toBe(401);
  });

  it('セッションCookieは HttpOnly・SameSite=Lax', async () => {
    const res = await app.request('/api/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'FreelanceDesk' },
      body: JSON.stringify({ email: `${rid()}@example.com`, password: 'password-1234' }),
    });
    const cookie = res.headers.get('set-cookie')!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
  });
});

describe('CSRF対策', () => {
  it('独自ヘッダなしの更新系リクエストを拒否', async () => {
    const { client } = await signup();
    const res = await app.request('/api/customers', {
      method: 'POST',
      headers: { cookie: client.cookie, 'content-type': 'application/json' },
      body: JSON.stringify(customerInput()),
    });
    expect(res.status).toBe(403);
  });
  it('別オリジンからのリクエストを拒否', async () => {
    const { client } = await signup();
    const res = await app.request('http://localhost/api/customers', {
      method: 'POST',
      headers: { cookie: client.cookie, 'content-type': 'application/json', 'x-requested-with': 'FreelanceDesk', origin: 'https://evil.example', host: 'localhost' },
      body: JSON.stringify(customerInput()),
    });
    expect(res.status).toBe(403);
  });
});

describe('ユーザー間のデータ分離（ID書換え）', () => {
  it('ユーザーBはAの顧客・案件・見積・請求・入金・添付・PDFにアクセスできない', async () => {
    const A = await signup();
    const B = await signup();
    const a = await setupInvoice(A.client, 100000);
    const pay = await A.client.post(`/api/invoices/${a.invoiceId}/payments`, { requestId: rid(), receivedOn: '2026-09-25', amount: 1000, method: 'cash', payerName: '', memo: '' }, 201);
    const att = await upload(A.client, a.projectId, 'logo.png', PNG);
    expect(att._status).toBe(201);
    const b = B.client;
    const paths = [
      `/api/customers/${a.customerId}`,
      `/api/projects/${a.projectId}`,
      `/api/quote-versions/${a.versionId}`,
      `/api/invoices/${a.invoiceId}`,
      `/api/invoice-versions/${a.invoiceVersionId}`,
      `/api/attachments/${att.attachment.id}`,
      `/api/pdf/quote-versions/${a.versionId}`,
      `/api/pdf/invoice-versions/${a.invoiceVersionId}`,
      `/api/payments/${pay.payment.id}/candidates`,
    ];
    for (const p of paths) {
      const r = await b.req('GET', p);
      expect(r.status, p).toBe(404);
    }
    // 更新・削除系
    expect((await b.put(`/api/customers/${a.customerId}`, customerInput(), 404))._status).toBe(404);
    expect((await b.post(`/api/projects/${a.projectId}/status`, { status: 'cancelled' }))._status).toBe(404);
    expect((await b.post(`/api/projects/${a.projectId}/quotes`, { requestId: rid() }))._status).toBe(404);
    expect((await b.post(`/api/projects/${a.projectId}/invoices`, { requestId: rid() }))._status).toBe(404);
    expect((await b.post(`/api/invoices/${a.invoiceId}/payments`, { requestId: rid(), receivedOn: '2026-09-25', amount: 1, method: 'cash', payerName: '', memo: '' }))._status).toBe(404);
    expect((await b.del(`/api/attachments/${att.attachment.id}`, 404))._status).toBe(404);
    expect((await b.del(`/api/payments/${pay.payment.id}`, 404))._status).toBe(404);
    // Bの顧客にAの案件IDを紐づけられない／Aの請求にBの入金を割り当てられない
    const bp = await b.post('/api/payments', { requestId: rid(), receivedOn: '2026-09-25', amount: 5000, method: 'cash', payerName: '', memo: '' }, 201);
    expect((await b.post(`/api/payments/${bp.payment.id}/allocations`, { requestId: rid(), invoiceId: a.invoiceId, amount: 100 }))._status).toBe(404);
    const bc = await b.post('/api/customers', customerInput(), 201);
    expect((await b.post('/api/projects', { requestId: rid(), customerId: a.customerId, title: 'x', inquiryDate: null, plannedStart: null, plannedDue: null, internalMemo: '' }))._status).toBe(404);
    expect(bc.customer.id).toBeTruthy();
    // 添付アップロード先にAの案件を指定できない
    expect((await upload(b, a.projectId, 'x.png', PNG))._status).toBe(404);
    // 一覧・検索・ダッシュボードにAのデータが出ない
    expect((await b.get('/api/projects')).projects).toHaveLength(0);
    expect((await b.get('/api/invoices')).invoices).toHaveLength(0);
    expect((await b.get(`/api/search?q=${encodeURIComponent('Sample')}`)).projects).toHaveLength(0);
    // Aは引き続き正常
    expect((await A.client.get(`/api/projects/${a.projectId}`))._status).toBe(200);
  });

  it('不正な形式のIDは404（SQLに渡さない）', async () => {
    const { client } = await signup();
    for (const p of ["/api/projects/1%20OR%201=1", "/api/projects/'--", '/api/invoices/abc']) {
      expect((await client.req('GET', p)).status).toBe(404);
    }
  });
});

describe('添付アップロード検証', () => {
  it('許可形式は保存、実行ファイル・偽装・過大サイズは拒否、配信は所有者のみ', async () => {
    const { client: c } = await signup();
    const { projectId } = await setupInvoice(c);
    const ok = await upload(c, projectId, '写真.png', PNG);
    expect(ok._status).toBe(201);
    expect(ok.attachment.mime).toBe('image/png');
    const res = await c.req('GET', `/api/attachments/${ok.attachment.id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toMatch(/attachment/);
    expect(res.headers.get('cache-control')).toMatch(/no-store/);
    expect((await upload(c, projectId, 'virus.exe', new Uint8Array([0x4d, 0x5a])))._status).toBe(415);
    expect((await upload(c, projectId, 'photo.jpg', new Uint8Array([0x4d, 0x5a, 0x90])))._status).toBe(415);
    expect((await upload(c, projectId, 'page.html', new TextEncoder().encode('<script>alert(1)</script>')))._status).toBe(415);
    const small = makeApp({ uploadMaxBytes: 1000 });
    const c2 = new Client(small);
    c2.cookie = c.cookie;
    expect((await upload(c2, projectId, 'big.png', new Uint8Array(5000).fill(1).map((v, i) => (i < 8 ? PNG[i] : v))))._status).toBe(413);
  });

  it('容量上限（アカウント単位）', async () => {
    const { client: c } = await signup();
    const { projectId } = await setupInvoice(c);
    const tight = new Client(makeApp({ accountStorageQuotaBytes: 20 }));
    tight.cookie = c.cookie;
    expect((await upload(tight, projectId, 'a.png', PNG))._status).toBe(201);
    expect((await upload(tight, projectId, 'b.png', PNG))._status).toBe(413);
  });
});
