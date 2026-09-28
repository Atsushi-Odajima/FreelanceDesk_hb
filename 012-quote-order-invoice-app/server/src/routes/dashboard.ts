import { Hono } from 'hono';
import { z } from 'zod';
import { type AppEnv, query, type Services } from '../context';
import { many, one } from '../db';
import { camelRows } from '../services/format';
import { listInvoices, listPayments } from '../services/queries';
import { endOfMonth, isValidDate, startOfMonth, weekRange } from '../../../shared/dates';
import { badRequest } from '../services/errors';

export function dashboardRoutes(s: Services) {
  const r = new Hono<AppEnv>();

  r.get('/dashboard', async (c) => {
    const q = query(c, z.object({ from: z.string().max(10).optional(), to: z.string().max(10).optional() }));
    const acc = c.get('accountId');
    const today = s.today();
    const from = q.from || startOfMonth(today);
    const to = q.to || endOfMonth(today);
    if (!isValidDate(from) || !isValidDate(to) || from > to) throw badRequest('期間の指定が正しくありません');
    const week = weekRange(today);

    const [awaitingAnswer, dueThisWeek, awaitingDelivery, unbilled] = await Promise.all([
      many(
        s.pool,
        `SELECT p.id, p.number, p.title, p.status, c.name AS customer_name, v.total, v.submitted_on, v.version, q.number AS quote_number, v.valid_until
         FROM projects p JOIN customers c ON c.id=p.customer_id
         JOIN LATERAL (SELECT * FROM quote_versions v WHERE v.project_id=p.id AND v.submitted_at IS NOT NULL ORDER BY v.version DESC LIMIT 1) v ON true
         JOIN quotes q ON q.id=v.quote_id
         WHERE p.account_id=$1 AND p.status IN ('quote_submitted','considering')
           AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.project_id=p.id AND o.status='active')
         ORDER BY v.submitted_on`,
        [acc],
      ),
      many(
        s.pool,
        `SELECT p.id, p.number, p.title, p.status, p.planned_due, c.name AS customer_name
         FROM projects p JOIN customers c ON c.id=p.customer_id
         WHERE p.account_id=$1 AND p.planned_due IS NOT NULL AND p.planned_due <= $2
           AND p.status NOT IN ('delivered','invoiced','completed','lost','cancelled')
           AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.project_id=p.id)
           AND (p.planned_due >= $3 OR EXISTS (SELECT 1 FROM orders o WHERE o.project_id=p.id AND o.status='active'))
         ORDER BY p.planned_due`,
        [acc, week.to, week.from],
      ),
      many(
        s.pool,
        `SELECT p.id, p.number, p.title, p.status, p.planned_due, c.name AS customer_name, o.amount, o.order_date
         FROM projects p JOIN customers c ON c.id=p.customer_id JOIN orders o ON o.project_id=p.id AND o.status='active'
         WHERE p.account_id=$1 AND p.status NOT IN ('completed','lost','cancelled')
           AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.project_id=p.id)
         ORDER BY p.planned_due NULLS LAST`,
        [acc],
      ),
      many(
        s.pool,
        `SELECT p.id, p.number, p.title, p.status, c.name AS customer_name, o.amount,
                (SELECT max(d.delivered_on) FROM deliveries d WHERE d.project_id=p.id) AS delivered_on
         FROM projects p JOIN customers c ON c.id=p.customer_id JOIN orders o ON o.project_id=p.id AND o.status='active'
         WHERE p.account_id=$1 AND p.status NOT IN ('lost','cancelled')
           AND EXISTS (SELECT 1 FROM deliveries d WHERE d.project_id=p.id)
           AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.project_id=p.id AND i.status='issued')
         ORDER BY delivered_on`,
        [acc],
      ),
    ]);

    const invoices = await listInvoices(s.pool, acc, today);
    const issued = invoices.filter((i) => i.status === 'issued');
    const dueThisMonth = issued.filter((i) => i.remaining > 0 && i.dueDate && i.dueDate >= startOfMonth(today) && i.dueDate <= endOfMonth(today));
    const overdue = issued.filter((i) => i.overdue);
    const payments = await listPayments(s.pool, acc, {});
    const unallocated = payments.filter((p) => p.unallocated > 0);

    // 金額カード（合算しない。期間の定義をそれぞれ明示）
    const quoting = await one(
      s.pool,
      `SELECT COALESCE(sum(v.total),0)::bigint AS s, count(*)::int AS n FROM projects p
       JOIN LATERAL (SELECT total FROM quote_versions v WHERE v.project_id=p.id AND v.status='final' ORDER BY v.version DESC LIMIT 1) v ON true
       WHERE p.account_id=$1 AND p.status IN ('quoting','quote_submitted','considering')
         AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.project_id=p.id AND o.status='active')`,
      [acc],
    );
    const ordered = await one(
      s.pool,
      "SELECT COALESCE(sum(amount),0)::bigint AS s, count(*)::int AS n FROM orders WHERE account_id=$1 AND status='active' AND order_date BETWEEN $2 AND $3",
      [acc, from, to],
    );
    const billed = issued.filter((i) => i.issueDate && i.issueDate >= from && i.issueDate <= to);
    const received = payments.filter((p) => p.receivedOn >= from && p.receivedOn <= to);
    const outstanding = issued.filter((i) => i.remaining > 0);

    return c.json({
      today,
      period: { from, to },
      week,
      lists: {
        awaitingAnswer: camelRows(awaitingAnswer),
        dueThisWeek: camelRows(dueThisWeek),
        awaitingDelivery: camelRows(awaitingDelivery),
        unbilled: camelRows(unbilled),
        dueThisMonth,
        overdue,
        unallocatedPayments: unallocated,
      },
      amounts: {
        quoting: { amount: Number(quoting.s), count: quoting.n, basis: '現在（受注前の見積の最新確定版）' },
        ordered: { amount: Number(ordered.s), count: ordered.n, basis: `受注日が ${from}〜${to}` },
        billed: { amount: billed.reduce((a, b) => a + b.total, 0), count: billed.length, basis: `請求日が ${from}〜${to}（発行済み）` },
        received: {
          amount: received.reduce((a, b) => a + b.amount, 0),
          count: received.length,
          unallocated: received.reduce((a, b) => a + b.unallocated, 0),
          basis: `入金日が ${from}〜${to}`,
        },
        outstanding: { amount: outstanding.reduce((a, b) => a + b.remaining, 0), count: outstanding.length, basis: `現在（${today}時点の未入金残額）` },
      },
    });
  });

  // 横断検索：案件番号・案件名・顧客・見積番号・請求番号
  r.get('/search', async (c) => {
    const q = query(c, z.object({ q: z.string().min(1).max(100) }));
    const acc = c.get('accountId');
    const like = `%${q.q.replace(/[%_\\]/g, (m) => '\\' + m)}%`;
    const [projects, customers, quotes, invoices] = await Promise.all([
      many(
        s.pool,
        `SELECT p.id, p.number, p.title, p.status, c.name AS customer_name FROM projects p JOIN customers c ON c.id=p.customer_id
         WHERE p.account_id=$1 AND (p.number ILIKE $2 OR p.title ILIKE $2 OR c.name ILIKE $2) ORDER BY p.updated_at DESC LIMIT 30`,
        [acc, like],
      ),
      many(s.pool, 'SELECT id, code, name, archived_at FROM customers WHERE account_id=$1 AND (name ILIKE $2 OR code ILIKE $2 OR contact_name ILIKE $2) LIMIT 20', [
        acc,
        like,
      ]),
      many(
        s.pool,
        `SELECT v.id, q.number, v.version, v.status, v.total, p.id AS project_id, p.title AS project_title FROM quote_versions v
         JOIN quotes q ON q.id=v.quote_id JOIN projects p ON p.id=v.project_id
         WHERE v.account_id=$1 AND q.number ILIKE $2 ORDER BY q.number, v.version LIMIT 30`,
        [acc, like],
      ),
      many(
        s.pool,
        `SELECT i.id, i.number, i.status, i.total, p.id AS project_id, p.title AS project_title FROM invoices i JOIN projects p ON p.id=i.project_id
         WHERE i.account_id=$1 AND i.number ILIKE $2 ORDER BY i.number LIMIT 30`,
        [acc, like],
      ),
    ]);
    return c.json({ projects: camelRows(projects), customers: camelRows(customers), quotes: camelRows(quotes), invoices: camelRows(invoices) });
  });

  return r;
}
