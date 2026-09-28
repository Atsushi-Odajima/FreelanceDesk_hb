import type { Tx } from '../db';

export type NumberKind = 'project' | 'quote' | 'invoice' | 'delivery';
const PREFIX: Record<NumberKind, string> = { project: 'P', quote: 'Q', invoice: 'INV', delivery: 'D' };

/** 年ごとの連番を採番（トランザクション内、行ロックで重複防止）。例: INV-2026-0001 */
export async function nextNumber(tx: Tx, accountId: string, kind: NumberKind, today: string): Promise<string> {
  const year = Number(today.slice(0, 4));
  const r = await tx.query(
    `INSERT INTO counters (account_id, kind, year, next_value) VALUES ($1, $2, $3, 2)
     ON CONFLICT (account_id, kind, year) DO UPDATE SET next_value = counters.next_value + 1
     RETURNING next_value - 1 AS value`,
    [accountId, kind, year],
  );
  const value = r.rows[0].value as number;
  return `${PREFIX[kind]}-${year}-${String(value).padStart(4, '0')}`;
}
