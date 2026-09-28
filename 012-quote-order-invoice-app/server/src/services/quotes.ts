import crypto from 'node:crypto';
import type { Queryable, Tx } from '../db';
import { lockRequest, one } from '../db';
import type { Services } from '../context';
import type { Adjustment, Line, RoundingMode, TaxMode } from '../../../shared/calc';
import { calculateTotals } from '../../../shared/calc';
import { addDays } from '../../../shared/dates';
import { conflict, notFound, unprocessable } from './errors';
import { nextNumber } from './numbering';
import { advanceProjectStatus, logEvent, setProjectStatus } from './events';
import { requireProject } from './projects';
import { buildDocSnapshot, loadBusiness, loadCustomerForProject } from './snapshot';
import { CLOSED_STATUSES } from '../../../shared/status';

export interface QuoteDraftInput {
  issueDate: string;
  validUntil: string | null;
  subject: string;
  deliveryNote: string;
  paymentTerms: string;
  notes: string;
  taxMode: TaxMode;
  lineRounding: RoundingMode;
  taxRounding: RoundingMode;
  lines: Line[];
  adjustments: Adjustment[];
  changeMemo: string;
}

export async function requireQuoteVersion(q: Queryable, accountId: string, versionId: string, lock = false) {
  const v = await one(
    q,
    `SELECT v.*, qu.number FROM quote_versions v JOIN quotes qu ON qu.account_id = v.account_id AND qu.id = v.quote_id
     WHERE v.account_id = $1 AND v.id = $2 ${lock ? 'FOR UPDATE OF v' : ''}`,
    [accountId, versionId],
  );
  if (!v) throw notFound('見積');
  return v;
}

function assertOpenProject(p: any) {
  if (CLOSED_STATUSES.includes(p.status)) throw unprocessable('完了・失注・キャンセルの案件では見積を編集できません。先に案件の状態を戻してください');
}

/** 案件に見積（v1下書き）を作成。requestIdで冪等 */
export async function createQuote(tx: Tx, s: Services, accountId: string, projectId: string, requestId: string) {
  await lockRequest(tx, accountId, requestId);
  const existing = await one(tx, 'SELECT id FROM quote_versions WHERE account_id = $1 AND request_id = $2', [accountId, requestId]);
  if (existing) return { versionId: existing.id as string, created: false };
  const project = await requireProject(tx, accountId, projectId, true);
  assertOpenProject(project);
  const b = await loadBusiness(tx, accountId);
  const customer = await loadCustomerForProject(tx, accountId, projectId);
  const number = await nextNumber(tx, accountId, 'quote', s.today());
  const qr = await tx.query('INSERT INTO quotes (account_id, project_id, number, request_id) VALUES ($1,$2,$3,$4) RETURNING id', [
    accountId,
    projectId,
    number,
    requestId,
  ]);
  const quoteId = qr.rows[0].id as string;
  const today = s.today();
  const vr = await tx.query(
    `INSERT INTO quote_versions (account_id, quote_id, project_id, version, status, issue_date, valid_until, subject, delivery_note, payment_terms, notes,
       tax_mode, line_rounding, tax_rounding, lines, adjustments, request_id)
     VALUES ($1,$2,$3,1,'draft',$4,$5,$6,$7,$8,$9,$10,$11,$12,'[]','[]',$13) RETURNING id`,
    [
      accountId,
      quoteId,
      projectId,
      today,
      b.quote_valid_days > 0 ? addDays(today, b.quote_valid_days) : null,
      project.title,
      project.planned_due ?? '',
      customer.payment_terms || b.default_payment_terms,
      b.default_notes,
      b.tax_mode,
      b.line_rounding,
      b.tax_rounding,
      requestId,
    ],
  );
  const versionId = vr.rows[0].id as string;
  await advanceProjectStatus(tx, accountId, projectId, 'quoting');
  await logEvent(tx, accountId, projectId, 'quote_created', `見積を作成（${number} v1 下書き）`, { refType: 'quote_version', refId: versionId });
  return { versionId, created: true };
}

export async function updateQuoteDraft(tx: Tx, accountId: string, versionId: string, input: QuoteDraftInput) {
  const v = await requireQuoteVersion(tx, accountId, versionId, true);
  if (v.status !== 'draft') throw conflict('確定済みの版は変更できません。「この版をもとに新しい版を作る」を使ってください', 'finalized');
  const project = await requireProject(tx, accountId, v.project_id);
  assertOpenProject(project);
  const lines = input.lines.map((l) => ({ ...l, id: l.id || crypto.randomUUID() }));
  const totals = calculateTotals(lines, input.adjustments, input);
  await tx.query(
    `UPDATE quote_versions SET issue_date=$3, valid_until=$4, subject=$5, delivery_note=$6, payment_terms=$7, notes=$8,
       tax_mode=$9, line_rounding=$10, tax_rounding=$11, lines=$12, adjustments=$13, subtotal=$14, adjustment_total=$15, tax_total=$16,
       total=$17, tax_breakdown=$18, change_memo=$19, updated_at=now()
     WHERE account_id=$1 AND id=$2`,
    [
      accountId,
      versionId,
      input.issueDate,
      input.validUntil,
      input.subject,
      input.deliveryNote,
      input.paymentTerms,
      input.notes,
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
      input.changeMemo,
    ],
  );
}

/** 版を確定（スナップショット保存）。確定済みなら何もしない（冪等） */
export async function finalizeQuoteVersion(tx: Tx, s: Services, accountId: string, versionId: string) {
  const v = await requireQuoteVersion(tx, accountId, versionId, true);
  if (v.status === 'final') return { alreadyFinal: true };
  if ((v.lines as Line[]).length === 0) throw unprocessable('明細を1行以上入力してください');
  const b = await loadBusiness(tx, accountId);
  const customer = await loadCustomerForProject(tx, accountId, v.project_id);
  const snap = buildDocSnapshot('quote', v, `${v.number}`, b, customer);
  snap.finalizedAt = s.now().toISOString();
  await tx.query(
    `UPDATE quote_versions SET status='final', snapshot=$3, finalized_at=$4, subtotal=$5, adjustment_total=$6, tax_total=$7, total=$8, tax_breakdown=$9, updated_at=now()
     WHERE account_id=$1 AND id=$2`,
    [
      accountId,
      versionId,
      JSON.stringify(snap),
      s.now(),
      snap.totals!.subtotal,
      snap.totals!.adjustmentTotal,
      snap.totals!.taxTotal,
      snap.totals!.total,
      JSON.stringify(snap.totals!.taxBreakdown),
    ],
  );
  await logEvent(tx, accountId, v.project_id, 'quote_finalized', `見積 ${v.number} v${v.version} を確定（${snap.totals!.total.toLocaleString('ja-JP')}円）`, {
    refType: 'quote_version',
    refId: versionId,
  });
  return { alreadyFinal: false };
}

/** 確定済みの版を複製して次の版の下書きを作る。既に下書きがあればそれを返す */
export async function createNextVersion(tx: Tx, accountId: string, versionId: string, requestId: string) {
  await lockRequest(tx, accountId, requestId);
  const byReq = await one(tx, 'SELECT id FROM quote_versions WHERE account_id=$1 AND request_id=$2', [accountId, requestId]);
  if (byReq) return { versionId: byReq.id as string, created: false };
  const base = await requireQuoteVersion(tx, accountId, versionId);
  const project = await requireProject(tx, accountId, base.project_id, true);
  assertOpenProject(project);
  await tx.query('SELECT id FROM quotes WHERE account_id=$1 AND id=$2 FOR UPDATE', [accountId, base.quote_id]);
  const draft = await one(tx, "SELECT id FROM quote_versions WHERE account_id=$1 AND quote_id=$2 AND status='draft'", [accountId, base.quote_id]);
  if (draft) return { versionId: draft.id as string, created: false };
  const accepted = await one(tx, "SELECT o.id FROM orders o JOIN quote_versions v ON v.id = o.quote_version_id WHERE v.quote_id=$1 AND o.status='active'", [
    base.quote_id,
  ]);
  if (accepted) throw unprocessable('受注済みの見積は改訂できません。受注を取り消してから改訂してください');
  const max = await one(tx, 'SELECT max(version) AS m FROM quote_versions WHERE quote_id=$1', [base.quote_id]);
  const version = (max.m as number) + 1;
  const r = await tx.query(
    `INSERT INTO quote_versions (account_id, quote_id, project_id, version, status, issue_date, valid_until, subject, delivery_note, payment_terms, notes,
       tax_mode, line_rounding, tax_rounding, lines, adjustments, subtotal, adjustment_total, tax_total, total, tax_breakdown, based_on_version_id, request_id)
     SELECT account_id, quote_id, project_id, $3, 'draft', issue_date, valid_until, subject, delivery_note, payment_terms, notes,
       tax_mode, line_rounding, tax_rounding, lines, adjustments, subtotal, adjustment_total, tax_total, total, tax_breakdown, id, $4
     FROM quote_versions WHERE account_id=$1 AND id=$2 RETURNING id`,
    [accountId, versionId, version, requestId],
  );
  const newId = r.rows[0].id as string;
  await logEvent(tx, accountId, base.project_id, 'quote_revised', `見積 ${base.number} v${version} を作成（v${base.version} から複製）`, {
    refType: 'quote_version',
    refId: newId,
  });
  return { versionId: newId, created: true };
}

/** 「提出済みにする」：提出日と版を記録。下書きなら先に確定する。実際の送信は行わない */
export async function submitQuoteVersion(tx: Tx, s: Services, accountId: string, versionId: string, submittedOn: string) {
  await finalizeQuoteVersion(tx, s, accountId, versionId);
  const v = await requireQuoteVersion(tx, accountId, versionId, true);
  if (v.submitted_at) return { alreadySubmitted: true };
  await tx.query('UPDATE quote_versions SET submitted_at=$3, submitted_on=$4, updated_at=now() WHERE account_id=$1 AND id=$2', [
    accountId,
    versionId,
    s.now(),
    submittedOn,
  ]);
  await advanceProjectStatus(tx, accountId, v.project_id, 'quote_submitted');
  await logEvent(tx, accountId, v.project_id, 'quote_submitted', `見積 ${v.number} v${v.version} を提出済みに記録（提出日 ${submittedOn}）`, {
    refType: 'quote_version',
    refId: versionId,
  });
  return { alreadySubmitted: false };
}

/** 失注：案件を失注にし、版に記録。請求は作らない */
export async function declineQuote(tx: Tx, s: Services, accountId: string, versionId: string, reason: string) {
  const v = await requireQuoteVersion(tx, accountId, versionId, true);
  const order = await one(tx, "SELECT id FROM orders WHERE account_id=$1 AND project_id=$2 AND status='active'", [accountId, v.project_id]);
  if (order) throw unprocessable('受注済みの案件は失注にできません');
  if (!v.declined_at) await tx.query('UPDATE quote_versions SET declined_at=$3 WHERE account_id=$1 AND id=$2', [accountId, versionId, s.now()]);
  await setProjectStatus(tx, accountId, v.project_id, 'lost', reason || '見積が不採用');
  await logEvent(tx, accountId, v.project_id, 'lost', `失注（${v.number} v${v.version}）`, { refType: 'quote_version', refId: versionId, note: reason });
}

/** 下書き版の破棄（v1の場合は見積ごと削除） */
export async function discardQuoteDraft(tx: Tx, accountId: string, versionId: string) {
  const v = await requireQuoteVersion(tx, accountId, versionId, true);
  if (v.status !== 'draft') throw conflict('確定済みの版は削除できません', 'finalized');
  await tx.query('DELETE FROM quote_versions WHERE account_id=$1 AND id=$2', [accountId, versionId]);
  const rest = await one(tx, 'SELECT count(*)::int AS n FROM quote_versions WHERE quote_id=$1', [v.quote_id]);
  if (rest.n === 0) await tx.query('DELETE FROM quotes WHERE account_id=$1 AND id=$2', [accountId, v.quote_id]);
  await logEvent(tx, accountId, v.project_id, 'quote_discarded', `見積 ${v.number} v${v.version} の下書きを破棄`);
}
