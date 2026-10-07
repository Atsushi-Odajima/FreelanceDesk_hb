// FreelanceDesk クライアントポータル — 顧客側API（/api/portal/...）
// 運営者セッションは参照しない。招待の引換以外は顧客セッション（fd_portal）が必須で、
// 案件は clientProject()（公開中・自分の案件・招待を使って入った案件）を必ず通す。
import { Hono } from 'hono';
import { z } from 'zod';
import { type AppEnv, body, idParam, query, type Services } from '../context';
import { many, one, withTx } from '../db';
import { requiredText, text, uuid } from '../schemas';
import { HttpError, notFound } from '../services/errors';
import { RateLimiter } from '../services/ratelimit';
import { clientIp } from '../services/ip';
import { clearPortalCookie, readPortalSession } from '../auth/portalSession';
import { contentDisposition } from '../services/upload';
import { attachmentHeaders } from '../services/attachmentStore';
import { renderDocPdf } from '../pdf/render';
import {
  approveVersion,
  buildInstructionSheet,
  clientProject,
  clientProjects,
  clientReadableAttachment,
  clientStatusLabel,
  createComment,
  deleteOwnComment,
  deliverablesWithVersions,
  deliveriesFor,
  inspectInvite,
  redeemInvite,
  requestChanges,
  versionDetail,
} from '../services/portal';
import { clientSelection, listSelections, savePicks, selectionDetailForClient, selectionDisplayName, submitPicks } from '../services/selection';
import { commentSchema, sheetQuery, sheetResponse } from './portalAdmin';

export function portalRoutes(s: Services) {
  const r = new Hono<AppEnv>();
  const relax = s.config.relaxRateLimits;
  const inviteLimiter = new RateLimiter(relax ? 1000 : 10, 10 * 60_000); // 招待の確認・引換：1IP 10分10回
  const approveLimiter = new RateLimiter(relax ? 1000 : 20, 60_000); // 承認：1セッション 1分20回
  const writeLimiter = new RateLimiter(relax ? 1000 : 30, 60_000); // コメント・修正依頼・選択：1セッション 1分30回

  const tooMany = () => new HttpError(429, '操作が多すぎます。しばらく待ってから再度お試しください', 'rate_limited');

  // ---- 招待リンク（セッション不要） ----
  r.post('/invite/inspect', async (c) => {
    if (!inviteLimiter.hit(clientIp(c, s))) throw tooMany();
    const i = await body(c, z.object({ token: z.string().min(10).max(200) }));
    return c.json(await inspectInvite(s.pool, s, i.token));
  });

  r.post('/invite/redeem', async (c) => {
    if (!inviteLimiter.hit(clientIp(c, s))) throw tooMany();
    const i = await body(c, z.object({ token: z.string().min(10).max(200), email: z.string().max(254) }));
    const res = await withTx(s.pool, (tx) => redeemInvite(tx, s, c, i.token, i.email));
    if (!res.ok) throw res.error;
    return c.json({ ok: true, projectId: res.projectId });
  });

  // ---- 以降は顧客セッション必須 ----
  r.use('*', async (c, next) => {
    if (c.req.path.startsWith('/api/portal/invite/')) return next();
    const sess = await readPortalSession(s.pool, s, c);
    if (!sess) throw new HttpError(401, 'ポータルのリンクから開き直してください', 'portal_unauthenticated');
    c.set('portal', sess);
    await next();
  });

  const writeGuard = (c: any, limiter = writeLimiter) => {
    if (!limiter.hit(c.get('portal').tokenHash)) throw tooMany();
  };

  r.get('/me', async (c) => {
    const sess = c.get('portal');
    const b = await one(s.pool, 'SELECT name, brand_color FROM business_profiles WHERE account_id=$1', [sess.accountId]);
    const projects = await clientProjects(s.pool, sess);
    return c.json({
      clientName: sess.clientName,
      business: { name: b?.name ?? '', brandColor: b?.brand_color ?? '#1f5fbf' },
      projects: projects.map((p) => ({ id: p.id, number: p.number, title: p.title, statusLabel: clientStatusLabel(p), updatedAt: p.updated_at })),
    });
  });

  r.post('/logout', async (c) => {
    await s.pool.query('DELETE FROM portal_sessions WHERE token_hash=$1', [c.get('portal').tokenHash]);
    clearPortalCookie(c, s);
    return c.json({ ok: true });
  });

  r.get('/projects/:pid', async (c) => {
    const sess = c.get('portal');
    const p = await clientProject(s.pool, sess, idParam(c, 'pid'));
    const b = await one(s.pool, 'SELECT name, brand_color, email, phone FROM business_profiles WHERE account_id=$1', [sess.accountId]);
    const events = await many(
      s.pool,
      'SELECT id, kind, title, occurred_at FROM project_events WHERE account_id=$1 AND project_id=$2 AND client_visible ORDER BY occurred_at DESC, id LIMIT 100',
      [sess.accountId, p.id],
    );
    return c.json({
      clientName: sess.clientName,
      business: { name: b?.name ?? '', brandColor: b?.brand_color ?? '#1f5fbf', email: b?.email ?? '', phone: b?.phone ?? '' },
      project: { id: p.id, number: p.number, title: p.title, statusLabel: clientStatusLabel(p), guidance: p.portal_guidance, plannedDue: p.planned_due },
      deliverables: await deliverablesWithVersions(s.pool, sess.accountId, p.id, 'client'),
      deliveries: await deliveriesFor(s.pool, sess.accountId, p.id, 'client'),
      selections: await listSelections(s.pool, sess.accountId, p.id, 'client', sess.customerId),
      events: events.map((e) => ({ id: e.id, kind: e.kind, title: e.title, occurredAt: e.occurred_at })),
    });
  });

  // ---- 版の確認・コメント・修正依頼・承認 ----
  r.get('/projects/:pid/versions/:vid', async (c) => {
    const sess = c.get('portal');
    const p = await clientProject(s.pool, sess, idParam(c, 'pid'));
    return c.json(await versionDetail(s.pool, sess.accountId, p, idParam(c, 'vid'), 'client', sess.customerId));
  });

  r.get('/projects/:pid/versions/:vid/instructions', async (c) => {
    const sess = c.get('portal');
    const q = query(c, sheetQuery);
    const p = await clientProject(s.pool, sess, idParam(c, 'pid'));
    const sheet = await buildInstructionSheet(s.pool, s, sess.accountId, p, idParam(c, 'vid'), { changeRequestId: q.changeRequestId, includeResolved: q.includeResolved === '1' }, 'client');
    return sheetResponse(c, sheet, q.format);
  });

  r.post('/projects/:pid/versions/:vid/comments', async (c) => {
    const sess = c.get('portal');
    writeGuard(c);
    const i = await body(c, commentSchema);
    const row = await withTx(s.pool, async (tx) => {
      const p = await clientProject(tx, sess, idParam(c, 'pid'));
      return createComment(tx, sess.accountId, p, idParam(c, 'vid'), { type: 'client', name: sess.clientName, customerId: sess.customerId }, i);
    });
    return c.json({ id: row.id, pinNumber: row.pin_number }, 201);
  });

  r.delete('/projects/:pid/comments/:cid', async (c) => {
    const sess = c.get('portal');
    writeGuard(c);
    await withTx(s.pool, async (tx) => {
      const p = await clientProject(tx, sess, idParam(c, 'pid'));
      await deleteOwnComment(tx, s, sess.accountId, p.id, idParam(c, 'cid'), { audience: 'client', customerId: sess.customerId });
    });
    return c.json({ ok: true });
  });

  r.post('/projects/:pid/versions/:vid/change-requests', async (c) => {
    const sess = c.get('portal');
    writeGuard(c);
    const i = await body(c, z.object({ body: requiredText(4000) }));
    const res = await withTx(s.pool, async (tx) => {
      const p = await clientProject(tx, sess, idParam(c, 'pid'));
      return requestChanges(tx, sess.accountId, p, sess, idParam(c, 'vid'), i.body);
    });
    return c.json(res, 201);
  });

  r.post('/projects/:pid/versions/:vid/approve', async (c) => {
    const sess = c.get('portal');
    writeGuard(c, approveLimiter);
    const i = await body(
      c,
      z.object({
        idempotencyKey: z.string().min(8).max(100).regex(/^[A-Za-z0-9_\-:.]+$/),
        expectedVersionNumber: z.number().int().min(1).optional(),
        comment: text(1000).optional().default(''),
      }),
    );
    const res = await withTx(s.pool, async (tx) => {
      const p = await clientProject(tx, sess, idParam(c, 'pid'));
      return approveVersion(tx, sess.accountId, p, sess, { versionId: idParam(c, 'vid'), ...i });
    });
    return c.json(res, res.duplicate ? 200 : 201);
  });

  // ---- ファイル・納品書 ----
  r.get('/projects/:pid/files/:fid', async (c) => {
    const sess = c.get('portal');
    const p = await clientProject(s.pool, sess, idParam(c, 'pid'));
    const a = await clientReadableAttachment(s.pool, sess.accountId, p.id, idParam(c, 'fid'));
    const name = a.purpose === 'selection_photo' ? selectionDisplayName(a.filename, a.sel_position, a.sel_show_names) : a.filename;
    const inline = c.req.query('inline') === '1' && (a.mime.startsWith('image/') || a.mime === 'application/pdf' || a.mime.startsWith('video/'));
    return c.body(new Uint8Array(a.data), 200, attachmentHeaders(a.mime, contentDisposition(inline ? 'inline' : 'attachment', name)));
  });

  r.get('/projects/:pid/deliveries/:did/pdf', async (c) => {
    const sess = c.get('portal');
    const p = await clientProject(s.pool, sess, idParam(c, 'pid'));
    const d = await one(s.pool, "SELECT number, snapshot FROM deliveries WHERE account_id=$1 AND project_id=$2 AND id=$3 AND portal_status='published'", [
      sess.accountId,
      p.id,
      idParam(c, 'did'),
    ]);
    if (!d) throw notFound('納品');
    const logoId = d.snapshot?.issuer?.logoAttachmentId ?? null;
    const logo = logoId
      ? await one(s.pool, 'SELECT a.mime, b.data FROM attachments a JOIN attachment_blobs b ON b.attachment_id=a.id WHERE a.account_id=$1 AND a.id=$2', [sess.accountId, logoId])
      : null;
    const pdf = await renderDocPdf(d.snapshot, { draft: false, logo: logo ? { mime: logo.mime, data: new Uint8Array(logo.data) } : null });
    return c.body(pdf as Uint8Array<ArrayBuffer>, 200, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': contentDisposition(c.req.query('download') === '1' ? 'attachment' : 'inline', `納品書_${d.number}.pdf`),
      'Cache-Control': 'private, no-store',
    });
  });

  // ---- FreelanceDesk 写真セレクト ----
  r.get('/projects/:pid/selections', async (c) => {
    const sess = c.get('portal');
    const p = await clientProject(s.pool, sess, idParam(c, 'pid'));
    return c.json({ selections: await listSelections(s.pool, sess.accountId, p.id, 'client', sess.customerId) });
  });

  r.get('/projects/:pid/selections/:sid', async (c) => {
    const sess = c.get('portal');
    const p = await clientProject(s.pool, sess, idParam(c, 'pid'));
    const set = await clientSelection(s.pool, sess.accountId, p.id, idParam(c, 'sid'));
    return c.json(await selectionDetailForClient(s.pool, p.id, set, sess));
  });

  r.post('/projects/:pid/selections/:sid/picks', async (c) => {
    const sess = c.get('portal');
    writeGuard(c);
    const i = await body(
      c,
      z.object({
        photoIds: z.array(uuid).max(1000).optional(),
        numbersText: z.string().max(10000).optional(),
        mode: z.enum(['add', 'replace']).optional().default('add'),
      }),
    );
    if (i.photoIds === undefined && i.numbersText === undefined) throw new HttpError(400, '選択内容を指定してください', 'validation');
    const res = await withTx(s.pool, async (tx) => {
      const p = await clientProject(tx, sess, idParam(c, 'pid'));
      const set = await clientSelection(tx, sess.accountId, p.id, idParam(c, 'sid'), true);
      return savePicks(tx, set, sess, i, s);
    });
    return c.json(res);
  });

  r.post('/projects/:pid/selections/:sid/submit', async (c) => {
    const sess = c.get('portal');
    writeGuard(c);
    const i = await body(c, z.object({ note: text(2000).optional().default('') }));
    const res = await withTx(s.pool, async (tx) => {
      const p = await clientProject(tx, sess, idParam(c, 'pid'));
      const set = await clientSelection(tx, sess.accountId, p.id, idParam(c, 'sid'), true);
      return submitPicks(tx, s, p.id, set, sess, i.note);
    });
    return c.json(res);
  });

  return r;
}
