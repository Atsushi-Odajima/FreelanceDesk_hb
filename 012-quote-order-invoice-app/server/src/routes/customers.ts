import { Hono } from 'hono';
import { z } from 'zod';
import { type AppEnv, body, idParam, query, type Services } from '../context';
import { lockRequest, many, one, withTx } from '../db';
import { customerSchema } from '../schemas';
import { camelRow, camelRows } from '../services/format';
import { conflict, notFound } from '../services/errors';

export function customerRoutes(s: Services) {
  const r = new Hono<AppEnv>();

  r.get('/', async (c) => {
    const q = query(c, z.object({ q: z.string().max(100).optional(), archived: z.enum(['0', '1', 'all']).optional() }));
    const params: unknown[] = [c.get('accountId')];
    let where = 'c.account_id=$1';
    if (q.archived === '1') where += ' AND c.archived_at IS NOT NULL';
    else if (q.archived !== 'all') where += ' AND c.archived_at IS NULL';
    if (q.q) {
      params.push(`%${q.q}%`);
      where += ` AND (c.name ILIKE $${params.length} OR c.code ILIKE $${params.length} OR c.contact_name ILIKE $${params.length})`;
    }
    const rows = await many(
      s.pool,
      `SELECT c.*, (SELECT count(*)::int FROM projects p WHERE p.customer_id=c.id) AS project_count
       FROM customers c WHERE ${where} ORDER BY c.archived_at NULLS FIRST, c.code NULLS LAST, c.name LIMIT 1000`,
      params,
    );
    return c.json({ customers: camelRows(rows) });
  });

  r.get('/:id', async (c) => {
    const id = idParam(c);
    const row = await one(s.pool, 'SELECT * FROM customers WHERE account_id=$1 AND id=$2', [c.get('accountId'), id]);
    if (!row) throw notFound('顧客');
    const projects = await many(
      s.pool,
      'SELECT id, number, title, status, planned_due, created_at FROM projects WHERE account_id=$1 AND customer_id=$2 ORDER BY created_at DESC',
      [c.get('accountId'), id],
    );
    return c.json({ customer: camelRow(row), projects: camelRows(projects) });
  });

  r.post('/', async (c) => {
    const i = await body(c, customerSchema);
    const accountId = c.get('accountId');
    const row = await withTx(s.pool, async (tx) => {
      if (i.requestId) {
        await lockRequest(tx, accountId, i.requestId);
        const ex = await one(tx, 'SELECT * FROM customers WHERE account_id=$1 AND request_id=$2', [accountId, i.requestId]);
        if (ex) return ex;
      }
      if (i.code) {
        const dup = await one(tx, 'SELECT id FROM customers WHERE account_id=$1 AND code=$2', [accountId, i.code]);
        if (dup) throw conflict(`顧客コード「${i.code}」はすでに使われています`);
      }
      return one(
        tx,
        `INSERT INTO customers (account_id, code, name, contact_name, honorific, postal_code, address, phone, email, payment_terms, payer_name, internal_memo, request_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [accountId, i.code, i.name, i.contactName, i.honorific, i.postalCode, i.address, i.phone, i.email, i.paymentTerms, i.payerName, i.internalMemo, i.requestId ?? null],
      );
    });
    return c.json({ customer: camelRow(row) }, 201);
  });

  r.put('/:id', async (c) => {
    const id = idParam(c);
    const i = await body(c, customerSchema);
    if (i.code) {
      const dup = await one(s.pool, 'SELECT id FROM customers WHERE account_id=$1 AND code=$2 AND id<>$3', [c.get('accountId'), i.code, id]);
      if (dup) throw conflict(`顧客コード「${i.code}」はすでに使われています`);
    }
    const row = await one(
      s.pool,
      `UPDATE customers SET code=$3, name=$4, contact_name=$5, honorific=$6, postal_code=$7, address=$8, phone=$9, email=$10, payment_terms=$11,
         payer_name=$12, internal_memo=$13, updated_at=now()
       WHERE account_id=$1 AND id=$2 RETURNING *`,
      [c.get('accountId'), id, i.code, i.name, i.contactName, i.honorific, i.postalCode, i.address, i.phone, i.email, i.paymentTerms, i.payerName, i.internalMemo],
    );
    if (!row) throw notFound('顧客');
    return c.json({ customer: camelRow(row) });
  });

  r.post('/:id/archive', async (c) => {
    const row = await one(s.pool, 'UPDATE customers SET archived_at=COALESCE(archived_at, now()), updated_at=now() WHERE account_id=$1 AND id=$2 RETURNING *', [
      c.get('accountId'),
      idParam(c),
    ]);
    if (!row) throw notFound('顧客');
    return c.json({ customer: camelRow(row) });
  });

  r.post('/:id/unarchive', async (c) => {
    const row = await one(s.pool, 'UPDATE customers SET archived_at=NULL, updated_at=now() WHERE account_id=$1 AND id=$2 RETURNING *', [
      c.get('accountId'),
      idParam(c),
    ]);
    if (!row) throw notFound('顧客');
    return c.json({ customer: camelRow(row) });
  });

  // 取引（案件）がある顧客は削除できない → アーカイブを案内
  r.delete('/:id', async (c) => {
    const id = idParam(c);
    const used = await one(s.pool, 'SELECT count(*)::int AS n FROM projects WHERE account_id=$1 AND customer_id=$2', [c.get('accountId'), id]);
    if (used.n > 0) throw conflict('この顧客には案件（取引）があるため削除できません。アーカイブしてください', 'has_projects');
    const r2 = await s.pool.query('DELETE FROM customers WHERE account_id=$1 AND id=$2', [c.get('accountId'), id]);
    if (!r2.rowCount) throw notFound('顧客');
    return c.json({ ok: true });
  });

  return r;
}
