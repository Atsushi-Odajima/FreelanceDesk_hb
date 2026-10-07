// FreelanceDesk クライアントポータル — 運営者側API（/api/projects/:id/portal/...）
// すべて運営者セッション（fd_session）で認証済み。案件は account_id で照合し、他アカウントのIDは 404。
import { Hono } from 'hono';
import { z } from 'zod';
import { type AppEnv, body, idParam, query, type Services } from '../context';
import { lockRequest, many, one, withTx } from '../db';
import { requestId as requestIdSchema, requiredText, text, uuid } from '../schemas';
import { HttpError, notFound } from '../services/errors';
import { requireCustomer, requireProject } from '../services/projects';
import { insertAttachment, receiveUpload } from '../services/attachmentStore';
import { contentDisposition } from '../services/upload';
import { logEvent } from '../services/events';
import {
  buildInstructionSheet,
  createComment,
  createDeliverable,
  deleteOwnComment,
  deliverablesWithVersions,
  deliveriesFor,
  INVITE_DEFAULT_DAYS,
  insertVersion,
  inviteDto,
  issueInvite,
  lockDeliverable,
  publishDelivery,
  resolveComment,
  revokeApproval,
  revokeInvite,
  stopAccess,
  versionDetail,
  withdrawDelivery,
} from '../services/portal';
import {
  addSelectionPhoto,
  assertSelectionAcceptsPhoto,
  createSelection,
  deletePhotos,
  deleteSelection,
  exportSelection,
  listSelections,
  movePhoto,
  projectSelection,
  SELECTION_IMAGE_MIMES,
  selectionDetailForOperator,
  setSelectionStatus,
  sortPhotosByName,
  updateSelection,
} from '../services/selection';
import { PIN_TYPE_IDS } from '../../../shared/correctionSheet';

export const portalSettingsSchema = z.object({
  status: z.enum(['draft', 'published', 'closed']).optional(),
  statusLabel: text(40).optional(),
  guidance: text(2000).optional(),
});
export const commentSchema = z.object({
  body: requiredText(2000),
  pin: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).nullable().optional(),
  pinType: z.enum(PIN_TYPE_IDS).nullable().optional(),
  parentId: uuid.nullable().optional(),
});
export const sheetQuery = z.object({
  format: z.enum(['json', 'txt']).default('json'),
  changeRequestId: uuid.optional(),
  includeResolved: z.enum(['0', '1']).default('0'),
});

export function sheetResponse(c: any, sheet: Awaited<ReturnType<typeof buildInstructionSheet>>, format: 'json' | 'txt') {
  if (format === 'json') return c.json(sheet);
  const body = '﻿' + sheet.text.split('\n').join('\r\n') + '\r\n';
  return c.body(body, 200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Disposition': contentDisposition('attachment', `修正指示_${sheet.deliverable.title}_v${sheet.version.versionNumber}.txt`),
    'Cache-Control': 'private, no-store',
  });
}

export function portalAdminRoutes(s: Services) {
  const r = new Hono<AppEnv>();

  // ---- 概要（設定・招待・制作物・納品・写真セレクト） ----
  r.get('/:id/portal', async (c) => {
    const acc = c.get('accountId');
    const id = idParam(c);
    const p = await requireProject(s.pool, acc, id);
    const cu = await requireCustomer(s.pool, acc, p.customer_id);
    const invites = await many(s.pool, 'SELECT * FROM portal_invites WHERE account_id=$1 AND project_id=$2 ORDER BY created_at DESC LIMIT 50', [acc, id]);
    return c.json({
      portal: { status: p.portal_status, statusLabel: p.portal_status_label, guidance: p.portal_guidance },
      customer: { id: cu.id, name: cu.name, contactName: cu.contact_name, email: cu.email },
      invites: invites.map((i) => inviteDto(i, s.now())),
      deliverables: await deliverablesWithVersions(s.pool, acc, id, 'operator'),
      deliveries: await deliveriesFor(s.pool, acc, id, 'operator'),
      selections: await listSelections(s.pool, acc, id, 'operator'),
    });
  });

  r.put('/:id/portal', async (c) => {
    const acc = c.get('accountId');
    const id = idParam(c);
    const i = await body(c, portalSettingsSchema);
    await withTx(s.pool, async (tx) => {
      const p = await requireProject(tx, acc, id, true);
      await tx.query('UPDATE projects SET portal_status=$3, portal_status_label=$4, portal_guidance=$5, updated_at=now() WHERE account_id=$1 AND id=$2', [
        acc,
        id,
        i.status ?? p.portal_status,
        i.statusLabel ?? p.portal_status_label,
        i.guidance ?? p.portal_guidance,
      ]);
      if (i.status && i.status !== p.portal_status) {
        const label = { draft: '準備中', published: '公開', closed: '公開終了' }[i.status];
        await logEvent(tx, acc, id, 'portal_status', `クライアントポータルを「${label}」に変更`);
      }
    });
    return c.json({ ok: true });
  });

  // ---- 招待リンク ----
  r.post('/:id/portal/invites', async (c) => {
    const acc = c.get('accountId');
    const id = idParam(c);
    const i = await body(c, z.object({ expiresInDays: z.number().int().min(1).max(90).optional() }));
    const res = await withTx(s.pool, (tx) => issueInvite(tx, s, acc, id, i.expiresInDays ?? INVITE_DEFAULT_DAYS));
    return c.json(res, 201);
  });

  r.post('/:id/portal/invites/:inviteId/revoke', async (c) => {
    const acc = c.get('accountId');
    await withTx(s.pool, (tx) => revokeInvite(tx, s, acc, idParam(c), idParam(c, 'inviteId')));
    return c.json({ ok: true });
  });

  r.post('/:id/portal/stop-access', async (c) => {
    const acc = c.get('accountId');
    const id = idParam(c);
    await withTx(s.pool, async (tx) => {
      await requireProject(tx, acc, id, true);
      await stopAccess(tx, s, acc, id);
    });
    return c.json({ ok: true });
  });

  // ---- 制作物・版 ----
  r.post('/:id/portal/deliverables', async (c) => {
    const acc = c.get('accountId');
    const id = idParam(c);
    const i = await body(c, z.object({ title: requiredText(120), description: text(2000).optional().default('') }));
    const d = await withTx(s.pool, async (tx) => {
      await requireProject(tx, acc, id, true);
      return createDeliverable(tx, acc, id, i);
    });
    return c.json({ deliverable: { id: d.id, title: d.title } }, 201);
  });

  r.patch('/:id/portal/deliverables/:did', async (c) => {
    const acc = c.get('accountId');
    const i = await body(c, z.object({ title: requiredText(120).optional(), description: text(2000).optional() }));
    const res = await s.pool.query(
      'UPDATE portal_deliverables SET title=COALESCE($4,title), description=COALESCE($5,description), updated_at=now() WHERE account_id=$1 AND project_id=$2 AND id=$3',
      [acc, idParam(c), idParam(c, 'did'), i.title ?? null, i.description ?? null],
    );
    if (!res.rowCount) throw notFound('制作物');
    return c.json({ ok: true });
  });

  r.delete('/:id/portal/deliverables/:did', async (c) => {
    const acc = c.get('accountId');
    const id = idParam(c);
    await withTx(s.pool, async (tx) => {
      const d = await lockDeliverable(tx, acc, id, idParam(c, 'did'));
      const v = await one(tx, 'SELECT 1 FROM portal_versions WHERE deliverable_id=$1 LIMIT 1', [d.id]);
      if (v) throw new HttpError(409, '提出済みの版がある制作物は削除できません（確認・承認の記録を残すため）', 'has_versions');
      await tx.query('DELETE FROM portal_deliverables WHERE id=$1', [d.id]);
    });
    return c.json({ ok: true });
  });

  // multipart: file, note?, requestId?
  r.post('/:id/portal/deliverables/:did/versions', async (c) => {
    const acc = c.get('accountId');
    const id = idParam(c);
    const did = idParam(c, 'did');
    const up = await receiveUpload(c, s);
    const note = up.form.note ? String(up.form.note).slice(0, 2000) : '';
    const rid = up.form.requestId ? requestIdSchema.parse(String(up.form.requestId)) : null;
    const v = await withTx(s.pool, async (tx) => {
      if (rid) {
        await lockRequest(tx, acc, rid);
        const ex = await one(tx, 'SELECT * FROM portal_versions WHERE account_id=$1 AND request_id=$2', [acc, rid]);
        if (ex) return ex;
      }
      await requireProject(tx, acc, id);
      const d = await lockDeliverable(tx, acc, id, did);
      const a = await insertAttachment(tx, s, acc, { projectId: id, deliveryId: null, purpose: 'portal_version', upload: up });
      return insertVersion(tx, acc, id, d, a.id, note, rid);
    });
    return c.json({ version: { id: v.id, versionNumber: v.version_number } }, 201);
  });

  r.get('/:id/portal/versions/:vid', async (c) => {
    const acc = c.get('accountId');
    const p = await requireProject(s.pool, acc, idParam(c));
    return c.json(await versionDetail(s.pool, acc, p, idParam(c, 'vid'), 'operator'));
  });

  r.get('/:id/portal/versions/:vid/instructions', async (c) => {
    const acc = c.get('accountId');
    const q = query(c, sheetQuery);
    const p = await requireProject(s.pool, acc, idParam(c));
    const sheet = await buildInstructionSheet(s.pool, s, acc, p, idParam(c, 'vid'), { changeRequestId: q.changeRequestId, includeResolved: q.includeResolved === '1' }, 'operator');
    return sheetResponse(c, sheet, q.format);
  });

  r.post('/:id/portal/versions/:vid/comments', async (c) => {
    const acc = c.get('accountId');
    const i = await body(c, commentSchema);
    const row = await withTx(s.pool, async (tx) => {
      const p = await requireProject(tx, acc, idParam(c));
      const b = await one(tx, 'SELECT name FROM business_profiles WHERE account_id=$1', [acc]);
      return createComment(tx, acc, p, idParam(c, 'vid'), { type: 'operator', name: b?.name || '担当者' }, i);
    });
    return c.json({ id: row.id, pinNumber: row.pin_number }, 201);
  });

  r.post('/:id/portal/comments/:cid/resolve', async (c) => {
    const i = await body(c, z.object({ resolved: z.boolean() }));
    await withTx(s.pool, (tx) => resolveComment(tx, s, c.get('accountId'), idParam(c), idParam(c, 'cid'), i.resolved));
    return c.json({ ok: true });
  });

  r.delete('/:id/portal/comments/:cid', async (c) => {
    await withTx(s.pool, (tx) => deleteOwnComment(tx, s, c.get('accountId'), idParam(c), idParam(c, 'cid'), { audience: 'operator' }));
    return c.json({ ok: true });
  });

  r.post('/:id/portal/approvals/:aid/revoke', async (c) => {
    const i = await body(c, z.object({ reason: requiredText(1000) }));
    await withTx(s.pool, (tx) => revokeApproval(tx, s, c.get('accountId'), idParam(c), idParam(c, 'aid'), i.reason));
    return c.json({ ok: true });
  });

  // ---- 納品の公開 ----
  r.post('/:id/portal/deliveries/:deliveryId/publish', async (c) => {
    const i = await body(c, z.object({ versionIds: z.array(uuid).max(200).default([]), message: text(2000).optional().default('') }));
    await withTx(s.pool, (tx) => publishDelivery(tx, c.get('accountId'), idParam(c), idParam(c, 'deliveryId'), i));
    return c.json({ ok: true });
  });

  r.post('/:id/portal/deliveries/:deliveryId/withdraw', async (c) => {
    await withTx(s.pool, (tx) => withdrawDelivery(tx, c.get('accountId'), idParam(c), idParam(c, 'deliveryId')));
    return c.json({ ok: true });
  });

  // ---- FreelanceDesk 写真セレクト ----
  r.get('/:id/portal/selections', async (c) => {
    const acc = c.get('accountId');
    const id = idParam(c);
    await requireProject(s.pool, acc, id);
    return c.json({ selections: await listSelections(s.pool, acc, id, 'operator') });
  });

  r.post('/:id/portal/selections', async (c) => {
    const acc = c.get('accountId');
    const id = idParam(c);
    const i = await body(c, z.object({ title: requiredText(120), message: text(2000).optional().default(''), showNames: z.boolean().optional().default(true) }));
    const set = await withTx(s.pool, async (tx) => {
      await requireProject(tx, acc, id, true);
      return createSelection(tx, acc, id, i);
    });
    return c.json({ id: set.id }, 201);
  });

  r.get('/:id/portal/selections/:sid', async (c) => {
    const acc = c.get('accountId');
    const id = idParam(c);
    const set = await projectSelection(s.pool, acc, id, idParam(c, 'sid'));
    return c.json(await selectionDetailForOperator(s.pool, id, set));
  });

  r.patch('/:id/portal/selections/:sid', async (c) => {
    const acc = c.get('accountId');
    const i = await body(c, z.object({ title: requiredText(120).optional(), message: text(2000).optional(), showNames: z.boolean().optional() }));
    await withTx(s.pool, async (tx) => updateSelection(tx, await projectSelection(tx, acc, idParam(c), idParam(c, 'sid'), true), i));
    return c.json({ ok: true });
  });

  r.delete('/:id/portal/selections/:sid', async (c) => {
    const acc = c.get('accountId');
    const id = idParam(c);
    await withTx(s.pool, async (tx) => deleteSelection(tx, acc, id, await projectSelection(tx, acc, id, idParam(c, 'sid'), true)));
    return c.json({ ok: true });
  });

  r.post('/:id/portal/selections/:sid/status', async (c) => {
    const acc = c.get('accountId');
    const id = idParam(c);
    const i = await body(c, z.object({ status: z.enum(['open', 'closed']) }));
    await withTx(s.pool, async (tx) => setSelectionStatus(tx, acc, id, await projectSelection(tx, acc, id, idParam(c, 'sid'), true), i.status));
    return c.json({ ok: true });
  });

  // multipart: file, requestId?（1枚ずつ。画面からは選んだ写真を順に送る）
  r.post('/:id/portal/selections/:sid/photos', async (c) => {
    const acc = c.get('accountId');
    const id = idParam(c);
    const sid = idParam(c, 'sid');
    const up = await receiveUpload(c, s);
    if (!SELECTION_IMAGE_MIMES.includes(up.detected.mime)) throw new HttpError(415, '写真セレクトには JPEG / PNG / GIF / WebP の画像を登録してください', 'unsupported_type');
    const rid = up.form.requestId ? requestIdSchema.parse(String(up.form.requestId)) : null;
    const res = await withTx(s.pool, async (tx) => {
      if (rid) {
        await lockRequest(tx, acc, rid);
        const ex = await one(
          tx,
          'SELECT sp.id, sp.position FROM attachments a JOIN selection_photos sp ON sp.attachment_id=a.id WHERE a.account_id=$1 AND a.request_id=$2',
          [acc, rid],
        );
        if (ex) return { photoId: ex.id, number: String(ex.position).padStart(3, '0'), duplicate: true };
      }
      const set = await projectSelection(tx, acc, id, sid, true);
      await assertSelectionAcceptsPhoto(tx, set, up.sha256);
      const a = await insertAttachment(tx, s, acc, { projectId: id, deliveryId: null, purpose: 'selection_photo', upload: up, requestId: rid });
      return addSelectionPhoto(tx, acc, id, set, a.id);
    });
    return c.json(res, 201);
  });

  r.post('/:id/portal/selections/:sid/photos/:phid/move', async (c) => {
    const acc = c.get('accountId');
    const i = await body(c, z.object({ toNumber: z.number().int().min(1).max(100000) }));
    await withTx(s.pool, async (tx) => movePhoto(tx, await projectSelection(tx, acc, idParam(c), idParam(c, 'sid'), true), idParam(c, 'phid'), i.toNumber));
    return c.json({ ok: true });
  });

  r.post('/:id/portal/selections/:sid/sort-by-name', async (c) => {
    const acc = c.get('accountId');
    await withTx(s.pool, async (tx) => sortPhotosByName(tx, await projectSelection(tx, acc, idParam(c), idParam(c, 'sid'), true)));
    return c.json({ ok: true });
  });

  r.post('/:id/portal/selections/:sid/photos/delete', async (c) => {
    const acc = c.get('accountId');
    const i = await body(c, z.object({ photoIds: z.array(uuid).min(1).max(1000) }));
    const n = await withTx(s.pool, async (tx) => deletePhotos(tx, acc, await projectSelection(tx, acc, idParam(c), idParam(c, 'sid'), true), i.photoIds));
    return c.json({ ok: true, deleted: n });
  });

  r.get('/:id/portal/selections/:sid/export', async (c) => {
    const acc = c.get('accountId');
    const q = query(c, z.object({ kind: z.enum(['map', 'picks']).default('map'), format: z.enum(['csv', 'txt']).default('csv') }));
    const set = await projectSelection(s.pool, acc, idParam(c), idParam(c, 'sid'));
    const out = await exportSelection(s.pool, set, q.kind, q.format);
    return c.body(out.body, 200, {
      'Content-Type': q.format === 'csv' ? 'text/csv; charset=utf-8' : 'text/plain; charset=utf-8',
      'Content-Disposition': contentDisposition('attachment', out.filename),
      'Cache-Control': 'private, no-store',
    });
  });

  return r;
}
