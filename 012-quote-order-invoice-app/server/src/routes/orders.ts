import { Hono } from 'hono';
import { type AppEnv, body, idParam, type Services } from '../context';
import { one, withTx } from '../db';
import { declineSchema, deliverySchema, orderSchema } from '../schemas';
import { camelRow } from '../services/format';
import { cancelOrder, createDelivery, createOrder } from '../services/orders';
import { notFound, unprocessable } from '../services/errors';

export function orderRoutes(s: Services) {
  const r = new Hono<AppEnv>();

  // 「この見積で受注」
  r.post('/projects/:id/orders', async (c) => {
    const i = await body(c, orderSchema);
    const res = await withTx(s.pool, (tx) => createOrder(tx, s, c.get('accountId'), idParam(c), i));
    return c.json({ order: camelRow(res.order), created: res.created }, res.created ? 201 : 200);
  });

  r.post('/orders/:id/cancel', async (c) => {
    const i = await body(c, declineSchema);
    await withTx(s.pool, (tx) => cancelOrder(tx, c.get('accountId'), idParam(c), i.reason));
    return c.json({ ok: true });
  });

  r.post('/projects/:id/deliveries', async (c) => {
    const i = await body(c, deliverySchema);
    const res = await withTx(s.pool, (tx) => createDelivery(tx, s, c.get('accountId'), idParam(c), i));
    return c.json({ delivery: camelRow(res.delivery), created: res.created }, res.created ? 201 : 200);
  });

  r.get('/deliveries/:id', async (c) => {
    const d = await one(s.pool, 'SELECT * FROM deliveries WHERE account_id=$1 AND id=$2', [c.get('accountId'), idParam(c)]);
    if (!d) throw notFound('納品');
    return c.json({ delivery: camelRow(d) });
  });

  r.delete('/deliveries/:id', async (c) => {
    const acc = c.get('accountId');
    const id = idParam(c);
    await withTx(s.pool, async (tx) => {
      const d = await one(tx, 'SELECT * FROM deliveries WHERE account_id=$1 AND id=$2 FOR UPDATE', [acc, id]);
      if (!d) throw notFound('納品');
      if (d.portal_status === 'published') throw unprocessable('クライアントポータルで公開中の納品は削除できません。先にポータルの公開を取り下げてください');
      await tx.query('DELETE FROM deliveries WHERE account_id=$1 AND id=$2', [acc, id]);
      await tx.query(
        "INSERT INTO project_events (account_id, project_id, kind, title) VALUES ($1,$2,'delivery_deleted',$3)",
        [acc, d.project_id, `納品記録 ${d.number} を削除`],
      );
    });
    return c.json({ ok: true });
  });

  return r;
}
