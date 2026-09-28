import { Hono } from 'hono';
import { type AppEnv, body, idParam, type Services } from '../context';
import { many, withTx } from '../db';
import { createQuoteSchema, declineSchema, quoteDraftSchema, submitQuoteSchema } from '../schemas';
import { camelRow, camelRows } from '../services/format';
import {
  createNextVersion,
  createQuote,
  declineQuote,
  discardQuoteDraft,
  finalizeQuoteVersion,
  requireQuoteVersion,
  submitQuoteVersion,
  updateQuoteDraft,
} from '../services/quotes';
import { buildDocSnapshot, loadBusiness, loadCustomerForProject } from '../services/snapshot';
import { calculateTotals } from '../../../shared/calc';

export function quoteRoutes(s: Services) {
  const r = new Hono<AppEnv>();

  r.post('/projects/:id/quotes', async (c) => {
    const i = await body(c, createQuoteSchema);
    const res = await withTx(s.pool, (tx) => createQuote(tx, s, c.get('accountId'), idParam(c), i.requestId));
    return c.json(res, res.created ? 201 : 200);
  });

  r.get('/quote-versions/:id', async (c) => {
    const acc = c.get('accountId');
    const v = await requireQuoteVersion(s.pool, acc, idParam(c));
    const versions = await many(
      s.pool,
      'SELECT id, version, status, total, change_memo, created_at, finalized_at, submitted_on, declined_at FROM quote_versions WHERE account_id=$1 AND quote_id=$2 ORDER BY version',
      [acc, v.quote_id],
    );
    const order = await many(s.pool, "SELECT id, status FROM orders WHERE account_id=$1 AND quote_version_id=$2", [acc, v.id]);
    // 画面表示用：下書きは現在のマスターから、確定版はスナップショットから
    const preview =
      v.status === 'final' ? v.snapshot : buildDocSnapshot('quote', v, v.number, await loadBusiness(s.pool, acc), await loadCustomerForProject(s.pool, acc, v.project_id));
    const lineAmounts = calculateTotals(v.lines, v.adjustments, { taxMode: v.tax_mode, lineRounding: v.line_rounding, taxRounding: v.tax_rounding }).lineAmounts;
    return c.json({ version: { ...camelRow<any>(v), lineAmounts }, versions: camelRows(versions), preview, order: order[0] ? camelRow(order[0]) : null });
  });

  r.put('/quote-versions/:id', async (c) => {
    const i = await body(c, quoteDraftSchema);
    await withTx(s.pool, (tx) => updateQuoteDraft(tx, c.get('accountId'), idParam(c), i));
    return c.json({ ok: true });
  });

  r.post('/quote-versions/:id/finalize', async (c) => {
    const res = await withTx(s.pool, (tx) => finalizeQuoteVersion(tx, s, c.get('accountId'), idParam(c)));
    return c.json(res);
  });

  r.post('/quote-versions/:id/new-version', async (c) => {
    const i = await body(c, createQuoteSchema);
    const res = await withTx(s.pool, (tx) => createNextVersion(tx, c.get('accountId'), idParam(c), i.requestId));
    return c.json(res, res.created ? 201 : 200);
  });

  r.post('/quote-versions/:id/submit', async (c) => {
    const i = await body(c, submitQuoteSchema);
    const res = await withTx(s.pool, (tx) => submitQuoteVersion(tx, s, c.get('accountId'), idParam(c), i.submittedOn));
    return c.json(res);
  });

  r.post('/quote-versions/:id/decline', async (c) => {
    const i = await body(c, declineSchema);
    await withTx(s.pool, (tx) => declineQuote(tx, s, c.get('accountId'), idParam(c), i.reason));
    return c.json({ ok: true });
  });

  r.delete('/quote-versions/:id', async (c) => {
    await withTx(s.pool, (tx) => discardQuoteDraft(tx, c.get('accountId'), idParam(c)));
    return c.json({ ok: true });
  });

  return r;
}
