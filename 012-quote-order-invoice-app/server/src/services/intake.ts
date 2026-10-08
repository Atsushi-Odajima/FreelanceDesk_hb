// FreelanceDesk ヒアリング（IntakeMint から統合）／FreelanceDesk 案件開始パック
// 案件ごとのヒアリング：回答・ファイル提出・充足判定（決定的）・レビュー（承認/差し戻し）・回答チェック（ルール判定）・追加質問・
// サインオフ／理由付き上書き・案件開始パック生成。
// IntakeMint の services/cases.ts（recompute）・intake.ts・review.ts・packages.ts・ai.ts を FreelanceDesk の規約
// （account_id 必須・複合外部キー・project_events・attachments(bytea)）に合わせて移植した。
// お客様側の呼び出しは必ず clientProject()（services/portal.ts）を通した案件IDと組で照合し、公開前・他案件は 404。
import { zipSync, strToU8 } from 'fflate';
import type { Services } from '../context';
import type { Queryable, Tx } from '../db';
import { lockRequest, many, one } from '../db';
import { badRequest, conflict, HttpError, notFound } from './errors';
import { logEvent } from './events';
import { type ReceivedUpload, insertAttachment } from './attachmentStore';
import { extensionOf } from './upload';
import { evaluateCompleteness, effectiveItems, missingSummary, readyExceptSignoff, STATUS_LABEL, type CompletenessResult } from '../../../shared/intake/completeness';
import { conditionQuestionIds, isAnswered } from '../../../shared/intake/logic';
import { validateAnswer } from '../../../shared/intake/validate';
import { runAnswerChecks, CHECK_PROVIDER } from '../../../shared/intake/checks';
import { buildPackage, filePath, toMarkdown, toText, INTAKE_STATUS_LABEL, type PackageFollowup } from '../../../shared/intake/package';
import type { Answers, FileInfo, HandoffProfile, ItemReviewState, TemplateDefinition } from '../../../shared/intake/types';
import { sampleTemplates } from '../../../shared/intake/samples';
import { parseDefinition } from './intakeDefinition';
import { blankDefinition } from '../../../shared/intake/lint';
import crypto from 'node:crypto';

export type IntakeActor = 'operator' | 'client';
export type IntakeStatus = 'draft' | 'sent' | 'in_progress' | 'needs_client' | 'needs_internal_review' | 'ready' | 'started' | 'cancelled';
const TERMINAL: IntakeStatus[] = ['started', 'cancelled'];
export const ITEM_ID_RE = /^[A-Za-z0-9_\-:]{1,64}$/;

// ---------------------------------------------------------------- テンプレート

export function templateDto(t: any) {
  return {
    id: t.id,
    name: t.name,
    description: t.description,
    sampleKey: t.sample_key,
    archivedAt: t.archived_at,
    updatedAt: t.updated_at,
    questionCount: (t.definition?.questions ?? []).length,
    fileItemCount: (t.definition?.requiredItems ?? []).filter((i: any) => i.type === 'file').length,
  };
}

export async function createTemplate(
  tx: Tx,
  accountId: string,
  i: { requestId?: string; name?: string; description?: string; sampleKey?: string; definition?: unknown },
) {
  if (i.requestId) {
    await lockRequest(tx, accountId, i.requestId);
    const ex = await one(tx, 'SELECT * FROM intake_templates WHERE account_id=$1 AND request_id=$2', [accountId, i.requestId]);
    if (ex) return ex;
  }
  const sample = i.sampleKey ? sampleTemplates.find((x) => x.key === i.sampleKey) : undefined;
  if (i.sampleKey && !sample) throw badRequest('サンプルが見つかりません');
  const def = i.definition !== undefined ? parseDefinition(i.definition) : sample ? structuredClone(sample.definition) : blankDefinition();
  const name = (i.name ?? '').trim() || sample?.name || '新しいヒアリング';
  return one(
    tx,
    `INSERT INTO intake_templates (account_id, name, description, sample_key, definition, request_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [accountId, name.slice(0, 200), (i.description ?? sample?.description ?? '').slice(0, 2000), sample?.key ?? null, JSON.stringify(def), i.requestId ?? null],
  );
}

export async function requireTemplate(q: Queryable, accountId: string, id: string, lock = false) {
  const t = await one(q, `SELECT * FROM intake_templates WHERE account_id=$1 AND id=$2 ${lock ? 'FOR UPDATE' : ''}`, [accountId, id]);
  if (!t) throw notFound('テンプレート');
  return t;
}

// ---------------------------------------------------------------- 状態の読み込み・再計算

export interface IntakeState {
  row: any;
  def: TemplateDefinition;
  answers: Answers;
  files: (FileInfo & { attachmentId: string; reviewNote: string | null; uploadedBy: string; createdAt: string; sha256: string })[];
  itemStates: ItemReviewState[];
  unresolved: number;
  result: CompletenessResult;
}

/** 案件IDと組で照合（他アカウント・他案件は 404） */
export async function requireIntake(q: Queryable, accountId: string, projectId: string, intakeId: string, lock = false) {
  const r = await one(q, `SELECT * FROM intakes WHERE account_id=$1 AND project_id=$2 AND id=$3 ${lock ? 'FOR UPDATE' : ''}`, [accountId, projectId, intakeId]);
  if (!r) throw notFound('ヒアリング');
  return r;
}

/** お客様に見せてよいヒアリング（公開済み・中止以外） */
export async function requireClientIntake(q: Queryable, accountId: string, projectId: string, intakeId: string, lock = false) {
  const r = await requireIntake(q, accountId, projectId, intakeId, lock);
  if (!r.shared_at || r.status === 'cancelled') throw notFound('ヒアリング');
  return r;
}

export async function loadState(q: Queryable, accountId: string, row: any): Promise<IntakeState> {
  const answers: Answers = {};
  for (const r of await many(q, 'SELECT question_id, value FROM intake_responses WHERE account_id=$1 AND intake_id=$2', [accountId, row.id])) answers[r.question_id] = r.value;
  const files = await many(
    q,
    `SELECT f.id, f.item_id AS "itemId", f.status, a.filename AS "originalName", a.mime, a.size_bytes::int AS size, f.attachment_id AS "attachmentId",
            f.review_note AS "reviewNote", f.uploaded_by_kind AS "uploadedBy", f.created_at AS "createdAt", a.sha256
     FROM intake_files f JOIN attachments a ON a.account_id=f.account_id AND a.id=f.attachment_id
     WHERE f.account_id=$1 AND f.intake_id=$2 ORDER BY f.created_at, f.id`,
    [accountId, row.id],
  );
  const itemStates = await many(q, 'SELECT item_id AS "itemId", review_status AS "reviewStatus", note FROM intake_item_states WHERE account_id=$1 AND intake_id=$2', [accountId, row.id]);
  const n = await one(
    q,
    `SELECT (SELECT count(*) FROM intake_candidates WHERE account_id=$1 AND intake_id=$2 AND status='open')
          + (SELECT count(*) FROM intake_followups WHERE account_id=$1 AND intake_id=$2 AND status IN ('open','answered')) AS n`,
    [accountId, row.id],
  );
  const unresolved = Number(n?.n ?? 0);
  const def = row.definition as TemplateDefinition;
  const result = evaluateCompleteness({ def, answers, files, itemStates, unresolvedAiCount: unresolved, internalSignoff: !!row.internal_signoff_at });
  return { row, def, answers, files, itemStates, unresolved, result };
}

/** 必須情報（必要項目の質問・条件分岐の元の質問）に関わる変更か */
export function affectsRequired(def: TemplateDefinition, questionIds: string[]): boolean {
  const set = new Set<string>();
  for (const it of effectiveItems(def)) for (const q of it.questionIds ?? []) set.add(q);
  for (const r of def.rules) for (const q of conditionQuestionIds(r.when)) set.add(q);
  return questionIds.some((q) => set.has(q));
}

/**
 * 変更のたびに再評価（IntakeMint cases.recompute を移植）。
 * Ready 後に必須情報が変わったらサインオフ・上書きを無効化し、条件を満たさなければ Ready を解除する。
 */
export async function recompute(tx: Tx, s: Services, accountId: string, intakeId: string, opts: { requiredChanged?: boolean } = {}): Promise<IntakeState> {
  let row = await one(tx, 'SELECT * FROM intakes WHERE account_id=$1 AND id=$2 FOR UPDATE', [accountId, intakeId]);
  if (!row) throw notFound('ヒアリング');
  if (opts.requiredChanged && (row.internal_signoff_at || row.ready_override)) {
    row = await one(tx, 'UPDATE intakes SET internal_signoff_at=NULL, signoff_note=NULL, ready_override=NULL WHERE account_id=$1 AND id=$2 RETURNING *', [accountId, intakeId]);
  }
  const st = await loadState(tx, accountId, row);
  const r = st.result;
  let status: IntakeStatus = row.status;
  const wasReady = status === 'ready';
  if (!TERMINAL.includes(status)) {
    const anyInput = Object.keys(st.answers).length > 0 || st.files.length > 0;
    const openFollowups = Number((await one(tx, `SELECT count(*) AS n FROM intake_followups WHERE account_id=$1 AND intake_id=$2 AND status='open'`, [accountId, intakeId])).n);
    const rejected = r.items.some((i) => i.applicable && i.required && i.status === 'rejected');
    const allSubmitted = r.progress.submitted === r.progress.denominator;
    if (r.ready.ready || row.ready_override) status = 'ready';
    else if (rejected || openFollowups > 0) status = 'needs_client';
    else if (allSubmitted && anyInput) status = 'needs_internal_review';
    else if (row.client_submitted_at && !allSubmitted) status = 'needs_client';
    else if (anyInput) status = 'in_progress';
    else if (row.shared_at) status = 'sent';
    else status = 'draft';
  }
  const readyAt = status === 'ready' ? (row.ready_at ?? s.now()) : TERMINAL.includes(status) ? row.ready_at : null;
  const summary = missingSummary(r.items);
  const updated = await one(
    tx,
    'UPDATE intakes SET status=$3, progress=$4, missing_summary=$5, ready_at=$6, updated_at=now() WHERE account_id=$1 AND id=$2 RETURNING *',
    [accountId, intakeId, status, JSON.stringify(r.progress), summary, readyAt],
  );
  if (wasReady && status !== 'ready') {
    await logEvent(tx, accountId, row.project_id, 'intake_ready_revoked', `ヒアリング「${row.title}」：必須情報が変更されたため Ready を解除`, { refType: 'intake', refId: intakeId });
  } else if (!wasReady && status === 'ready') {
    await logEvent(tx, accountId, row.project_id, 'intake_ready', `ヒアリング「${row.title}」：必要な情報がそろいました`, {
      refType: 'intake',
      refId: intakeId,
      clientVisible: !!row.shared_at,
      note: row.ready_override ? 'Ready上書き' : '',
    });
  }
  if (row.status !== status && status === 'needs_internal_review') {
    await logEvent(tx, accountId, row.project_id, 'intake_review_needed', `ヒアリング「${row.title}」：提出がそろいました（内部確認待ち）`, { refType: 'intake', refId: intakeId });
  }
  return { ...st, row: updated };
}

// ---------------------------------------------------------------- 作成・一覧・詳細

export async function createIntake(
  tx: Tx,
  s: Services,
  accountId: string,
  projectId: string,
  i: { requestId?: string; templateId?: string; sampleKey?: string; title?: string; dueDate?: string | null },
) {
  if (i.requestId) {
    await lockRequest(tx, accountId, i.requestId);
    const ex = await one(tx, 'SELECT id FROM intakes WHERE account_id=$1 AND request_id=$2', [accountId, i.requestId]);
    if (ex) return { id: ex.id as string, created: false };
  }
  let def: TemplateDefinition;
  let templateId: string | null = null;
  let name: string;
  if (i.templateId) {
    const t = await requireTemplate(tx, accountId, i.templateId);
    if (t.archived_at) throw badRequest('アーカイブ済みのテンプレートからは作成できません');
    def = parseDefinition(t.definition);
    templateId = t.id;
    name = t.name;
  } else if (i.sampleKey) {
    const sample = sampleTemplates.find((x) => x.key === i.sampleKey);
    if (!sample) throw badRequest('サンプルが見つかりません');
    def = structuredClone(sample.definition);
    name = sample.name;
  } else throw badRequest('テンプレートを選択してください');
  const title = (i.title ?? '').trim() || name;
  const row = await one(
    tx,
    `INSERT INTO intakes (account_id, project_id, template_id, title, definition, due_date, request_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [accountId, projectId, templateId, title.slice(0, 200), JSON.stringify(def), i.dueDate ?? null, i.requestId ?? null],
  );
  await logEvent(tx, accountId, projectId, 'intake_created', `FreelanceDesk ヒアリング「${title}」を作成`, { refType: 'intake', refId: row.id });
  await recompute(tx, s, accountId, row.id);
  return { id: row.id as string, created: true };
}

export function intakeSummary(r: any) {
  return {
    id: r.id,
    title: r.title,
    status: r.status,
    statusLabel: INTAKE_STATUS_LABEL[r.status] ?? r.status,
    progress: r.progress,
    missingSummary: r.missing_summary,
    dueDate: r.due_date,
    sharedAt: r.shared_at,
    readyAt: r.ready_at,
    clientSubmittedAt: r.client_submitted_at,
    updatedAt: r.updated_at,
  };
}

export async function listIntakes(q: Queryable, accountId: string, projectId: string, audience: IntakeActor) {
  const rows = await many(
    q,
    `SELECT * FROM intakes WHERE account_id=$1 AND project_id=$2 ${audience === 'client' ? "AND shared_at IS NOT NULL AND status <> 'cancelled'" : ''} ORDER BY created_at`,
    [accountId, projectId],
  );
  return rows.map(intakeSummary);
}

function fileDto(f: IntakeState['files'][number], audience: IntakeActor, projectId: string) {
  return {
    id: f.id,
    itemId: f.itemId,
    filename: f.originalName,
    mime: f.mime,
    size: f.size,
    status: f.status,
    reviewNote: f.reviewNote,
    uploadedBy: f.uploadedBy,
    createdAt: f.createdAt,
    url: audience === 'operator' ? `/api/attachments/${f.attachmentId}` : `/api/portal/projects/${projectId}/files/${f.attachmentId}`,
  };
}

/** 運営者向け詳細 */
export async function operatorDetail(q: Queryable, accountId: string, row: any) {
  const st = await loadState(q, accountId, row);
  const [candidates, followups, packages] = await Promise.all([
    many(q, 'SELECT * FROM intake_candidates WHERE account_id=$1 AND intake_id=$2 ORDER BY created_at DESC', [accountId, row.id]),
    many(q, 'SELECT * FROM intake_followups WHERE account_id=$1 AND intake_id=$2 ORDER BY created_at DESC', [accountId, row.id]),
    many(q, 'SELECT id, version, profile, created_at FROM intake_packages WHERE account_id=$1 AND intake_id=$2 ORDER BY version DESC', [accountId, row.id]),
  ]);
  return {
    intake: { ...intakeSummary(row), templateId: row.template_id, internalSignoffAt: row.internal_signoff_at, signoffNote: row.signoff_note, readyOverride: row.ready_override, startedAt: row.started_at },
    definition: st.def,
    answers: st.answers,
    files: st.files.map((f) => fileDto(f, 'operator', row.project_id)),
    itemStates: st.itemStates,
    completeness: st.result,
    candidates: candidates.map((c) => ({ id: c.id, kind: c.kind, questionId: c.question_id, payload: c.payload, status: c.status, provider: c.provider, createdAt: c.created_at })),
    followups: followups.map(followupDto),
    packages: packages.map((p) => ({ id: p.id, version: p.version, profile: p.profile, createdAt: p.created_at })),
  };
}

function followupDto(f: any) {
  return { id: f.id, questionId: f.question_id, text: f.text, options: f.options, status: f.status, answer: f.answer, answeredAt: f.answered_at, createdAt: f.created_at };
}

/** お客様向け詳細：内部のレビューメモ・パック設定・Ready判定の内訳は返さない（差し戻し理由のみ表示） */
export async function clientDetail(q: Queryable, accountId: string, row: any) {
  const st = await loadState(q, accountId, row);
  const { packageTemplate: _p, ...def } = st.def;
  const followups = await many(q, "SELECT * FROM intake_followups WHERE account_id=$1 AND intake_id=$2 AND status IN ('open','answered') ORDER BY created_at", [accountId, row.id]);
  return {
    intake: {
      id: row.id,
      title: row.title,
      status: row.status,
      statusLabel: clientStatusLabel(row.status),
      dueDate: row.due_date,
      submittedAt: row.client_submitted_at,
      closed: TERMINAL.includes(row.status),
      progress: st.result.progress,
    },
    definition: def,
    answers: st.answers,
    files: st.files.map((f) => ({ ...fileDto(f, 'client', row.project_id), reviewNote: f.status === 'rejected' ? f.reviewNote : null })),
    items: st.result.items.map((i) => ({
      itemId: i.itemId,
      label: i.label,
      type: i.type,
      required: i.required,
      applicable: i.applicable,
      status: i.status,
      statusLabel: STATUS_LABEL[i.status],
      count: i.count,
      minCount: i.minCount,
      answered: i.answered,
      total: i.total,
      missingQuestionIds: i.missingQuestionIds ?? [],
      note: i.status === 'rejected' ? i.note : null,
    })),
    invalid: st.result.invalid,
    followups: followups.map((f) => ({ id: f.id, text: f.text, options: f.options, status: f.status, answer: f.answer })),
  };
}

export function clientStatusLabel(status: string) {
  const m: Record<string, string> = {
    sent: 'ご回答をお待ちしています',
    in_progress: 'ご回答中',
    needs_client: 'ご対応をお願いします',
    needs_internal_review: '担当者が確認中です',
    ready: '必要な情報がそろいました',
    started: '受付を終了しました',
    cancelled: '受付を終了しました',
    draft: '準備中',
  };
  return m[status] ?? status;
}

// ---------------------------------------------------------------- 回答・ファイル（運営者・お客様共通）

function assertOpen(row: any, actor: IntakeActor) {
  if (actor === 'client' && TERMINAL.includes(row.status)) throw conflict('このヒアリングは受付を終了しました', 'intake_closed');
}

function answerJson(v: unknown) {
  return JSON.stringify(v ?? null);
}

/** 回答の保存（IntakeMint intake.saveAnswers）。形式エラーの回答は保存せず errors に返す */
export async function saveAnswers(tx: Tx, s: Services, accountId: string, row: any, actor: IntakeActor, input: Record<string, unknown>) {
  assertOpen(row, actor);
  const st = await loadState(tx, accountId, row);
  const qById = new Map(st.def.questions.map((q) => [q.id, q]));
  const errors: { questionId: string; message: string }[] = [];
  const changed: string[] = [];
  const entries = Object.entries(input);
  if (entries.length > 300) throw badRequest('一度に保存できる回答数を超えています');
  for (const [qid, value] of entries) {
    const q = qById.get(qid);
    if (!q) {
      errors.push({ questionId: qid, message: '存在しない質問です' });
      continue;
    }
    if (q.type === 'file' || q.type === 'image') continue;
    if (answerJson(value).length > 50_000) {
      errors.push({ questionId: qid, message: '回答が長すぎます' });
      continue;
    }
    const msg = validateAnswer(q, value);
    if (msg) {
      errors.push({ questionId: qid, message: msg });
      continue;
    }
    const prev = st.answers[qid];
    if (answerJson(prev) === answerJson(isAnswered(value) ? value : null)) continue;
    if (!isAnswered(value)) {
      await tx.query('DELETE FROM intake_responses WHERE account_id=$1 AND intake_id=$2 AND question_id=$3', [accountId, row.id, qid]);
    } else {
      await tx.query(
        `INSERT INTO intake_responses (account_id, intake_id, question_id, value, updated_by_kind, updated_at) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (intake_id, question_id) DO UPDATE SET value=EXCLUDED.value, version=intake_responses.version+1, updated_by_kind=EXCLUDED.updated_by_kind, updated_at=EXCLUDED.updated_at`,
        [accountId, row.id, qid, JSON.stringify(value), actor, s.now()],
      );
    }
    changed.push(qid);
  }
  if (changed.length) {
    // 変更された回答が属する項目のレビューをやり直す（差し戻し→再提出、承認済み→再確認）
    const items = effectiveItems(st.def).filter((it) => (it.questionIds ?? []).some((q) => changed.includes(q)));
    for (const it of items) {
      await tx.query(
        `UPDATE intake_item_states SET review_status='none', reviewed_at=NULL WHERE account_id=$1 AND intake_id=$2 AND item_id=$3 AND review_status IN ('rejected','accepted','needs_review')`,
        [accountId, row.id, it.id],
      );
    }
  }
  const after = await recompute(tx, s, accountId, row.id, { requiredChanged: changed.length > 0 && affectsRequired(st.def, changed) });
  return { saved: changed, errors, status: after.row.status, progress: after.result.progress };
}

const EXT_KIND: Record<string, (mime: string) => boolean> = {
  jpg: (m) => m.startsWith('image/'),
  jpeg: (m) => m.startsWith('image/'),
  png: (m) => m.startsWith('image/'),
  gif: (m) => m.startsWith('image/'),
  webp: (m) => m.startsWith('image/'),
  heic: (m) => m.startsWith('image/'),
  heif: (m) => m.startsWith('image/'),
  pdf: (m) => m === 'application/pdf',
  ai: (m) => m === 'application/pdf', // PDF互換で保存された Illustrator ファイルのみ
  mp4: (m) => m.startsWith('video/'),
  mov: (m) => m.startsWith('video/'),
  txt: (m) => m.startsWith('text/'),
  csv: (m) => m.startsWith('text/'),
  md: (m) => m.startsWith('text/'),
  tsv: (m) => m.startsWith('text/'),
};

/** ファイル提出（IntakeMint intake.uploadFile）。検証は FreelanceDesk の detectFile（実体判定）＋項目の形式・件数・サイズ */
export async function uploadFile(tx: Tx, s: Services, accountId: string, row: any, actor: IntakeActor, itemId: string, up: ReceivedUpload) {
  assertOpen(row, actor);
  const st = await loadState(tx, accountId, row);
  const item = st.def.requiredItems.find((i) => i.id === itemId && i.type === 'file');
  if (!item) throw notFound('提出先の項目');
  const ev = st.result.items.find((i) => i.itemId === itemId);
  if (ev && !ev.applicable) throw badRequest('この項目は現在提出対象外です', 'not_applicable');
  const active = st.files.filter((f) => f.itemId === itemId && f.status !== 'rejected').length;
  if (item.maxCount && active >= item.maxCount) throw badRequest(`この項目は最大${item.maxCount}件までです`, 'max_count');
  const ext = extensionOf(up.filename);
  if (item.acceptedFormats?.length) {
    if (!item.acceptedFormats.includes(ext)) throw new HttpError(415, `この項目に提出できる形式は ${item.acceptedFormats.join(' / ')} です`, 'format_not_accepted');
  }
  const kindOk = EXT_KIND[ext];
  if (kindOk && !kindOk(up.detected.mime)) throw new HttpError(415, 'ファイルの中身と拡張子が一致しません', 'ext_mismatch');
  const maxBytes = Math.min((item.maxSizeMB ?? Infinity) * 1024 * 1024, s.config.uploadMaxBytes);
  if (up.buf.length > maxBytes) throw new HttpError(413, `この項目のファイルは ${Math.floor(maxBytes / 1024 / 1024)}MB までです`, 'too_large');
  const a = await insertAttachment(tx, s, accountId, { projectId: row.project_id, deliveryId: null, purpose: 'intake_file', upload: up });
  const needReview = item.requireReview ?? st.def.completionRules?.requireFileReview ?? true;
  const f = await one(
    tx,
    `INSERT INTO intake_files (account_id, intake_id, item_id, attachment_id, status, uploaded_by_kind) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, status`,
    [accountId, row.id, itemId, a.id, needReview ? 'pending_review' : 'accepted', actor],
  );
  await tx.query(
    `UPDATE intake_item_states SET review_status='none' WHERE account_id=$1 AND intake_id=$2 AND item_id=$3 AND review_status IN ('rejected','needs_review')`,
    [accountId, row.id, itemId],
  );
  if (actor === 'client') {
    await logEvent(tx, accountId, row.project_id, 'intake_file', `ヒアリング「${row.title}」：「${item.label}」にファイルが提出されました`, { refType: 'intake', refId: row.id });
  }
  const after = await recompute(tx, s, accountId, row.id, { requiredChanged: true });
  return { fileId: f.id as string, status: f.status as string, progress: after.result.progress };
}

/** お客様は確認前の自分の提出だけ削除できる。運営者はいつでも削除可（記録は project_events） */
export async function deleteFile(tx: Tx, s: Services, accountId: string, row: any, actor: IntakeActor, fileId: string) {
  const f = await one(tx, 'SELECT * FROM intake_files WHERE account_id=$1 AND intake_id=$2 AND id=$3 FOR UPDATE', [accountId, row.id, fileId]);
  if (!f) throw notFound('ファイル');
  if (actor === 'client') {
    assertOpen(row, actor);
    if (f.status !== 'pending_review' || f.uploaded_by_kind !== 'client') throw conflict('確認済みのファイルは削除できません', 'file_reviewed');
  }
  await tx.query('DELETE FROM attachments WHERE account_id=$1 AND id=$2', [accountId, f.attachment_id]); // intake_files も連鎖削除
  await recompute(tx, s, accountId, row.id, { requiredChanged: true });
}

/** お客様の「送信」（IntakeMint intake.clientSubmit）。未提出があっても送信でき、状態で「対応待ち」を示す */
export async function clientSubmit(tx: Tx, s: Services, accountId: string, row: any) {
  assertOpen(row, 'client');
  await tx.query('UPDATE intakes SET client_submitted_at=$3 WHERE account_id=$1 AND id=$2', [accountId, row.id, s.now()]);
  const after = await recompute(tx, s, accountId, row.id);
  const complete = after.result.progress.submitted === after.result.progress.denominator;
  await logEvent(tx, accountId, row.project_id, 'intake_submitted', `ヒアリング「${row.title}」の回答が送信されました${complete ? '' : '（未提出の項目あり）'}`, {
    refType: 'intake',
    refId: row.id,
    clientVisible: true,
  });
  // 回答チェック（ルール判定）を送信時に実行（候補の作成のみ。お客様には表示しない）
  await runChecks(tx, s, accountId, after.row);
  const final = await recompute(tx, s, accountId, row.id);
  return { complete, status: final.row.status, progress: final.result.progress };
}

export async function answerFollowup(tx: Tx, s: Services, accountId: string, row: any, followupId: string, answer: unknown) {
  assertOpen(row, 'client');
  if (!isAnswered(answer) || JSON.stringify(answer).length > 10000) throw badRequest('回答を入力してください');
  const r = await tx.query(
    `UPDATE intake_followups SET answer=$4, status='answered', answered_at=$5 WHERE account_id=$1 AND intake_id=$2 AND id=$3 AND status IN ('open','answered')`,
    [accountId, row.id, followupId, JSON.stringify(answer), s.now()],
  );
  if (!r.rowCount) throw notFound('追加質問');
  await logEvent(tx, accountId, row.project_id, 'intake_followup_answered', `ヒアリング「${row.title}」：追加質問に回答がありました`, { refType: 'intake', refId: row.id });
  const after = await recompute(tx, s, accountId, row.id);
  return { status: after.row.status };
}

// ---------------------------------------------------------------- 運営者：公開・レビュー

export async function setShared(tx: Tx, s: Services, accountId: string, row: any, shared: boolean) {
  if (shared && !row.shared_at) {
    if (row.status === 'cancelled') throw conflict('中止したヒアリングは公開できません');
    await tx.query('UPDATE intakes SET shared_at=$3 WHERE account_id=$1 AND id=$2', [accountId, row.id, s.now()]);
    await logEvent(tx, accountId, row.project_id, 'intake_shared', `ヒアリング「${row.title}」へのご回答をお願いしています`, { refType: 'intake', refId: row.id, clientVisible: true });
  } else if (!shared && row.shared_at) {
    await tx.query('UPDATE intakes SET shared_at=NULL WHERE account_id=$1 AND id=$2', [accountId, row.id]);
    await logEvent(tx, accountId, row.project_id, 'intake_unshared', `ヒアリング「${row.title}」をクライアントポータルで非公開に変更`, { refType: 'intake', refId: row.id });
  }
  return recompute(tx, s, accountId, row.id);
}

export async function reviewFile(tx: Tx, s: Services, accountId: string, row: any, fileId: string, decision: 'accept' | 'reject', note?: string) {
  const f = await one(tx, 'SELECT * FROM intake_files WHERE account_id=$1 AND intake_id=$2 AND id=$3 FOR UPDATE', [accountId, row.id, fileId]);
  if (!f) throw notFound('ファイル');
  if (decision === 'reject' && !note?.trim()) throw badRequest('差し戻し理由を入力してください（お客様に表示されます）', 'note_required');
  await tx.query('UPDATE intake_files SET status=$4, review_note=$5 WHERE account_id=$1 AND intake_id=$2 AND id=$3', [
    accountId,
    row.id,
    fileId,
    decision === 'accept' ? 'accepted' : 'rejected',
    note?.trim() || null,
  ]);
  const label = row.definition.requiredItems?.find((i: any) => i.id === f.item_id)?.label ?? f.item_id;
  if (decision === 'reject') {
    await logEvent(tx, accountId, row.project_id, 'intake_returned', `ヒアリング「${row.title}」：「${label}」のファイルを差し戻しました`, { refType: 'intake', refId: row.id, clientVisible: !!row.shared_at });
  }
  return recompute(tx, s, accountId, row.id, { requiredChanged: decision === 'reject' });
}

export type ItemDecision = 'accept' | 'reject' | 'needs_review' | 'not_applicable' | 'reopen';

export async function reviewItem(tx: Tx, s: Services, accountId: string, row: any, itemId: string, decision: ItemDecision, note?: string) {
  const st = await loadState(tx, accountId, row);
  const ev = st.result.items.find((i) => i.itemId === itemId);
  if (!ev) throw notFound('必要項目');
  if (decision === 'reject' && !note?.trim()) throw badRequest('差し戻し理由を入力してください（お客様に表示されます）', 'note_required');
  if (decision === 'not_applicable' && !note?.trim()) throw badRequest('対象外にする理由を入力してください', 'note_required');
  if (decision === 'accept' && ev.type === 'question' && (ev.status === 'missing' || ev.status === 'partial')) throw conflict('未回答の項目は承認できません', 'not_answered');
  if (decision === 'accept' && ev.type === 'file' && (ev.count ?? 0) < (ev.minCount ?? 1)) throw conflict(`必要数に達していません（${ev.count}/${ev.minCount}）`, 'not_enough_files');
  const status = decision === 'accept' ? 'accepted' : decision === 'reject' ? 'rejected' : decision === 'reopen' ? 'none' : decision;
  await tx.query(
    `INSERT INTO intake_item_states (account_id, intake_id, item_id, review_status, note, reviewed_at) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (intake_id, item_id) DO UPDATE SET review_status=EXCLUDED.review_status, note=EXCLUDED.note, reviewed_at=EXCLUDED.reviewed_at`,
    [accountId, row.id, itemId, status, note?.trim() || null, s.now()],
  );
  if (decision === 'accept' && ev.type === 'file') {
    await tx.query(`UPDATE intake_files SET status='accepted' WHERE account_id=$1 AND intake_id=$2 AND item_id=$3 AND status='pending_review'`, [accountId, row.id, itemId]);
  }
  if (decision === 'reject') {
    await logEvent(tx, accountId, row.project_id, 'intake_returned', `ヒアリング「${row.title}」：「${ev.label}」を差し戻しました`, { refType: 'intake', refId: row.id, clientVisible: !!row.shared_at });
  }
  return recompute(tx, s, accountId, row.id, { requiredChanged: decision !== 'accept' });
}

// ---------------------------------------------------------------- 回答チェック（ルール判定）・追加質問

const sha = (v: unknown) => crypto.createHash('sha256').update(JSON.stringify(v ?? '')).digest('hex').slice(0, 16);

/** 回答チェックを実行して確認候補を作る（IntakeMint ai.runCaseAnalysis のローカル判定部分）。外部送信なし */
export async function runChecks(tx: Tx, s: Services, accountId: string, row: any) {
  const st = await loadState(tx, accountId, row);
  const answers = st.result.logic.effectiveAnswers;
  // テキスト形式の提出ファイル（差し戻し以外）の本文も数量矛盾のチェックに使う
  const textFiles = st.files.filter((f) => f.status !== 'rejected' && f.mime.startsWith('text/'));
  const fileTexts: { fileId: string; name: string; text: string }[] = [];
  for (const f of textFiles.slice(0, 20)) {
    const b = await one(tx, 'SELECT data FROM attachment_blobs WHERE attachment_id=$1', [f.attachmentId]);
    if (b) fileTexts.push({ fileId: f.id, name: f.originalName, text: Buffer.from(b.data).toString('utf8').slice(0, 20000) });
  }
  const out = runAnswerChecks({ def: st.def, answers, fileTexts, today: s.today() });
  let created = 0;
  const ins = async (kind: string, fingerprint: string, payload: unknown, questionId?: string | null) => {
    const r = await tx.query(
      `INSERT INTO intake_candidates (account_id, intake_id, kind, question_id, fingerprint, payload, provider) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (intake_id, fingerprint) DO NOTHING`,
      [accountId, row.id, kind, questionId ?? null, fingerprint, JSON.stringify(payload), CHECK_PROVIDER],
    );
    created += r.rowCount ?? 0;
  };
  for (const f of out.followUps) await ins('follow_up', `fu:${f.questionId}:${sha(answers[f.questionId])}`, f, f.questionId);
  for (const a of out.ambiguities) await ins('ambiguous', `amb:${a.questionId}:${sha(answers[a.questionId])}`, a, a.questionId);
  for (const c of out.contradictions) await ins('contradiction', c.fingerprint, c, c.sourceRefs[0]?.questionId ?? null);
  // 元の回答が変わった未処理の候補は stale 表示（自動では閉じない）
  const open = await many(tx, `SELECT id, fingerprint, question_id FROM intake_candidates WHERE account_id=$1 AND intake_id=$2 AND status='open' AND kind IN ('follow_up','ambiguous')`, [
    accountId,
    row.id,
  ]);
  for (const o of open) {
    if (!String(o.fingerprint).endsWith(sha(answers[o.question_id]))) {
      await tx.query(`UPDATE intake_candidates SET payload = payload || '{"stale":true}'::jsonb WHERE account_id=$1 AND id=$2`, [accountId, o.id]);
    }
  }
  return { created };
}

export async function resolveCandidate(tx: Tx, s: Services, accountId: string, row: any, candidateId: string, decision: 'send_to_client' | 'dismiss' | 'resolve', text?: string) {
  const c = await one(tx, 'SELECT * FROM intake_candidates WHERE account_id=$1 AND intake_id=$2 AND id=$3 FOR UPDATE', [accountId, row.id, candidateId]);
  if (!c) throw notFound('確認候補');
  if (c.status !== 'open') throw conflict('この候補は処理済みです', 'already_resolved');
  if (decision === 'send_to_client') {
    const t = (text ?? c.payload.text ?? '').trim();
    if (!t) throw badRequest('質問文を入力してください');
    await tx.query('INSERT INTO intake_followups (account_id, intake_id, candidate_id, question_id, text, options) VALUES ($1,$2,$3,$4,$5,$6)', [
      accountId,
      row.id,
      c.id,
      c.question_id,
      t.slice(0, 2000),
      c.payload.options ? JSON.stringify(c.payload.options) : null,
    ]);
    await logEvent(tx, accountId, row.project_id, 'intake_followup', `ヒアリング「${row.title}」：追加のご質問があります`, { refType: 'intake', refId: row.id, clientVisible: !!row.shared_at });
  }
  const status = decision === 'send_to_client' ? 'sent_to_client' : decision === 'dismiss' ? 'dismissed' : 'resolved';
  await tx.query('UPDATE intake_candidates SET status=$3, resolved_at=$4 WHERE account_id=$1 AND id=$2', [accountId, c.id, status, s.now()]);
  return recompute(tx, s, accountId, row.id);
}

export async function requestMoreInfo(tx: Tx, s: Services, accountId: string, row: any, text: string, questionId?: string | null) {
  if (questionId && !(row.definition.questions ?? []).some((q: any) => q.id === questionId)) throw badRequest('存在しない質問です');
  const f = await one(tx, 'INSERT INTO intake_followups (account_id, intake_id, question_id, text) VALUES ($1,$2,$3,$4) RETURNING id', [
    accountId,
    row.id,
    questionId ?? null,
    text.trim().slice(0, 2000),
  ]);
  await logEvent(tx, accountId, row.project_id, 'intake_followup', `ヒアリング「${row.title}」：追加のご質問があります`, { refType: 'intake', refId: row.id, clientVisible: !!row.shared_at });
  await recompute(tx, s, accountId, row.id);
  return f.id as string;
}

export async function resolveFollowup(
  tx: Tx,
  s: Services,
  accountId: string,
  row: any,
  followupId: string,
  decision: 'resolve' | 'reopen' | 'cancel',
  applyToQuestion = false,
) {
  const f = await one(tx, 'SELECT * FROM intake_followups WHERE account_id=$1 AND intake_id=$2 AND id=$3 FOR UPDATE', [accountId, row.id, followupId]);
  if (!f) throw notFound('追加質問');
  let requiredChanged = false;
  if (decision === 'resolve' && applyToQuestion && f.question_id && f.answer !== null) {
    const q = (row.definition as TemplateDefinition).questions.find((x) => x.id === f.question_id);
    if (q && (q.type === 'long_text' || q.type === 'short_text')) {
      const cur = await one(tx, 'SELECT value FROM intake_responses WHERE account_id=$1 AND intake_id=$2 AND question_id=$3', [accountId, row.id, q.id]);
      const prev = typeof cur?.value === 'string' ? (cur.value as string) : '';
      const add = typeof f.answer === 'string' ? f.answer : JSON.stringify(f.answer);
      const merged = prev ? `${prev}\n（追加回答）${add}` : add;
      await tx.query(
        `INSERT INTO intake_responses (account_id, intake_id, question_id, value, updated_by_kind) VALUES ($1,$2,$3,$4,'operator')
         ON CONFLICT (intake_id, question_id) DO UPDATE SET value=EXCLUDED.value, version=intake_responses.version+1, updated_by_kind='operator', updated_at=now()`,
        [accountId, row.id, q.id, JSON.stringify(merged)],
      );
      requiredChanged = affectsRequired(row.definition, [q.id]);
    }
  }
  const status = decision === 'resolve' ? 'resolved' : decision === 'reopen' ? 'open' : 'cancelled';
  await tx.query('UPDATE intake_followups SET status=$3 WHERE account_id=$1 AND id=$2', [accountId, followupId, status]);
  if (f.candidate_id && decision === 'resolve') {
    await tx.query(`UPDATE intake_candidates SET status='resolved', resolved_at=now() WHERE account_id=$1 AND id=$2`, [accountId, f.candidate_id]);
  }
  return recompute(tx, s, accountId, row.id, { requiredChanged });
}

// ---------------------------------------------------------------- Ready：サインオフ・上書き・開始

export async function signoff(tx: Tx, s: Services, accountId: string, row: any, note?: string) {
  const st = await loadState(tx, accountId, row);
  if (!readyExceptSignoff(st.result)) throw new HttpError(409, 'Ready条件を満たしていないためサインオフできません', 'not_ready', st.result.ready.reasons);
  await tx.query('UPDATE intakes SET internal_signoff_at=$3, signoff_note=$4 WHERE account_id=$1 AND id=$2', [accountId, row.id, s.now(), (note ?? '').trim().slice(0, 1000) || null]);
  await logEvent(tx, accountId, row.project_id, 'intake_signoff', `ヒアリング「${row.title}」：内部確認（サインオフ）`, { refType: 'intake', refId: row.id });
  return recompute(tx, s, accountId, row.id);
}

export async function overrideReady(tx: Tx, s: Services, accountId: string, row: any, reason: string) {
  if (!reason || reason.trim().length < 5) throw badRequest('Ready上書きには理由（5文字以上）が必要です', 'reason_required');
  const st = await loadState(tx, accountId, row);
  if (st.result.ready.ready) throw conflict('すでにReady条件を満たしています', 'already_ready');
  const ov = { reason: reason.trim().slice(0, 1000), at: s.now().toISOString(), unmet: st.result.ready.reasons };
  await tx.query('UPDATE intakes SET ready_override=$3 WHERE account_id=$1 AND id=$2', [accountId, row.id, JSON.stringify(ov)]);
  await logEvent(tx, accountId, row.project_id, 'intake_ready_override', `ヒアリング「${row.title}」：Ready を上書き`, { refType: 'intake', refId: row.id, note: ov.reason });
  return recompute(tx, s, accountId, row.id);
}

/** Ready のヒアリングを「開始済み」にする（お客様の受付を終了）。中止は Ready 以外でも可 */
export async function closeIntake(tx: Tx, s: Services, accountId: string, row: any, to: 'started' | 'cancelled') {
  if (to === 'started' && row.status !== 'ready') throw conflict('Readyのヒアリングのみ開始済みにできます', 'not_ready');
  if (TERMINAL.includes(row.status)) throw conflict('すでに受付を終了しています', 'closed');
  await tx.query('UPDATE intakes SET status=$3, started_at=CASE WHEN $3=\'started\' THEN $4::timestamptz ELSE started_at END, updated_at=now() WHERE account_id=$1 AND id=$2', [
    accountId,
    row.id,
    to,
    s.now(),
  ]);
  await logEvent(tx, accountId, row.project_id, `intake_${to}`, `ヒアリング「${row.title}」の受付を終了しました${to === 'cancelled' ? '（中止）' : ''}`, {
    refType: 'intake',
    refId: row.id,
    clientVisible: !!row.shared_at,
  });
}

export async function deleteIntake(tx: Tx, accountId: string, row: any) {
  await tx.query('DELETE FROM attachments WHERE account_id=$1 AND id IN (SELECT attachment_id FROM intake_files WHERE account_id=$1 AND intake_id=$2)', [accountId, row.id]);
  await tx.query('DELETE FROM intakes WHERE account_id=$1 AND id=$2', [accountId, row.id]);
  await logEvent(tx, accountId, row.project_id, 'intake_deleted', `ヒアリング「${row.title}」を削除`);
}

// ---------------------------------------------------------------- FreelanceDesk 案件開始パック

async function packageInputs(q: Queryable, accountId: string, row: any) {
  const st = await loadState(q, accountId, row);
  const p = await one(
    q,
    `SELECT p.number, p.title, c.name AS customer_name FROM projects p JOIN customers c ON c.account_id=p.account_id AND c.id=p.customer_id WHERE p.account_id=$1 AND p.id=$2`,
    [accountId, row.project_id],
  );
  const followups = await many<PackageFollowup>(q, 'SELECT id, question_id, text, status, answer FROM intake_followups WHERE account_id=$1 AND intake_id=$2 ORDER BY created_at', [
    accountId,
    row.id,
  ]);
  return { st, p, followups };
}

export async function generatePackage(tx: Tx, s: Services, accountId: string, row: any, profile?: HandoffProfile) {
  await lockRequest(tx, accountId, `intake-package:${row.id}`);
  const { st, p, followups } = await packageInputs(tx, accountId, row);
  const pkg = buildPackage(
    {
      intake: row,
      project: { number: p.number, title: p.title },
      clientName: p.customer_name,
      def: st.def,
      result: st.result,
      files: st.files.map((f) => ({ id: f.id, itemId: f.itemId, originalName: f.originalName, status: f.status, size: f.size })),
      itemStates: st.itemStates,
    },
    s.now(),
    { followups, profile },
  );
  const md = toMarkdown(pkg);
  const last = await one(tx, 'SELECT COALESCE(MAX(version),0) AS v FROM intake_packages WHERE account_id=$1 AND intake_id=$2', [accountId, row.id]);
  const version = Number(last.v) + 1;
  const r = await one(
    tx,
    'INSERT INTO intake_packages (account_id, intake_id, version, profile, content, markdown) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, version, created_at',
    [accountId, row.id, version, pkg.meta.profile, JSON.stringify(pkg), md],
  );
  await logEvent(tx, accountId, row.project_id, 'intake_package', `FreelanceDesk 案件開始パック v${version} を作成（ヒアリング「${row.title}」）`, {
    refType: 'intake',
    refId: row.id,
    note: row.status === 'ready' ? '' : '（Ready前に作成）',
  });
  return { id: r.id as string, version, package: pkg, markdown: md };
}

export function packageText(markdown: string, format: 'md' | 'txt') {
  const body = format === 'md' ? markdown : toText(markdown);
  return '﻿' + body.split('\n').join('\r\n') + '\r\n';
}

/** 提出ファイル（差し戻し以外）と最新の案件開始パック（Markdown）を ZIP にまとめる。無圧縮（画像・PDFは圧縮効果が小さいため） */
export async function buildFilesZip(q: Queryable, s: Services, accountId: string, row: any) {
  const st = await loadState(q, accountId, row);
  const files: Record<string, Uint8Array> = {};
  let total = 0;
  const limit = Math.max(s.config.accountStorageQuotaBytes, 50 * 1024 * 1024);
  for (const f of st.files.filter((x) => x.status !== 'rejected')) {
    const b = await one(q, 'SELECT data FROM attachment_blobs WHERE attachment_id=$1', [f.attachmentId]);
    if (!b) continue;
    total += b.data.length;
    if (total > limit) throw new HttpError(413, 'ファイルの合計が大きすぎるためZIPを作成できません。個別にダウンロードしてください', 'too_large');
    files[filePath(f.itemId, f.originalName, f.id)] = new Uint8Array(b.data);
  }
  const pkg = await one(q, 'SELECT version, markdown FROM intake_packages WHERE account_id=$1 AND intake_id=$2 ORDER BY version DESC LIMIT 1', [accountId, row.id]);
  if (pkg) files[`案件開始パック_v${pkg.version}.md`] = strToU8(pkg.markdown);
  return zipSync(files, { level: 0 });
}
