import type { Queryable, Tx } from '../db';
import { lockRequest, one } from '../db';
import type { Services } from '../context';
import { notFound, unprocessable } from './errors';
import { nextNumber } from './numbering';
import { logEvent } from './events';

export interface ProjectInput {
  requestId?: string;
  customerId: string;
  title: string;
  inquiryDate: string | null;
  plannedStart: string | null;
  plannedDue: string | null;
  internalMemo: string;
}

export async function requireProject(q: Queryable, accountId: string, projectId: string, lock = false) {
  const p = await one(q, `SELECT * FROM projects WHERE account_id = $1 AND id = $2 ${lock ? 'FOR UPDATE' : ''}`, [accountId, projectId]);
  if (!p) throw notFound('案件');
  return p;
}

export async function requireCustomer(q: Queryable, accountId: string, customerId: string) {
  const c = await one(q, 'SELECT * FROM customers WHERE account_id = $1 AND id = $2', [accountId, customerId]);
  if (!c) throw notFound('顧客');
  return c;
}

/** 案件作成（requestId による冪等化：同じ requestId の再送は既存案件を返す） */
export async function createProject(tx: Tx, s: Services, accountId: string, input: ProjectInput): Promise<{ id: string; created: boolean }> {
  if (input.requestId) {
    await lockRequest(tx, accountId, input.requestId);
    const existing = await one(tx, 'SELECT id FROM projects WHERE account_id = $1 AND request_id = $2', [accountId, input.requestId]);
    if (existing) return { id: existing.id, created: false };
  }
  const customer = await requireCustomer(tx, accountId, input.customerId);
  if (customer.archived_at) throw unprocessable('アーカイブ済みの顧客には新しい案件を作成できません');
  const number = await nextNumber(tx, accountId, 'project', s.today());
  const r = await tx.query(
    `INSERT INTO projects (account_id, number, customer_id, title, inquiry_date, planned_start, planned_due, internal_memo, request_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (account_id, request_id) DO NOTHING
     RETURNING id`,
    [accountId, number, input.customerId, input.title, input.inquiryDate ?? s.today(), input.plannedStart, input.plannedDue, input.internalMemo, input.requestId ?? null],
  );
  if (!r.rows[0]) {
    // 同時送信で先行トランザクションが作成済み
    const existing = await one(tx, 'SELECT id FROM projects WHERE account_id = $1 AND request_id = $2', [accountId, input.requestId]);
    return { id: existing.id, created: false };
  }
  const id = r.rows[0].id as string;
  await tx.query('INSERT INTO project_status_history (account_id, project_id, from_status, to_status, note) VALUES ($1,$2,NULL,$3,$4)', [
    accountId,
    id,
    'inquiry',
    '案件作成',
  ]);
  await logEvent(tx, accountId, id, 'created', `案件を作成（${number}）`);
  return { id, created: true };
}
