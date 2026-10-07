/**
 * FreelanceDesk クライアントポータル（Client Portal から統合）
 *  招待リンクのライフサイクル / 認可（他アカウント・他案件は 404）/ 承認（最新版のみ・冪等）/ 修正依頼 /
 *  FreelanceDesk 修正指示（指示書）/ 納品の公開 / FreelanceDesk 写真セレクト / 状態連携 / バックアップ
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { strFromU8, unzipSync } from 'fflate';
import { app, Client, customerInput, makeApp, rid, setNow, setupOrdered, setupProject, signup } from '../helpers';

/** 顧客（ポータル）用クライアント：fd_portal Cookie を保持 */
class PortalClient extends Client {
  async req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await super.req(method, path, body, headers);
    const set = res.headers.get('set-cookie');
    if (set) {
      const m = /fd_portal=([^;]*)/.exec(set);
      if (m) this.cookie = m[1] && !/Max-Age=0/i.test(set) ? `fd_portal=${m[1]}` : '';
    }
    return res;
  }
}

let seq = 0;
function png(tag = String(++seq)) {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Buffer.from(`png-${tag}-${crypto.randomUUID()}`)]);
}
const pdf = () => new Uint8Array(Buffer.from(`%PDF-1.4\n% test ${crypto.randomUUID()}\n%%EOF\n`));

function form(file: Uint8Array, name: string, extra: Record<string, string> = {}) {
  const f = new FormData();
  f.append('file', new File([file as BlobPart], name));
  for (const [k, v] of Object.entries(extra)) f.append(k, v);
  return f;
}

async function uploadVersion(op: Client, projectId: string, deliverableId: string, file = png(), name = 'design.png') {
  const r = await op.json('POST', `/api/projects/${projectId}/portal/deliverables/${deliverableId}/versions`, form(file, name, { note: '確認をお願いします', requestId: rid() }));
  expect(r._status, JSON.stringify(r)).toBe(201);
  return r.version as { id: string; versionNumber: number };
}

/** 運営者＋公開済みポータル＋制作物v1＋招待を引き換えた顧客 */
async function setupPortal(opts: { ordered?: boolean; email?: string } = {}) {
  const A = await signup();
  const op = A.client;
  let projectId: string;
  let customerId: string;
  if (opts.ordered) ({ projectId, customerId } = await setupOrdered(op));
  else ({ projectId, customerId } = await setupProject(op));
  if (opts.email !== undefined) {
    await op.put(`/api/customers/${customerId}`, customerInput({ email: opts.email }));
  }
  await op.put(`/api/projects/${projectId}/portal`, { status: 'published', statusLabel: 'デザイン確認中', guidance: '画像をご確認ください' });
  const d = await op.post(`/api/projects/${projectId}/portal/deliverables`, { title: 'トップページ' }, 201);
  const v1 = await uploadVersion(op, projectId, d.deliverable.id);
  const inv = await op.post(`/api/projects/${projectId}/portal/invites`, { expiresInDays: 14 }, 201);
  const token = inv.path.split('#t=')[1] as string;
  const cl = new PortalClient();
  const red = await cl.post('/api/portal/invite/redeem', { token, email: 'INFO@example.com ' }, 200);
  expect(red.projectId).toBe(projectId);
  return { op, cl, projectId, customerId, deliverableId: d.deliverable.id as string, v1, token };
}

afterEach(() => setNow(null));

describe('招待リンク', () => {
  it('発行・引換（メール照合は大文字小文字・前後空白を無視）・使用回数・ポータル一覧', async () => {
    const P = await setupPortal();
    const me = await P.cl.get('/api/portal/me');
    expect(me.projects.map((p: any) => p.id)).toEqual([P.projectId]);
    expect(me.projects[0].statusLabel).toBe('デザイン確認中');
    // 同じリンクは期限内なら別端末でも使える
    const cl2 = new PortalClient();
    await cl2.post('/api/portal/invite/redeem', { token: P.token, email: 'info@example.com' }, 200);
    const ov = await P.op.get(`/api/projects/${P.projectId}/portal`);
    expect(ov.invites[0]).toMatchObject({ state: 'active', useCount: 2, failedAttempts: 0 });
    // トークン（平文）はDBに保存しない
    expect(JSON.stringify(ov)).not.toContain(P.token);
    // inspect はメールアドレスを返さない
    const ins = await new PortalClient().post('/api/portal/invite/inspect', { token: P.token }, 200);
    expect(ins.projectTitle).toBeTruthy();
    expect(JSON.stringify(ins)).not.toContain('example.com');
    // ログアウト
    await P.cl.post('/api/portal/logout', {}, 200);
    expect((await P.cl.get('/api/portal/me', 401))._status).toBe(401);
  });

  it('メール不一致は回数を数え、5回でロック（以後は正しいメールでも不可）', async () => {
    const A = await signup();
    const p = await setupProject(A.client);
    await A.client.put(`/api/projects/${p.projectId}/portal`, { status: 'published' });
    const inv = await A.client.post(`/api/projects/${p.projectId}/portal/invites`, {}, 201);
    const token = inv.path.split('#t=')[1];
    const c = new PortalClient();
    for (let n = 1; n <= 4; n++) {
      const r = await c.post('/api/portal/invite/redeem', { token, email: 'wrong@example.com' }, 400);
      expect(r.error.code).toBe('email_mismatch');
    }
    const locked = await c.post('/api/portal/invite/redeem', { token, email: 'wrong@example.com' }, 410);
    expect(locked.error.code).toBe('invite_locked');
    expect((await c.post('/api/portal/invite/redeem', { token, email: 'info@example.com' }, 410)).error.code).toBe('invite_locked');
    const ov = await A.client.get(`/api/projects/${p.projectId}/portal`);
    expect(ov.invites[0]).toMatchObject({ state: 'locked', failedAttempts: 5, useCount: 0 });
    expect(c.cookie).toBe('');
  });

  it('期限切れ・再発行（旧リンク失効）・手動失効・非公開・不正トークン・メール未登録', async () => {
    const A = await signup();
    const p = await setupProject(A.client);
    // 非公開（準備中）では引換不可
    const inv0 = await A.client.post(`/api/projects/${p.projectId}/portal/invites`, {}, 201);
    const t0 = inv0.path.split('#t=')[1];
    expect((await new PortalClient().post('/api/portal/invite/redeem', { token: t0, email: 'info@example.com' }, 403)).error.code).toBe('invite_closed');
    await A.client.put(`/api/projects/${p.projectId}/portal`, { status: 'published' });
    // 再発行で旧リンクは失効
    const inv1 = await A.client.post(`/api/projects/${p.projectId}/portal/invites`, { expiresInDays: 3 }, 201);
    const t1 = inv1.path.split('#t=')[1];
    expect((await new PortalClient().post('/api/portal/invite/redeem', { token: t0, email: 'info@example.com' }, 410)).error.code).toBe('invite_revoked');
    // 期限切れ
    setNow(new Date(Date.now() + 4 * 86400_000));
    expect((await new PortalClient().post('/api/portal/invite/redeem', { token: t1, email: 'info@example.com' }, 410)).error.code).toBe('invite_expired');
    setNow(null);
    // 手動失効
    const inv2 = await A.client.post(`/api/projects/${p.projectId}/portal/invites`, {}, 201);
    await A.client.post(`/api/projects/${p.projectId}/portal/invites/${inv2.invite.id}/revoke`, {}, 200);
    expect((await new PortalClient().post('/api/portal/invite/redeem', { token: inv2.path.split('#t=')[1], email: 'info@example.com' }, 410)).error.code).toBe('invite_revoked');
    // 不正トークン
    expect((await new PortalClient().post('/api/portal/invite/redeem', { token: 'x'.repeat(43), email: 'info@example.com' }, 404)).error.code).toBe('invite_invalid');
    // 期限は 1〜90日
    await A.client.post(`/api/projects/${p.projectId}/portal/invites`, { expiresInDays: 91 }, 400);
    // 顧客メール未登録は発行不可
    const cu = await A.client.post('/api/customers', customerInput({ email: '' }), 201);
    const p2 = await A.client.post('/api/projects', { requestId: rid(), customerId: cu.customer.id, title: 'メールなし', inquiryDate: null, plannedStart: null, plannedDue: null, internalMemo: '' }, 201);
    expect((await A.client.post(`/api/projects/${p2.id}/portal/invites`, {}, 400)).error.code).toBe('no_customer_email');
  });

  it('アクセス停止で入室済みの端末も見られなくなり、再発行・引換で再開。ポータル公開終了でも見られない', async () => {
    const P = await setupPortal();
    await P.cl.get(`/api/portal/projects/${P.projectId}`, 200);
    await P.op.post(`/api/projects/${P.projectId}/portal/stop-access`, {}, 200);
    await P.cl.get(`/api/portal/projects/${P.projectId}`, 404);
    expect((await P.cl.get('/api/portal/me')).projects).toHaveLength(0);
    const inv = await P.op.post(`/api/projects/${P.projectId}/portal/invites`, {}, 201);
    await P.cl.post('/api/portal/invite/redeem', { token: inv.path.split('#t=')[1], email: 'info@example.com' }, 200);
    await P.cl.get(`/api/portal/projects/${P.projectId}`, 200);
    await P.op.put(`/api/projects/${P.projectId}/portal`, { status: 'closed' });
    await P.cl.get(`/api/portal/projects/${P.projectId}`, 404);
  });

  it('引換はIPごとにレート制限される', async () => {
    const strict = makeApp({ relaxRateLimits: false });
    const c = new PortalClient(strict);
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await c.post('/api/portal/invite/redeem', { token: 'y'.repeat(43), email: 'a@example.com' }))._status;
    expect(last).toBe(429);
  });
});

describe('認可：顧客は自分の公開案件だけ・他アカウント/他案件のIDは 404', () => {
  let A: Awaited<ReturnType<typeof setupPortal>>;
  let B: Awaited<ReturnType<typeof setupPortal>>;
  let other: { projectId: string; versionId: string; selectionId: string; photoId: string; deliveryId: string; fileId: string; commentId: string };
  let mine: { selectionId: string; photoId: string; deliveryId: string; commentId: string };

  async function fixtures(P: Awaited<ReturnType<typeof setupPortal>>) {
    const sel = await P.op.post(`/api/projects/${P.projectId}/portal/selections`, { title: 'セレクト' }, 201);
    const ph = await P.op.json('POST', `/api/projects/${P.projectId}/portal/selections/${sel.id}/photos`, form(png(), 'a.png'));
    await P.op.post(`/api/projects/${P.projectId}/portal/selections/${sel.id}/status`, { status: 'open' }, 200);
    const dv = await P.op.post(`/api/projects/${P.projectId}/deliveries`, { requestId: rid(), deliveredOn: '2026-10-01', content: '納品', customerComment: '', internalMemo: '', includeLines: false }, 201);
    const deliveryId = dv.delivery.id;
    const att = await P.op.json('POST', '/api/attachments', form(pdf(), 'final.pdf', { purpose: 'delivery', projectId: P.projectId, deliveryId }));
    await P.op.post(`/api/projects/${P.projectId}/portal/deliveries/${deliveryId}/publish`, { versionIds: [], message: '' }, 200);
    const cm = await P.cl.post(`/api/portal/projects/${P.projectId}/versions/${P.v1.id}/comments`, { body: 'コメント' }, 201);
    return { selectionId: sel.id, photoId: ph.photoId, deliveryId, fileId: att.attachment.id, commentId: cm.id };
  }

  beforeAll(async () => {
    A = await setupPortal();
    B = await setupPortal();
    const fa = await fixtures(A);
    const fb = await fixtures(B);
    mine = fa;
    other = { projectId: B.projectId, versionId: B.v1.id, ...fb };
  });

  const clientRoutes = (pid: string, ids: { versionId: string; selectionId: string; photoId: string; deliveryId: string; fileId: string; commentId: string }) =>
    [
      ['GET', `/api/portal/projects/${pid}`],
      ['GET', `/api/portal/projects/${pid}/versions/${ids.versionId}`],
      ['GET', `/api/portal/projects/${pid}/versions/${ids.versionId}/instructions`],
      ['GET', `/api/portal/projects/${pid}/versions/${ids.versionId}/instructions?format=txt`],
      ['POST', `/api/portal/projects/${pid}/versions/${ids.versionId}/comments`, { body: 'x' }],
      ['DELETE', `/api/portal/projects/${pid}/comments/${ids.commentId}`],
      ['POST', `/api/portal/projects/${pid}/versions/${ids.versionId}/change-requests`, { body: 'x' }],
      ['POST', `/api/portal/projects/${pid}/versions/${ids.versionId}/approve`, { idempotencyKey: rid() }],
      ['GET', `/api/portal/projects/${pid}/files/${ids.fileId}`],
      ['GET', `/api/portal/projects/${pid}/deliveries/${ids.deliveryId}/pdf`],
      ['GET', `/api/portal/projects/${pid}/selections`],
      ['GET', `/api/portal/projects/${pid}/selections/${ids.selectionId}`],
      ['POST', `/api/portal/projects/${pid}/selections/${ids.selectionId}/picks`, { photoIds: [ids.photoId] }],
      ['POST', `/api/portal/projects/${pid}/selections/${ids.selectionId}/submit`, { note: '' }],
    ] as Array<[string, string, unknown?]>;

  it('他アカウントの案件IDは全ルートで 404', async () => {
    for (const [m, path, b] of clientRoutes(other.projectId, other)) {
      const r = await A.cl.json(m, path, b);
      expect(r._status, `${m} ${path}`).toBe(404);
    }
  });

  it('自分の案件IDに他案件のID（版・コメント・写真セレクト・写真・納品・ファイル）を混ぜても 404', async () => {
    const routes = clientRoutes(A.projectId, other).slice(1); // 先頭（案件概要）は自分の案件なので除外
    for (const [m, path, b] of routes) {
      if (path.endsWith('/selections')) continue; // 一覧は自分の案件
      const r = await A.cl.json(m, path, b);
      expect(r._status, `${m} ${path}`).toBe(404);
    }
    // 自分のセットに他セットの写真ID
    const r = await A.cl.post(`/api/portal/projects/${A.projectId}/selections/${mine.selectionId}/picks`, { photoIds: [other.photoId] });
    expect(r._status).toBe(404);
  });

  it('同じアカウントの別案件（招待を使っていない）も 404・内部ファイルは 404', async () => {
    const p2 = await setupProject(A.op, '別の案件');
    await A.op.put(`/api/projects/${p2.projectId}/portal`, { status: 'published' });
    await A.cl.get(`/api/portal/projects/${p2.projectId}`, 404);
    // 案件の内部ファイル（purpose=project）は顧客に出さない
    const att = await A.op.json('POST', '/api/attachments', form(pdf(), 'internal.pdf', { purpose: 'project', projectId: A.projectId }));
    await A.cl.get(`/api/portal/projects/${A.projectId}/files/${att.attachment.id}`, 404);
    // 自分の案件の公開ファイルは取得できる
    const view = await A.cl.get(`/api/portal/projects/${A.projectId}`);
    const ok = await A.cl.req('GET', view.deliverables[0].latest.file.url);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-security-policy')).toContain('sandbox');
  });

  it('認証の分離：顧客Cookieなし→401、運営者Cookieでは顧客APIに入れず、顧客Cookieでは運営者APIに入れない', async () => {
    expect((await new Client().get(`/api/portal/projects/${A.projectId}`, 401))._status).toBe(401);
    expect((await A.op.get(`/api/portal/projects/${A.projectId}`, 401))._status).toBe(401);
    expect((await A.cl.get(`/api/projects/${A.projectId}/portal`, 401))._status).toBe(401);
    // CSRFヘッダなしの更新は 403
    const res = await app.request(`/api/portal/projects/${A.projectId}/versions/${A.v1.id}/comments`, {
      method: 'POST',
      headers: { cookie: A.cl.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'x' }),
    });
    expect(res.status).toBe(403);
  });

  it('運営者APIも他アカウントの案件・版・セット・納品は 404', async () => {
    const pid = other.projectId;
    const routes: Array<[string, string, unknown?]> = [
      ['GET', `/api/projects/${pid}/portal`],
      ['PUT', `/api/projects/${pid}/portal`, { status: 'closed' }],
      ['POST', `/api/projects/${pid}/portal/invites`, {}],
      ['POST', `/api/projects/${pid}/portal/stop-access`, {}],
      ['POST', `/api/projects/${pid}/portal/deliverables`, { title: 'x' }],
      ['GET', `/api/projects/${pid}/portal/versions/${other.versionId}`],
      ['GET', `/api/projects/${pid}/portal/versions/${other.versionId}/instructions`],
      ['POST', `/api/projects/${pid}/portal/versions/${other.versionId}/comments`, { body: 'x' }],
      ['POST', `/api/projects/${pid}/portal/comments/${other.commentId}/resolve`, { resolved: true }],
      ['POST', `/api/projects/${pid}/portal/deliveries/${other.deliveryId}/withdraw`, {}],
      ['GET', `/api/projects/${pid}/portal/selections/${other.selectionId}`],
      ['POST', `/api/projects/${pid}/portal/selections/${other.selectionId}/status`, { status: 'closed' }],
      ['GET', `/api/projects/${pid}/portal/selections/${other.selectionId}/export`],
      // 自分の案件 + 他アカウントのID
      ['GET', `/api/projects/${A.projectId}/portal/versions/${other.versionId}`],
      ['POST', `/api/projects/${A.projectId}/portal/deliveries/${other.deliveryId}/publish`, { versionIds: [] }],
      ['POST', `/api/projects/${A.projectId}/portal/deliveries/${mine.deliveryId}/publish`, { versionIds: [other.versionId] }],
      ['GET', `/api/projects/${A.projectId}/portal/selections/${other.selectionId}`],
    ];
    for (const [m, path, b] of routes) {
      const r = await A.op.json(m, path, b);
      expect(r._status, `${m} ${path}`).toBe(404);
    }
    const up = await A.op.json('POST', `/api/projects/${pid}/portal/deliverables/${B.deliverableId}/versions`, form(png(), 'x.png'));
    expect(up._status).toBe(404);
  });
});

describe('承認・修正依頼・修正指示', () => {
  it('承認は最新版のみ・冪等。古い版や見ていた版番号のずれは 409 stale_version。案件状態は 作業中→納品待ち', async () => {
    const P = await setupPortal({ ordered: true });
    const base = `/api/portal/projects/${P.projectId}/versions`;
    let pj = await P.op.get(`/api/projects/${P.projectId}`);
    expect(pj.project.status).toBe('in_progress'); // 受注後の版提出で「作業中」
    const v2 = await uploadVersion(P.op, P.projectId, P.deliverableId);
    // 古い版（v1）の承認は 409
    const stale = await P.cl.post(`${base}/${P.v1.id}/approve`, { idempotencyKey: rid(), expectedVersionNumber: 1 }, 409);
    expect(stale.error.code).toBe('stale_version');
    expect(stale.error.details).toMatchObject({ latestVersionId: v2.id, latestVersionNumber: 2 });
    // 最新版でも、顧客が見ていた版番号がずれていれば 409
    expect((await P.cl.post(`${base}/${v2.id}/approve`, { idempotencyKey: rid(), expectedVersionNumber: 1 }, 409)).error.code).toBe('stale_version');
    const key = rid();
    const a1 = await P.cl.post(`${base}/${v2.id}/approve`, { idempotencyKey: key, expectedVersionNumber: 2, comment: 'OKです' }, 201);
    expect(a1).toMatchObject({ duplicate: false, approval: { versionNumber: 2, clientName: '山田 花子', comment: 'OKです' } });
    // 同じキーの再送は同じ承認
    const a2 = await P.cl.post(`${base}/${v2.id}/approve`, { idempotencyKey: key, expectedVersionNumber: 2 }, 200);
    expect(a2).toMatchObject({ duplicate: true, approval: { id: a1.approval.id } });
    // 別キーでも有効な承認は1件
    const a3 = await P.cl.post(`${base}/${v2.id}/approve`, { idempotencyKey: rid() }, 200);
    expect(a3.approval.id).toBe(a1.approval.id);
    // 同じキーを別の版に使うと 409
    expect((await P.cl.post(`${base}/${P.v1.id}/approve`, { idempotencyKey: key }, 409)).error.code).toBe('idempotency_conflict');
    pj = await P.op.get(`/api/projects/${P.projectId}`);
    expect(pj.project.status).toBe('awaiting_delivery');
    const ev = pj.events.find((e: any) => e.kind === 'portal_approved');
    expect(ev).toMatchObject({ clientVisible: true });
    // 承認済みの版に修正依頼は不可
    expect((await P.cl.post(`${base}/${v2.id}/change-requests`, { body: '修正' }, 409)).error.code).toBe('already_approved');
    // 運営者が取消 → 確認待ちに戻る（案件状態は戻さない）
    await P.op.post(`/api/projects/${P.projectId}/portal/approvals/${a1.approval.id}/revoke`, { reason: '誤操作' }, 200);
    const det = await P.cl.get(`${base}/${v2.id}`);
    expect(det.version.status).toBe('in_review');
    expect(det.approvals[0].revokedAt).toBeTruthy();
    const again = await P.cl.post(`${base}/${v2.id}/approve`, { idempotencyKey: rid(), expectedVersionNumber: 2 }, 201);
    expect(again.approval.id).not.toBe(a1.approval.id);
  });

  it('見積前の案件では版の提出・承認で状態を動かさない', async () => {
    const P = await setupPortal();
    await P.cl.post(`/api/portal/projects/${P.projectId}/versions/${P.v1.id}/approve`, { idempotencyKey: rid(), expectedVersionNumber: 1 }, 201);
    expect((await P.op.get(`/api/projects/${P.projectId}`)).project.status).toBe('inquiry');
  });

  it('ピン（指示タイプ付き）→ 修正依頼（その時点の未解決ピンを固定）→ 修正指示書 JSON/TXT', async () => {
    const P = await setupPortal();
    const vb = `/api/portal/projects/${P.projectId}/versions/${P.v1.id}`;
    const p1 = await P.cl.post(`${vb}/comments`, { body: 'ロゴを大きく', pin: { x: 0.2, y: 0.3 }, pinType: 'change' }, 201);
    const p2 = await P.cl.post(`${vb}/comments`, { body: 'ここは変えない', pin: { x: 0.5, y: 0.5 }, pinType: 'keep' }, 201);
    const p3 = await P.op.json('POST', `/api/projects/${P.projectId}/portal/versions/${P.v1.id}/comments`, { body: '補足', pin: { x: 0.9, y: 0.9 }, pinType: 'delete' });
    expect([p1.pinNumber, p2.pinNumber, p3.pinNumber]).toEqual([1, 2, 3]);
    await P.cl.post(`${vb}/comments`, { body: '返信', parentId: p1.id }, 201);
    await P.cl.post(`${vb}/comments`, { body: '範囲外', pin: { x: 1.5, y: 0.1 } }, 400);
    await P.cl.post(`${vb}/comments`, { body: '不正タイプ', pin: { x: 0.1, y: 0.1 }, pinType: 'bogus' }, 400);
    // 運営者がピン3を対応済みにし、顧客が自分のピン以外を削除しようとすると 403
    await P.op.post(`/api/projects/${P.projectId}/portal/comments/${p3.id}/resolve`, { resolved: true }, 200);
    await P.cl.del(`/api/portal/projects/${P.projectId}/comments/${p3.id}`, 403);

    const cr = await P.cl.post(`${vb}/change-requests`, { body: '2点修正をお願いします' }, 201);
    expect(cr.pinCount).toBe(2);
    const det = await P.op.get(`/api/projects/${P.projectId}/portal/versions/${P.v1.id}`);
    expect(det.version.status).toBe('changes_requested');
    expect(det.changeRequests[0]).toMatchObject({ body: '2点修正をお願いします', pinCount: 2, clientName: '山田 花子' });

    // 指示書（既定：未解決のみ）
    const sh = await P.cl.get(`${vb}/instructions`);
    expect(sh.pins.map((p: any) => [p.number, p.type])).toEqual([
      [1, 'change'],
      [2, 'keep'],
    ]);
    expect(sh.text).toContain('【修正指示】');
    expect(sh.text).toContain('① [変更]');
    expect(sh.text).toContain('【変更しない箇所】');
    const all = await P.op.get(`/api/projects/${P.projectId}/portal/versions/${P.v1.id}/instructions?includeResolved=1`);
    expect(all.pins).toHaveLength(3);
    expect(all.text).toContain('③ [削除]（対応済み）');
    const byCr = await P.cl.get(`${vb}/instructions?changeRequestId=${cr.id}`);
    expect(byCr.pins).toHaveLength(2);
    expect(byCr.text).toContain('【備考】');
    expect(byCr.text).toContain('2点修正をお願いします');
    // 他の版の修正依頼IDは 404
    const v2 = await uploadVersion(P.op, P.projectId, P.deliverableId);
    await P.cl.get(`/api/portal/projects/${P.projectId}/versions/${v2.id}/instructions?changeRequestId=${cr.id}`, 404);
    // TXT：BOM + CRLF
    const res = await P.cl.req('GET', `${vb}/instructions?format=txt`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('attachment');
    const raw = new Uint8Array(await res.arrayBuffer());
    expect([...raw.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // BOM（text() では取り除かれるためバイトで確認）
    const txt = new TextDecoder().decode(raw);
    expect(txt).toContain('\r\n');
    expect(txt).not.toMatch(/[^\r]\n/);
    // 古い版への修正依頼は 409
    expect((await P.cl.post(`${vb}/change-requests`, { body: 'もう一度' }, 409)).error.code).toBe('stale_version');
    // 画像以外の版にはピン不可
    const v3 = await uploadVersion(P.op, P.projectId, P.deliverableId, pdf(), 'spec.pdf');
    await P.cl.post(`/api/portal/projects/${P.projectId}/versions/${v3.id}/comments`, { body: 'x', pin: { x: 0.1, y: 0.1 } }, 400);
    await P.cl.post(`/api/portal/projects/${P.projectId}/versions/${v3.id}/comments`, { body: 'PDFへのコメント' }, 201);
    // 修正依頼は顧客に表示される履歴に残る
    const pv = await P.cl.get(`/api/portal/projects/${P.projectId}`);
    expect(pv.events.some((e: any) => e.kind === 'portal_change_request')).toBe(true);
    expect(pv.events.some((e: any) => e.kind === 'portal_invite')).toBe(false); // 運営者専用の履歴は出さない
  });
});

describe('納品の公開', () => {
  it('公開前は見えない → 未承認の版は含められない → 公開で納品書PDF・添付・承認済みの版を取得 → 公開中は承認取消・削除不可 → 取り下げで非表示', async () => {
    const P = await setupPortal({ ordered: true });
    const dv = await P.op.post(`/api/projects/${P.projectId}/deliveries`, { requestId: rid(), deliveredOn: '2026-10-05', content: 'LP一式', customerComment: 'ご確認ください', internalMemo: '社外秘', includeLines: true }, 201);
    const did = dv.delivery.id;
    const att = await P.op.json('POST', '/api/attachments', form(pdf(), 'final.pdf', { purpose: 'delivery', projectId: P.projectId, deliveryId: did }));
    let view = await P.cl.get(`/api/portal/projects/${P.projectId}`);
    expect(view.deliveries).toHaveLength(0);
    await P.cl.get(`/api/portal/projects/${P.projectId}/files/${att.attachment.id}`, 404);
    await P.cl.get(`/api/portal/projects/${P.projectId}/deliveries/${did}/pdf`, 404);

    expect((await P.op.post(`/api/projects/${P.projectId}/portal/deliveries/${did}/publish`, { versionIds: [P.v1.id] }, 409)).error.code).toBe('not_approved');
    const ap = await P.cl.post(`/api/portal/projects/${P.projectId}/versions/${P.v1.id}/approve`, { idempotencyKey: rid(), expectedVersionNumber: 1 }, 201);
    await P.op.post(`/api/projects/${P.projectId}/portal/deliveries/${did}/publish`, { versionIds: [P.v1.id], message: '納品しました' }, 200);

    view = await P.cl.get(`/api/portal/projects/${P.projectId}`);
    expect(view.deliveries).toHaveLength(1);
    expect(view.deliveries[0]).toMatchObject({ number: dv.delivery.number, portalMessage: '納品しました', customerComment: 'ご確認ください' });
    expect(JSON.stringify(view)).not.toContain('社外秘');
    expect(view.deliveries[0].versions[0].label).toBe('トップページ v1');
    const f = await P.cl.req('GET', view.deliveries[0].files[0].url);
    expect(f.status).toBe(200);
    const pdfRes = await P.cl.req('GET', view.deliveries[0].pdfUrl);
    expect(pdfRes.status).toBe(200);
    expect(pdfRes.headers.get('content-type')).toBe('application/pdf');
    expect(view.events.some((e: any) => e.kind === 'portal_delivery_published')).toBe(true);
    expect((await P.op.get(`/api/projects/${P.projectId}`)).project.status).toBe('delivered');

    expect((await P.op.post(`/api/projects/${P.projectId}/portal/approvals/${ap.approval.id}/revoke`, { reason: 'x' }, 409)).error.code).toBe('in_delivery');
    await P.op.del(`/api/deliveries/${did}`, 422);
    // ポータル用の添付は通常の添付削除APIでは消せない
    await P.op.del(`/api/attachments/${view.deliveries[0].versions[0].file.id}`, 409);

    await P.op.post(`/api/projects/${P.projectId}/portal/deliveries/${did}/withdraw`, {}, 200);
    view = await P.cl.get(`/api/portal/projects/${P.projectId}`);
    expect(view.deliveries).toHaveLength(0);
    await P.cl.get(`/api/portal/projects/${P.projectId}/files/${att.attachment.id}`, 404);
    await P.op.post(`/api/projects/${P.projectId}/portal/approvals/${ap.approval.id}/revoke`, { reason: '再確認' }, 200);
  });
});

describe('FreelanceDesk 写真セレクト', () => {
  it('登録・自然順・準備中は非公開・公開後は番号固定・番号入力の読み取り・送信・書き出し', async () => {
    const P = await setupPortal();
    const base = `/api/projects/${P.projectId}/portal/selections`;
    const s = await P.op.post(base, { title: '撮影セレクト', message: '10枚選んでください' }, 201);
    const same = png('same');
    for (const name of ['IMG_10.png', 'IMG_2.png', 'IMG_1.png']) {
      const r = await P.op.json('POST', `${base}/${s.id}/photos`, form(name === 'IMG_2.png' ? same : png(), name, { requestId: rid() }));
      expect(r._status, JSON.stringify(r)).toBe(201);
    }
    // 同じ内容は二重登録不可、画像以外は不可
    expect((await P.op.json('POST', `${base}/${s.id}/photos`, form(same, 'copy.png')))._status).toBe(409);
    expect((await P.op.json('POST', `${base}/${s.id}/photos`, form(pdf(), 'x.pdf')))._status).toBe(415);
    // 準備中は顧客に見えない
    const cbase = `/api/portal/projects/${P.projectId}/selections`;
    expect((await P.cl.get(cbase)).selections).toHaveLength(0);
    await P.cl.get(`${cbase}/${s.id}`, 404);
    let det = await P.op.get(`${base}/${s.id}`);
    await P.cl.get(`/api/portal/projects/${P.projectId}/files/${det.photos[0].url.split('/').pop()}`, 404);
    // 自然順に並べ替え → 001 IMG_1, 002 IMG_2, 003 IMG_10
    await P.op.post(`${base}/${s.id}/sort-by-name`, {}, 200);
    det = await P.op.get(`${base}/${s.id}`);
    expect(det.photos.map((p: any) => `${p.number}:${p.name}`)).toEqual(['001:IMG_1.png', '002:IMG_2.png', '003:IMG_10.png']);
    await P.op.post(`${base}/${s.id}/photos/${det.photos[2].id}/move`, { toNumber: 1 }, 200);
    det = await P.op.get(`${base}/${s.id}`);
    expect(det.photos.map((p: any) => p.name)).toEqual(['IMG_10.png', 'IMG_1.png', 'IMG_2.png']);
    await P.op.post(`${base}/${s.id}/status`, { status: 'open' }, 200);
    // 公開後は番号が変わる操作を拒否
    expect((await P.op.post(`${base}/${s.id}/sort-by-name`, {}, 409)).error.code).toBe('numbers_locked');
    expect((await P.op.post(`${base}/${s.id}/photos/delete`, { photoIds: [det.photos[0].id] }, 409)).error.code).toBe('numbers_locked');
    await P.op.del(`${base}/${s.id}`, 409);

    // 顧客：番号入力（全角・読点・0省略・該当なし・読めない語・重複）
    const cd = await P.cl.get(`${cbase}/${s.id}`);
    expect(cd.photos.map((p: any) => p.number)).toEqual(['001', '002', '003']);
    const r1 = await P.cl.post(`${cbase}/${s.id}/picks`, { numbersText: '1、００３ x 99 001', mode: 'add' }, 200);
    expect(r1.pickedNumbers).toEqual(['001', '003']);
    expect(r1.check.invalid).toEqual(['x']);
    expect(r1.check.results.filter((x: any) => !x.found).map((x: any) => x.label)).toEqual(['099']);
    expect(r1.check.duplicates).toEqual([{ label: '001', count: 2 }]);
    const r2 = await P.cl.post(`${cbase}/${s.id}/picks`, { numbersText: '2', mode: 'add' }, 200);
    expect(r2.pickedNumbers).toEqual(['001', '002', '003']);
    const r3 = await P.cl.post(`${cbase}/${s.id}/picks`, { numbersText: '2', mode: 'replace' }, 200);
    expect(r3.pickedNumbers).toEqual(['002']);
    // クリック選択（写真IDで置き換え）
    await P.cl.post(`${cbase}/${s.id}/picks`, { photoIds: [cd.photos[0].id, cd.photos[2].id] }, 200);
    const sub = await P.cl.post(`${cbase}/${s.id}/submit`, { note: '001は明るめに' }, 200);
    expect(sub).toMatchObject({ count: 2, numbers: ['001', '003'] });

    det = await P.op.get(`${base}/${s.id}`);
    expect(det.set.submittedCount).toBe(1);
    expect(det.responses[0]).toMatchObject({ clientName: '山田 花子', note: '001は明るめに', changedAfterSubmit: false });
    expect(det.responses[0].picks.map((p: any) => `${p.number}:${p.name}`)).toEqual(['001:IMG_10.png', '003:IMG_2.png']);
    // 書き出し：CSV（BOM・CRLF）とテキスト
    const csv = await (await P.op.req('GET', `${base}/${s.id}/export?kind=picks&format=csv`)).text();
    expect(csv).toBe('番号,元ファイル名\r\n001,IMG_10.png\r\n003,IMG_2.png\r\n');
    const map = await (await P.op.req('GET', `${base}/${s.id}/export?kind=map&format=txt`)).text();
    expect(map).toContain('002 → IMG_1.png\r\n');
    const txt = await (await P.op.req('GET', `${base}/${s.id}/export?kind=picks&format=txt`)).text();
    expect(txt).toContain('選んだ人：山田 花子');
    expect(txt).toContain('001 → IMG_10.png');
    // 公開後の追加は末尾の番号
    const add = await P.op.json('POST', `${base}/${s.id}/photos`, form(png(), 'IMG_0.png'));
    expect(add.number).toBe('004');
    // 受付終了で顧客の変更・送信は不可、閲覧は可
    await P.op.post(`${base}/${s.id}/status`, { status: 'closed' }, 200);
    expect((await P.cl.post(`${cbase}/${s.id}/picks`, { numbersText: '1' }, 409)).error.code).toBe('selection_closed');
    await P.cl.post(`${cbase}/${s.id}/submit`, {}, 409);
    await P.cl.get(`${cbase}/${s.id}`, 200);
    expect((await P.cl.get(`/api/portal/projects/${P.projectId}`)).events.some((e: any) => e.kind === 'selection_submitted')).toBe(true);
  });

  it('元ファイル名を見せない設定：顧客APIに名前を出さず、ファイルのヘッダも番号名', async () => {
    const P = await setupPortal();
    const base = `/api/projects/${P.projectId}/portal/selections`;
    const s = await P.op.post(base, { title: '非表示', showNames: false }, 201);
    await P.op.json('POST', `${base}/${s.id}/photos`, form(png(), '顧客に見せない名前.png'));
    await P.op.post(`${base}/${s.id}/status`, { status: 'open' }, 200);
    const cd = await P.cl.get(`/api/portal/projects/${P.projectId}/selections/${s.id}`);
    expect(cd.photos[0].name).toBeNull();
    expect(JSON.stringify(cd)).not.toContain('顧客に見せない名前');
    const res = await P.cl.req('GET', cd.photos[0].url);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('filename="001.png"');
    const r = await P.cl.post(`/api/portal/projects/${P.projectId}/selections/${s.id}/picks`, { numbersText: '1' }, 200);
    expect(r.check.results[0].name).toBe('001.png');
  });
});

describe('バックアップ', () => {
  it('ポータルの制作物・版・コメント・承認・写真セレクトを含めて復元できる（招待リンクは含めない）', async () => {
    const P = await setupPortal();
    const vb = `/api/portal/projects/${P.projectId}/versions/${P.v1.id}`;
    const c1 = await P.cl.post(`${vb}/comments`, { body: 'ピン', pin: { x: 0.1, y: 0.2 }, pinType: 'move' }, 201);
    await P.cl.post(`${vb}/comments`, { body: '返信', parentId: c1.id }, 201);
    await P.cl.post(`${vb}/change-requests`, { body: '修正して' }, 201);
    const s = await P.op.post(`/api/projects/${P.projectId}/portal/selections`, { title: 'S' }, 201);
    const ph = await P.op.json('POST', `/api/projects/${P.projectId}/portal/selections/${s.id}/photos`, form(png(), 'p.png'));
    await P.op.post(`/api/projects/${P.projectId}/portal/selections/${s.id}/status`, { status: 'open' }, 200);
    await P.cl.post(`/api/portal/projects/${P.projectId}/selections/${s.id}/picks`, { photoIds: [ph.photoId] }, 200);
    await P.cl.post(`/api/portal/projects/${P.projectId}/selections/${s.id}/submit`, {}, 200);

    const res = await P.op.req('GET', '/api/data/backup.zip');
    expect(res.status).toBe(200);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const manifest = JSON.parse(strFromU8(unzipSync(bytes)['manifest.json']));
    expect(manifest.stats.counts).toMatchObject({ portal_versions: 1, portal_comments: 2, portal_change_requests: 1, selection_photos: 1, selection_picks: 1, selection_responses: 1 });
    expect(manifest.stats.counts.portal_invites).toBeUndefined();

    const B = await signup();
    const f = new FormData();
    f.append('file', new File([bytes as BlobPart], 'backup.zip'));
    const r = await B.client.json('POST', '/api/data/restore', f);
    expect(r._status, JSON.stringify(r)).toBe(200);
    const projects = (await B.client.get('/api/projects')).projects;
    const ov = await B.client.get(`/api/projects/${projects[0].id}/portal`);
    expect(ov.deliverables[0].versions[0]).toMatchObject({ versionNumber: 1, status: 'changes_requested', commentCount: 2 });
    expect(ov.invites).toHaveLength(0);
    const file = await B.client.req('GET', ov.deliverables[0].versions[0].file.url);
    expect(file.status).toBe(200);
  });
});
