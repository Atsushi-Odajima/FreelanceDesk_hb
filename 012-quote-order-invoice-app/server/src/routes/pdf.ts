import { Hono } from 'hono';
import { type AppEnv, idParam, type Services } from '../context';
import { one } from '../db';
import { renderDocPdf } from '../pdf/render';
import { buildDocSnapshot, loadBusiness, loadCustomerForProject, type DocSnapshot } from '../services/snapshot';
import { requireQuoteVersion } from '../services/quotes';
import { requireInvoiceVersion } from '../services/invoices';
import { notFound } from '../services/errors';
import { contentDisposition } from '../services/upload';
import type { Queryable } from '../db';

async function loadLogo(q: Queryable, accountId: string, id: string | null) {
  if (!id) return null;
  const r = await one(
    q,
    'SELECT a.mime, b.data FROM attachments a JOIN attachment_blobs b ON b.attachment_id=a.id WHERE a.account_id=$1 AND a.id=$2',
    [accountId, id],
  );
  return r ? { mime: r.mime as string, data: new Uint8Array(r.data) } : null;
}

export function pdfRoutes(s: Services) {
  const r = new Hono<AppEnv>();

  const send = async (c: any, snap: DocSnapshot, draft: boolean, filename: string) => {
    const pdf = await renderDocPdf(snap, { draft, logo: await loadLogo(s.pool, c.get('accountId'), snap.issuer.logoAttachmentId) });
    const download = c.req.query('download') === '1';
    return c.body(pdf, 200, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': contentDisposition(download ? 'attachment' : 'inline', filename),
      'Cache-Control': 'private, no-store',
    });
  };

  r.get('/quote-versions/:id', async (c) => {
    const acc = c.get('accountId');
    const v = await requireQuoteVersion(s.pool, acc, idParam(c));
    const draft = v.status === 'draft';
    const snap: DocSnapshot = draft
      ? buildDocSnapshot('quote', v, v.number, await loadBusiness(s.pool, acc), await loadCustomerForProject(s.pool, acc, v.project_id))
      : v.snapshot;
    return send(c, snap, draft, `見積書_${v.number}_v${v.version}${draft ? '_下書き' : ''}.pdf`);
  });

  r.get('/invoice-versions/:id', async (c) => {
    const acc = c.get('accountId');
    const v = await requireInvoiceVersion(s.pool, acc, idParam(c));
    const draft = v.status === 'draft';
    const snap: DocSnapshot = draft
      ? buildDocSnapshot('invoice', v, v.number ?? '（確定時に採番）', await loadBusiness(s.pool, acc), await loadCustomerForProject(s.pool, acc, v.project_id))
      : v.snapshot;
    const suffix = v.revision > 1 ? `_訂正第${v.revision}版` : '';
    return send(c, snap, draft, `請求書_${v.number ?? '下書き'}${suffix}${draft ? '_下書き' : ''}.pdf`);
  });

  r.get('/deliveries/:id', async (c) => {
    const d = await one(s.pool, 'SELECT number, snapshot FROM deliveries WHERE account_id=$1 AND id=$2', [c.get('accountId'), idParam(c)]);
    if (!d) throw notFound('納品');
    return send(c, d.snapshot, false, `納品書_${d.number}.pdf`);
  });

  return r;
}
