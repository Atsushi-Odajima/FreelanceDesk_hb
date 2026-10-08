// FreelanceDesk ヒアリング — お客様側API（/api/portal/projects/:pid/intakes/...）
// クライアントポータルの顧客セッション（fd_portal）必須（portalRoutes のミドルウェア内で登録する）。
// 案件は clientProject()（公開中・自分の案件・招待を使って入った案件）を必ず通し、ヒアリングは
// その案件IDと組で照合（公開前・中止・他案件・他アカウントは 404）。書き込みは顧客セッション単位でレート制限。
import type { Hono } from 'hono';
import { z } from 'zod';
import { type AppEnv, body, idParam, type Services } from '../context';
import { withTx } from '../db';
import { HttpError } from '../services/errors';
import { RateLimiter } from '../services/ratelimit';
import { clientProject } from '../services/portal';
import { receiveUpload } from '../services/attachmentStore';
import { answerFollowup, clientDetail, clientSubmit, deleteFile, listIntakes, requireClientIntake, saveAnswers, uploadFile } from '../services/intake';
import { answersSchema, itemParam } from './intakeAdmin';

export function registerPortalIntakeRoutes(r: Hono<AppEnv>, s: Services) {
  const relax = s.config.relaxRateLimits;
  const intakeWriteLimiter = new RateLimiter(relax ? 1000 : 60, 60_000); // 回答保存・送信・追加質問：1セッション 1分60回
  const intakeUploadLimiter = new RateLimiter(relax ? 1000 : 30, 60_000); // ファイル提出・削除：1セッション 1分30回
  const guard = (c: any, limiter: RateLimiter) => {
    if (!limiter.hit(c.get('portal').tokenHash)) throw new HttpError(429, '操作が多すぎます。しばらく待ってから再度お試しください', 'rate_limited');
  };

  r.get('/projects/:pid/intakes', async (c) => {
    const sess = c.get('portal');
    const p = await clientProject(s.pool, sess, idParam(c, 'pid'));
    return c.json({ intakes: await listIntakes(s.pool, sess.accountId, p.id, 'client') });
  });

  r.get('/projects/:pid/intakes/:iid', async (c) => {
    const sess = c.get('portal');
    const p = await clientProject(s.pool, sess, idParam(c, 'pid'));
    const row = await requireClientIntake(s.pool, sess.accountId, p.id, idParam(c, 'iid'));
    return c.json(await clientDetail(s.pool, sess.accountId, row));
  });

  r.put('/projects/:pid/intakes/:iid/answers', async (c) => {
    const sess = c.get('portal');
    guard(c, intakeWriteLimiter);
    const i = await body(c, answersSchema);
    const res = await withTx(s.pool, async (tx) => {
      const p = await clientProject(tx, sess, idParam(c, 'pid'));
      const row = await requireClientIntake(tx, sess.accountId, p.id, idParam(c, 'iid'), true);
      return saveAnswers(tx, s, sess.accountId, row, 'client', i.answers);
    });
    return c.json(res);
  });

  r.post('/projects/:pid/intakes/:iid/items/:itemId/files', async (c) => {
    const sess = c.get('portal');
    guard(c, intakeUploadLimiter);
    // 本文を読む前にアクセス権を確認（他人の案件へ大きなファイルを送らせない）
    await requireClientIntake(s.pool, sess.accountId, (await clientProject(s.pool, sess, idParam(c, 'pid'))).id, idParam(c, 'iid'));
    const itemId = itemParam(c);
    const up = await receiveUpload(c, s);
    const res = await withTx(s.pool, async (tx) => {
      const p = await clientProject(tx, sess, idParam(c, 'pid'));
      const row = await requireClientIntake(tx, sess.accountId, p.id, idParam(c, 'iid'), true);
      return uploadFile(tx, s, sess.accountId, row, 'client', itemId, up);
    });
    return c.json(res, 201);
  });

  r.delete('/projects/:pid/intakes/:iid/files/:fid', async (c) => {
    const sess = c.get('portal');
    guard(c, intakeUploadLimiter);
    await withTx(s.pool, async (tx) => {
      const p = await clientProject(tx, sess, idParam(c, 'pid'));
      const row = await requireClientIntake(tx, sess.accountId, p.id, idParam(c, 'iid'), true);
      await deleteFile(tx, s, sess.accountId, row, 'client', idParam(c, 'fid'));
    });
    return c.json({ ok: true });
  });

  r.post('/projects/:pid/intakes/:iid/submit', async (c) => {
    const sess = c.get('portal');
    guard(c, intakeWriteLimiter);
    const res = await withTx(s.pool, async (tx) => {
      const p = await clientProject(tx, sess, idParam(c, 'pid'));
      const row = await requireClientIntake(tx, sess.accountId, p.id, idParam(c, 'iid'), true);
      return clientSubmit(tx, s, sess.accountId, row);
    });
    return c.json(res);
  });

  r.post('/projects/:pid/intakes/:iid/followups/:fid/answer', async (c) => {
    const sess = c.get('portal');
    guard(c, intakeWriteLimiter);
    const i = await body(c, z.object({ answer: z.unknown() }));
    const res = await withTx(s.pool, async (tx) => {
      const p = await clientProject(tx, sess, idParam(c, 'pid'));
      const row = await requireClientIntake(tx, sess.accountId, p.id, idParam(c, 'iid'), true);
      return answerFollowup(tx, s, sess.accountId, row, idParam(c, 'fid'), i.answer);
    });
    return c.json(res);
  });
}
