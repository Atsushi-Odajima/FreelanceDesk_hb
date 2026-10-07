import { Hono } from 'hono';
import { type AppEnv, idParam, isUuid, type Services } from '../context';
import { lockRequest, one, withTx } from '../db';
import { camelRow } from '../services/format';
import { HttpError, notFound } from '../services/errors';
import { contentDisposition } from '../services/upload';
import { attachmentHeaders, insertAttachment, receiveUpload } from '../services/attachmentStore';
import { logEvent } from '../services/events';

export function attachmentRoutes(s: Services) {
  const r = new Hono<AppEnv>();

  // multipart/form-data: file, purpose(project|delivery|logo), projectId?, deliveryId?, requestId?, note?
  r.post('/', async (c) => {
    const acc = c.get('accountId');
    const up = await receiveUpload(c, s);
    const form = up.form;
    const purpose = String(form.purpose ?? 'project');
    // クライアントポータル用（portal_version / selection_photo）はポータルの専用APIからのみ作成する
    if (!['project', 'delivery', 'logo'].includes(purpose)) throw new HttpError(400, '用途が正しくありません');
    const projectId = form.projectId ? String(form.projectId) : null;
    const deliveryId = form.deliveryId ? String(form.deliveryId) : null;
    const requestId = form.requestId ? String(form.requestId).slice(0, 100) : null;
    const note = form.note ? String(form.note).slice(0, 500) : '';
    if ((projectId && !isUuid(projectId)) || (deliveryId && !isUuid(deliveryId))) throw notFound('案件');
    if (purpose !== 'logo' && !projectId) throw new HttpError(400, '案件を指定してください');
    if (purpose === 'logo' && !['image/png', 'image/jpeg'].includes(up.detected.mime)) throw new HttpError(415, 'ロゴはPNGまたはJPEGを選択してください', 'unsupported_type');

    const row = await withTx(s.pool, async (tx) => {
      if (requestId) {
        await lockRequest(tx, acc, requestId);
        const ex = await one(tx, 'SELECT * FROM attachments WHERE account_id=$1 AND request_id=$2', [acc, requestId]);
        if (ex) return ex;
      }
      if (projectId) {
        const p = await one(tx, 'SELECT id FROM projects WHERE account_id=$1 AND id=$2', [acc, projectId]);
        if (!p) throw notFound('案件');
      }
      if (deliveryId) {
        const d = await one(tx, 'SELECT id FROM deliveries WHERE account_id=$1 AND id=$2 AND project_id=$3', [acc, deliveryId, projectId]);
        if (!d) throw notFound('納品');
      }
      const a = await insertAttachment(tx, s, acc, { projectId, deliveryId, purpose: purpose as 'project', upload: up, note, requestId });
      delete a.sha256;
      if (purpose === 'logo') {
        await tx.query('UPDATE business_profiles SET logo_attachment_id=$2, updated_at=now() WHERE account_id=$1', [acc, a.id]);
      } else if (projectId) {
        await logEvent(tx, acc, projectId, 'attachment', `ファイルを添付：${up.filename}`, { refType: 'attachment', refId: a.id });
      }
      return a;
    });
    return c.json({ attachment: camelRow(row) }, 201);
  });

  // 所有者確認のうえ配信（公開URLは発行しない）
  r.get('/:id', async (c) => {
    const acc = c.get('accountId');
    const a = await one(
      s.pool,
      'SELECT a.filename, a.mime, b.data FROM attachments a JOIN attachment_blobs b ON b.attachment_id=a.id WHERE a.account_id=$1 AND a.id=$2',
      [acc, idParam(c)],
    );
    if (!a) throw notFound('ファイル');
    const inline = c.req.query('inline') === '1' && (a.mime.startsWith('image/') || a.mime === 'application/pdf' || a.mime.startsWith('video/'));
    const headers = attachmentHeaders(a.mime, contentDisposition(inline ? 'inline' : 'attachment', a.filename));
    return c.body(new Uint8Array(a.data), 200, headers);
  });

  r.delete('/:id', async (c) => {
    const acc = c.get('accountId');
    const id = idParam(c);
    await withTx(s.pool, async (tx) => {
      const a = await one(tx, 'SELECT * FROM attachments WHERE account_id=$1 AND id=$2 FOR UPDATE', [acc, id]);
      if (!a) throw notFound('ファイル');
      if (a.purpose === 'portal_version' || a.purpose === 'selection_photo') {
        throw new HttpError(409, 'クライアントポータルのファイルです。ポータルの画面から操作してください', 'portal_file');
      }
      if (a.purpose === 'logo') {
        await tx.query('UPDATE business_profiles SET logo_attachment_id=NULL WHERE account_id=$1 AND logo_attachment_id=$2', [acc, id]);
        // 確定済み書類のスナップショットが参照するロゴは残す（過去書類を変えない）
        const used = await one(
          tx,
          `SELECT 1 FROM quote_versions WHERE account_id=$1 AND snapshot->'issuer'->>'logoAttachmentId'=$2
           UNION ALL SELECT 1 FROM invoice_versions WHERE account_id=$1 AND snapshot->'issuer'->>'logoAttachmentId'=$2
           UNION ALL SELECT 1 FROM deliveries WHERE account_id=$1 AND snapshot->'issuer'->>'logoAttachmentId'=$2 LIMIT 1`,
          [acc, id],
        );
        if (used) return;
      }
      await tx.query('DELETE FROM attachments WHERE account_id=$1 AND id=$2', [acc, id]);
      if (a.project_id) await logEvent(tx, acc, a.project_id, 'attachment_deleted', `添付を削除：${a.filename}`);
    });
    return c.json({ ok: true });
  });

  return r;
}
