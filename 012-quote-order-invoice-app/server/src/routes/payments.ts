import { Hono } from 'hono';
import { z } from 'zod';
import { type AppEnv, body, idParam, query, type Services } from '../context';
import { many, withTx } from '../db';
import { allocationSchema, bankImportSchema, paymentSchema } from '../schemas';
import { camelRow, camelRows } from '../services/format';
import { allocatePayment, candidatesFor, createPayment, deletePayment, importBankRows, removeAllocation } from '../services/payments';
import { listPayments } from '../services/queries';

export function paymentRoutes(s: Services) {
  const r = new Hono<AppEnv>();

  r.get('/payments', async (c) => {
    const q = query(
      c,
      z.object({
        from: z.string().max(10).optional(),
        to: z.string().max(10).optional(),
        unallocated: z.enum(['1']).optional(),
        q: z.string().max(100).optional(),
      }),
    );
    const rows = await listPayments(s.pool, c.get('accountId'), { from: q.from, to: q.to, unallocatedOnly: q.unallocated === '1', q: q.q });
    return c.json({ payments: rows });
  });

  // 請求書に紐づけない入金の登録（後で割当）
  r.post('/payments', async (c) => {
    const i = await body(c, paymentSchema);
    const res = await withTx(s.pool, (tx) => createPayment(tx, c.get('accountId'), i));
    return c.json({ payment: camelRow(res.payment), created: res.created }, res.created ? 201 : 200);
  });

  r.delete('/payments/:id', async (c) => {
    await withTx(s.pool, (tx) => deletePayment(tx, c.get('accountId'), idParam(c)));
    return c.json({ ok: true });
  });

  r.get('/payments/:id/candidates', async (c) => {
    const res = await candidatesFor(s.pool, s, c.get('accountId'), idParam(c));
    return c.json({ ...res, payment: camelRow(res.payment) });
  });

  // 利用者の確認後にのみ割当
  r.post('/payments/:id/allocations', async (c) => {
    const i = await body(c, allocationSchema);
    const res = await withTx(s.pool, (tx) => allocatePayment(tx, s, c.get('accountId'), idParam(c), i));
    return c.json({ allocation: camelRow(res.allocation), created: res.created }, res.created ? 201 : 200);
  });

  r.delete('/allocations/:id', async (c) => {
    await withTx(s.pool, (tx) => removeAllocation(tx, c.get('accountId'), idParam(c)));
    return c.json({ ok: true });
  });

  // 銀行CSV：ブラウザで解析・列マッピングした入金行（日付・名義・金額のみ）を受け取る。CSV本文は保存・ログ出力しない
  r.post('/bank-imports', async (c) => {
    const i = await body(c, bankImportSchema);
    const res = await withTx(s.pool, (tx) => importBankRows(tx, c.get('accountId'), i));
    return c.json(res, 201);
  });

  r.get('/bank-imports', async (c) => {
    const rows = await many(
      s.pool,
      'SELECT id, filename, encoding, row_count, imported_count, skipped_count, created_at FROM bank_imports WHERE account_id=$1 ORDER BY created_at DESC LIMIT 100',
      [c.get('accountId')],
    );
    return c.json({ imports: camelRows(rows) });
  });

  return r;
}
