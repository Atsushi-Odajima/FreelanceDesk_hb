import type { Queryable } from '../db';
import { one } from '../db';
import type { ProjectStatus } from '../../../shared/status';
import { advanceStatus, PROJECT_STATUS_LABELS } from '../../../shared/status';

export async function logEvent(
  q: Queryable,
  accountId: string,
  projectId: string,
  kind: string,
  title: string,
  opts: { refType?: string; refId?: string; note?: string; clientVisible?: boolean } = {},
) {
  await q.query(
    `INSERT INTO project_events (account_id, project_id, kind, title, ref_type, ref_id, note, client_visible) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [accountId, projectId, kind, title, opts.refType ?? null, opts.refId ?? null, opts.note ?? '', opts.clientVisible ?? false],
  );
}

/** 状態を変更し履歴を残す（変化なしなら何もしない） */
export async function setProjectStatus(q: Queryable, accountId: string, projectId: string, to: ProjectStatus, note = ''): Promise<void> {
  const cur = await one<{ status: ProjectStatus }>(q, 'SELECT status FROM projects WHERE account_id = $1 AND id = $2 FOR UPDATE', [accountId, projectId]);
  if (!cur || cur.status === to) return;
  await q.query('UPDATE projects SET status = $3, updated_at = now() WHERE account_id = $1 AND id = $2', [accountId, projectId, to]);
  await q.query('INSERT INTO project_status_history (account_id, project_id, from_status, to_status, note) VALUES ($1,$2,$3,$4,$5)', [
    accountId,
    projectId,
    cur.status,
    to,
    note,
  ]);
  await logEvent(q, accountId, projectId, 'status', `状態：${PROJECT_STATUS_LABELS[cur.status]} → ${PROJECT_STATUS_LABELS[to]}`, { note });
}

/** 操作に伴って状態を前進させる（後戻り・終了状態からの変更はしない） */
export async function advanceProjectStatus(q: Queryable, accountId: string, projectId: string, target: ProjectStatus, note = ''): Promise<void> {
  const cur = await one<{ status: ProjectStatus }>(q, 'SELECT status FROM projects WHERE account_id = $1 AND id = $2 FOR UPDATE', [accountId, projectId]);
  if (!cur) return;
  const next = advanceStatus(cur.status, target);
  if (next !== cur.status) await setProjectStatus(q, accountId, projectId, next, note || '操作に伴う自動更新');
}
