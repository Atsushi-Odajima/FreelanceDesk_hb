import { Hono } from 'hono';
import crypto from 'node:crypto';
import { type AppEnv, idParam, isUuid, type Services } from '../context';
import { lockRequest, one, withTx } from '../db';
import { camelRow } from '../services/format';
import { HttpError, notFound } from '../services/errors';
import { contentDisposition, detectFile, sanitizeFilename, UploadRejected } from '../services/upload';
import { logEvent } from '../services/events';

export function attachmentRoutes(s: Services) {
  const r = new Hono<AppEnv>();

  // multipart/form-data: file, purpose(project|delivery|logo), projectId?, deliveryId?, requestId?, note?
  r.post('/', async (c) => {
    const acc = c.get('accountId');
    const len = Number(c.req.header('content-length') ?? 0);
    if (len > s.config.uploadMaxBytes + 64 * 1024) throw new HttpError(413, `ファイルが大きすぎます（上限 ${Math.floor(s.config.uploadMaxBytes / 1024 / 1024)}MB）`, 'too_large');
    let form: Record<string, string | File>;
    try {
      form = (await c.req.parseBody()) as Record<string, string | File>;
    } catch {
      throw new HttpError(400, 'アップロード形式が正しくありません', 'bad_upload');
    }
    const file = form.file;
    if (!(file instanceof File)) throw new HttpError(400, 'ファイルを選択してください', 'no_file');
    if (file.size === 0) throw new HttpError(400, '空のファイルは添付できません', 'empty');
    if (file.size > s.config.uploadMaxBytes) throw new HttpError(413, `ファイルが大きすぎます（上限 ${Math.floor(s.config.uploadMaxBytes / 1024 / 1024)}MB）`, 'too_large');
    const purpose = String(form.purpose ?? 'project');
    if (!['project', 'delivery', 'logo'].includes(purpose)) throw new HttpError(400, '用途が正しくありません');
    const projectId = form.projectId ? String(form.projectId) : null;
    const deliveryId = form.deliveryId ? String(form.deliveryId) : null;
    const requestId = form.requestId ? String(form.requestId).slice(0, 100) : null;
    const note = form.note ? String(form.note).slice(0, 500) : '';
    if ((projectId && !isUuid(projectId)) || (deliveryId && !isUuid(deliveryId))) throw notFound('案件');
    if (purpose !== 'logo' && !projectId) throw new HttpError(400, '案件を指定してください');

    const buf = new Uint8Array(await file.arrayBuffer());
    const filename = sanitizeFilename(file.name || 'file');
    let detected;
    try {
      detected = detectFile(filename, buf);
    } catch (e) {
      if (e instanceof UploadRejected) throw new HttpError(415, e.message, 'unsupported_type');
      throw e;
    }
    if (purpose === 'logo' && !['image/png', 'image/jpeg'].includes(detected.mime)) throw new HttpError(415, 'ロゴはPNGまたはJPEGを選択してください', 'unsupported_type');
    const sha = crypto.createHash('sha256').update(buf).digest('hex');

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
      await lockRequest(tx, acc, 'storage-quota');
      const used = await one(tx, 'SELECT COALESCE(sum(size_bytes),0)::bigint AS s FROM attachments WHERE account_id=$1', [acc]);
      if (Number(used.s) + buf.length > s.config.accountStorageQuotaBytes) {
        throw new HttpError(413, `保存容量の上限（${Math.floor(s.config.accountStorageQuotaBytes / 1024 / 1024)}MB）を超えます。不要な添付を削除してください`, 'quota');
      }
      const a = await one(
        tx,
        `INSERT INTO attachments (account_id, project_id, delivery_id, purpose, filename, mime, size_bytes, sha256, note, request_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, project_id, delivery_id, purpose, filename, mime, size_bytes, note, created_at`,
        [acc, projectId, deliveryId, purpose, filename, detected.mime, buf.length, sha, note, requestId],
      );
      await tx.query('INSERT INTO attachment_blobs (attachment_id, data) VALUES ($1,$2)', [a.id, Buffer.from(buf)]);
      if (purpose === 'logo') {
        await tx.query('UPDATE business_profiles SET logo_attachment_id=$2, updated_at=now() WHERE account_id=$1', [acc, a.id]);
      } else if (projectId) {
        await logEvent(tx, acc, projectId, 'attachment', `ファイルを添付：${filename}`, { refType: 'attachment', refId: a.id });
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
    const headers: Record<string, string> = {
      'Content-Type': a.mime.startsWith('text/') ? `${a.mime}; charset=utf-8` : a.mime,
      'Content-Disposition': contentDisposition(inline ? 'inline' : 'attachment', a.filename),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    };
    if (a.mime !== 'application/pdf') headers['Content-Security-Policy'] = "sandbox; default-src 'none'; img-src 'self'; media-src 'self'";
    return c.body(new Uint8Array(a.data), 200, headers);
  });

  r.delete('/:id', async (c) => {
    const acc = c.get('accountId');
    const id = idParam(c);
    await withTx(s.pool, async (tx) => {
      const a = await one(tx, 'SELECT * FROM attachments WHERE account_id=$1 AND id=$2 FOR UPDATE', [acc, id]);
      if (!a) throw notFound('ファイル');
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
