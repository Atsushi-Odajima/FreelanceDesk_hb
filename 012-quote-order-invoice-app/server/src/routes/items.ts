import { Hono } from 'hono';
import { z } from 'zod';
import { type AppEnv, body, idParam, query, type Services } from '../context';
import { lockRequest, many, one, withTx } from '../db';
import { itemSchema } from '../schemas';
import { camelRow, camelRows } from '../services/format';
import { conflict, notFound } from '../services/errors';

// 品目マスター。変更しても確定済み書類（スナップショット）には影響しない
export function itemRoutes(s: Services) {
  const r = new Hono<AppEnv>();

  r.get('/', async (c) => {
    const q = query(c, z.object({ q: z.string().max(100).optional(), archived: z.enum(['0', '1', 'all']).optional() }));
    const params: unknown[] = [c.get('accountId')];
    let where = 'account_id=$1';
    if (q.archived === '1') where += ' AND archived_at IS NOT NULL';
    else if (q.archived !== 'all') where += ' AND archived_at IS NULL';
    if (q.q) {
      params.push(`%${q.q}%`);
      where += ` AND (name ILIKE $2 OR code ILIKE $2 OR description ILIKE $2)`;
    }
    const rows = await many(s.pool, `SELECT * FROM items WHERE ${where} ORDER BY archived_at NULLS FIRST, code, name LIMIT 1000`, params);
    return c.json({ items: camelRows(rows) });
  });

  r.post('/', async (c) => {
    const i = await body(c, itemSchema);
    const accountId = c.get('accountId');
    const row = await withTx(s.pool, async (tx) => {
      if (i.requestId) {
        await lockRequest(tx, accountId, i.requestId);
        const ex = await one(tx, 'SELECT * FROM items WHERE account_id=$1 AND request_id=$2', [accountId, i.requestId]);
        if (ex) return ex;
      }
      if (i.code) {
        const dup = await one(tx, 'SELECT id FROM items WHERE account_id=$1 AND code=$2', [accountId, i.code]);
        if (dup) throw conflict(`品目コード「${i.code}」はすでに使われています`);
      }
      return one(
        tx,
        `INSERT INTO items (account_id, code, name, description, unit_price, unit, tax_rate, request_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [accountId, i.code, i.name, i.description, i.unitPrice, i.unit, i.taxRate, i.requestId ?? null],
      );
    });
    return c.json({ item: camelRow(row) }, 201);
  });

  r.put('/:id', async (c) => {
    const id = idParam(c);
    const i = await body(c, itemSchema);
    if (i.code) {
      const dup = await one(s.pool, 'SELECT id FROM items WHERE account_id=$1 AND code=$2 AND id<>$3', [c.get('accountId'), i.code, id]);
      if (dup) throw conflict(`品目コード「${i.code}」はすでに使われています`);
    }
    const row = await one(
      s.pool,
      `UPDATE items SET code=$3, name=$4, description=$5, unit_price=$6, unit=$7, tax_rate=$8, updated_at=now() WHERE account_id=$1 AND id=$2 RETURNING *`,
      [c.get('accountId'), id, i.code, i.name, i.description, i.unitPrice, i.unit, i.taxRate],
    );
    if (!row) throw notFound('品目');
    return c.json({ item: camelRow(row) });
  });

  r.post('/:id/archive', async (c) => {
    const row = await one(s.pool, 'UPDATE items SET archived_at=COALESCE(archived_at, now()), updated_at=now() WHERE account_id=$1 AND id=$2 RETURNING *', [
      c.get('accountId'),
      idParam(c),
    ]);
    if (!row) throw notFound('品目');
    return c.json({ item: camelRow(row) });
  });

  r.post('/:id/unarchive', async (c) => {
    const row = await one(s.pool, 'UPDATE items SET archived_at=NULL, updated_at=now() WHERE account_id=$1 AND id=$2 RETURNING *', [
      c.get('accountId'),
      idParam(c),
    ]);
    if (!row) throw notFound('品目');
    return c.json({ item: camelRow(row) });
  });

  // 書類で使われた品目は削除せずアーカイブ（明細のitemIdで参照）
  r.delete('/:id', async (c) => {
    const id = idParam(c);
    const used = await one(
      s.pool,
      `SELECT (SELECT count(*) FROM quote_versions WHERE account_id=$1 AND lines @> jsonb_build_array(jsonb_build_object('itemId', $2::text)))
            + (SELECT count(*) FROM invoice_versions WHERE account_id=$1 AND lines @> jsonb_build_array(jsonb_build_object('itemId', $2::text))) AS n`,
      [c.get('accountId'), id],
    );
    if (Number(used.n) > 0) throw conflict('この品目は見積・請求で使われているため削除できません。アーカイブしてください', 'in_use');
    const r2 = await s.pool.query('DELETE FROM items WHERE account_id=$1 AND id=$2', [c.get('accountId'), id]);
    if (!r2.rowCount) throw notFound('品目');
    return c.json({ ok: true });
  });

  return r;
}
