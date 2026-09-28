import type { Queryable } from '../db';
import { many } from '../db';
import { summarizePayment } from '../../../shared/calc';

export interface InvoiceListFilter {
  projectId?: string;
  customerId?: string;
  from?: string;
  to?: string;
  q?: string;
  ids?: string[];
}

/** 請求書一覧＋入金集計（状態は金額から導出） */
export async function listInvoices(q: Queryable, accountId: string, today: string, f: InvoiceListFilter = {}) {
  const params: unknown[] = [accountId];
  const conds = ['i.account_id=$1'];
  if (f.projectId) {
    params.push(f.projectId);
    conds.push(`i.project_id=$${params.length}`);
  }
  if (f.customerId) {
    params.push(f.customerId);
    conds.push(`p.customer_id=$${params.length}`);
  }
  if (f.from) {
    params.push(f.from);
    conds.push(`i.issue_date >= $${params.length}`);
  }
  if (f.to) {
    params.push(f.to);
    conds.push(`i.issue_date <= $${params.length}`);
  }
  if (f.q) {
    params.push(`%${f.q}%`);
    conds.push(`(i.number ILIKE $${params.length} OR p.title ILIKE $${params.length} OR c.name ILIKE $${params.length} OR p.number ILIKE $${params.length})`);
  }
  if (f.ids) {
    params.push(f.ids);
    conds.push(`i.id = ANY($${params.length}::uuid[])`);
  }
  const rows = await many(
    q,
    `SELECT i.id, i.number, i.status, i.issue_date, i.due_date, i.total, i.project_id, i.order_id, i.created_at, i.cancelled_at, i.cancel_reason,
            p.number AS project_number, p.title AS project_title, p.customer_id, c.name AS customer_name,
            cv.revision AS current_revision, cv.status AS current_version_status, cv.total AS draft_total,
            (SELECT id FROM invoice_versions dv WHERE dv.invoice_id=i.id AND dv.status='draft') AS draft_version_id,
            (SELECT id FROM invoice_versions fv WHERE fv.invoice_id=i.id AND fv.status='final') AS final_version_id,
            COALESCE((SELECT sum(a.amount) FROM payment_allocations a WHERE a.invoice_id=i.id),0)::bigint AS allocated,
            (SELECT max(pm.received_on) FROM payment_allocations a JOIN payments pm ON pm.id=a.payment_id WHERE a.invoice_id=i.id) AS last_payment_on
     FROM invoices i
     JOIN projects p ON p.account_id=i.account_id AND p.id=i.project_id
     JOIN customers c ON c.account_id=p.account_id AND c.id=p.customer_id
     LEFT JOIN invoice_versions cv ON cv.id=i.current_version_id
     WHERE ${conds.join(' AND ')}
     ORDER BY i.due_date NULLS LAST, i.created_at DESC
     LIMIT 2000`,
    params,
  );
  return rows.map((r) => {
    const base = {
      id: r.id,
      number: r.number,
      status: r.status as 'draft' | 'issued' | 'cancelled',
      issueDate: r.issue_date,
      dueDate: r.due_date,
      total: Number(r.total),
      projectId: r.project_id,
      projectNumber: r.project_number,
      projectTitle: r.project_title,
      customerId: r.customer_id,
      customerName: r.customer_name,
      orderId: r.order_id,
      currentRevision: r.current_revision,
      draftVersionId: r.draft_version_id,
      finalVersionId: r.final_version_id,
      draftTotal: Number(r.draft_total ?? 0),
      lastPaymentOn: r.last_payment_on,
      cancelReason: r.cancel_reason,
      createdAt: r.created_at,
    };
    const allocated = Number(r.allocated);
    const sum = r.status === 'issued' ? summarizePayment(Number(r.total), allocated, r.due_date, today) : null;
    return {
      ...base,
      allocated,
      remaining: sum ? sum.remaining : 0,
      paymentState: sum?.state ?? null,
      overdue: sum?.overdue ?? false,
      overpaidAmount: sum?.overpaidAmount ?? 0,
    };
  });
}

export type InvoiceListItem = Awaited<ReturnType<typeof listInvoices>>[number];

/** 入金一覧（未割当額つき） */
export async function listPayments(q: Queryable, accountId: string, f: { from?: string; to?: string; unallocatedOnly?: boolean; q?: string } = {}) {
  const params: unknown[] = [accountId];
  const conds = ['pm.account_id=$1'];
  if (f.from) {
    params.push(f.from);
    conds.push(`pm.received_on >= $${params.length}`);
  }
  if (f.to) {
    params.push(f.to);
    conds.push(`pm.received_on <= $${params.length}`);
  }
  if (f.q) {
    params.push(`%${f.q}%`);
    conds.push(`(pm.payer_name ILIKE $${params.length} OR pm.memo ILIKE $${params.length})`);
  }
  const rows = await many(
    q,
    `SELECT pm.*, COALESCE((SELECT sum(a.amount) FROM payment_allocations a WHERE a.payment_id=pm.id),0)::bigint AS allocated,
            COALESCE((SELECT json_agg(json_build_object('id', a.id, 'invoiceId', a.invoice_id, 'amount', a.amount, 'invoiceNumber', i.number,
                        'projectId', i.project_id, 'projectTitle', p.title, 'customerName', c.name) ORDER BY a.created_at)
                      FROM payment_allocations a JOIN invoices i ON i.id=a.invoice_id JOIN projects p ON p.id=i.project_id JOIN customers c ON c.id=p.customer_id
                      WHERE a.payment_id=pm.id), '[]') AS allocations
     FROM payments pm WHERE ${conds.join(' AND ')}
     ORDER BY pm.received_on DESC, pm.created_at DESC LIMIT 2000`,
    params,
  );
  const out = rows.map((r) => ({
    id: r.id,
    receivedOn: r.received_on,
    amount: Number(r.amount),
    method: r.method,
    payerName: r.payer_name,
    memo: r.memo,
    source: r.source,
    allocated: Number(r.allocated),
    unallocated: Number(r.amount) - Number(r.allocated),
    allocations: r.allocations,
    createdAt: r.created_at,
  }));
  return f.unallocatedOnly ? out.filter((p) => p.unallocated > 0) : out;
}
