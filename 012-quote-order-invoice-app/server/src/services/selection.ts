// FreelanceDesk 写真セレクト（Client Portal 写真セレクトの移植）
// 運営者が写真を「セレクト」に登録すると 001, 002… の番号が付き、顧客はポータルでクリックまたは番号入力（例「001, 007、012」）で選んで送信する。
// 運営者は番号→元ファイル名の対応で結果を確認し、CSV/テキストで書き出す。規則は shared/photoSelect.ts。
import type { PortalSession, Services } from '../context';
import type { Queryable, Tx } from '../db';
import { many, one } from '../db';
import { badRequest, conflict, notFound } from './errors';
import { logEvent } from './events';
import { fileUrl, type Audience } from './portal';
import { SELECTION_MAX_PHOTOS, buildCsv, buildSelectionText, checkSelection, formatNumber, naturalCompare } from '../../../shared/photoSelect';

export const SELECTION_STATUS_LABELS: Record<string, string> = { draft: '準備中（お客様に非表示）', open: '選択受付中', closed: '受付終了' };
export const SELECTION_IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

export async function projectSelection(q: Queryable, accountId: string, projectId: string, setId: string, lock = false) {
  const s = await one(q, `SELECT * FROM selection_sets WHERE account_id=$1 AND project_id=$2 AND id=$3 ${lock ? 'FOR UPDATE' : ''}`, [accountId, projectId, setId]);
  if (!s) throw notFound('写真セレクト');
  return s;
}

/** 顧客：公開済み（open/closed）のみ。準備中は存在を明かさない */
export async function clientSelection(q: Queryable, accountId: string, projectId: string, setId: string, lock = false) {
  const s = await projectSelection(q, accountId, projectId, setId, lock);
  if (s.status === 'draft') throw notFound('写真セレクト');
  return s;
}

async function photos(q: Queryable, setId: string) {
  return many(
    q,
    `SELECT sp.id AS photo_id, sp.position, a.id AS attachment_id, a.filename, a.mime, a.size_bytes, a.sha256
     FROM selection_photos sp JOIN attachments a ON a.account_id=sp.account_id AND a.id=sp.attachment_id
     WHERE sp.set_id=$1 ORDER BY sp.position`,
    [setId],
  );
}

async function picksOf(q: Queryable, setId: string, customerId?: string): Promise<Array<{ customer_id: string; photo_id: string }>> {
  return customerId
    ? many(q, 'SELECT customer_id, photo_id FROM selection_picks WHERE set_id=$1 AND customer_id=$2', [setId, customerId])
    : many(q, 'SELECT customer_id, photo_id FROM selection_picks WHERE set_id=$1', [setId]);
}

function extOf(name: string): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(name);
  return m ? `.${m[1].toLowerCase()}` : '';
}

/** 顧客向けの表示名：元ファイル名を見せない設定なら「007.jpg」 */
export function selectionDisplayName(filename: string, position: number, showNames: boolean): string {
  return showNames ? filename : `${formatNumber(position)}${extOf(filename)}`;
}

export async function selectionSummary(q: Queryable, s: any, audience: Audience, customerId?: string) {
  const cnt = await one(q, 'SELECT count(*)::int AS n FROM selection_photos WHERE set_id=$1', [s.id]);
  const base = { id: s.id, title: s.title, message: s.message, status: s.status, statusLabel: SELECTION_STATUS_LABELS[s.status], photoCount: cnt.n, updatedAt: s.updated_at };
  if (audience === 'client') {
    const mine = await one(q, 'SELECT count(*)::int AS n FROM selection_picks WHERE set_id=$1 AND customer_id=$2', [s.id, customerId]);
    const r = await one(q, 'SELECT submitted_at FROM selection_responses WHERE set_id=$1 AND customer_id=$2', [s.id, customerId]);
    return { ...base, myPickCount: mine.n, submittedAt: r?.submitted_at ?? null };
  }
  const resp = await many(q, 'SELECT submitted_at FROM selection_responses WHERE set_id=$1 AND submitted_at IS NOT NULL ORDER BY submitted_at', [s.id]);
  return { ...base, showNames: s.show_names, openedAt: s.opened_at, closedAt: s.closed_at, submittedCount: resp.length, lastSubmittedAt: resp.at(-1)?.submitted_at ?? null };
}

export async function listSelections(q: Queryable, accountId: string, projectId: string, audience: Audience, customerId?: string) {
  const sets = await many(
    q,
    `SELECT * FROM selection_sets WHERE account_id=$1 AND project_id=$2 ${audience === 'client' ? "AND status IN ('open','closed')" : ''} ORDER BY created_at`,
    [accountId, projectId],
  );
  const out = [];
  for (const s of sets) out.push(await selectionSummary(q, s, audience, customerId));
  return out;
}

export async function selectionDetailForOperator(q: Queryable, projectId: string, s: any) {
  const list = await photos(q, s.id);
  const nameCount = new Map<string, number>();
  for (const f of list) nameCount.set(f.filename, (nameCount.get(f.filename) ?? 0) + 1);
  const picks = await picksOf(q, s.id);
  const responses = await many(q, 'SELECT * FROM selection_responses WHERE set_id=$1 ORDER BY submitted_at NULLS LAST', [s.id]);
  const byPhoto = new Map<string, string[]>();
  for (const pk of picks) byPhoto.set(pk.photo_id, [...(byPhoto.get(pk.photo_id) ?? []), pk.customer_id]);
  const photoById = new Map(list.map((f) => [f.photo_id, f]));
  return {
    set: await selectionSummary(q, s, 'operator'),
    photos: list.map((f) => ({
      id: f.photo_id,
      number: formatNumber(f.position),
      position: f.position,
      name: f.filename,
      sameName: (nameCount.get(f.filename) ?? 0) > 1,
      picked: (byPhoto.get(f.photo_id) ?? []).length > 0,
      url: fileUrl('operator', projectId, f.attachment_id),
    })),
    responses: responses.map((r) => {
      const mine = picks
        .filter((pk) => pk.customer_id === r.customer_id)
        .map((pk) => photoById.get(pk.photo_id)!)
        .filter(Boolean)
        .sort((a, b) => a.position - b.position);
      return {
        customerId: r.customer_id,
        clientName: r.client_name,
        note: r.note,
        submittedAt: r.submitted_at,
        picksUpdatedAt: r.picks_updated_at,
        changedAfterSubmit: !!r.submitted_at && !!r.picks_updated_at && new Date(r.picks_updated_at) > new Date(r.submitted_at),
        picks: mine.map((f) => ({ photoId: f.photo_id, number: formatNumber(f.position), name: f.filename })),
      };
    }),
  };
}

export async function selectionDetailForClient(q: Queryable, projectId: string, s: any, sess: PortalSession) {
  const list = await photos(q, s.id);
  const mine = new Set((await picksOf(q, s.id, sess.customerId)).map((r) => r.photo_id));
  const r = await one(q, 'SELECT * FROM selection_responses WHERE set_id=$1 AND customer_id=$2', [s.id, sess.customerId]);
  return {
    set: { ...(await selectionSummary(q, s, 'client', sess.customerId)), showNames: s.show_names },
    photos: list.map((f) => ({
      id: f.photo_id,
      number: formatNumber(f.position),
      // 元ファイル名を見せない設定ならファイル名を返さない
      name: s.show_names ? f.filename : null,
      url: fileUrl('client', projectId, f.attachment_id),
      picked: mine.has(f.photo_id),
    })),
    myResponse: {
      note: r?.note ?? '',
      submittedAt: r?.submitted_at ?? null,
      picksUpdatedAt: r?.picks_updated_at ?? null,
      changedAfterSubmit: !!r?.submitted_at && !!r?.picks_updated_at && new Date(r.picks_updated_at) > new Date(r.submitted_at),
    },
  };
}

// ---- 運営者の操作 ----

export async function createSelection(tx: Tx, accountId: string, projectId: string, i: { title: string; message: string; showNames: boolean }) {
  const s = await one(tx, 'INSERT INTO selection_sets (account_id, project_id, title, message, show_names) VALUES ($1,$2,$3,$4,$5) RETURNING *', [
    accountId,
    projectId,
    i.title,
    i.message,
    i.showNames,
  ]);
  await logEvent(tx, accountId, projectId, 'selection_created', `写真セレクト「${i.title}」を作成`, { refType: 'selection', refId: s.id });
  return s;
}

export async function updateSelection(tx: Tx, s: any, i: { title?: string; message?: string; showNames?: boolean }) {
  await tx.query('UPDATE selection_sets SET title=$2, message=$3, show_names=$4, updated_at=now() WHERE id=$1', [s.id, i.title ?? s.title, i.message ?? s.message, i.showNames ?? s.show_names]);
}

export async function setSelectionStatus(tx: Tx, accountId: string, projectId: string, s: any, to: 'open' | 'closed') {
  if (to === 'open') {
    if (s.status === 'open') return;
    const n = await one(tx, 'SELECT count(*)::int AS n FROM selection_photos WHERE set_id=$1', [s.id]);
    if (n.n === 0) throw badRequest('写真を1枚以上追加してから公開してください');
    await tx.query(`UPDATE selection_sets SET status='open', opened_at=COALESCE(opened_at, now()), closed_at=NULL, updated_at=now() WHERE id=$1`, [s.id]);
    await logEvent(tx, accountId, projectId, 'selection_opened', `写真セレクト「${s.title}」の選択受付を開始`, { refType: 'selection', refId: s.id, clientVisible: true });
  } else {
    if (s.status !== 'open') throw conflict('受付中のセレクトのみ終了できます');
    await tx.query(`UPDATE selection_sets SET status='closed', closed_at=now(), updated_at=now() WHERE id=$1`, [s.id]);
    await logEvent(tx, accountId, projectId, 'selection_closed', `写真セレクト「${s.title}」の受付を終了`, { refType: 'selection', refId: s.id, clientVisible: true });
  }
}

/** 写真の追加前チェック（受付終了・上限・同一内容の二重登録） */
export async function assertSelectionAcceptsPhoto(tx: Tx, s: any, sha256: string) {
  if (s.status === 'closed') throw conflict('受付終了したセレクトには写真を追加できません。受付を再開してください', 'selection_closed');
  const n = await one(tx, 'SELECT count(*)::int AS n FROM selection_photos WHERE set_id=$1', [s.id]);
  if (n.n >= SELECTION_MAX_PHOTOS) throw badRequest(`1つのセレクトに登録できる写真は${SELECTION_MAX_PHOTOS}枚までです。セレクトを分けて作成してください`, 'selection_full');
  const dup = await one(tx, 'SELECT 1 FROM selection_photos sp JOIN attachments a ON a.id=sp.attachment_id WHERE sp.set_id=$1 AND a.sha256=$2', [s.id, sha256]);
  if (dup) throw conflict('同じ写真がすでに登録されています', 'duplicate_photo');
}

/** 末尾に追加（公開後に追加しても既存の番号は変わらない） */
export async function addSelectionPhoto(tx: Tx, accountId: string, projectId: string, s: any, attachmentId: string) {
  const max = await one(tx, 'SELECT COALESCE(max(position),0) AS m FROM selection_photos WHERE set_id=$1', [s.id]);
  const pos = Number(max.m) + 1;
  const p = await one(tx, 'INSERT INTO selection_photos (account_id, project_id, set_id, attachment_id, position) VALUES ($1,$2,$3,$4,$5) RETURNING id', [
    accountId,
    projectId,
    s.id,
    attachmentId,
    pos,
  ]);
  await tx.query('UPDATE selection_sets SET updated_at=now() WHERE id=$1', [s.id]);
  return { photoId: p.id as string, number: formatNumber(pos) };
}

function assertDraft(s: any) {
  // 顧客に番号を伝えた後に番号が変わらないよう、並べ替え・削除は公開前（準備中）のみ
  if (s.status !== 'draft') throw conflict('公開後は番号が変わる操作（並べ替え・削除）はできません。追加した写真は末尾の番号になります', 'numbers_locked');
}

/** 番号を 1..N に詰め直す（UNIQUE(set_id, position) を避けるため負数を経由） */
async function renumber(tx: Tx, setId: string, orderedPhotoIds: string[]) {
  for (let i = 0; i < orderedPhotoIds.length; i++) await tx.query('UPDATE selection_photos SET position=$3 WHERE id=$1 AND set_id=$2', [orderedPhotoIds[i], setId, -(i + 1)]);
  for (let i = 0; i < orderedPhotoIds.length; i++) await tx.query('UPDATE selection_photos SET position=$3 WHERE id=$1 AND set_id=$2', [orderedPhotoIds[i], setId, i + 1]);
  await tx.query('UPDATE selection_sets SET updated_at=now() WHERE id=$1', [setId]);
}

export async function movePhoto(tx: Tx, s: any, photoId: string, toNumber: number) {
  assertDraft(s);
  const ids = (await many(tx, 'SELECT id FROM selection_photos WHERE set_id=$1 ORDER BY position', [s.id])).map((r) => r.id as string);
  const from = ids.indexOf(photoId);
  if (from < 0) throw notFound('写真');
  const to = Math.min(ids.length - 1, Math.max(0, Math.trunc(toNumber) - 1));
  ids.splice(from, 1);
  ids.splice(to, 0, photoId);
  await renumber(tx, s.id, ids);
}

export async function sortPhotosByName(tx: Tx, s: any) {
  assertDraft(s);
  const list = await photos(tx, s.id);
  const ids = [...list].sort((a, b) => naturalCompare(a.filename, b.filename) || a.position - b.position).map((f) => f.photo_id as string);
  await renumber(tx, s.id, ids);
}

/** 準備中の写真を削除（一度も公開していないため、添付の実体も削除する） */
export async function deletePhotos(tx: Tx, accountId: string, s: any, photoIds: string[] | 'all') {
  assertDraft(s);
  const all = await photos(tx, s.id);
  const targets = photoIds === 'all' ? all : all.filter((f) => photoIds.includes(f.photo_id));
  if (photoIds !== 'all' && targets.length !== new Set(photoIds).size) throw notFound('写真');
  for (const f of targets) await tx.query('DELETE FROM attachments WHERE account_id=$1 AND id=$2', [accountId, f.attachment_id]);
  const rest = (await many(tx, 'SELECT id FROM selection_photos WHERE set_id=$1 ORDER BY position', [s.id])).map((r) => r.id as string);
  await renumber(tx, s.id, rest);
  return targets.length;
}

export async function deleteSelection(tx: Tx, accountId: string, projectId: string, s: any) {
  if (s.status !== 'draft') throw conflict('公開したセレクトは履歴のため削除できません（受付終了にしてください）', 'not_draft');
  await deletePhotos(tx, accountId, s, 'all');
  await tx.query('DELETE FROM selection_sets WHERE id=$1', [s.id]);
  await logEvent(tx, accountId, projectId, 'selection_deleted', `写真セレクト「${s.title}」を削除`);
}

/** 書き出し：map=番号対応表（全写真）, picks=選択結果。format=csv / txt（どちらも BOM + CRLF） */
export async function exportSelection(q: Queryable, s: any, kind: 'map' | 'picks', format: 'csv' | 'txt'): Promise<{ body: string; filename: string }> {
  const list = await photos(q, s.id);
  const base = `写真セレクト_${s.title}`;
  if (kind === 'map') {
    if (format === 'csv') return { body: buildCsv(list.map((f) => f.filename), list.map((f) => f.position)), filename: `${base}_番号対応表.csv` };
    return { body: '﻿' + list.map((f) => `${formatNumber(f.position)} → ${f.filename}`).join('\r\n') + '\r\n', filename: `${base}_番号対応表.txt` };
  }
  const byId = new Map(list.map((f) => [f.photo_id, f]));
  const responses = await many(q, 'SELECT * FROM selection_responses WHERE set_id=$1 ORDER BY submitted_at NULLS LAST', [s.id]);
  const picks = await picksOf(q, s.id);
  const picked = [...new Set(picks.map((p) => p.photo_id))]
    .map((id) => byId.get(id)!)
    .filter(Boolean)
    .sort((a, b) => a.position - b.position);
  if (format === 'csv') return { body: buildCsv(picked.map((f) => f.filename), picked.map((f) => f.position)), filename: `${base}_選択結果.csv` };
  const fmt = (d: any) => (d ? new Date(d).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }) : null);
  const parts = (responses.length ? responses : [null]).map((r) => {
    const mine = r
      ? picks
          .filter((p) => p.customer_id === r.customer_id)
          .map((p) => byId.get(p.photo_id)!)
          .filter(Boolean)
          .sort((a, b) => a.position - b.position)
      : picked;
    return buildSelectionText(
      { title: s.title, clientName: r?.client_name, submittedAt: fmt(r?.submitted_at), note: r?.note },
      mine.map((f) => ({ number: f.position, name: f.filename })),
      '\r\n',
    );
  });
  return { body: '﻿' + parts.join('\r\n\r\n----------------------------------------\r\n\r\n') + '\r\n', filename: `${base}_選択結果.txt` };
}

// ---- 顧客の操作 ----

async function upsertResponse(tx: Tx, s: any, sess: PortalSession, patch: { picksUpdatedAt?: Date; submittedAt?: Date; note?: string; submittedCount?: number }) {
  await tx.query(
    `INSERT INTO selection_responses (account_id, set_id, customer_id, client_name, note, picks_updated_at, submitted_at, submitted_count)
     VALUES ($1,$2,$3,$4,COALESCE($5,''),$6,$7,COALESCE($8,0))
     ON CONFLICT (set_id, customer_id) DO UPDATE SET client_name=EXCLUDED.client_name,
       note=COALESCE($5, selection_responses.note),
       picks_updated_at=COALESCE($6, selection_responses.picks_updated_at),
       submitted_at=COALESCE($7, selection_responses.submitted_at),
       submitted_count=COALESCE($8, selection_responses.submitted_count)`,
    [s.account_id, s.id, sess.customerId, sess.clientName, patch.note ?? null, patch.picksUpdatedAt ?? null, patch.submittedAt ?? null, patch.submittedCount ?? null],
  );
}

function assertOpen(s: any) {
  if (s.status !== 'open') throw conflict('このセレクトは受付を終了しています。変更が必要な場合は担当者にご連絡ください', 'selection_closed');
}

/**
 * 選択の保存。
 * - photoIds：選択を丸ごと置き換え（クリック選択）
 * - numbersText：「001, 007、012」形式の番号入力。mode=add は現在の選択に追加、replace は置き換え。
 *   見つからない番号・読めない語は選択に加えず、照合結果（checkSelection）を返す
 */
export async function savePicks(tx: Tx, s: any, sess: PortalSession, i: { photoIds?: string[]; numbersText?: string; mode?: 'add' | 'replace' }, svc: Services) {
  assertOpen(s);
  const list = await photos(tx, s.id);
  const valid = new Set(list.map((f) => f.photo_id as string));
  let next: Set<string>;
  let check: ReturnType<typeof checkSelection> | null = null;
  if (i.numbersText !== undefined) {
    const names = list.map((f) => selectionDisplayName(f.filename, f.position, s.show_names));
    check = checkSelection(i.numbersText, names);
    const byPos = new Map(list.map((f) => [f.position as number, f.photo_id as string]));
    const ids = check.results.filter((r) => r.found && byPos.has(r.number)).map((r) => byPos.get(r.number)!);
    next = i.mode === 'replace' ? new Set(ids) : new Set([...(await picksOf(tx, s.id, sess.customerId)).map((r) => r.photo_id), ...ids]);
  } else {
    const ids = i.photoIds ?? [];
    // 他のセット・他の案件の写真IDは存在を明かさず拒否
    for (const id of ids) if (!valid.has(id)) throw notFound('写真');
    next = new Set(ids);
  }
  await tx.query('DELETE FROM selection_picks WHERE set_id=$1 AND customer_id=$2', [s.id, sess.customerId]);
  for (const id of next) await tx.query('INSERT INTO selection_picks (account_id, set_id, customer_id, photo_id) VALUES ($1,$2,$3,$4)', [s.account_id, s.id, sess.customerId, id]);
  await upsertResponse(tx, s, sess, { picksUpdatedAt: svc.now() });
  const pickedNumbers = list.filter((f) => next.has(f.photo_id)).map((f) => formatNumber(f.position));
  return { pickedIds: [...next], pickedNumbers, check };
}

export async function submitPicks(tx: Tx, svc: Services, projectId: string, s: any, sess: PortalSession, note: string) {
  assertOpen(s);
  const list = await photos(tx, s.id);
  const mine = new Set((await picksOf(tx, s.id, sess.customerId)).map((r) => r.photo_id));
  const picked = list.filter((f) => mine.has(f.photo_id));
  if (picked.length === 0) throw badRequest('写真を1枚以上選んでください');
  const now = svc.now();
  await upsertResponse(tx, s, sess, { submittedAt: now, note: note.trim().slice(0, 2000), submittedCount: picked.length });
  await tx.query('UPDATE selection_sets SET updated_at=now() WHERE id=$1', [s.id]);
  const labels = picked.map((f) => formatNumber(f.position));
  await logEvent(tx, s.account_id, projectId, 'selection_submitted', `写真セレクト「${s.title}」で${picked.length}枚が選ばれました（${sess.clientName}）`, {
    refType: 'selection',
    refId: s.id,
    note: labels.join(', ').slice(0, 1000),
    clientVisible: true,
  });
  return { submittedAt: now, count: picked.length, numbers: labels };
}
