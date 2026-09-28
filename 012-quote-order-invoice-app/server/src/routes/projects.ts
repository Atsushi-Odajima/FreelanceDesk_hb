import { Hono } from 'hono';
import { z } from 'zod';
import { type AppEnv, body, idParam, query, type Services } from '../context';
import { lockRequest, many, one, withTx } from '../db';
import { projectNoteSchema, projectSchema, projectStatusSchema, taskOrderSchema, taskSchema, taskUpdateSchema } from '../schemas';
import { camelRow, camelRows } from '../services/format';
import { notFound, unprocessable } from '../services/errors';
import { createProject, requireCustomer, requireProject } from '../services/projects';
import { logEvent, setProjectStatus } from '../services/events';
import { listInvoices } from '../services/queries';
import { buildTimeline } from '../services/timeline';
import { PROJECT_STATUSES } from '../../../shared/status';

export function projectRoutes(s: Services) {
  const r = new Hono<AppEnv>();

  r.get('/', async (c) => {
    const q = query(
      c,
      z.object({
        q: z.string().max(100).optional(),
        status: z.string().max(300).optional(), // カンマ区切り
        customerId: z.string().uuid().optional(),
        open: z.enum(['1']).optional(),
      }),
    );
    const params: unknown[] = [c.get('accountId')];
    const conds = ['p.account_id=$1'];
    if (q.q) {
      params.push(`%${q.q}%`);
      conds.push(`(p.title ILIKE $${params.length} OR p.number ILIKE $${params.length} OR c.name ILIKE $${params.length})`);
    }
    if (q.status) {
      const sts = q.status.split(',').filter((x) => (PROJECT_STATUSES as readonly string[]).includes(x));
      params.push(sts);
      conds.push(`p.status = ANY($${params.length}::text[])`);
    }
    if (q.open) conds.push(`p.status NOT IN ('completed','lost','cancelled')`);
    if (q.customerId) {
      params.push(q.customerId);
      conds.push(`p.customer_id=$${params.length}`);
    }
    const rows = await many(
      s.pool,
      `SELECT p.id, p.number, p.title, p.status, p.inquiry_date, p.planned_due, p.updated_at, p.created_at, p.customer_id, c.name AS customer_name,
         (SELECT o.amount FROM orders o WHERE o.project_id=p.id AND o.status='active') AS order_amount,
         (SELECT v.total FROM quote_versions v WHERE v.project_id=p.id AND v.status='final' ORDER BY v.version DESC LIMIT 1) AS quote_total
       FROM projects p JOIN customers c ON c.account_id=p.account_id AND c.id=p.customer_id
       WHERE ${conds.join(' AND ')}
       ORDER BY CASE WHEN p.status IN ('completed','lost','cancelled') THEN 1 ELSE 0 END, p.planned_due NULLS LAST, p.updated_at DESC
       LIMIT 1000`,
      params,
    );
    return c.json({ projects: camelRows(rows) });
  });

  r.post('/', async (c) => {
    const i = await body(c, projectSchema);
    const res = await withTx(s.pool, (tx) => createProject(tx, s, c.get('accountId'), i));
    return c.json({ id: res.id, created: res.created }, res.created ? 201 : 200);
  });

  r.get('/:id', async (c) => {
    const id = idParam(c);
    const acc = c.get('accountId');
    const project = await requireProject(s.pool, acc, id);
    const customer = await requireCustomer(s.pool, acc, project.customer_id);
    const [quoteVersions, orders, tasks, deliveries, attachments, events, history] = await Promise.all([
      many(
        s.pool,
        `SELECT v.id, v.quote_id, q.number, v.version, v.status, v.issue_date, v.total, v.change_memo, v.created_at, v.finalized_at, v.submitted_at, v.submitted_on, v.declined_at
         FROM quote_versions v JOIN quotes q ON q.id=v.quote_id WHERE v.account_id=$1 AND v.project_id=$2 ORDER BY q.created_at, v.version`,
        [acc, id],
      ),
      many(
        s.pool,
        `SELECT o.id, o.quote_version_id, o.order_date, o.amount, o.due_date, o.payment_terms, o.memo, o.status, o.created_at, o.cancelled_at,
                v.version AS quote_version, q.number AS quote_number
         FROM orders o JOIN quote_versions v ON v.id=o.quote_version_id JOIN quotes q ON q.id=v.quote_id
         WHERE o.account_id=$1 AND o.project_id=$2 ORDER BY o.created_at`,
        [acc, id],
      ),
      many(s.pool, 'SELECT * FROM tasks WHERE account_id=$1 AND project_id=$2 ORDER BY sort_order, created_at', [acc, id]),
      many(
        s.pool,
        'SELECT id, number, delivered_on, content, customer_comment, internal_memo, include_lines, created_at FROM deliveries WHERE account_id=$1 AND project_id=$2 ORDER BY delivered_on, created_at',
        [acc, id],
      ),
      many(
        s.pool,
        "SELECT id, delivery_id, purpose, filename, mime, size_bytes, note, created_at FROM attachments WHERE account_id=$1 AND project_id=$2 ORDER BY created_at",
        [acc, id],
      ),
      many(s.pool, 'SELECT id, kind, title, ref_type, ref_id, note, occurred_at FROM project_events WHERE account_id=$1 AND project_id=$2 ORDER BY occurred_at DESC, id LIMIT 300', [
        acc,
        id,
      ]),
      many(s.pool, 'SELECT from_status, to_status, note, changed_at FROM project_status_history WHERE account_id=$1 AND project_id=$2 ORDER BY changed_at', [acc, id]),
    ]);
    const invoices = await listInvoices(s.pool, acc, s.today(), { projectId: id });
    const activeOrder = orders.find((o) => o.status === 'active') ?? null;
    const timeline = buildTimeline({
      project,
      quoteVersions: quoteVersions.map((v) => ({ ...v, total: Number(v.total) })),
      order: activeOrder,
      tasks,
      deliveries,
      invoices,
    });
    return c.json({
      project: camelRow(project),
      customer: camelRow(customer),
      quoteVersions: camelRows(quoteVersions),
      orders: camelRows(orders),
      activeOrder: activeOrder ? camelRow(activeOrder) : null,
      tasks: camelRows(tasks),
      deliveries: camelRows(deliveries),
      attachments: camelRows(attachments),
      invoices,
      events: camelRows(events),
      statusHistory: camelRows(history),
      timeline,
    });
  });

  r.put('/:id', async (c) => {
    const id = idParam(c);
    const i = await body(c, projectSchema);
    const acc = c.get('accountId');
    await withTx(s.pool, async (tx) => {
      const p = await requireProject(tx, acc, id, true);
      if (i.customerId !== p.customer_id) {
        const hasDocs = await one(tx, "SELECT 1 FROM quote_versions WHERE project_id=$1 AND status='final' LIMIT 1", [id]);
        if (hasDocs) throw unprocessable('確定済みの見積がある案件は顧客を変更できません');
        await requireCustomer(tx, acc, i.customerId);
      }
      await tx.query(
        `UPDATE projects SET customer_id=$3, title=$4, inquiry_date=$5, planned_start=$6, planned_due=$7, internal_memo=$8, updated_at=now() WHERE account_id=$1 AND id=$2`,
        [acc, id, i.customerId, i.title, i.inquiryDate, i.plannedStart, i.plannedDue, i.internalMemo],
      );
    });
    return c.json({ ok: true });
  });

  // 状態変更（履歴保存）。状態変更だけで帳票は作らない
  r.post('/:id/status', async (c) => {
    const id = idParam(c);
    const i = await body(c, projectStatusSchema);
    await withTx(s.pool, async (tx) => {
      await requireProject(tx, c.get('accountId'), id, true);
      await setProjectStatus(tx, c.get('accountId'), id, i.status, i.note);
    });
    return c.json({ ok: true });
  });

  r.post('/:id/notes', async (c) => {
    const id = idParam(c);
    const i = await body(c, projectNoteSchema);
    await requireProject(s.pool, c.get('accountId'), id);
    await logEvent(s.pool, c.get('accountId'), id, 'note', 'メモ', { note: i.note });
    return c.json({ ok: true }, 201);
  });

  r.delete('/:id', async (c) => {
    const id = idParam(c);
    const acc = c.get('accountId');
    await withTx(s.pool, async (tx) => {
      await requireProject(tx, acc, id, true);
      const docs = await one(
        tx,
        `SELECT (SELECT count(*) FROM quote_versions WHERE project_id=$1 AND status='final') + (SELECT count(*) FROM invoices WHERE project_id=$1 AND status <> 'draft') + (SELECT count(*) FROM orders WHERE project_id=$1) AS n`,
        [id],
      );
      if (Number(docs.n) > 0) throw unprocessable('確定済みの書類がある案件は削除できません。状態を「キャンセル」にしてください');
      await tx.query('DELETE FROM invoices WHERE account_id=$1 AND project_id=$2', [acc, id]);
      await tx.query('DELETE FROM attachments WHERE account_id=$1 AND project_id=$2', [acc, id]);
      await tx.query('DELETE FROM deliveries WHERE account_id=$1 AND project_id=$2', [acc, id]);
      await tx.query('DELETE FROM projects WHERE account_id=$1 AND id=$2', [acc, id]);
    });
    return c.json({ ok: true });
  });

  // ---- タスク ----
  r.post('/:id/tasks', async (c) => {
    const id = idParam(c);
    const i = await body(c, taskSchema);
    const acc = c.get('accountId');
    const row = await withTx(s.pool, async (tx) => {
      if (i.requestId) {
        await lockRequest(tx, acc, i.requestId);
        const ex = await one(tx, 'SELECT * FROM tasks WHERE account_id=$1 AND request_id=$2', [acc, i.requestId]);
        if (ex) return ex;
      }
      await requireProject(tx, acc, id, true);
      const max = await one(tx, 'SELECT COALESCE(max(sort_order), 0) AS m FROM tasks WHERE project_id=$1', [id]);
      return one(tx, 'INSERT INTO tasks (account_id, project_id, title, due_date, memo, sort_order, request_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *', [
        acc,
        id,
        i.title,
        i.dueDate,
        i.memo,
        Number(max.m) + 10,
        i.requestId ?? null,
      ]);
    });
    return c.json({ task: camelRow(row) }, 201);
  });

  r.put('/:id/tasks/order', async (c) => {
    const id = idParam(c);
    const i = await body(c, taskOrderSchema);
    const acc = c.get('accountId');
    await withTx(s.pool, async (tx) => {
      await requireProject(tx, acc, id, true);
      for (let n = 0; n < i.ids.length; n++) {
        await tx.query('UPDATE tasks SET sort_order=$4, updated_at=now() WHERE account_id=$1 AND project_id=$2 AND id=$3', [acc, id, i.ids[n], (n + 1) * 10]);
      }
    });
    return c.json({ ok: true });
  });

  r.patch('/:id/tasks/:taskId', async (c) => {
    const id = idParam(c);
    const taskId = idParam(c, 'taskId');
    const i = await body(c, taskUpdateSchema);
    const acc = c.get('accountId');
    const row = await withTx(s.pool, async (tx) => {
      const t = await one(tx, 'SELECT * FROM tasks WHERE account_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE', [acc, id, taskId]);
      if (!t) throw notFound('タスク');
      const done = i.done ?? t.done;
      const updated = await one(
        tx,
        `UPDATE tasks SET title=$4, due_date=$5, memo=$6, done=$7, done_at=CASE WHEN $7 AND NOT done THEN now() WHEN NOT $7 THEN NULL ELSE done_at END, updated_at=now()
         WHERE account_id=$1 AND project_id=$2 AND id=$3 RETURNING *`,
        [acc, id, taskId, i.title ?? t.title, i.dueDate === undefined ? t.due_date : i.dueDate || null, i.memo ?? t.memo, done],
      );
      if (i.done === true && !t.done) await logEvent(tx, acc, id, 'task_done', `タスク完了：${t.title}`);
      return updated;
    });
    return c.json({ task: camelRow(row) });
  });

  r.delete('/:id/tasks/:taskId', async (c) => {
    const r2 = await s.pool.query('DELETE FROM tasks WHERE account_id=$1 AND project_id=$2 AND id=$3', [c.get('accountId'), idParam(c), idParam(c, 'taskId')]);
    if (!r2.rowCount) throw notFound('タスク');
    return c.json({ ok: true });
  });

  return r;
}
