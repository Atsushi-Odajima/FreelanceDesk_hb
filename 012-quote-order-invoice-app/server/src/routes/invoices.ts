import { Hono } from 'hono';
import { z } from 'zod';
import { type AppEnv, body, idParam, query, type Services } from '../context';
import { many, withTx } from '../db';
import { cancelInvoiceSchema, correctionSchema, createInvoiceSchema, invoiceDraftSchema, invoicePaymentSchema } from '../schemas';
import { camelRow, camelRows } from '../services/format';
import {
  cancelInvoice,
  createInvoiceFromOrder,
  discardInvoiceDraft,
  finalizeInvoiceVersion,
  requireInvoice,
  requireInvoiceVersion,
  startCorrection,
  updateInvoiceDraft,
} from '../services/invoices';
import { recordInvoicePayment } from '../services/payments';
import { listInvoices } from '../services/queries';
import { buildDocSnapshot, loadBusiness, loadCustomerForProject } from '../services/snapshot';
import { calculateTotals } from '../../../shared/calc';
import { endOfMonth, startOfMonth } from '../../../shared/dates';

export function invoiceRoutes(s: Services) {
  const r = new Hono<AppEnv>();

  // 一覧：未入金/一部入金/入金済み/期限超過/過入金/下書き/取消 で絞込
  r.get('/invoices', async (c) => {
    const q = query(
      c,
      z.object({
        state: z.enum(['all', 'unpaid', 'partial', 'paid', 'overdue', 'overpaid', 'draft', 'cancelled', 'open', 'due_this_month']).optional(),
        from: z.string().max(10).optional(),
        to: z.string().max(10).optional(),
        customerId: z.string().uuid().optional(),
        projectId: z.string().uuid().optional(),
        q: z.string().max(100).optional(),
      }),
    );
    const today = s.today();
    let rows = await listInvoices(s.pool, c.get('accountId'), today, q);
    const st = q.state ?? 'all';
    if (st === 'draft' || st === 'cancelled') rows = rows.filter((x) => x.status === st);
    else if (st === 'overdue') rows = rows.filter((x) => x.overdue);
    else if (st === 'open') rows = rows.filter((x) => x.status === 'issued' && (x.paymentState === 'unpaid' || x.paymentState === 'partial'));
    else if (st === 'due_this_month')
      rows = rows.filter((x) => x.status === 'issued' && x.remaining > 0 && x.dueDate && x.dueDate >= startOfMonth(today) && x.dueDate <= endOfMonth(today));
    else if (st !== 'all') rows = rows.filter((x) => x.status === 'issued' && x.paymentState === st);
    return c.json({ invoices: rows, today });
  });

  // 受注から「請求書を作る」（下書き作成→確認→確定）
  r.post('/projects/:id/invoices', async (c) => {
    const i = await body(c, createInvoiceSchema);
    const res = await withTx(s.pool, (tx) => createInvoiceFromOrder(tx, s, c.get('accountId'), idParam(c), i.requestId, i.orderId, i.allowAdditional));
    return c.json(res, res.created ? 201 : 200);
  });

  r.get('/invoices/:id', async (c) => {
    const acc = c.get('accountId');
    const id = idParam(c);
    const inv = await requireInvoice(s.pool, acc, id);
    const [summary] = await listInvoices(s.pool, acc, s.today(), { ids: [id] });
    const versions = await many(
      s.pool,
      'SELECT id, revision, status, issue_date, due_date, total, correction_reason, previous_total, created_at, finalized_at FROM invoice_versions WHERE account_id=$1 AND invoice_id=$2 ORDER BY revision',
      [acc, id],
    );
    const allocations = await many(
      s.pool,
      `SELECT a.id, a.amount, a.created_at, p.id AS payment_id, p.received_on, p.method, p.payer_name, p.memo, p.source, p.amount AS payment_amount
       FROM payment_allocations a JOIN payments p ON p.id=a.payment_id WHERE a.account_id=$1 AND a.invoice_id=$2 ORDER BY p.received_on, a.created_at`,
      [acc, id],
    );
    return c.json({ invoice: { ...summary, cancelledAt: inv.cancelled_at }, versions: camelRows(versions), allocations: camelRows(allocations) });
  });

  r.get('/invoice-versions/:id', async (c) => {
    const acc = c.get('accountId');
    const v = await requireInvoiceVersion(s.pool, acc, idParam(c));
    const preview =
      v.status !== 'draft'
        ? v.snapshot
        : buildDocSnapshot(
            'invoice',
            { ...v, previous_total: v.previous_total },
            v.number ?? '（確定時に採番）',
            await loadBusiness(s.pool, acc),
            await loadCustomerForProject(s.pool, acc, v.project_id),
          );
    const lineAmounts = calculateTotals(v.lines, v.adjustments, { taxMode: v.tax_mode, lineRounding: v.line_rounding, taxRounding: v.tax_rounding }).lineAmounts;
    const allocated = await many(s.pool, 'SELECT COALESCE(sum(amount),0)::bigint AS s FROM payment_allocations WHERE invoice_id=$1', [v.invoice_id]);
    return c.json({ version: { ...camelRow<any>(v), lineAmounts }, preview, allocated: Number(allocated[0].s) });
  });

  r.put('/invoice-versions/:id', async (c) => {
    const i = await body(c, invoiceDraftSchema);
    await withTx(s.pool, (tx) => updateInvoiceDraft(tx, c.get('accountId'), idParam(c), i));
    return c.json({ ok: true });
  });

  r.post('/invoice-versions/:id/finalize', async (c) => {
    const res = await withTx(s.pool, (tx) => finalizeInvoiceVersion(tx, s, c.get('accountId'), idParam(c)));
    return c.json(res);
  });

  r.delete('/invoice-versions/:id', async (c) => {
    const res = await withTx(s.pool, (tx) => discardInvoiceDraft(tx, c.get('accountId'), idParam(c)));
    return c.json(res);
  });

  r.post('/invoices/:id/corrections', async (c) => {
    const i = await body(c, correctionSchema);
    const res = await withTx(s.pool, (tx) => startCorrection(tx, c.get('accountId'), idParam(c), i.requestId, i.reason));
    return c.json(res, res.created ? 201 : 200);
  });

  r.post('/invoices/:id/cancel', async (c) => {
    const i = await body(c, cancelInvoiceSchema);
    await withTx(s.pool, (tx) => cancelInvoice(tx, s, c.get('accountId'), idParam(c), i.reason));
    return c.json({ ok: true });
  });

  // 請求書から手入力で入金を記録（入金登録＋割当）
  r.post('/invoices/:id/payments', async (c) => {
    const i = await body(c, invoicePaymentSchema);
    const res = await withTx(s.pool, (tx) => recordInvoicePayment(tx, s, c.get('accountId'), idParam(c), i));
    return c.json({ payment: camelRow(res.payment), created: res.created }, res.created ? 201 : 200);
  });

  return r;
}
