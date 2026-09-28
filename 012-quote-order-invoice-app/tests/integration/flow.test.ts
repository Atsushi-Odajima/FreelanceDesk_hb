// 案件フロー全体（E2Eシナリオ1〜4相当をAPIで検証）
import { afterAll, describe, expect, it } from 'vitest';
import { Client, customerInput, line, pool, quoteDraft, rid, setupInvoice, setupOrdered, setupProject, signup } from '../helpers';

afterAll(async () => {
  // pool は他ファイルでも使うため閉じない（プロセス終了で解放）
});

describe('シナリオ1：顧客→案件→見積v1→v2→提出→受注→タスク→納品→請求→30,000入金→70,000入金→完了', () => {
  it('一貫した流れで状態・金額・スナップショットが正しい', async () => {
    const { client: c } = await signup();
    await c.put('/api/business', {
      name: 'テスト制作室',
      contactName: '見本 太郎',
      postalCode: '000-0000',
      address: '東京都架空区1-1',
      phone: '000',
      email: 'me@example.com',
      bankInfo: 'テスト銀行 本店 普通 1234567',
      registrationNo: 'T1234567890123',
      brandColor: '#1f5fbf',
      defaultPaymentTerms: '翌月末払い',
      defaultNotes: '',
      defaultTaxRate: '10',
      taxMode: 'inclusive',
      lineRounding: 'round',
      taxRounding: 'floor',
      quoteValidDays: 30,
      invoiceDueDays: 30,
    });
    const cu = await c.post('/api/customers', customerInput(), 201);
    const p = await c.post('/api/projects', { requestId: rid(), customerId: cu.customer.id, title: '秋キャンペーンLP制作', inquiryDate: '2026-08-25', plannedStart: null, plannedDue: '2026-10-10', internalMemo: '社外秘' }, 201);
    const pid = p.id;

    // 見積 v1 120,000
    const q = await c.post(`/api/projects/${pid}/quotes`, { requestId: rid() }, 201);
    await c.put(`/api/quote-versions/${q.versionId}`, quoteDraft([line('デザイン', 60000), line('コーディング', 40000), line('撮影素材手配', 20000)], { changeMemo: '初回' }));
    let v1 = await c.get(`/api/quote-versions/${q.versionId}`);
    expect(v1.version.total).toBe(120000);
    await c.post(`/api/quote-versions/${q.versionId}/submit`, { submittedOn: '2026-09-01' }, 200);
    v1 = await c.get(`/api/quote-versions/${q.versionId}`);
    expect(v1.version.status).toBe('final');
    expect(v1.version.submittedOn).toBe('2026-09-01');
    // 確定版は上書き不可
    const ng = await c.json('PUT', `/api/quote-versions/${q.versionId}`, quoteDraft([line('x', 1)]));
    expect(ng._status).toBe(409);

    // v2（複製して編集）100,000
    const n2 = await c.post(`/api/quote-versions/${q.versionId}/new-version`, { requestId: rid() }, 201);
    const v2draft = await c.get(`/api/quote-versions/${n2.versionId}`);
    expect(v2draft.version.version).toBe(2);
    expect(v2draft.version.lines).toHaveLength(3); // v1から複製
    await c.put(`/api/quote-versions/${n2.versionId}`, quoteDraft([line('デザイン', 60000), line('コーディング', 40000)], { changeMemo: '素材は先方支給' }));
    await c.post(`/api/quote-versions/${n2.versionId}/submit`, { submittedOn: '2026-09-03' }, 200);
    const v2 = await c.get(`/api/quote-versions/${n2.versionId}`);
    expect(v2.version.total).toBe(100000);
    expect(v2.versions.map((x: any) => [x.version, x.status, x.total])).toEqual([
      [1, 'final', 120000],
      [2, 'final', 100000],
    ]);
    // v1 のスナップショットは 120,000 のまま
    expect((await c.get(`/api/quote-versions/${q.versionId}`)).preview.totals.total).toBe(120000);

    // 受注（v2を採用）
    const o = await c.post(`/api/projects/${pid}/orders`, { quoteVersionId: n2.versionId, orderDate: '2026-09-05', dueDate: '2026-10-10' }, 201);
    expect(o.order.amount).toBe(100000);
    expect(o.order.snapshot.quoteVersion).toBe(2);

    // マスター変更（顧客名）後も確定済み書類は変わらない
    await c.put(`/api/customers/${cu.customer.id}`, customerInput({ name: '変更後の社名株式会社' }));
    expect((await c.get(`/api/quote-versions/${n2.versionId}`)).preview.recipient.name).toBe('Sample Design株式会社');

    // タスク
    for (const t of ['素材受領', '初稿', '確認', '修正', '納品']) await c.post(`/api/projects/${pid}/tasks`, { requestId: rid(), title: t, dueDate: '2026-09-20' }, 201);
    let d = await c.get(`/api/projects/${pid}`);
    expect(d.tasks.map((t: any) => t.title)).toEqual(['素材受領', '初稿', '確認', '修正', '納品']);
    // 並び替え
    const ids = d.tasks.map((t: any) => t.id);
    await c.put(`/api/projects/${pid}/tasks/order`, { ids: [ids[1], ids[0], ...ids.slice(2)] });
    d = await c.get(`/api/projects/${pid}`);
    expect(d.tasks[0].title).toBe('初稿');
    for (const t of d.tasks) await c.patch(`/api/projects/${pid}/tasks/${t.id}`, { done: true });
    d = await c.get(`/api/projects/${pid}`);
    expect(d.tasks.every((t: any) => t.done && t.dueDate === '2026-09-20')).toBe(true);

    // 納品（請求は自動生成されない）
    await c.post(`/api/projects/${pid}/deliveries`, { requestId: rid(), deliveredOn: '2026-10-08', content: 'LP一式', customerComment: 'ご確認ください', internalMemo: '社外秘', includeLines: true }, 201);
    d = await c.get(`/api/projects/${pid}`);
    expect(d.project.status).toBe('delivered');
    expect(d.invoices).toHaveLength(0);

    // 請求書を作る（受注明細を引継ぎ）→ 確定
    const inv = await c.post(`/api/projects/${pid}/invoices`, { requestId: rid() }, 201);
    const iv = await c.get(`/api/invoice-versions/${inv.versionId}`);
    expect(iv.version.lines.map((l: any) => l.name)).toEqual(['デザイン', 'コーディング']);
    expect(iv.version.total).toBe(100000);
    expect(iv.version.bankInfo).toBe('テスト銀行 本店 普通 1234567');
    await c.post(`/api/invoice-versions/${inv.versionId}/finalize`, {}, 200);
    let invd = await c.get(`/api/invoices/${inv.invoiceId}`);
    expect(invd.invoice.number).toMatch(/^INV-\d{4}-0001$/);
    expect(invd.invoice.paymentState).toBe('unpaid');

    // 30,000 → 一部入金
    await c.post(`/api/invoices/${inv.invoiceId}/payments`, { requestId: rid(), receivedOn: '2026-10-20', amount: 30000, method: 'bank_transfer', payerName: 'ｻﾝﾌﾟﾙﾃﾞｻﾞｲﾝ', memo: '' }, 201);
    invd = await c.get(`/api/invoices/${inv.invoiceId}`);
    expect(invd.invoice).toMatchObject({ paymentState: 'partial', allocated: 30000, remaining: 70000 });
    // 70,000 → 入金済み
    await c.post(`/api/invoices/${inv.invoiceId}/payments`, { requestId: rid(), receivedOn: '2026-10-25', amount: 70000, method: 'bank_transfer', payerName: '', memo: '' }, 201);
    invd = await c.get(`/api/invoices/${inv.invoiceId}`);
    expect(invd.invoice).toMatchObject({ paymentState: 'paid', allocated: 100000, remaining: 0 });

    d = await c.get(`/api/projects/${pid}`);
    const tl = Object.fromEntries(d.timeline.map((e: any) => [e.step, e]));
    expect(tl.payment.state).toBe('done');
    expect(tl.payment.nextAction.key).toBe('complete');
    await c.post(`/api/projects/${pid}/status`, { status: 'completed', note: '入金確認' }, 200);
    d = await c.get(`/api/projects/${pid}`);
    expect(d.project.status).toBe('completed');
    expect(d.statusHistory.map((h: any) => h.toStatus)).toEqual(['inquiry', 'quoting', 'quote_submitted', 'ordered', 'delivered', 'invoiced', 'completed']);
  });
});

describe('シナリオ2：見積提出→失注（請求を生成しない）', () => {
  it('失注後は受注・請求できない', async () => {
    const { client: c } = await signup();
    const { projectId } = await setupProject(c);
    const q = await c.post(`/api/projects/${projectId}/quotes`, { requestId: rid() }, 201);
    await c.put(`/api/quote-versions/${q.versionId}`, quoteDraft([line('パンフレット', 200000)]));
    await c.post(`/api/quote-versions/${q.versionId}/submit`, { submittedOn: '2026-09-02' }, 200);
    await c.post(`/api/quote-versions/${q.versionId}/decline`, { reason: '予算' }, 200);
    const d = await c.get(`/api/projects/${projectId}`);
    expect(d.project.status).toBe('lost');
    expect(d.invoices).toHaveLength(0);
    const o = await c.post(`/api/projects/${projectId}/orders`, { quoteVersionId: q.versionId, orderDate: '2026-09-05', dueDate: null });
    expect(o._status).toBe(422);
    const inv = await c.post(`/api/projects/${projectId}/invoices`, { requestId: rid() });
    expect(inv._status).toBe(422);
    const invs = await pool.query('SELECT count(*)::int AS n FROM invoices WHERE project_id=$1', [projectId]);
    expect(invs.rows[0].n).toBe(0);
  });
});

describe('シナリオ3：受注→納品→未請求表示→請求作成で未請求から消える', () => {
  it('ダッシュボードの未請求', async () => {
    const { client: c } = await signup();
    const { projectId } = await setupOrdered(c, 55000);
    let dash = await c.get('/api/dashboard');
    expect(dash.lists.unbilled.map((x: any) => x.id)).not.toContain(projectId);
    expect(dash.lists.awaitingDelivery.map((x: any) => x.id)).toContain(projectId);
    await c.post(`/api/projects/${projectId}/deliveries`, { requestId: rid(), deliveredOn: '2026-09-25', content: '', customerComment: '', internalMemo: '', includeLines: true }, 201);
    dash = await c.get('/api/dashboard');
    expect(dash.lists.unbilled.map((x: any) => x.id)).toContain(projectId);
    const inv = await c.post(`/api/projects/${projectId}/invoices`, { requestId: rid() }, 201);
    dash = await c.get('/api/dashboard');
    expect(dash.lists.unbilled.map((x: any) => x.id)).toContain(projectId); // 下書きではまだ未請求
    await c.post(`/api/invoice-versions/${inv.versionId}/finalize`, {}, 200);
    dash = await c.get('/api/dashboard');
    expect(dash.lists.unbilled.map((x: any) => x.id)).not.toContain(projectId);
  });
});

describe('シナリオ4：期限超過請求→銀行CSV→候補→利用者確定→入金済み', () => {
  it('候補を表示するだけで自動確定しない', async () => {
    const { client: c } = await signup();
    const { invoiceId } = await setupInvoice(c, 55000, '2026-09-01');
    let list = await c.get('/api/invoices?state=overdue');
    // 税込計算：inclusive 55,000
    expect(list.invoices.map((i: any) => i.id)).toContain(invoiceId);

    const rows = [
      { date: '2026-09-10', name: 'ｻﾝﾌﾟﾙﾃﾞｻﾞｲﾝ(ｶ', amount: 55000 },
      { date: '2026-09-11', name: 'ﾍﾞﾂﾉｶｲｼｬ', amount: 12345 },
    ];
    const imp = await c.post('/api/bank-imports', { filename: 'bank.csv', encoding: 'utf-8', mapping: { date: 0, name: 1, amount: 2, hasHeader: true }, rowCount: 2, rows }, 201);
    expect(imp).toMatchObject({ imported: 2, skipped: 0 });
    // 自動割当されていない
    list = await c.get('/api/invoices?state=overdue');
    expect(list.invoices.map((i: any) => i.id)).toContain(invoiceId);
    const pays = await c.get('/api/payments?unallocated=1');
    expect(pays.payments).toHaveLength(2);
    const target = pays.payments.find((p: any) => p.amount === 55000);
    const cand = await c.get(`/api/payments/${target.id}/candidates`);
    expect(cand.candidates[0].invoiceId).toBe(invoiceId);
    expect(cand.candidates[0].reasons).toContain('残額と入金額が一致');
    expect(cand.candidates[0].reasons).toContain('名義と顧客名が一致');
    // 利用者が確定
    await c.post(`/api/payments/${target.id}/allocations`, { requestId: rid(), invoiceId, amount: 55000 }, 201);
    const inv = await c.get(`/api/invoices/${invoiceId}`);
    expect(inv.invoice).toMatchObject({ paymentState: 'paid', overdue: false });
    // 同一CSVの再取込は拒否
    const again = await c.post('/api/bank-imports', { filename: 'bank.csv', encoding: 'utf-8', mapping: { date: 0, name: 1, amount: 2, hasHeader: true }, rowCount: 2, rows });
    expect(again._status).toBe(409);
    // 期間が重なる別CSV：既存行はスキップ、新しい行だけ取込
    const overlap = await c.post(
      '/api/bank-imports',
      { filename: 'bank2.csv', encoding: 'shift_jis', mapping: { date: 0, name: 1, amount: 2, hasHeader: true }, rowCount: 2, rows: [rows[1], { date: '2026-09-12', name: 'ｱﾀﾗｼｲ', amount: 1000 }] },
      201,
    );
    expect(overlap).toMatchObject({ imported: 1, skipped: 1 });
  });

  it('同額・同名の請求が複数ある場合は要確認として扱う', async () => {
    const { client: c } = await signup();
    const a = await setupInvoice(c, 30000, '2026-09-01');
    const cust2 = await c.post('/api/customers', customerInput({ name: 'Sample Design株式会社' }), 201);
    const p2 = await c.post('/api/projects', { requestId: rid(), customerId: cust2.customer.id, title: '別案件', inquiryDate: null, plannedStart: null, plannedDue: null, internalMemo: '' }, 201);
    const q = await c.post(`/api/projects/${p2.id}/quotes`, { requestId: rid() }, 201);
    await c.put(`/api/quote-versions/${q.versionId}`, quoteDraft([line('同額', 30000)]));
    await c.post(`/api/quote-versions/${q.versionId}/finalize`, {}, 200);
    await c.post(`/api/projects/${p2.id}/orders`, { quoteVersionId: q.versionId, orderDate: '2026-09-05', dueDate: null }, 201);
    const inv2 = await c.post(`/api/projects/${p2.id}/invoices`, { requestId: rid() }, 201);
    await c.post(`/api/invoice-versions/${inv2.versionId}/finalize`, {}, 200);
    await c.post('/api/bank-imports', { filename: 'x.csv', encoding: 'utf-8', mapping: { date: 0, name: 1, amount: 2, hasHeader: false }, rowCount: 1, rows: [{ date: '2026-09-15', name: 'サンプルデザイン', amount: 30000 }] }, 201);
    const pays = await c.get('/api/payments?unallocated=1');
    const cand = await c.get(`/api/payments/${pays.payments[0].id}/candidates`);
    expect(cand.candidates.length).toBeGreaterThanOrEqual(2);
    expect(cand.ambiguous).toBe(true);
    expect(cand.needsReview).toBe(true);
    expect(a.invoiceId).toBeTruthy();
  });
});
