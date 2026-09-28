import crypto from 'node:crypto';
import type { Queryable, Tx } from '../db';
import { lockRequest, many, one } from '../db';
import type { Services } from '../context';
import { summarizePayment, formatYen } from '../../../shared/calc';
import { notFound, unprocessable, conflict } from './errors';
import { logEvent } from './events';
import { allocatedFor, requireInvoice } from './invoices';

export interface PaymentInput {
  requestId: string;
  receivedOn: string;
  amount: number;
  method: string;
  payerName: string;
  memo: string;
}

export async function requirePayment(q: Queryable, accountId: string, paymentId: string, lock = false) {
  const p = await one(q, `SELECT * FROM payments WHERE account_id=$1 AND id=$2 ${lock ? 'FOR UPDATE' : ''}`, [accountId, paymentId]);
  if (!p) throw notFound('入金');
  return p;
}

export async function unallocatedOf(q: Queryable, accountId: string, paymentId: string): Promise<number> {
  const r = await one(
    q,
    `SELECT p.amount - COALESCE((SELECT sum(a.amount) FROM payment_allocations a WHERE a.payment_id = p.id),0) AS rest
     FROM payments p WHERE p.account_id=$1 AND p.id=$2`,
    [accountId, paymentId],
  );
  return Number(r?.rest ?? 0);
}

async function invoiceStateNote(tx: Tx, s: Services, accountId: string, invoiceId: string) {
  const inv = await requireInvoice(tx, accountId, invoiceId);
  const sum = summarizePayment(Number(inv.total), await allocatedFor(tx, accountId, invoiceId), inv.due_date, s.today());
  return { inv, sum };
}

/** 入金の登録（未割当）。requestId で冪等 */
export async function createPayment(tx: Tx, accountId: string, input: PaymentInput, source: 'manual' | 'bank_csv' = 'manual') {
  await lockRequest(tx, accountId, input.requestId);
  const existing = await one(tx, 'SELECT * FROM payments WHERE account_id=$1 AND request_id=$2', [accountId, input.requestId]);
  if (existing) return { payment: existing, created: false };
  const r = await tx.query(
    `INSERT INTO payments (account_id, received_on, amount, method, payer_name, memo, source, request_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [accountId, input.receivedOn, input.amount, input.method, input.payerName, input.memo, source, input.requestId],
  );
  return { payment: r.rows[0], created: true };
}

/** 入金の割当（利用者の確定操作でのみ行う）。requestId で冪等。未割当額を超える割当は拒否 */
export async function allocatePayment(tx: Tx, s: Services, accountId: string, paymentId: string, input: { requestId: string; invoiceId: string; amount: number }) {
  await lockRequest(tx, accountId, input.requestId);
  const existing = await one(tx, 'SELECT * FROM payment_allocations WHERE account_id=$1 AND request_id=$2', [accountId, input.requestId]);
  if (existing) return { allocation: existing, created: false };
  const payment = await requirePayment(tx, accountId, paymentId, true);
  const inv = await requireInvoice(tx, accountId, input.invoiceId, true);
  if (inv.status !== 'issued') throw unprocessable('発行済みの請求書にのみ入金を割り当てられます');
  const rest = await unallocatedOf(tx, accountId, paymentId);
  if (input.amount > rest) throw unprocessable(`割当額が入金の未割当額（${formatYen(rest)}）を超えています`);
  const r = await tx.query('INSERT INTO payment_allocations (account_id, payment_id, invoice_id, amount, request_id) VALUES ($1,$2,$3,$4,$5) RETURNING *', [
    accountId,
    paymentId,
    input.invoiceId,
    input.amount,
    input.requestId,
  ]);
  const { sum } = await invoiceStateNote(tx, s, accountId, input.invoiceId);
  const stateLabel = { unpaid: '未入金', partial: '一部入金', paid: '入金済み', overpaid: '過入金' }[sum.state];
  await logEvent(
    tx,
    accountId,
    inv.project_id,
    'payment',
    `入金 ${formatYen(input.amount)} を請求書 ${inv.number} に割当（${payment.received_on}）→ ${stateLabel}${sum.remaining > 0 ? `・残額 ${formatYen(sum.remaining)}` : ''}${sum.overpaidAmount > 0 ? `・過入金 ${formatYen(sum.overpaidAmount)}` : ''}`,
    { refType: 'invoice', refId: inv.id },
  );
  return { allocation: r.rows[0], created: true };
}

/** 請求書からの手入力入金：入金登録と割当を1トランザクションで行う */
export async function recordInvoicePayment(tx: Tx, s: Services, accountId: string, invoiceId: string, input: PaymentInput) {
  const inv = await requireInvoice(tx, accountId, invoiceId);
  if (inv.status !== 'issued') throw unprocessable('発行済みの請求書にのみ入金を記録できます');
  const { payment, created } = await createPayment(tx, accountId, input);
  if (created) {
    await allocatePayment(tx, s, accountId, payment.id, { requestId: `${input.requestId}:alloc`, invoiceId, amount: input.amount });
  }
  return { payment, created };
}

export async function removeAllocation(tx: Tx, accountId: string, allocationId: string) {
  const a = await one(
    tx,
    `SELECT a.*, i.project_id, i.number FROM payment_allocations a JOIN invoices i ON i.id = a.invoice_id WHERE a.account_id=$1 AND a.id=$2`,
    [accountId, allocationId],
  );
  if (!a) throw notFound('割当');
  await tx.query('DELETE FROM payment_allocations WHERE account_id=$1 AND id=$2', [accountId, allocationId]);
  await logEvent(tx, accountId, a.project_id, 'payment_unallocated', `請求書 ${a.number} への入金割当 ${formatYen(Number(a.amount))} を解除`, {
    refType: 'invoice',
    refId: a.invoice_id,
  });
}

export async function deletePayment(tx: Tx, accountId: string, paymentId: string) {
  const p = await requirePayment(tx, accountId, paymentId, true);
  const allocs = await many(tx, 'SELECT a.*, i.project_id, i.number FROM payment_allocations a JOIN invoices i ON i.id=a.invoice_id WHERE a.payment_id=$1', [p.id]);
  for (const a of allocs) {
    await logEvent(tx, accountId, a.project_id, 'payment_deleted', `入金 ${formatYen(Number(a.amount))}（${p.received_on}）を削除し、請求書 ${a.number} の割当を解除`, {
      refType: 'invoice',
      refId: a.invoice_id,
    });
  }
  await tx.query('DELETE FROM payments WHERE account_id=$1 AND id=$2', [accountId, paymentId]);
}

// ---------------- 銀行CSV ----------------

export interface BankRow {
  date: string;
  name: string;
  amount: number;
}

export function normalizePayerName(name: string): string {
  return name
    .normalize('NFKC')
    .replace(/\s+/g, '')
    .replace(/(株式会社|有限会社|合同会社|\(株\)|\(有\)|\(同\)|カブシキガイシャ|カ\)|\(カ|ユ\)|ド\))/g, '')
    .toUpperCase();
}

/** 行キー：日付|正規化名義|金額|同一内容の出現順。重複行の再取込を防ぐ */
export function bankRowKeys(rows: BankRow[]): string[] {
  const seen = new Map<string, number>();
  return rows.map((r) => {
    const base = `${r.date}|${normalizePayerName(r.name)}|${r.amount}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return crypto.createHash('sha256').update(`${base}|${n}`).digest('hex');
  });
}

export function bankContentHash(rows: BankRow[]): string {
  const canonical = rows.map((r) => `${r.date}|${r.name}|${r.amount}`).join('\n');
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

/**
 * 銀行CSV（入金行のみ、クライアントで列マッピング済み）を未割当入金として取り込む。
 * 同一内容のCSVは拒否、既に取り込んだ行（行キー一致）はスキップ。割当は行わない。
 */
export async function importBankRows(
  tx: Tx,
  accountId: string,
  input: { filename: string; encoding: string; mapping: unknown; rowCount: number; rows: BankRow[] },
) {
  const hash = bankContentHash(input.rows);
  await lockRequest(tx, accountId, 'bank-import'); // 期間が重なるCSVの同時取込も直列化
  const dup = await one(tx, 'SELECT id, created_at FROM bank_imports WHERE account_id=$1 AND file_sha256=$2', [accountId, hash]);
  if (dup) throw conflict('このCSVはすでに取り込まれています（同じ内容のファイル）', 'duplicate_import');
  if (input.rows.length === 0) throw unprocessable('取り込める入金行がありません');
  const keys = bankRowKeys(input.rows);
  const existing = new Set(
    (await many(tx, 'SELECT row_key FROM payments WHERE account_id=$1 AND row_key = ANY($2::text[])', [accountId, keys])).map((r) => r.row_key as string),
  );
  const ir = await tx.query(
    `INSERT INTO bank_imports (account_id, file_sha256, filename, encoding, mapping, row_count, imported_count, skipped_count)
     VALUES ($1,$2,$3,$4,$5,$6,0,0) RETURNING id`,
    [accountId, hash, input.filename, input.encoding, JSON.stringify(input.mapping), input.rowCount],
  );
  const importId = ir.rows[0].id as string;
  let imported = 0;
  let skipped = 0;
  for (let i = 0; i < input.rows.length; i++) {
    const r = input.rows[i];
    if (existing.has(keys[i])) {
      skipped++;
      continue;
    }
    await tx.query(
      `INSERT INTO payments (account_id, received_on, amount, method, payer_name, memo, source, bank_import_id, row_key)
       VALUES ($1,$2,$3,'bank_transfer',$4,'','bank_csv',$5,$6)`,
      [accountId, r.date, r.amount, r.name, importId, keys[i]],
    );
    imported++;
  }
  await tx.query('UPDATE bank_imports SET imported_count=$3, skipped_count=$4 WHERE account_id=$1 AND id=$2', [accountId, importId, imported, skipped]);
  return { importId, imported, skipped };
}

export interface Candidate {
  invoiceId: string;
  number: string;
  customerName: string;
  projectTitle: string;
  remaining: number;
  dueDate: string | null;
  score: number;
  reasons: string[];
}

/** 未割当入金に対する請求書候補を返す（自動確定はしない） */
export async function candidatesFor(q: Queryable, s: Services, accountId: string, paymentId: string) {
  const p = await requirePayment(q, accountId, paymentId);
  const rest = await unallocatedOf(q, accountId, paymentId);
  const invs = await many(
    q,
    `SELECT i.id, i.number, i.total, i.due_date, i.issue_date, c.name AS customer_name, c.payer_name, pr.title AS project_title,
            COALESCE((SELECT sum(a.amount) FROM payment_allocations a WHERE a.invoice_id=i.id),0)::bigint AS allocated
     FROM invoices i JOIN projects pr ON pr.id = i.project_id JOIN customers c ON c.id = pr.customer_id
     WHERE i.account_id=$1 AND i.status='issued'`,
    [accountId],
  );
  const payer = normalizePayerName(p.payer_name);
  const out: Candidate[] = [];
  for (const inv of invs) {
    const remaining = Number(inv.total) - Number(inv.allocated);
    if (remaining <= 0) continue;
    let score = 0;
    const reasons: string[] = [];
    if (remaining === rest) {
      score += 60;
      reasons.push('残額と入金額が一致');
    } else if (rest < remaining) {
      score += 10;
      reasons.push('一部入金の可能性');
    }
    const names = [inv.customer_name, inv.payer_name].map((n: string) => normalizePayerName(n ?? '')).filter((n: string) => n.length >= 2);
    if (payer && names.some((n: string) => payer.includes(n) || n.includes(payer))) {
      score += 40;
      reasons.push('名義と顧客名が一致');
    }
    if (inv.issue_date && p.received_on < inv.issue_date) score -= 20;
    if (score <= 10 && !reasons.includes('名義と顧客名が一致')) continue;
    out.push({
      invoiceId: inv.id,
      number: inv.number,
      customerName: inv.customer_name,
      projectTitle: inv.project_title,
      remaining,
      dueDate: inv.due_date,
      score,
      reasons,
    });
  }
  out.sort((a, b) => b.score - a.score || (a.dueDate ?? '').localeCompare(b.dueDate ?? ''));
  const top = out.filter((c) => c.score === out[0]?.score);
  const needsReview = out.length === 0 || top.length > 1 || out[0].score < 100;
  return { payment: { ...p, unallocated: rest }, candidates: out.slice(0, 10), needsReview, ambiguous: top.length > 1 };
}
