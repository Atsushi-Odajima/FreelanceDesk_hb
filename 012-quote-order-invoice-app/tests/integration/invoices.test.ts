// 請求の訂正・取消・キャンセル・過入金・期限
import { describe, expect, it } from 'vitest';
import { line, pool, rid, setupInvoice, setupOrdered, signup } from '../helpers';

async function editDraft(c: any, versionId: string, patch: Record<string, unknown>) {
  const v = (await c.get(`/api/invoice-versions/${versionId}`)).version;
  await c.put(`/api/invoice-versions/${versionId}`, {
    issueDate: v.issueDate,
    dueDate: v.dueDate,
    subject: v.subject,
    paymentTerms: v.paymentTerms,
    notes: v.notes,
    bankInfo: v.bankInfo,
    taxMode: v.taxMode,
    lineRounding: v.lineRounding,
    taxRounding: v.taxRounding,
    lines: v.lines,
    adjustments: v.adjustments,
    correctionReason: v.correctionReason,
    ...patch,
  });
}

describe('請求の訂正', () => {
  it('確定後は上書き不可→訂正版で履歴（理由・旧金額・新金額・日時）', async () => {
    const { client: c } = await signup();
    const { invoiceId, invoiceVersionId } = await setupInvoice(c, 100000);
    const ng = await c.json('PUT', `/api/invoice-versions/${invoiceVersionId}`, { any: 1 });
    expect([400, 409]).toContain(ng._status);
    const corr = await c.post(`/api/invoices/${invoiceId}/corrections`, { requestId: rid(), reason: '作業範囲の追加' }, 201);
    await editDraft(c, corr.versionId, { lines: [line('LP制作', 100000), line('追加ページ', 20000)] });
    // 訂正確定前は旧版が有効
    expect((await c.get(`/api/invoices/${invoiceId}`)).invoice.total).toBe(100000);
    await c.post(`/api/invoice-versions/${corr.versionId}/finalize`, {}, 200);
    const d = await c.get(`/api/invoices/${invoiceId}`);
    expect(d.invoice.total).toBe(120000);
    expect(d.invoice.currentRevision).toBe(2);
    expect(d.versions.map((v: any) => [v.revision, v.status, v.total, v.previousTotal])).toEqual([
      [1, 'superseded', 100000, null],
      [2, 'final', 120000, 100000],
    ]);
    expect(d.versions[1].correctionReason).toBe('作業範囲の追加');
    expect(d.versions[1].finalizedAt).toBeTruthy();
    // 旧版のスナップショット・PDFは残る
    const old = await c.get(`/api/invoice-versions/${invoiceVersionId}`);
    expect(old.preview.totals.total).toBe(100000);
    const pdf = await c.req('GET', `/api/pdf/invoice-versions/${invoiceVersionId}`);
    expect(pdf.status).toBe(200);
    // 番号は同じ
    expect((await c.get(`/api/invoice-versions/${corr.versionId}`)).preview.number).toBe(d.invoice.number);
  });

  it('割当済み入金額を下回る訂正は拒否', async () => {
    const { client: c } = await signup();
    const { invoiceId } = await setupInvoice(c, 100000);
    await c.post(`/api/invoices/${invoiceId}/payments`, { requestId: rid(), receivedOn: '2026-09-25', amount: 80000, method: 'bank_transfer', payerName: '', memo: '' }, 201);
    const corr = await c.post(`/api/invoices/${invoiceId}/corrections`, { requestId: rid(), reason: '値引き' }, 201);
    await editDraft(c, corr.versionId, { lines: [line('LP制作', 70000)] });
    const r = await c.post(`/api/invoice-versions/${corr.versionId}/finalize`, {});
    expect(r._status).toBe(422);
    expect(r.error.code).toBe('below_allocated');
    expect((await c.get(`/api/invoices/${invoiceId}`)).invoice.total).toBe(100000);
    // 80,000 ちょうどは可
    await editDraft(c, corr.versionId, { lines: [line('LP制作', 80000)] });
    await c.post(`/api/invoice-versions/${corr.versionId}/finalize`, {}, 200);
    expect((await c.get(`/api/invoices/${invoiceId}`)).invoice).toMatchObject({ total: 80000, paymentState: 'paid' });
  });

  it('訂正理由なしでは確定できない', async () => {
    const { client: c } = await signup();
    const { invoiceId } = await setupInvoice(c, 1000);
    const corr = await c.post(`/api/invoices/${invoiceId}/corrections`, { requestId: rid(), reason: '理由' }, 201);
    await pool.query("UPDATE invoice_versions SET correction_reason='' WHERE id=$1", [corr.versionId]);
    expect((await c.post(`/api/invoice-versions/${corr.versionId}/finalize`, {}))._status).toBe(422);
  });
});

describe('取消・キャンセル', () => {
  it('入金割当がある請求書は取消不可。割当解除後に取消可', async () => {
    const { client: c } = await signup();
    const { invoiceId } = await setupInvoice(c, 10000);
    const p = await c.post(`/api/invoices/${invoiceId}/payments`, { requestId: rid(), receivedOn: '2026-09-25', amount: 5000, method: 'cash', payerName: '', memo: '' }, 201);
    expect((await c.post(`/api/invoices/${invoiceId}/cancel`, { reason: '誤発行' }))._status).toBe(422);
    const d = await c.get(`/api/invoices/${invoiceId}`);
    await c.del(`/api/allocations/${d.allocations[0].id}`);
    await c.post(`/api/invoices/${invoiceId}/cancel`, { reason: '誤発行' }, 200);
    const after = await c.get(`/api/invoices/${invoiceId}`);
    expect(after.invoice.status).toBe('cancelled');
    // 入金自体は未割当入金として残る
    const unalloc = await c.get('/api/payments?unallocated=1');
    expect(unalloc.payments.map((x: any) => x.id)).toContain(p.payment.id);
  });

  it('案件キャンセル：状態のみ変更し帳票は作らない。受注取消は請求書取消が先', async () => {
    const { client: c } = await signup();
    const { projectId, orderId } = await setupOrdered(c);
    await c.post(`/api/projects/${projectId}/status`, { status: 'cancelled', note: '先方都合' }, 200);
    const d = await c.get(`/api/projects/${projectId}`);
    expect(d.project.status).toBe('cancelled');
    expect(d.invoices).toHaveLength(0);
    expect(d.timeline.find((t: any) => t.step === 'invoice').state).toBe('skipped');
    await c.post(`/api/orders/${orderId}/cancel`, { reason: '案件キャンセル' }, 200);
    expect((await c.get(`/api/projects/${projectId}`)).activeOrder).toBeNull();
  });
});

describe('過入金・期限超過', () => {
  it('過入金を明示し、差額を値引き・手数料にしない', async () => {
    const { client: c } = await signup();
    const { invoiceId } = await setupInvoice(c, 100000);
    await c.post(`/api/invoices/${invoiceId}/payments`, { requestId: rid(), receivedOn: '2026-09-25', amount: 100500, method: 'bank_transfer', payerName: '', memo: '' }, 201);
    const d = await c.get(`/api/invoices/${invoiceId}`);
    expect(d.invoice).toMatchObject({ paymentState: 'overpaid', remaining: -500, overpaidAmount: 500, total: 100000 });
    const list = await c.get('/api/invoices?state=overpaid');
    expect(list.invoices).toHaveLength(1);
  });

  it('期限超過は支払期限の翌日から', async () => {
    const { client: c } = await signup();
    const today = (await c.get('/api/dashboard')).today as string;
    const a = await setupInvoice(c, 1000, today);
    let d = await c.get(`/api/invoices/${a.invoiceId}`);
    expect(d.invoice.overdue).toBe(false);
    const y = new Date(Date.parse(today) - 86400000).toISOString().slice(0, 10);
    const b = await setupInvoice(c, 1000, y);
    d = await c.get(`/api/invoices/${b.invoiceId}`);
    expect(d.invoice.overdue).toBe(true);
    const dash = await c.get('/api/dashboard');
    expect(dash.lists.overdue.map((x: any) => x.id)).toEqual([b.invoiceId]);
  });
});
