import crypto from 'node:crypto';
import type { Queryable, Tx } from '../db';
import { lockRequest, one } from '../db';
import type { Services } from '../context';
import type { Adjustment, Line, RoundingMode, TaxMode } from '../../../shared/calc';
import { calculateTotals } from '../../../shared/calc';
import { addDays } from '../../../shared/dates';
import { conflict, notFound, unprocessable } from './errors';
import { nextNumber } from './numbering';
import { advanceProjectStatus, logEvent } from './events';
import { requireProject } from './projects';
import { buildDocSnapshot, loadBusiness, loadCustomerForProject, type DocSnapshot } from './snapshot';

export interface InvoiceDraftInput {
  issueDate: string;
  dueDate: string | null;
  subject: string;
  paymentTerms: string;
  notes: string;
  bankInfo: string;
  taxMode: TaxMode;
  lineRounding: RoundingMode;
  taxRounding: RoundingMode;
  lines: Line[];
  adjustments: Adjustment[];
  correctionReason?: string;
}

export async function requireInvoice(q: Queryable, accountId: string, invoiceId: string, lock = false) {
  const inv = await one(q, `SELECT * FROM invoices WHERE account_id=$1 AND id=$2 ${lock ? 'FOR UPDATE' : ''}`, [accountId, invoiceId]);
  if (!inv) throw notFound('請求書');
  return inv;
}

export async function requireInvoiceVersion(q: Queryable, accountId: string, versionId: string, lock = false) {
  const v = await one(
    q,
    `SELECT v.*, i.number, i.project_id, i.status AS invoice_status, i.order_id FROM invoice_versions v
     JOIN invoices i ON i.account_id = v.account_id AND i.id = v.invoice_id
     WHERE v.account_id=$1 AND v.id=$2 ${lock ? 'FOR UPDATE OF v' : ''}`,
    [accountId, versionId],
  );
  if (!v) throw notFound('請求書');
  return v;
}

export async function allocatedFor(q: Queryable, accountId: string, invoiceId: string): Promise<number> {
  const r = await one(q, 'SELECT COALESCE(sum(amount),0)::bigint AS s FROM payment_allocations WHERE account_id=$1 AND invoice_id=$2', [accountId, invoiceId]);
  return Number(r.s);
}

/**
 * 受注内容から請求書（下書き）を作る。明細・調整・税設定・件名・支払条件を引き継ぐ。
 * requestId で冪等。同じ受注に未確定の下書きがあればそれを返す。
 */
export async function createInvoiceFromOrder(tx: Tx, s: Services, accountId: string, projectId: string, requestId: string, orderId?: string | null) {
  await lockRequest(tx, accountId, requestId);
  const byReq = await one(tx, 'SELECT id FROM invoices WHERE account_id=$1 AND request_id=$2', [accountId, requestId]);
  if (byReq) {
    const v = await one(tx, 'SELECT id FROM invoice_versions WHERE invoice_id=$1 ORDER BY revision DESC LIMIT 1', [byReq.id]);
    return { invoiceId: byReq.id as string, versionId: v.id as string, created: false };
  }
  await lockRequest(tx, accountId, `invoice-create:${projectId}`);
  await requireProject(tx, accountId, projectId, true);
  const order = orderId
    ? await one(tx, "SELECT * FROM orders WHERE account_id=$1 AND id=$2 AND project_id=$3 AND status='active'", [accountId, orderId, projectId])
    : await one(tx, "SELECT * FROM orders WHERE account_id=$1 AND project_id=$2 AND status='active'", [accountId, projectId]);
  if (!order) throw unprocessable('受注がありません。先に見積から受注を登録してください');
  const draft = await one(
    tx,
    `SELECT i.id AS invoice_id, v.id AS version_id FROM invoices i JOIN invoice_versions v ON v.invoice_id = i.id
     WHERE i.account_id=$1 AND i.order_id=$2 AND i.status='draft' AND v.status='draft' LIMIT 1`,
    [accountId, order.id],
  );
  if (draft) return { invoiceId: draft.invoice_id as string, versionId: draft.version_id as string, created: false };

  const b = await loadBusiness(tx, accountId);
  const snap = order.snapshot as DocSnapshot & { orderPaymentTerms?: string };
  const lines: Line[] = snap.lines.map((l) => ({
    id: crypto.randomUUID(),
    itemId: null,
    name: l.name,
    description: l.description,
    quantity: l.quantity,
    unit: l.unit,
    unitPrice: l.unitPrice,
    taxRate: l.taxRate,
  }));
  const adjustments: Adjustment[] = snap.adjustments.map((a) => ({ id: crypto.randomUUID(), ...a }));
  const totals = calculateTotals(lines, adjustments, snap);
  const today = s.today();
  const ir = await tx.query('INSERT INTO invoices (account_id, project_id, order_id, status, request_id) VALUES ($1,$2,$3,$4,$5) RETURNING id', [
    accountId,
    projectId,
    order.id,
    'draft',
    requestId,
  ]);
  const invoiceId = ir.rows[0].id as string;
  const vr = await tx.query(
    `INSERT INTO invoice_versions (account_id, invoice_id, revision, status, issue_date, due_date, subject, payment_terms, notes, bank_info,
       tax_mode, line_rounding, tax_rounding, lines, adjustments, subtotal, adjustment_total, tax_total, total, tax_breakdown)
     VALUES ($1,$2,1,'draft',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id`,
    [
      accountId,
      invoiceId,
      today,
      addDays(today, b.invoice_due_days),
      snap.subject,
      order.payment_terms,
      b.default_notes,
      b.bank_info,
      snap.taxMode,
      snap.lineRounding,
      snap.taxRounding,
      JSON.stringify(lines),
      JSON.stringify(adjustments),
      totals.subtotal,
      totals.adjustmentTotal,
      totals.taxTotal,
      totals.total,
      JSON.stringify(totals.taxBreakdown),
    ],
  );
  const versionId = vr.rows[0].id as string;
  await tx.query('UPDATE invoices SET current_version_id=$3 WHERE account_id=$1 AND id=$2', [accountId, invoiceId, versionId]);
  await logEvent(tx, accountId, projectId, 'invoice_created', '請求書の下書きを作成（受注内容を引継ぎ）', { refType: 'invoice', refId: invoiceId });
  return { invoiceId, versionId, created: true };
}

export async function updateInvoiceDraft(tx: Tx, accountId: string, versionId: string, input: InvoiceDraftInput) {
  const v = await requireInvoiceVersion(tx, accountId, versionId, true);
  if (v.status !== 'draft') throw conflict('確定済みの請求書は変更できません。「訂正版を作る」を使ってください', 'finalized');
  if (v.invoice_status === 'cancelled') throw conflict('取消済みの請求書は変更できません');
  const lines = input.lines.map((l) => ({ ...l, id: l.id || crypto.randomUUID() }));
  const totals = calculateTotals(lines, input.adjustments, input);
  await tx.query(
    `UPDATE invoice_versions SET issue_date=$3, due_date=$4, subject=$5, payment_terms=$6, notes=$7, bank_info=$8, tax_mode=$9, line_rounding=$10,
       tax_rounding=$11, lines=$12, adjustments=$13, subtotal=$14, adjustment_total=$15, tax_total=$16, total=$17, tax_breakdown=$18,
       correction_reason = CASE WHEN revision > 1 AND $19 <> '' THEN $19 ELSE correction_reason END, updated_at=now()
     WHERE account_id=$1 AND id=$2`,
    [
      accountId,
      versionId,
      input.issueDate,
      input.dueDate,
      input.subject,
      input.paymentTerms,
      input.notes,
      input.bankInfo,
      input.taxMode,
      input.lineRounding,
      input.taxRounding,
      JSON.stringify(lines),
      JSON.stringify(input.adjustments),
      totals.subtotal,
      totals.adjustmentTotal,
      totals.taxTotal,
      totals.total,
      JSON.stringify(totals.taxBreakdown),
      input.correctionReason ?? '',
    ],
  );
}

/**
 * 請求書（版）の確定。初回は採番して発行済みに。訂正版は旧版を superseded にし、
 * 割当済み入金額を下回る訂正は拒否する。確定済みなら何もしない（冪等）。
 */
export async function finalizeInvoiceVersion(tx: Tx, s: Services, accountId: string, versionId: string) {
  const v0 = await requireInvoiceVersion(tx, accountId, versionId);
  const inv = await requireInvoice(tx, accountId, v0.invoice_id, true);
  const v = await requireInvoiceVersion(tx, accountId, versionId, true);
  if (v.status !== 'draft') return { alreadyFinal: true, invoiceId: inv.id as string };
  if (inv.status === 'cancelled') throw conflict('取消済みの請求書は確定できません');
  if ((v.lines as Line[]).length === 0) throw unprocessable('明細を1行以上入力してください');
  if (!v.due_date) throw unprocessable('支払期限を入力してください');
  if (v.revision > 1 && !String(v.correction_reason).trim()) throw unprocessable('訂正理由を入力してください');

  const b = await loadBusiness(tx, accountId);
  const customer = await loadCustomerForProject(tx, accountId, inv.project_id);
  const number = inv.number ?? (await nextNumber(tx, accountId, 'invoice', s.today()));
  const snap = buildDocSnapshot('invoice', { ...v, previous_total: v.revision > 1 ? inv.total : null }, number, b, customer);
  snap.finalizedAt = s.now().toISOString();
  const newTotal = snap.totals!.total;
  const allocated = await allocatedFor(tx, accountId, inv.id);
  if (v.revision > 1 && newTotal < allocated) {
    throw unprocessable(
      `訂正後の金額（${newTotal.toLocaleString('ja-JP')}円）が、割当済みの入金額（${allocated.toLocaleString('ja-JP')}円）を下回ります。先に入金の割当を見直してください`,
      'below_allocated',
    );
  }
  const previousTotal = v.revision > 1 ? Number(inv.total) : null;
  await tx.query("UPDATE invoice_versions SET status='superseded', updated_at=now() WHERE account_id=$1 AND invoice_id=$2 AND status='final'", [
    accountId,
    inv.id,
  ]);
  await tx.query(
    `UPDATE invoice_versions SET status='final', snapshot=$3, finalized_at=$4, previous_total=$5, subtotal=$6, adjustment_total=$7, tax_total=$8, total=$9,
       tax_breakdown=$10, updated_at=now() WHERE account_id=$1 AND id=$2`,
    [
      accountId,
      versionId,
      JSON.stringify(snap),
      s.now(),
      previousTotal,
      snap.totals!.subtotal,
      snap.totals!.adjustmentTotal,
      snap.totals!.taxTotal,
      newTotal,
      JSON.stringify(snap.totals!.taxBreakdown),
    ],
  );
  await tx.query(
    `UPDATE invoices SET status='issued', number=$3, current_version_id=$4, issue_date=$5, due_date=$6, total=$7, updated_at=now() WHERE account_id=$1 AND id=$2`,
    [accountId, inv.id, number, versionId, v.issue_date, v.due_date, newTotal],
  );
  if (v.revision === 1) {
    await advanceProjectStatus(tx, accountId, inv.project_id, 'invoiced');
    await logEvent(tx, accountId, inv.project_id, 'invoice_issued', `請求書 ${number} を発行（${newTotal.toLocaleString('ja-JP')}円・期限 ${v.due_date}）`, {
      refType: 'invoice',
      refId: inv.id,
    });
  } else {
    await logEvent(
      tx,
      accountId,
      inv.project_id,
      'invoice_corrected',
      `請求書 ${number} を訂正（第${v.revision}版：${previousTotal!.toLocaleString('ja-JP')}円 → ${newTotal.toLocaleString('ja-JP')}円）`,
      { refType: 'invoice', refId: inv.id, note: v.correction_reason },
    );
  }
  return { alreadyFinal: false, invoiceId: inv.id as string };
}

/** 訂正版（下書き）を作る。発行済みのみ。既存の下書きがあればそれを返す */
export async function startCorrection(tx: Tx, accountId: string, invoiceId: string, requestId: string, reason: string) {
  await lockRequest(tx, accountId, requestId);
  const byReq = await one(tx, 'SELECT id FROM invoice_versions WHERE account_id=$1 AND request_id=$2', [accountId, requestId]);
  if (byReq) return { versionId: byReq.id as string, created: false };
  const inv = await requireInvoice(tx, accountId, invoiceId, true);
  if (inv.status !== 'issued') throw unprocessable('発行済みの請求書のみ訂正できます');
  const draft = await one(tx, "SELECT id FROM invoice_versions WHERE account_id=$1 AND invoice_id=$2 AND status='draft'", [accountId, invoiceId]);
  if (draft) return { versionId: draft.id as string, created: false };
  const cur = await one(tx, "SELECT * FROM invoice_versions WHERE account_id=$1 AND invoice_id=$2 AND status='final'", [accountId, invoiceId]);
  const r = await tx.query(
    `INSERT INTO invoice_versions (account_id, invoice_id, revision, status, issue_date, due_date, subject, payment_terms, notes, bank_info,
       tax_mode, line_rounding, tax_rounding, lines, adjustments, subtotal, adjustment_total, tax_total, total, tax_breakdown, correction_reason, previous_total, request_id)
     SELECT account_id, invoice_id, revision + 1, 'draft', issue_date, due_date, subject, payment_terms, notes, bank_info,
       tax_mode, line_rounding, tax_rounding, lines, adjustments, subtotal, adjustment_total, tax_total, total, tax_breakdown, $3, total, $4
     FROM invoice_versions WHERE account_id=$1 AND id=$2 RETURNING id`,
    [accountId, cur.id, reason, requestId],
  );
  await logEvent(tx, accountId, inv.project_id, 'invoice_correction_started', `請求書 ${inv.number} の訂正版（下書き）を作成`, {
    refType: 'invoice',
    refId: invoiceId,
    note: reason,
  });
  return { versionId: r.rows[0].id as string, created: true };
}

export async function discardInvoiceDraft(tx: Tx, accountId: string, versionId: string) {
  const v = await requireInvoiceVersion(tx, accountId, versionId, true);
  if (v.status !== 'draft') throw conflict('確定済みの請求書は削除できません。取消または訂正を使ってください', 'finalized');
  await tx.query('DELETE FROM invoice_versions WHERE account_id=$1 AND id=$2', [accountId, versionId]);
  const inv = await requireInvoice(tx, accountId, v.invoice_id, true);
  if (inv.status === 'draft') {
    await tx.query('DELETE FROM invoices WHERE account_id=$1 AND id=$2', [accountId, inv.id]);
    await logEvent(tx, accountId, inv.project_id, 'invoice_discarded', '請求書の下書きを破棄');
    return { invoiceDeleted: true };
  }
  const cur = await one(tx, "SELECT id FROM invoice_versions WHERE invoice_id=$1 AND status='final'", [inv.id]);
  await tx.query('UPDATE invoices SET current_version_id=$3 WHERE account_id=$1 AND id=$2', [accountId, inv.id, cur?.id ?? null]);
  await logEvent(tx, accountId, inv.project_id, 'invoice_correction_discarded', `請求書 ${inv.number} の訂正下書きを破棄`);
  return { invoiceDeleted: false };
}

/** 請求書の取消。入金が割り当てられている場合は不可 */
export async function cancelInvoice(tx: Tx, s: Services, accountId: string, invoiceId: string, reason: string) {
  const inv = await requireInvoice(tx, accountId, invoiceId, true);
  if (inv.status === 'cancelled') return;
  if (inv.status === 'draft') throw unprocessable('下書きは取消ではなく破棄してください');
  const allocated = await allocatedFor(tx, accountId, invoiceId);
  if (allocated > 0) throw unprocessable('入金が割り当てられている請求書は取消できません。先に入金の割当を解除してください');
  await tx.query("DELETE FROM invoice_versions WHERE account_id=$1 AND invoice_id=$2 AND status='draft'", [accountId, invoiceId]);
  await tx.query("UPDATE invoices SET status='cancelled', cancelled_at=$3, cancel_reason=$4, updated_at=now() WHERE account_id=$1 AND id=$2", [
    accountId,
    invoiceId,
    s.now(),
    reason,
  ]);
  await logEvent(tx, accountId, inv.project_id, 'invoice_cancelled', `請求書 ${inv.number} を取消`, { refType: 'invoice', refId: invoiceId, note: reason });
}
