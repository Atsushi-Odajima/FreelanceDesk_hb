// FreelanceDesk クライアントポータル（Client Portal から統合）
// 招待リンク・顧客の閲覧範囲（アクセス判定）・制作物の版・コメント（FreelanceDesk 修正指示）・修正依頼・承認・納品の公開。
// 認可はすべてここの関数を通す。他アカウント・他案件・非公開のIDは存在を明かさないよう 404。
import type { Context } from 'hono';
import type { PortalSession, Services } from '../context';
import type { Queryable, Tx } from '../db';
import { lockRequest, many, one } from '../db';
import { randomToken, sha256 } from '../auth/password';
import { createPortalSession } from '../auth/portalSession';
import { HttpError, badRequest, conflict, notFound } from './errors';
import { advanceProjectStatus, logEvent } from './events';
import { PROJECT_STATUS_LABELS, PROJECT_STATUS_RANK, type ProjectStatus } from '../../../shared/status';
import { PIN_TYPE_LABEL, buildInstructionText, normalizePinType, type PinType } from '../../../shared/correctionSheet';
import { todayIn } from '../../../shared/dates';

export type Audience = 'operator' | 'client';

export const INVITE_DEFAULT_DAYS = 14;
export const INVITE_MAX_FAILURES = 5;
const PIN_IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

// ---------------------------------------------------------------- アクセス判定

/**
 * 顧客が閲覧できる案件：
 *  同一アカウント・案件の顧客がセッションの顧客・ポータル公開中・この案件の招待を実際に使って入った（停止されていない）
 */
export async function clientProject(q: Queryable, sess: PortalSession, projectId: string) {
  const p = await one(
    q,
    `SELECT p.* FROM projects p
     WHERE p.account_id=$1 AND p.id=$2 AND p.customer_id=$3 AND p.portal_status='published'
       AND EXISTS (SELECT 1 FROM portal_invites i WHERE i.account_id=p.account_id AND i.project_id=p.id AND i.customer_id=$3
                   AND i.stopped_at IS NULL AND i.use_count > 0)`,
    [sess.accountId, projectId, sess.customerId],
  );
  if (!p) throw notFound('案件');
  return p;
}

export async function clientProjects(q: Queryable, sess: PortalSession) {
  return many(
    q,
    `SELECT p.id, p.number, p.title, p.status, p.portal_status_label, p.updated_at FROM projects p
     WHERE p.account_id=$1 AND p.customer_id=$2 AND p.portal_status='published'
       AND EXISTS (SELECT 1 FROM portal_invites i WHERE i.account_id=p.account_id AND i.project_id=p.id AND i.customer_id=$2
                   AND i.stopped_at IS NULL AND i.use_count > 0)
     ORDER BY p.updated_at DESC`,
    [sess.accountId, sess.customerId],
  );
}

export async function projectVersion(q: Queryable, accountId: string, projectId: string, versionId: string, lock = false) {
  const v = await one(
    q,
    `SELECT v.*, d.title AS deliverable_title, a.filename, a.mime, a.size_bytes, a.sha256
     FROM portal_versions v
     JOIN portal_deliverables d ON d.account_id=v.account_id AND d.id=v.deliverable_id
     JOIN attachments a ON a.account_id=v.account_id AND a.id=v.attachment_id
     WHERE v.account_id=$1 AND v.project_id=$2 AND v.id=$3 ${lock ? 'FOR UPDATE OF v' : ''}`,
    [accountId, projectId, versionId],
  );
  if (!v) throw notFound('版');
  return v;
}

async function latestVersion(q: Queryable, accountId: string, deliverableId: string) {
  return one(q, 'SELECT * FROM portal_versions WHERE account_id=$1 AND deliverable_id=$2 ORDER BY version_number DESC LIMIT 1', [accountId, deliverableId]);
}

export function fileUrl(audience: Audience, projectId: string, attachmentId: string) {
  return audience === 'operator' ? `/api/attachments/${attachmentId}` : `/api/portal/projects/${projectId}/files/${attachmentId}`;
}

/** 受注以降の案件だけ、ポータル操作に合わせて状態を前進させる（見積前の提案段階では動かさない） */
async function advanceIfOrdered(tx: Tx, accountId: string, projectId: string, target: ProjectStatus, note: string) {
  const p = await one(tx, 'SELECT status FROM projects WHERE account_id=$1 AND id=$2', [accountId, projectId]);
  if (!p || PROJECT_STATUS_RANK[p.status as ProjectStatus] < PROJECT_STATUS_RANK.ordered) return;
  await advanceProjectStatus(tx, accountId, projectId, target, note);
}

// ---------------------------------------------------------------- 招待リンク

export function inviteState(i: any, now: Date): 'active' | 'expired' | 'revoked' | 'locked' | 'stopped' {
  if (i.stopped_at) return 'stopped';
  if (i.revoke_reason === 'locked') return 'locked';
  if (i.revoked_at) return 'revoked';
  if (new Date(i.expires_at) <= now) return 'expired';
  return 'active';
}

export function inviteDto(i: any, now: Date) {
  return {
    id: i.id,
    email: i.email,
    state: inviteState(i, now),
    createdAt: i.created_at,
    expiresAt: i.expires_at,
    revokedAt: i.revoked_at,
    revokeReason: i.revoke_reason,
    stoppedAt: i.stopped_at,
    useCount: i.use_count,
    failedAttempts: i.failed_attempts,
    lastUsedAt: i.last_used_at,
  };
}

/** 招待リンクの発行（再発行）。有効な旧リンクは自動で失効させる。平文トークンはこの応答でのみ返す */
export async function issueInvite(tx: Tx, s: Services, accountId: string, projectId: string, days: number) {
  const p = await one(
    tx,
    `SELECT p.id, p.customer_id, c.email FROM projects p JOIN customers c ON c.account_id=p.account_id AND c.id=p.customer_id
     WHERE p.account_id=$1 AND p.id=$2 FOR UPDATE OF p`,
    [accountId, projectId],
  );
  if (!p) throw notFound('案件');
  const email = String(p.email ?? '').trim().toLowerCase();
  if (!email) throw badRequest('顧客のメールアドレスが未登録です。顧客情報にメールアドレスを登録してから招待リンクを発行してください', 'no_customer_email');
  const now = s.now();
  await tx.query(
    `UPDATE portal_invites SET revoked_at=$3, revoke_reason='reissued'
     WHERE account_id=$1 AND project_id=$2 AND revoked_at IS NULL AND stopped_at IS NULL`,
    [accountId, projectId, now],
  );
  const token = randomToken(32);
  const expires = new Date(now.getTime() + days * 86400_000);
  const inv = await one(
    tx,
    `INSERT INTO portal_invites (account_id, project_id, customer_id, email, token_hash, expires_at, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [accountId, projectId, p.customer_id, email, sha256(token), expires, now],
  );
  await logEvent(tx, accountId, projectId, 'portal_invite', `クライアントポータルの招待リンクを発行（有効期限 ${days}日）`);
  return { invite: inviteDto(inv, now), token, path: `/portal/invite#t=${token}` };
}

export async function revokeInvite(tx: Tx, s: Services, accountId: string, projectId: string, inviteId: string) {
  const r = await tx.query(
    `UPDATE portal_invites SET revoked_at=COALESCE(revoked_at, $4), revoke_reason=CASE WHEN revoked_at IS NULL THEN 'manual' ELSE revoke_reason END
     WHERE account_id=$1 AND project_id=$2 AND id=$3`,
    [accountId, projectId, inviteId, s.now()],
  );
  if (!r.rowCount) throw notFound('招待リンク');
  await logEvent(tx, accountId, projectId, 'portal_invite_revoked', 'クライアントポータルの招待リンクを失効');
}

/** アクセス停止：全リンクを失効し、リンクから入った端末もこの案件を見られなくする（再開は招待リンクの再発行） */
export async function stopAccess(tx: Tx, s: Services, accountId: string, projectId: string) {
  await tx.query(
    `UPDATE portal_invites SET stopped_at=COALESCE(stopped_at, $3), revoked_at=COALESCE(revoked_at, $3),
       revoke_reason=CASE WHEN revoked_at IS NULL THEN 'stopped' ELSE revoke_reason END
     WHERE account_id=$1 AND project_id=$2`,
    [accountId, projectId, s.now()],
  );
  await logEvent(tx, accountId, projectId, 'portal_access_stopped', 'クライアントポータルへのアクセスを停止');
}

const INVITE_ERRORS = {
  invalid: [404, 'リンクが正しくないか、無効になっています。担当者にお問い合わせください'],
  expired: [410, 'このリンクは有効期限が切れています。担当者に再発行を依頼してください'],
  revoked: [410, 'このリンクは無効になっています。担当者に再発行を依頼してください'],
  locked: [410, '確認に複数回失敗したため、このリンクは無効化されました。担当者に再発行を依頼してください'],
  stopped: [410, 'このリンクは無効になっています。担当者に再発行を依頼してください'],
  closed: [403, 'このポータルは現在公開されていません。担当者にお問い合わせください'],
} as const;

function inviteError(kind: keyof typeof INVITE_ERRORS) {
  const [status, msg] = INVITE_ERRORS[kind];
  return new HttpError(status, msg, `invite_${kind}`);
}

async function findInvite(q: Queryable, token: string, lock: boolean) {
  if (!token || token.length > 200) return null;
  return one(
    q,
    `SELECT i.*, p.portal_status, p.customer_id AS project_customer_id, p.title AS project_title, b.name AS business_name
     FROM portal_invites i
     JOIN projects p ON p.account_id=i.account_id AND p.id=i.project_id
     LEFT JOIN business_profiles b ON b.account_id=i.account_id
     WHERE i.token_hash=$1 ${lock ? 'FOR UPDATE OF i' : ''}`,
    [sha256(token)],
  );
}

function inviteProblem(inv: any, now: Date): keyof typeof INVITE_ERRORS | null {
  if (!inv) return 'invalid';
  if (inv.project_customer_id !== inv.customer_id) return 'revoked'; // 案件の顧客が変更された
  const st = inviteState(inv, now);
  if (st !== 'active') return st;
  if (inv.portal_status !== 'published') return 'closed';
  return null;
}

/** リンクを開いた時点の確認（メールアドレスは返さない） */
export async function inspectInvite(q: Queryable, s: Services, token: string) {
  const inv = await findInvite(q, token, false);
  const problem = inviteProblem(inv, s.now());
  if (problem) throw inviteError(problem);
  return { businessName: inv.business_name ?? '', projectTitle: inv.project_title, expiresAt: inv.expires_at };
}

/**
 * 招待の引換：登録メールアドレスと一致すれば顧客セッションを作成。
 * 失敗回数はトランザクションを確定させてから例外にする（ロールバックで数え直されないように）。
 */
export async function redeemInvite(tx: Tx, s: Services, c: Context, token: string, email: string): Promise<{ ok: true; projectId: string } | { ok: false; error: HttpError }> {
  const now = s.now();
  const inv = await findInvite(tx, token, true);
  const problem = inviteProblem(inv, now);
  if (problem) return { ok: false, error: inviteError(problem) };
  if (email.trim().toLowerCase() !== inv.email) {
    const failed = Number(inv.failed_attempts) + 1;
    const lock = failed >= INVITE_MAX_FAILURES;
    await tx.query(
      `UPDATE portal_invites SET failed_attempts=$2, revoked_at=CASE WHEN $3 THEN $4::timestamptz ELSE revoked_at END,
         revoke_reason=CASE WHEN $3 THEN 'locked' ELSE revoke_reason END WHERE id=$1`,
      [inv.id, failed, lock, now],
    );
    if (lock) {
      await logEvent(tx, inv.account_id, inv.project_id, 'portal_invite_locked', 'メールアドレスの確認に複数回失敗したため、招待リンクを無効化');
      return { ok: false, error: inviteError('locked') };
    }
    return {
      ok: false,
      error: new HttpError(400, `メールアドレスが一致しません（あと${INVITE_MAX_FAILURES - failed}回失敗するとリンクが無効になります）`, 'email_mismatch'),
    };
  }
  await tx.query('UPDATE portal_invites SET use_count=use_count+1, last_used_at=$2, failed_attempts=0 WHERE id=$1', [inv.id, now]);
  await createPortalSession(tx, s, c, inv.account_id, inv.customer_id, inv.id);
  if (Number(inv.use_count) === 0) {
    await logEvent(tx, inv.account_id, inv.project_id, 'portal_invite_used', 'お客様がクライアントポータルの招待リンクを使用');
  }
  return { ok: true, projectId: inv.project_id };
}

// ---------------------------------------------------------------- DTO

export function commentDto(c: any, viewer: { audience: Audience; customerId?: string }) {
  const deleted = !!c.deleted_at;
  const type = normalizePinType(c.pin_type);
  return {
    id: c.id,
    versionId: c.version_id,
    parentId: c.parent_id,
    authorType: c.author_type,
    authorName: c.author_name,
    mine: viewer.audience === 'operator' ? c.author_type === 'operator' : c.author_type === 'client' && c.customer_id === viewer.customerId,
    body: deleted ? '' : c.body,
    deleted,
    pin: c.pin_number !== null && c.pin_number !== undefined ? { x: Number(c.pin_x), y: Number(c.pin_y), number: c.pin_number, type, typeLabel: PIN_TYPE_LABEL[type] } : null,
    resolved: !!c.resolved_at,
    resolvedAt: c.resolved_at,
    createdAt: c.created_at,
  };
}

function approvalDto(a: any) {
  return {
    id: a.id,
    versionId: a.version_id,
    versionNumber: a.version_number,
    clientName: a.client_name,
    comment: a.comment,
    fileSha256: a.file_sha256,
    approvedAt: a.approved_at,
    revokedAt: a.revoked_at,
    revokeReason: a.revoke_reason,
  };
}

export const VERSION_STATUS_LABELS: Record<string, string> = {
  in_review: '確認待ち',
  changes_requested: '修正依頼あり',
  approved: '承認済み',
  superseded: '旧版',
};

async function versionSummaries(q: Queryable, accountId: string, projectId: string, audience: Audience) {
  const rows = await many(
    q,
    `SELECT v.id, v.deliverable_id, v.version_number, v.status, v.note, v.submitted_at, v.attachment_id, a.filename, a.mime, a.size_bytes,
       (SELECT count(*)::int FROM portal_comments c WHERE c.version_id=v.id AND c.deleted_at IS NULL) AS comment_count,
       (SELECT count(*)::int FROM portal_comments c WHERE c.version_id=v.id AND c.deleted_at IS NULL AND c.pin_number IS NOT NULL AND c.resolved_at IS NULL) AS open_pin_count,
       (SELECT count(*)::int FROM portal_change_requests r WHERE r.version_id=v.id) AS change_request_count
     FROM portal_versions v JOIN attachments a ON a.account_id=v.account_id AND a.id=v.attachment_id
     WHERE v.account_id=$1 AND v.project_id=$2 ORDER BY v.version_number DESC`,
    [accountId, projectId],
  );
  const approvals = await many(q, 'SELECT * FROM portal_approvals WHERE account_id=$1 AND project_id=$2 AND revoked_at IS NULL', [accountId, projectId]);
  const byVersion = new Map(approvals.map((a) => [a.version_id, a]));
  return rows.map((v) => ({
    id: v.id,
    deliverableId: v.deliverable_id,
    versionNumber: v.version_number,
    status: v.status,
    statusLabel: VERSION_STATUS_LABELS[v.status],
    note: v.note,
    submittedAt: v.submitted_at,
    file: { id: v.attachment_id, filename: v.filename, mime: v.mime, sizeBytes: Number(v.size_bytes), url: fileUrl(audience, projectId, v.attachment_id), canPin: PIN_IMAGE_MIMES.includes(v.mime) },
    approval: byVersion.has(v.id) ? approvalDto(byVersion.get(v.id)) : null,
    commentCount: v.comment_count,
    openPinCount: v.open_pin_count,
    changeRequestCount: v.change_request_count,
  }));
}

export async function deliverablesWithVersions(q: Queryable, accountId: string, projectId: string, audience: Audience) {
  const ds = await many(q, 'SELECT * FROM portal_deliverables WHERE account_id=$1 AND project_id=$2 ORDER BY sort_order, created_at', [accountId, projectId]);
  const vs = await versionSummaries(q, accountId, projectId, audience);
  return ds
    .map((d) => {
      const versions = vs.filter((v) => v.deliverableId === d.id);
      return { id: d.id, title: d.title, description: d.description, createdAt: d.created_at, latest: versions[0] ?? null, versions };
    })
    .filter((d) => audience === 'operator' || d.versions.length > 0);
}

export async function versionDetail(q: Queryable, accountId: string, project: any, versionId: string, audience: Audience, customerId?: string) {
  const v = await projectVersion(q, accountId, project.id, versionId);
  const latest = await latestVersion(q, accountId, v.deliverable_id);
  const all = await deliverablesWithVersions(q, accountId, project.id, audience);
  const d = all.find((x) => x.id === v.deliverable_id)!;
  const summary = d.versions.find((x) => x.id === v.id)!;
  const comments = await many(q, 'SELECT * FROM portal_comments WHERE account_id=$1 AND version_id=$2 ORDER BY created_at, id', [accountId, v.id]);
  const crs = await many(q, 'SELECT * FROM portal_change_requests WHERE account_id=$1 AND version_id=$2 ORDER BY created_at', [accountId, v.id]);
  const approvals = await many(q, 'SELECT * FROM portal_approvals WHERE account_id=$1 AND version_id=$2 ORDER BY approved_at', [accountId, v.id]);
  return {
    project: { id: project.id, number: project.number, title: project.title },
    deliverable: { id: d.id, title: d.title, description: d.description },
    version: summary,
    versions: d.versions.map((x) => ({ id: x.id, versionNumber: x.versionNumber, statusLabel: x.statusLabel })),
    isLatest: latest?.id === v.id,
    latestVersionId: latest?.id ?? null,
    latestVersionNumber: latest?.version_number ?? null,
    comments: comments.filter((c) => !(c.deleted_at && audience === 'client')).map((c) => commentDto(c, { audience, customerId })),
    changeRequests: crs.map((r) => ({ id: r.id, clientName: r.client_name, body: r.body, createdAt: r.created_at, pinCount: (r.pin_comment_ids as string[]).length })),
    approvals: approvals.map(approvalDto),
  };
}

// ---------------------------------------------------------------- 制作物・版（運営者）

export async function createDeliverable(tx: Tx, accountId: string, projectId: string, i: { title: string; description: string }) {
  const max = await one(tx, 'SELECT COALESCE(max(sort_order),0) AS m FROM portal_deliverables WHERE account_id=$1 AND project_id=$2', [accountId, projectId]);
  return one(tx, 'INSERT INTO portal_deliverables (account_id, project_id, title, description, sort_order) VALUES ($1,$2,$3,$4,$5) RETURNING *', [
    accountId,
    projectId,
    i.title,
    i.description,
    Number(max.m) + 10,
  ]);
}

export async function lockDeliverable(tx: Tx, accountId: string, projectId: string, deliverableId: string) {
  const d = await one(tx, 'SELECT * FROM portal_deliverables WHERE account_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE', [accountId, projectId, deliverableId]);
  if (!d) throw notFound('制作物');
  return d;
}

/** 新しい版を提出（添付保存後、同じトランザクション内）。旧版は superseded として残し、旧版の承認は引き継がない */
export async function insertVersion(tx: Tx, accountId: string, projectId: string, d: any, attachmentId: string, note: string, requestId: string | null) {
  const prev = await latestVersion(tx, accountId, d.id);
  const num = (prev?.version_number ?? 0) + 1;
  if (prev && prev.status !== 'superseded') await tx.query(`UPDATE portal_versions SET status='superseded' WHERE id=$1`, [prev.id]);
  const v = await one(
    tx,
    `INSERT INTO portal_versions (account_id, project_id, deliverable_id, version_number, attachment_id, note, request_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [accountId, projectId, d.id, num, attachmentId, note, requestId],
  );
  await tx.query('UPDATE portal_deliverables SET updated_at=now() WHERE id=$1', [d.id]);
  await logEvent(tx, accountId, projectId, 'portal_version', `制作物「${d.title}」v${num} を提出（確認依頼）`, { refType: 'portal_version', refId: v.id, clientVisible: true });
  await advanceIfOrdered(tx, accountId, projectId, 'in_progress', 'クライアントポータルで制作物を提出');
  return v;
}

// ---------------------------------------------------------------- コメント（修正指示ピン）

export interface CommentInput {
  body: string;
  pin?: { x: number; y: number } | null;
  pinType?: PinType | null;
  parentId?: string | null;
}

export async function createComment(
  tx: Tx,
  accountId: string,
  project: any,
  versionId: string,
  author: { type: Audience; name: string; customerId?: string },
  i: CommentInput,
) {
  const v = await projectVersion(tx, accountId, project.id, versionId, true);
  const body = i.body.trim();
  if (!body) throw badRequest('コメントを入力してください');
  if (i.pin) {
    if (!PIN_IMAGE_MIMES.includes(v.mime)) throw badRequest('ピン（修正指示）は画像（JPEG/PNG/GIF/WebP）の版にのみ付けられます');
    if (i.parentId) throw badRequest('返信にはピンを付けられません');
  }
  if (i.parentId) {
    const parent = await one(tx, 'SELECT * FROM portal_comments WHERE account_id=$1 AND id=$2 AND version_id=$3', [accountId, i.parentId, v.id]);
    if (!parent || parent.parent_id) throw notFound('返信先コメント');
  }
  let pinNumber: number | null = null;
  if (i.pin) {
    const m = await one(tx, 'SELECT COALESCE(max(pin_number),0) AS m FROM portal_comments WHERE version_id=$1', [v.id]);
    pinNumber = Number(m.m) + 1;
  }
  const c = await one(
    tx,
    `INSERT INTO portal_comments (account_id, project_id, version_id, parent_id, author_type, customer_id, author_name, body, pin_x, pin_y, pin_number, pin_type)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [
      accountId,
      project.id,
      v.id,
      i.parentId ?? null,
      author.type,
      author.customerId ?? null,
      author.name,
      body,
      i.pin?.x ?? null,
      i.pin?.y ?? null,
      pinNumber,
      i.pin ? normalizePinType(i.pinType) : null,
    ],
  );
  if (author.type === 'client') {
    await logEvent(tx, accountId, project.id, 'portal_comment', `お客様がコメント（${v.deliverable_title} v${v.version_number}${pinNumber ? `・修正指示${pinNumber}` : ''}）`, {
      refType: 'portal_version',
      refId: v.id,
    });
  }
  return c;
}

export async function resolveComment(tx: Tx, s: Services, accountId: string, projectId: string, commentId: string, resolved: boolean) {
  const r = await tx.query(
    'UPDATE portal_comments SET resolved_at=$4 WHERE account_id=$1 AND project_id=$2 AND id=$3 AND deleted_at IS NULL',
    [accountId, projectId, commentId, resolved ? s.now() : null],
  );
  if (!r.rowCount) throw notFound('コメント');
}

/** 自分のコメントを削除（ピン番号は振り直さない） */
export async function deleteOwnComment(tx: Tx, s: Services, accountId: string, projectId: string, commentId: string, viewer: { audience: Audience; customerId?: string }) {
  const c = await one(tx, 'SELECT * FROM portal_comments WHERE account_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE', [accountId, projectId, commentId]);
  if (!c || (viewer.audience === 'client' && c.deleted_at)) throw notFound('コメント');
  if (!commentDto(c, viewer).mine) throw new HttpError(403, '自分のコメントのみ削除できます', 'forbidden');
  await tx.query('UPDATE portal_comments SET deleted_at=COALESCE(deleted_at, $2) WHERE id=$1', [c.id, s.now()]);
}

// ---------------------------------------------------------------- 修正依頼・承認（顧客）

function staleError(v: any, latest: any) {
  return new HttpError(409, `この版（v${v.version_number}）は最新版ではありません。最新版（v${latest.version_number}）をご確認ください`, 'stale_version', {
    latestVersionId: latest.id,
    latestVersionNumber: latest.version_number,
  });
}

export async function requestChanges(tx: Tx, accountId: string, project: any, sess: PortalSession, versionId: string, body: string) {
  const text = body.trim();
  if (!text) throw badRequest('修正内容を入力してください');
  const v0 = await projectVersion(tx, accountId, project.id, versionId);
  await lockDeliverable(tx, accountId, project.id, v0.deliverable_id);
  const v = await projectVersion(tx, accountId, project.id, versionId, true);
  const latest = await latestVersion(tx, accountId, v.deliverable_id);
  if (latest.id !== v.id) throw staleError(v, latest);
  if (v.status === 'approved') throw conflict('この版は承認済みです。修正が必要な場合は担当者にご連絡ください', 'already_approved');
  const pins = await many(
    tx,
    'SELECT id FROM portal_comments WHERE version_id=$1 AND pin_number IS NOT NULL AND deleted_at IS NULL AND resolved_at IS NULL ORDER BY pin_number',
    [v.id],
  );
  const cr = await one(
    tx,
    `INSERT INTO portal_change_requests (account_id, project_id, version_id, customer_id, client_name, body, pin_comment_ids) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [accountId, project.id, v.id, sess.customerId, sess.clientName, text, JSON.stringify(pins.map((p) => p.id))],
  );
  await tx.query(`UPDATE portal_versions SET status='changes_requested' WHERE id=$1`, [v.id]);
  await logEvent(tx, accountId, project.id, 'portal_change_request', `修正依頼：${v.deliverable_title} v${v.version_number}（${sess.clientName}・修正指示${pins.length}件）`, {
    refType: 'portal_version',
    refId: v.id,
    note: text.slice(0, 500),
    clientVisible: true,
  });
  return { id: cr.id, pinCount: pins.length };
}

/**
 * 承認：最新版かつ確認待ち/修正依頼の状態のみ。
 * - expectedVersionNumber（顧客が見ていた版番号）も照合し、新しい版が出ていれば 409 stale_version
 * - 冪等キーの再送は同じ承認を返す（duplicate=true）。有効な承認は1版1件（部分UNIQUEインデックス）
 */
export async function approveVersion(
  tx: Tx,
  accountId: string,
  project: any,
  sess: PortalSession,
  i: { versionId: string; idempotencyKey: string; expectedVersionNumber?: number; comment: string },
) {
  await lockRequest(tx, accountId, `portal-approve:${i.idempotencyKey}`);
  const byKey = await one(tx, 'SELECT * FROM portal_approvals WHERE account_id=$1 AND idempotency_key=$2', [accountId, i.idempotencyKey]);
  if (byKey) {
    if (byKey.version_id !== i.versionId || byKey.customer_id !== sess.customerId || byKey.project_id !== project.id) {
      throw conflict('リクエストが重複しています。画面を再読み込みしてください', 'idempotency_conflict');
    }
    return { approval: approvalDto(byKey), duplicate: true };
  }
  const v0 = await projectVersion(tx, accountId, project.id, i.versionId);
  await lockDeliverable(tx, accountId, project.id, v0.deliverable_id);
  const v = await projectVersion(tx, accountId, project.id, i.versionId, true);
  const latest = await latestVersion(tx, accountId, v.deliverable_id);
  if (latest.id !== v.id || (i.expectedVersionNumber !== undefined && i.expectedVersionNumber !== v.version_number)) throw staleError(v, latest);
  const active = await one(tx, 'SELECT * FROM portal_approvals WHERE version_id=$1 AND revoked_at IS NULL', [v.id]);
  if (active) return { approval: approvalDto(active), duplicate: true };
  if (v.status !== 'in_review' && v.status !== 'changes_requested') throw conflict('この版は現在承認できない状態です', 'not_approvable');
  const a = await one(
    tx,
    `INSERT INTO portal_approvals (account_id, project_id, version_id, version_number, customer_id, client_name, attachment_id, file_sha256, comment, idempotency_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [accountId, project.id, v.id, v.version_number, sess.customerId, sess.clientName, v.attachment_id, v.sha256, i.comment.trim().slice(0, 1000), i.idempotencyKey],
  );
  await tx.query(`UPDATE portal_versions SET status='approved' WHERE id=$1`, [v.id]);
  await logEvent(tx, accountId, project.id, 'portal_approved', `承認：${v.deliverable_title} v${v.version_number}（${sess.clientName}）`, {
    refType: 'portal_version',
    refId: v.id,
    clientVisible: true,
  });
  // すべての制作物の最新版が承認済みになったら「納品待ち」へ
  const pending = await one(
    tx,
    `SELECT count(*)::int AS n FROM portal_deliverables d
     WHERE d.account_id=$1 AND d.project_id=$2
       AND (SELECT v.status FROM portal_versions v WHERE v.deliverable_id=d.id ORDER BY v.version_number DESC LIMIT 1) IS DISTINCT FROM 'approved'
       AND EXISTS (SELECT 1 FROM portal_versions v WHERE v.deliverable_id=d.id)`,
    [accountId, project.id],
  );
  if (pending.n === 0) await advanceIfOrdered(tx, accountId, project.id, 'awaiting_delivery', 'クライアントポータルで全制作物が承認された');
  return { approval: approvalDto(a), duplicate: false };
}

/** 承認の取消（運営者）。公開中の納品に含まれる承認は取り消せない。案件状態は自動で戻さない */
export async function revokeApproval(tx: Tx, s: Services, accountId: string, projectId: string, approvalId: string, reason: string) {
  const a = await one(tx, 'SELECT * FROM portal_approvals WHERE account_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE', [accountId, projectId, approvalId]);
  if (!a) throw notFound('承認');
  if (a.revoked_at) throw conflict('すでに取り消されています', 'already_revoked');
  const inDelivery = await one(
    tx,
    `SELECT d.number FROM portal_delivery_items i JOIN deliveries d ON d.account_id=i.account_id AND d.id=i.delivery_id
     WHERE i.approval_id=$1 AND d.portal_status='published' LIMIT 1`,
    [a.id],
  );
  if (inDelivery) throw conflict(`公開中の納品（${inDelivery.number}）に含まれているため取り消せません。先に納品の公開を取り下げてください`, 'in_delivery');
  await tx.query('UPDATE portal_approvals SET revoked_at=$2, revoke_reason=$3 WHERE id=$1', [a.id, s.now(), reason]);
  const v = await one(tx, 'SELECT v.*, d.title FROM portal_versions v JOIN portal_deliverables d ON d.id=v.deliverable_id WHERE v.id=$1', [a.version_id]);
  const latest = await latestVersion(tx, accountId, v.deliverable_id);
  if (latest.id === v.id && v.status === 'approved') await tx.query(`UPDATE portal_versions SET status='in_review' WHERE id=$1`, [v.id]);
  await logEvent(tx, accountId, projectId, 'portal_approval_revoked', `承認を取消：${v.title} v${v.version_number}`, { note: reason, refType: 'portal_version', refId: v.id, clientVisible: true });
}

// ---------------------------------------------------------------- 納品の公開

/** 既存の納品記録をポータルに公開。含める版はすべて有効な承認があること（公開時に再確認） */
export async function publishDelivery(tx: Tx, accountId: string, projectId: string, deliveryId: string, i: { versionIds: string[]; message: string }) {
  const d = await one(tx, 'SELECT * FROM deliveries WHERE account_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE', [accountId, projectId, deliveryId]);
  if (!d) throw notFound('納品');
  const items: Array<{ versionId: string; approvalId: string }> = [];
  for (const vid of [...new Set(i.versionIds)]) {
    const v = await one(tx, 'SELECT v.id, v.version_number, d.title FROM portal_versions v JOIN portal_deliverables d ON d.id=v.deliverable_id WHERE v.account_id=$1 AND v.project_id=$2 AND v.id=$3', [
      accountId,
      projectId,
      vid,
    ]);
    if (!v) throw notFound('版');
    const a = await one(tx, 'SELECT id FROM portal_approvals WHERE version_id=$1 AND revoked_at IS NULL', [vid]);
    if (!a) throw conflict(`「${v.title} v${v.version_number}」は承認されていないため、納品に含められません`, 'not_approved');
    items.push({ versionId: vid, approvalId: a.id });
  }
  await tx.query('DELETE FROM portal_delivery_items WHERE account_id=$1 AND delivery_id=$2', [accountId, deliveryId]);
  for (const it of items) {
    await tx.query('INSERT INTO portal_delivery_items (account_id, delivery_id, version_id, approval_id) VALUES ($1,$2,$3,$4)', [accountId, deliveryId, it.versionId, it.approvalId]);
  }
  await tx.query(`UPDATE deliveries SET portal_status='published', portal_published_at=now(), portal_message=$3 WHERE account_id=$1 AND id=$2`, [accountId, deliveryId, i.message]);
  await logEvent(tx, accountId, projectId, 'portal_delivery_published', `納品 ${d.number} をクライアントポータルで公開`, { refType: 'delivery', refId: d.id, clientVisible: true });
  await advanceProjectStatus(tx, accountId, projectId, 'delivered', 'クライアントポータルで納品を公開');
}

export async function withdrawDelivery(tx: Tx, accountId: string, projectId: string, deliveryId: string) {
  const d = await one(tx, 'SELECT * FROM deliveries WHERE account_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE', [accountId, projectId, deliveryId]);
  if (!d) throw notFound('納品');
  if (d.portal_status !== 'published') throw conflict('公開中の納品ではありません', 'not_published');
  await tx.query(`UPDATE deliveries SET portal_status='withdrawn' WHERE id=$1`, [d.id]);
  await logEvent(tx, accountId, projectId, 'portal_delivery_withdrawn', `納品 ${d.number} のポータル公開を取り下げ`, { refType: 'delivery', refId: d.id, clientVisible: true });
}

export async function deliveriesFor(q: Queryable, accountId: string, projectId: string, audience: Audience) {
  const ds = await many(
    q,
    `SELECT id, number, delivered_on, content, customer_comment, portal_status, portal_published_at, portal_message FROM deliveries
     WHERE account_id=$1 AND project_id=$2 ${audience === 'client' ? "AND portal_status='published'" : ''} ORDER BY delivered_on, created_at`,
    [accountId, projectId],
  );
  if (!ds.length) return [];
  const ids = ds.map((d) => d.id);
  const files = await many(
    q,
    `SELECT id, delivery_id, filename, mime, size_bytes FROM attachments WHERE account_id=$1 AND purpose='delivery' AND delivery_id = ANY($2::uuid[]) ORDER BY created_at`,
    [accountId, ids],
  );
  const items = await many(
    q,
    `SELECT i.delivery_id, v.id AS version_id, v.version_number, dl.title, a.id AS attachment_id, a.filename, a.mime, a.size_bytes
     FROM portal_delivery_items i JOIN portal_versions v ON v.id=i.version_id JOIN portal_deliverables dl ON dl.id=v.deliverable_id
     JOIN attachments a ON a.id=v.attachment_id WHERE i.account_id=$1 AND i.delivery_id = ANY($2::uuid[]) ORDER BY dl.sort_order, v.version_number`,
    [accountId, ids],
  );
  return ds.map((d) => ({
    id: d.id,
    number: d.number,
    deliveredOn: d.delivered_on,
    content: d.content,
    customerComment: d.customer_comment,
    portalStatus: d.portal_status,
    portalPublishedAt: d.portal_published_at,
    portalMessage: d.portal_message,
    pdfUrl: audience === 'operator' ? `/api/pdf/deliveries/${d.id}` : `/api/portal/projects/${projectId}/deliveries/${d.id}/pdf`,
    versions: items
      .filter((it) => it.delivery_id === d.id)
      .map((it) => ({ versionId: it.version_id, label: `${it.title} v${it.version_number}`, file: { id: it.attachment_id, filename: it.filename, mime: it.mime, sizeBytes: Number(it.size_bytes), url: fileUrl(audience, projectId, it.attachment_id) } })),
    files: files
      .filter((f) => f.delivery_id === d.id)
      .map((f) => ({ id: f.id, filename: f.filename, mime: f.mime, sizeBytes: Number(f.size_bytes), url: fileUrl(audience, projectId, f.id) })),
  }));
}

// ---------------------------------------------------------------- ファイル配信（顧客）

/**
 * 顧客がこの添付を取得できるか（用途ごとの公開判定）：
 * - portal_version: 提出済みの版のファイル
 * - delivery: ポータルで公開中の納品の添付
 * - selection_photo: 公開済み（受付中・受付終了）の写真セレクトの写真
 * それ以外（案件の内部ファイル・ロゴ等）は 404
 */
export async function clientReadableAttachment(q: Queryable, accountId: string, projectId: string, attachmentId: string) {
  const a = await one(
    q,
    `SELECT a.id, a.filename, a.mime, a.purpose, b.data,
       (SELECT sp.position FROM selection_photos sp WHERE sp.attachment_id=a.id) AS sel_position,
       (SELECT ss.show_names FROM selection_photos sp JOIN selection_sets ss ON ss.id=sp.set_id WHERE sp.attachment_id=a.id) AS sel_show_names
     FROM attachments a JOIN attachment_blobs b ON b.attachment_id=a.id
     WHERE a.account_id=$1 AND a.project_id=$2 AND a.id=$3 AND (
       (a.purpose='portal_version' AND EXISTS (SELECT 1 FROM portal_versions v WHERE v.attachment_id=a.id AND v.project_id=$2))
       OR (a.purpose='delivery' AND EXISTS (SELECT 1 FROM deliveries d WHERE d.account_id=a.account_id AND d.id=a.delivery_id AND d.project_id=$2 AND d.portal_status='published'))
       OR (a.purpose='selection_photo' AND EXISTS (SELECT 1 FROM selection_photos sp JOIN selection_sets ss ON ss.id=sp.set_id
             WHERE sp.attachment_id=a.id AND ss.project_id=$2 AND ss.status IN ('open','closed')))
     )`,
    [accountId, projectId, attachmentId],
  );
  if (!a) throw notFound('ファイル');
  return a;
}

// ---------------------------------------------------------------- FreelanceDesk 修正指示（指示書）

export async function buildInstructionSheet(
  q: Queryable,
  s: Services,
  accountId: string,
  project: any,
  versionId: string,
  opts: { changeRequestId?: string; includeResolved?: boolean },
  audience: Audience,
) {
  const v = await projectVersion(q, accountId, project.id, versionId);
  let rows = await many(q, 'SELECT * FROM portal_comments WHERE version_id=$1 AND pin_number IS NOT NULL AND deleted_at IS NULL ORDER BY pin_number', [v.id]);
  let changeRequest: { id: string; clientName: string; body: string; createdAt: string } | null = null;
  if (opts.changeRequestId) {
    const cr = await one(q, 'SELECT * FROM portal_change_requests WHERE account_id=$1 AND project_id=$2 AND version_id=$3 AND id=$4', [
      accountId,
      project.id,
      v.id,
      opts.changeRequestId,
    ]);
    if (!cr) throw notFound('修正依頼');
    const ids = new Set(cr.pin_comment_ids as string[]);
    rows = rows.filter((r) => ids.has(r.id));
    changeRequest = { id: cr.id, clientName: cr.client_name, body: cr.body, createdAt: cr.created_at };
  } else if (!opts.includeResolved) {
    rows = rows.filter((r) => !r.resolved_at);
  }
  const pins = rows.map((r) => {
    const type = normalizePinType(r.pin_type);
    return { commentId: r.id, number: r.pin_number as number, type, typeLabel: PIN_TYPE_LABEL[type], text: r.body as string, x: Number(r.pin_x), y: Number(r.pin_y), resolved: !!r.resolved_at, authorName: r.author_name };
  });
  const info = {
    projectName: `${project.number} ${project.title}`,
    imageName: `${v.deliverable_title} v${v.version_number}（${v.filename}）`,
    date: todayIn(s.config.tz, s.now()),
    note: changeRequest ? `修正依頼（${changeRequest.clientName}）:\n${changeRequest.body}` : '',
  };
  return {
    project: { id: project.id, number: project.number, title: project.title },
    deliverable: { id: v.deliverable_id, title: v.deliverable_title },
    version: { id: v.id, versionNumber: v.version_number, status: v.status },
    file: { id: v.attachment_id, filename: v.filename, mime: v.mime, url: fileUrl(audience, project.id, v.attachment_id), canPin: PIN_IMAGE_MIMES.includes(v.mime) },
    changeRequest,
    pins,
    info,
    text: buildInstructionText(info, pins),
  };
}

// ---------------------------------------------------------------- 画面用の集約

export function clientStatusLabel(p: any): string {
  return p.portal_status_label || PROJECT_STATUS_LABELS[p.status as ProjectStatus] || '';
}
