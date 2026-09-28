// 二重クリック・通信再送で二重登録しないこと
import { describe, expect, it } from 'vitest';
import { customerInput, line, pool, quoteDraft, rid, setupInvoice, setupOrdered, setupProject, signup } from '../helpers';

describe('再送・同時送信', () => {
  it('案件作成：同じrequestIdの同時送信でも1件（番号の欠番なし）', async () => {
    const { client: c } = await signup();
    const cu = await c.post('/api/customers', customerInput(), 201);
    const body = { requestId: rid(), customerId: cu.customer.id, title: '同時送信', inquiryDate: null, plannedStart: null, plannedDue: null, internalMemo: '' };
    const res = await Promise.all([1, 2, 3, 4, 5].map(() => c.post('/api/projects', body)));
    const ids = new Set(res.map((r) => r.id));
    expect(ids.size).toBe(1);
    expect(res.filter((r) => r._status === 201)).toHaveLength(1);
    const list = await c.get('/api/projects');
    expect(list.projects).toHaveLength(1);
    expect(list.projects[0].number).toMatch(/-0001$/);
    // 次の案件は 0002（欠番なし）
    const p2 = await c.post('/api/projects', { ...body, requestId: rid(), title: '次' }, 201);
    const d2 = await c.get(`/api/projects/${p2.id}`);
    expect(d2.project.number).toMatch(/-0002$/);
  });

  it('受注の再送・同時送信：同じ見積で1件のみ', async () => {
    const { client: c } = await signup();
    const { projectId } = await setupProject(c);
    const q = await c.post(`/api/projects/${projectId}/quotes`, { requestId: rid() }, 201);
    await c.put(`/api/quote-versions/${q.versionId}`, quoteDraft([line('A', 1000)]));
    await c.post(`/api/quote-versions/${q.versionId}/finalize`, {}, 200);
    const body = { quoteVersionId: q.versionId, orderDate: '2026-09-05', dueDate: null };
    const res = await Promise.all([1, 2, 3, 4].map(() => c.post(`/api/projects/${projectId}/orders`, body)));
    expect(new Set(res.map((r) => r.order?.id)).size).toBe(1);
    expect(res.every((r) => r._status === 200 || r._status === 201)).toBe(true);
    const n = await pool.query('SELECT count(*)::int AS n FROM orders WHERE project_id=$1', [projectId]);
    expect(n.rows[0].n).toBe(1);
    // 別の版で二重受注も不可
    const n2 = await c.post(`/api/quote-versions/${q.versionId}/new-version`, { requestId: rid() });
    expect(n2._status).toBe(422); // 受注済みの見積は改訂不可
  });

  it('請求書作成の再送：1件のみ／確定の再送も1回分', async () => {
    const { client: c } = await signup();
    const { projectId } = await setupOrdered(c);
    const reqId = rid();
    const res = await Promise.all([1, 2, 3].map(() => c.post(`/api/projects/${projectId}/invoices`, { requestId: reqId })));
    expect(new Set(res.map((r) => r.invoiceId)).size).toBe(1);
    // 別requestIdでも、同じ受注に下書きがあればそれを返す
    const other = await c.post(`/api/projects/${projectId}/invoices`, { requestId: rid() }, 200);
    expect(other.invoiceId).toBe(res[0].invoiceId);
    const fin = await Promise.all([1, 2, 3].map(() => c.post(`/api/invoice-versions/${res[0].versionId}/finalize`, {})));
    expect(fin.filter((f) => f.alreadyFinal === false)).toHaveLength(1);
    const n = await pool.query("SELECT count(*)::int AS n, max(number) AS num FROM invoices WHERE project_id=$1", [projectId]);
    expect(n.rows[0].n).toBe(1);
    const counters = await pool.query("SELECT next_value FROM counters WHERE kind='invoice' AND account_id=(SELECT account_id FROM projects WHERE id=$1)", [projectId]);
    expect(counters.rows[0].next_value).toBe(2); // 採番は1回だけ
  });

  it('入金割当の再送：同じrequestIdで1回分', async () => {
    const { client: c } = await signup();
    const { invoiceId } = await setupInvoice(c, 100000);
    const p = await c.post('/api/payments', { requestId: rid(), receivedOn: '2026-09-25', amount: 100000, method: 'bank_transfer', payerName: 'X', memo: '' }, 201);
    const body = { requestId: rid(), invoiceId, amount: 30000 };
    const res = await Promise.all([1, 2, 3].map(() => c.post(`/api/payments/${p.payment.id}/allocations`, body)));
    expect(new Set(res.map((r) => r.allocation.id)).size).toBe(1);
    const inv = await c.get(`/api/invoices/${invoiceId}`);
    expect(inv.invoice.allocated).toBe(30000);
    // 未割当額を超える割当は拒否
    const over = await c.post(`/api/payments/${p.payment.id}/allocations`, { requestId: rid(), invoiceId, amount: 70001 });
    expect(over._status).toBe(422);
  });

  it('請求書からの入金記録の再送：1件のみ', async () => {
    const { client: c } = await signup();
    const { invoiceId } = await setupInvoice(c, 100000);
    const body = { requestId: rid(), receivedOn: '2026-09-25', amount: 30000, method: 'cash', payerName: '', memo: '' };
    await Promise.all([1, 2, 3].map(() => c.post(`/api/invoices/${invoiceId}/payments`, body)));
    const inv = await c.get(`/api/invoices/${invoiceId}`);
    expect(inv.invoice.allocated).toBe(30000);
    expect(inv.allocations).toHaveLength(1);
  });

  it('見積作成・次の版・納品・タスクの再送', async () => {
    const { client: c } = await signup();
    const { projectId } = await setupProject(c);
    const r1 = rid();
    const a = await Promise.all([1, 2].map(() => c.post(`/api/projects/${projectId}/quotes`, { requestId: r1 })));
    expect(a[0].versionId).toBe(a[1].versionId);
    await c.post(`/api/quote-versions/${a[0].versionId}/finalize`, {}).catch(() => null);
    await c.put(`/api/quote-versions/${a[0].versionId}`, quoteDraft([line('A', 1000)]));
    await c.post(`/api/quote-versions/${a[0].versionId}/finalize`, {}, 200);
    const r2 = rid();
    const b = await Promise.all([1, 2].map(() => c.post(`/api/quote-versions/${a[0].versionId}/new-version`, { requestId: r2 })));
    expect(b[0].versionId).toBe(b[1].versionId);
    const tr = rid();
    await Promise.all([1, 2].map(() => c.post(`/api/projects/${projectId}/tasks`, { requestId: tr, title: 'T' })));
    const d = await c.get(`/api/projects/${projectId}`);
    expect(d.tasks).toHaveLength(1);
    const dr = rid();
    await Promise.all([1, 2].map(() => c.post(`/api/projects/${projectId}/deliveries`, { requestId: dr, deliveredOn: '2026-09-25', content: '', customerComment: '', internalMemo: '', includeLines: false })));
    expect((await c.get(`/api/projects/${projectId}`)).deliveries).toHaveLength(1);
  });
});
