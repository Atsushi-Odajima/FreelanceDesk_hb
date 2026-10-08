// FreelanceDesk ヒアリング／案件開始パック — 運営者側API
//   /api/intake-templates…            テンプレート（サンプルから作成・編集・アーカイブ）
//   /api/projects/:id/intakes…        案件のヒアリング（公開・回答・レビュー・回答チェック・追加質問・Ready・パック）
// すべて運営者セッション（fd_session）で認証済み。account_id で照合し、他アカウント・他案件のIDは 404。
import { Hono } from 'hono';
import { z } from 'zod';
import { type AppEnv, body, idParam, query, type Services } from '../context';
import { many, withTx } from '../db';
import { dateStr, optDate, requestId as requestIdSchema, requiredText, text, uuid } from '../schemas';
import { HttpError, notFound } from '../services/errors';
import { requireProject } from '../services/projects';
import { receiveUpload } from '../services/attachmentStore';
import { contentDisposition } from '../services/upload';
import { parseDefinition } from '../services/intakeDefinition';
import {
  ITEM_ID_RE,
  buildFilesZip,
  closeIntake,
  createIntake,
  createTemplate,
  deleteFile,
  deleteIntake,
  generatePackage,
  listIntakes,
  operatorDetail,
  overrideReady,
  recompute,
  packageText,
  requestMoreInfo,
  requireIntake,
  requireTemplate,
  resolveCandidate,
  resolveFollowup,
  reviewFile,
  reviewItem,
  runChecks,
  saveAnswers,
  setShared,
  signoff,
  templateDto,
  uploadFile,
} from '../services/intake';
import { sampleTemplates } from '../../../shared/intake/samples';
import { lintDefinition } from '../../../shared/intake/lint';
import { one } from '../db';

const PROFILES = ['web_development', 'design', 'video', 'sns_management', 'consulting', 'recruiting', 'accounting_prep', 'generic'] as const;
export const answersSchema = z.object({ answers: z.record(z.string().max(64), z.unknown()) });

export function itemParam(c: any): string {
  const v = c.req.param('itemId') ?? '';
  if (!ITEM_ID_RE.test(v)) throw notFound('提出先の項目');
  return v;
}

export function intakeAdminRoutes(s: Services) {
  const r = new Hono<AppEnv>();

  // ---------------------------------------------------------------- テンプレート
  r.get('/intake-templates', async (c) => {
    const acc = c.get('accountId');
    const rows = await many(s.pool, 'SELECT * FROM intake_templates WHERE account_id=$1 ORDER BY archived_at NULLS FIRST, updated_at DESC', [acc]);
    return c.json({
      templates: rows.map(templateDto),
      samples: sampleTemplates.map((x) => ({ key: x.key, name: x.name, description: x.description })),
    });
  });

  r.post('/intake-templates', async (c) => {
    const acc = c.get('accountId');
    const i = await body(
      c,
      z.object({ requestId: requestIdSchema.optional(), name: text(200).optional(), description: text(2000).optional(), sampleKey: z.string().max(50).optional(), definition: z.unknown().optional() }),
    );
    const t = await withTx(s.pool, (tx) => createTemplate(tx, acc, i));
    return c.json({ template: { ...templateDto(t), definition: t.definition } }, 201);
  });

  r.get('/intake-templates/:id', async (c) => {
    const t = await requireTemplate(s.pool, c.get('accountId'), idParam(c));
    return c.json({ template: { ...templateDto(t), definition: t.definition }, lint: lintDefinition(t.definition) });
  });

  r.put('/intake-templates/:id', async (c) => {
    const acc = c.get('accountId');
    const id = idParam(c);
    const i = await body(c, z.object({ name: requiredText(200).optional(), description: text(2000).optional(), definition: z.unknown().optional() }));
    const def = i.definition !== undefined ? parseDefinition(i.definition) : null;
    const t = await withTx(s.pool, async (tx) => {
      const cur = await requireTemplate(tx, acc, id, true);
      if (cur.archived_at) throw new HttpError(409, 'アーカイブ済みのテンプレートは編集できません', 'archived');
      return one(
        tx,
        'UPDATE intake_templates SET name=$3, description=$4, definition=$5, updated_at=now() WHERE account_id=$1 AND id=$2 RETURNING *',
        [acc, id, i.name ?? cur.name, i.description ?? cur.description, def ? JSON.stringify(def) : JSON.stringify(cur.definition)],
      );
    });
    return c.json({ template: { ...templateDto(t), definition: t.definition }, lint: lintDefinition(t.definition) });
  });

  // 既存のヒアリングはテンプレートの定義をコピーして持つため、アーカイブしても影響しない
  r.post('/intake-templates/:id/archive', async (c) => {
    const acc = c.get('accountId');
    const i = await body(c, z.object({ archived: z.boolean().default(true) }));
    await withTx(s.pool, async (tx) => {
      await requireTemplate(tx, acc, idParam(c), true);
      await tx.query('UPDATE intake_templates SET archived_at=$3, updated_at=now() WHERE account_id=$1 AND id=$2', [acc, idParam(c), i.archived ? s.now() : null]);
    });
    return c.json({ ok: true });
  });

  // ---------------------------------------------------------------- 案件のヒアリング
  r.get('/projects/:id/intakes', async (c) => {
    const acc = c.get('accountId');
    const id = idParam(c);
    await requireProject(s.pool, acc, id);
    return c.json({ intakes: await listIntakes(s.pool, acc, id, 'operator') });
  });

  r.post('/projects/:id/intakes', async (c) => {
    const acc = c.get('accountId');
    const id = idParam(c);
    const i = await body(
      c,
      z.object({ requestId: requestIdSchema.optional(), templateId: uuid.optional(), sampleKey: z.string().max(50).optional(), title: text(200).optional(), dueDate: optDate }),
    );
    const res = await withTx(s.pool, async (tx) => {
      await requireProject(tx, acc, id, true);
      return createIntake(tx, s, acc, id, i);
    });
    return c.json(res, res.created ? 201 : 200);
  });

  /** :iid は必ず案件IDと組で照合（他案件のヒアリングIDは 404） */
  const load = (tx: any, c: any, lock = true) => requireIntake(tx, c.get('accountId'), idParam(c), idParam(c, 'iid'), lock);

  r.get('/projects/:id/intakes/:iid', async (c) => {
    const acc = c.get('accountId');
    const row = await load(s.pool, c, false);
    return c.json(await operatorDetail(s.pool, acc, row));
  });

  r.put('/projects/:id/intakes/:iid', async (c) => {
    const acc = c.get('accountId');
    const i = await body(c, z.object({ title: requiredText(200).optional(), dueDate: z.union([dateStr, z.literal(''), z.null()]).optional() }));
    await withTx(s.pool, async (tx) => {
      const row = await load(tx, c);
      await tx.query('UPDATE intakes SET title=$3, due_date=$4, updated_at=now() WHERE account_id=$1 AND id=$2', [
        acc,
        row.id,
        i.title ?? row.title,
        i.dueDate === undefined ? row.due_date : i.dueDate || null,
      ]);
    });
    return c.json({ ok: true });
  });

  r.delete('/projects/:id/intakes/:iid', async (c) => {
    const acc = c.get('accountId');
    await withTx(s.pool, async (tx) => deleteIntake(tx, acc, await load(tx, c)));
    return c.json({ ok: true });
  });

  r.post('/projects/:id/intakes/:iid/share', async (c) => {
    const acc = c.get('accountId');
    const i = await body(c, z.object({ shared: z.boolean() }));
    const st = await withTx(s.pool, async (tx) => setShared(tx, s, acc, await load(tx, c), i.shared));
    return c.json({ status: st.row.status, sharedAt: st.row.shared_at });
  });

  r.put('/projects/:id/intakes/:iid/answers', async (c) => {
    const acc = c.get('accountId');
    const i = await body(c, answersSchema);
    return c.json(await withTx(s.pool, async (tx) => saveAnswers(tx, s, acc, await load(tx, c), 'operator', i.answers)));
  });

  r.post('/projects/:id/intakes/:iid/items/:itemId/files', async (c) => {
    const acc = c.get('accountId');
    const up = await receiveUpload(c, s);
    const res = await withTx(s.pool, async (tx) => uploadFile(tx, s, acc, await load(tx, c), 'operator', itemParam(c), up));
    return c.json(res, 201);
  });

  r.delete('/projects/:id/intakes/:iid/files/:fid', async (c) => {
    const acc = c.get('accountId');
    await withTx(s.pool, async (tx) => deleteFile(tx, s, acc, await load(tx, c), 'operator', idParam(c, 'fid')));
    return c.json({ ok: true });
  });

  r.post('/projects/:id/intakes/:iid/files/:fid/review', async (c) => {
    const acc = c.get('accountId');
    const i = await body(c, z.object({ decision: z.enum(['accept', 'reject']), note: text(1000).optional() }));
    const st = await withTx(s.pool, async (tx) => reviewFile(tx, s, acc, await load(tx, c), idParam(c, 'fid'), i.decision, i.note));
    return c.json({ status: st.row.status, completeness: st.result });
  });

  r.post('/projects/:id/intakes/:iid/items/:itemId/review', async (c) => {
    const acc = c.get('accountId');
    const i = await body(c, z.object({ decision: z.enum(['accept', 'reject', 'needs_review', 'not_applicable', 'reopen']), note: text(1000).optional() }));
    const st = await withTx(s.pool, async (tx) => reviewItem(tx, s, acc, await load(tx, c), itemParam(c), i.decision, i.note));
    return c.json({ status: st.row.status, completeness: st.result });
  });

  r.post('/projects/:id/intakes/:iid/check', async (c) => {
    const acc = c.get('accountId');
    const res = await withTx(s.pool, async (tx) => {
      const row = await load(tx, c);
      const out = await runChecks(tx, s, acc, row);
      await recompute(tx, s, acc, row.id);
      return out;
    });
    return c.json(res);
  });

  r.post('/projects/:id/intakes/:iid/candidates/:cid/resolve', async (c) => {
    const acc = c.get('accountId');
    const i = await body(c, z.object({ decision: z.enum(['send_to_client', 'dismiss', 'resolve']), text: text(2000).optional() }));
    const st = await withTx(s.pool, async (tx) => resolveCandidate(tx, s, acc, await load(tx, c), idParam(c, 'cid'), i.decision, i.text));
    return c.json({ status: st.row.status });
  });

  r.post('/projects/:id/intakes/:iid/followups', async (c) => {
    const acc = c.get('accountId');
    const i = await body(c, z.object({ text: requiredText(2000), questionId: z.string().max(64).nullable().optional() }));
    const id = await withTx(s.pool, async (tx) => requestMoreInfo(tx, s, acc, await load(tx, c), i.text, i.questionId));
    return c.json({ id }, 201);
  });

  r.post('/projects/:id/intakes/:iid/followups/:fid/resolve', async (c) => {
    const acc = c.get('accountId');
    const i = await body(c, z.object({ decision: z.enum(['resolve', 'reopen', 'cancel']), applyToQuestion: z.boolean().optional().default(false) }));
    const st = await withTx(s.pool, async (tx) => resolveFollowup(tx, s, acc, await load(tx, c), idParam(c, 'fid'), i.decision, i.applyToQuestion));
    return c.json({ status: st.row.status });
  });

  r.post('/projects/:id/intakes/:iid/signoff', async (c) => {
    const acc = c.get('accountId');
    const i = await body(c, z.object({ note: text(1000).optional() }));
    const st = await withTx(s.pool, async (tx) => signoff(tx, s, acc, await load(tx, c), i.note));
    return c.json({ status: st.row.status, ready: st.result.ready });
  });

  r.post('/projects/:id/intakes/:iid/override', async (c) => {
    const acc = c.get('accountId');
    const i = await body(c, z.object({ reason: text(1000) }));
    const st = await withTx(s.pool, async (tx) => overrideReady(tx, s, acc, await load(tx, c), i.reason));
    return c.json({ status: st.row.status });
  });

  r.post('/projects/:id/intakes/:iid/close', async (c) => {
    const acc = c.get('accountId');
    const i = await body(c, z.object({ to: z.enum(['started', 'cancelled']) }));
    await withTx(s.pool, async (tx) => closeIntake(tx, s, acc, await load(tx, c), i.to));
    return c.json({ ok: true });
  });

  // ---------------------------------------------------------------- FreelanceDesk 案件開始パック
  r.post('/projects/:id/intakes/:iid/packages', async (c) => {
    const acc = c.get('accountId');
    const i = await body(c, z.object({ profile: z.enum(PROFILES).optional() }));
    const res = await withTx(s.pool, async (tx) => generatePackage(tx, s, acc, await load(tx, c), i.profile));
    return c.json(res, 201);
  });

  r.get('/projects/:id/intakes/:iid/packages/:pkid', async (c) => {
    const acc = c.get('accountId');
    const q = query(c, z.object({ format: z.enum(['json', 'md', 'txt']).default('json') }));
    const row = await load(s.pool, c, false);
    const p = await one(s.pool, 'SELECT * FROM intake_packages WHERE account_id=$1 AND intake_id=$2 AND id=$3', [acc, row.id, idParam(c, 'pkid')]);
    if (!p) throw notFound('案件開始パック');
    if (q.format === 'json') return c.json({ id: p.id, version: p.version, profile: p.profile, createdAt: p.created_at, package: p.content, markdown: p.markdown });
    return c.body(packageText(p.markdown, q.format), 200, {
      'Content-Type': `${q.format === 'md' ? 'text/markdown' : 'text/plain'}; charset=utf-8`,
      'Content-Disposition': contentDisposition('attachment', `案件開始パック_${row.title}_v${p.version}.${q.format}`),
      'Cache-Control': 'private, no-store',
    });
  });

  r.get('/projects/:id/intakes/:iid/files.zip', async (c) => {
    const acc = c.get('accountId');
    const row = await load(s.pool, c, false);
    const zip = await buildFilesZip(s.pool, s, acc, row);
    return c.body(zip as Uint8Array<ArrayBuffer>, 200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': contentDisposition('attachment', `提出ファイル_${row.title}.zip`),
      'Cache-Control': 'private, no-store',
    });
  });

  return r;
}
