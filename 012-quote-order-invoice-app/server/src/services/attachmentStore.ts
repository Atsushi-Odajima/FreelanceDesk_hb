// 添付の受信・検証・保存（attachments + attachment_blobs）。
// 通常の添付（routes/attachments.ts）とクライアントポータルの版・写真セレクトのアップロードで共用する。
import crypto from 'node:crypto';
import type { Context } from 'hono';
import type { Services } from '../context';
import type { Tx } from '../db';
import { lockRequest, one } from '../db';
import { HttpError } from './errors';
import { type DetectedFile, detectFile, sanitizeFilename, UploadRejected } from './upload';

export interface ReceivedUpload {
  form: Record<string, string | File>;
  buf: Uint8Array;
  filename: string;
  detected: DetectedFile;
  sha256: string;
}

const tooLarge = (s: Services) => new HttpError(413, `ファイルが大きすぎます（上限 ${Math.floor(s.config.uploadMaxBytes / 1024 / 1024)}MB）`, 'too_large');

/** multipart/form-data の file を受け取り、サイズ・実体（先頭バイト）を検査する */
export async function receiveUpload(c: Context, s: Services): Promise<ReceivedUpload> {
  const len = Number(c.req.header('content-length') ?? 0);
  if (len > s.config.uploadMaxBytes + 64 * 1024) throw tooLarge(s);
  let form: Record<string, string | File>;
  try {
    form = (await c.req.parseBody()) as Record<string, string | File>;
  } catch {
    throw new HttpError(400, 'アップロード形式が正しくありません', 'bad_upload');
  }
  const file = form.file;
  if (!(file instanceof File)) throw new HttpError(400, 'ファイルを選択してください', 'no_file');
  if (file.size === 0) throw new HttpError(400, '空のファイルは添付できません', 'empty');
  if (file.size > s.config.uploadMaxBytes) throw tooLarge(s);
  const buf = new Uint8Array(await file.arrayBuffer());
  const filename = sanitizeFilename(file.name || 'file');
  let detected: DetectedFile;
  try {
    detected = detectFile(filename, buf);
  } catch (e) {
    if (e instanceof UploadRejected) throw new HttpError(415, e.message, 'unsupported_type');
    throw e;
  }
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  return { form, buf, filename, detected, sha256 };
}

export interface InsertAttachmentInput {
  projectId: string | null;
  deliveryId: string | null;
  purpose: 'project' | 'delivery' | 'logo' | 'portal_version' | 'selection_photo';
  upload: ReceivedUpload;
  note?: string;
  requestId?: string | null;
}

/** 保存容量を確認して attachments / attachment_blobs に保存（呼び出し側トランザクション内） */
export async function insertAttachment(tx: Tx, s: Services, accountId: string, i: InsertAttachmentInput) {
  await lockRequest(tx, accountId, 'storage-quota');
  const used = await one(tx, 'SELECT COALESCE(sum(size_bytes),0)::bigint AS s FROM attachments WHERE account_id=$1', [accountId]);
  if (Number(used.s) + i.upload.buf.length > s.config.accountStorageQuotaBytes) {
    throw new HttpError(413, `保存容量の上限（${Math.floor(s.config.accountStorageQuotaBytes / 1024 / 1024)}MB）を超えます。不要な添付を削除してください`, 'quota');
  }
  const a = await one(
    tx,
    `INSERT INTO attachments (account_id, project_id, delivery_id, purpose, filename, mime, size_bytes, sha256, note, request_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, project_id, delivery_id, purpose, filename, mime, size_bytes, sha256, note, created_at`,
    [accountId, i.projectId, i.deliveryId, i.purpose, i.upload.filename, i.upload.detected.mime, i.upload.buf.length, i.upload.sha256, i.note ?? '', i.requestId ?? null],
  );
  await tx.query('INSERT INTO attachment_blobs (attachment_id, data) VALUES ($1,$2)', [a.id, Buffer.from(i.upload.buf)]);
  return a;
}

/** 添付の配信用ヘッダ（attachments ルートと同じ方針：nosniff・sandbox CSP・キャッシュなし） */
export function attachmentHeaders(mime: string, disposition: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': mime.startsWith('text/') ? `${mime}; charset=utf-8` : mime,
    'Content-Disposition': disposition,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  };
  if (mime !== 'application/pdf') headers['Content-Security-Policy'] = "sandbox; default-src 'none'; img-src 'self'; media-src 'self'";
  return headers;
}
