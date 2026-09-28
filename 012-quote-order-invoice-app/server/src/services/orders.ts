import type { Queryable, Tx } from '../db';
import { lockRequest, one } from '../db';
import type { Services } from '../context';
import { conflict, notFound, unprocessable } from './errors';
import { advanceProjectStatus, logEvent } from './events';
import { requireProject } from './projects';
import { requireQuoteVersion } from './quotes';
import { issuerFrom, loadBusiness, loadCustomerForProject, recipientFrom, type DocSnapshot } from './snapshot';
import { nextNumber } from './numbering';
import { CLOSED_STATUSES } from '../../../shared/status';

export interface OrderInput {
  quoteVersionId: string;
  orderDate: string;
  dueDate: string | null;
  paymentTerms?: string;
  memo: string;
}

export async function requireOrder(q: Queryable, accountId: string, orderId: string) {
  const o = await one(q, 'SELECT * FROM orders WHERE account_id=$1 AND id=$2', [accountId, orderId]);
  if (!o) throw notFound('受注');
  return o;
}

/**
 * 「この見積で受注」：採用版・受注日・受注金額・納期・支払条件をスナップショット保存。
 * 同じ見積版での再送は既存の受注を返す（冪等）。別の有効な受注がある案件では拒否。
 */
export async function createOrder(tx: Tx, s: Services, accountId: string, projectId: string, input: OrderInput) {
  await lockRequest(tx, accountId, `order:${projectId}`);
  const project = await requireProject(tx, accountId, projectId, true);
  const v = await requireQuoteVersion(tx, accountId, input.quoteVersionId, true);
  if (v.project_id !== projectId) throw notFound('見積');
  const existing = await one(tx, 'SELECT * FROM orders WHERE account_id=$1 AND quote_version_id=$2', [accountId, v.id]);
  if (existing) {
    if (existing.status === 'active') return { order: existing, created: false };
    throw conflict('この見積版の受注は取り消されています。新しい版を作成して受注してください', 'order_cancelled');
  }
  if (CLOSED_STATUSES.includes(project.status)) throw unprocessable('完了・失注・キャンセルの案件では受注できません。先に案件の状態を戻してください');
  const active = await one(tx, "SELECT id FROM orders WHERE account_id=$1 AND project_id=$2 AND status='active'", [accountId, projectId]);
  if (active) throw conflict('この案件はすでに受注済みです', 'already_ordered');
  if (v.status !== 'final') throw unprocessable('見積を確定（または提出済みに）してから受注してください');
  const snap = v.snapshot as DocSnapshot;
  const paymentTerms = input.paymentTerms ?? snap.paymentTerms;
  const orderSnapshot = {
    ...snap,
    orderDate: input.orderDate,
    orderDueDate: input.dueDate,
    orderPaymentTerms: paymentTerms,
    quoteNumber: v.number,
    quoteVersion: v.version,
  };
  const r = await tx.query(
    `INSERT INTO orders (account_id, project_id, quote_version_id, order_date, amount, due_date, payment_terms, memo, snapshot)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [accountId, projectId, v.id, input.orderDate, snap.totals!.total, input.dueDate, paymentTerms, input.memo, JSON.stringify(orderSnapshot)],
  );
  const order = r.rows[0];
  if (input.dueDate) await tx.query('UPDATE projects SET planned_due=$3, updated_at=now() WHERE account_id=$1 AND id=$2', [accountId, projectId, input.dueDate]);
  await advanceProjectStatus(tx, accountId, projectId, 'ordered');
  await logEvent(tx, accountId, projectId, 'ordered', `受注（${v.number} v${v.version}・${order.amount.toLocaleString('ja-JP')}円）`, {
    refType: 'order',
    refId: order.id,
  });
  return { order, created: true };
}

/** 受注取消（請求書が発行済みの場合は不可） */
export async function cancelOrder(tx: Tx, accountId: string, orderId: string, reason: string) {
  const o = await requireOrder(tx, accountId, orderId);
  if (o.status === 'cancelled') return;
  const inv = await one(tx, "SELECT id FROM invoices WHERE account_id=$1 AND order_id=$2 AND status <> 'cancelled'", [accountId, orderId]);
  if (inv) throw unprocessable('この受注には請求書があります。先に請求書を取消してください');
  await tx.query("UPDATE orders SET status='cancelled', cancelled_at=now() WHERE account_id=$1 AND id=$2", [accountId, orderId]);
  await logEvent(tx, accountId, o.project_id, 'order_cancelled', '受注を取消', { refType: 'order', refId: orderId, note: reason });
}

export interface DeliveryInput {
  requestId: string;
  deliveredOn: string;
  content: string;
  customerComment: string;
  internalMemo: string;
  includeLines: boolean;
}

/** 納品記録（納品書スナップショット付き）。納品だけで請求は作らない */
export async function createDelivery(tx: Tx, s: Services, accountId: string, projectId: string, input: DeliveryInput) {
  await lockRequest(tx, accountId, input.requestId);
  const byReq = await one(tx, 'SELECT * FROM deliveries WHERE account_id=$1 AND request_id=$2', [accountId, input.requestId]);
  if (byReq) return { delivery: byReq, created: false };
  await requireProject(tx, accountId, projectId, true);
  const order = await one(tx, "SELECT * FROM orders WHERE account_id=$1 AND project_id=$2 AND status='active'", [accountId, projectId]);
  const b = await loadBusiness(tx, accountId);
  const customer = await loadCustomerForProject(tx, accountId, projectId);
  const number = await nextNumber(tx, accountId, 'delivery', s.today());
  const osnap = order?.snapshot as DocSnapshot | undefined;
  const snapshot: DocSnapshot = {
    docType: 'delivery',
    number,
    version: 1,
    issueDate: input.deliveredOn,
    deliveredOn: input.deliveredOn,
    subject: osnap?.subject ?? '',
    paymentTerms: '',
    notes: '',
    content: input.content,
    customerComment: input.customerComment,
    issuer: issuerFrom(b),
    recipient: recipientFrom(customer),
    lines: input.includeLines && osnap ? osnap.lines : [],
    adjustments: input.includeLines && osnap ? osnap.adjustments : [],
    totals: input.includeLines && osnap ? osnap.totals : null,
    taxMode: osnap?.taxMode ?? b.tax_mode,
    lineRounding: osnap?.lineRounding ?? b.line_rounding,
    taxRounding: osnap?.taxRounding ?? b.tax_rounding,
    finalizedAt: s.now().toISOString(),
  };
  const r = await tx.query(
    `INSERT INTO deliveries (account_id, project_id, order_id, number, delivered_on, content, customer_comment, internal_memo, include_lines, snapshot, request_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [
      accountId,
      projectId,
      order?.id ?? null,
      number,
      input.deliveredOn,
      input.content,
      input.customerComment,
      input.internalMemo,
      input.includeLines && !!osnap,
      JSON.stringify(snapshot),
      input.requestId,
    ],
  );
  const delivery = r.rows[0];
  await advanceProjectStatus(tx, accountId, projectId, 'delivered');
  await logEvent(tx, accountId, projectId, 'delivered', `納品を記録（${number}・${input.deliveredOn}）`, { refType: 'delivery', refId: delivery.id });
  return { delivery, created: true };
}
