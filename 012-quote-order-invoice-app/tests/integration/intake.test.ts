/**
 * FreelanceDesk ヒアリング（IntakeMint から統合）／FreelanceDesk 案件開始パック
 *  テンプレート / ヒアリングのライフサイクル（問い合わせ段階から）/ 充足判定（条件分岐・3/5・提出≠承認）/
 *  お客様の回答・提出（クライアントポータル経由）/ 承認・差し戻し / 回答チェック（ルール判定）・追加質問 /
 *  Ready（サインオフ・理由付き上書き・必須情報変更で解除）/ 案件開始パック（MD/TXT/ZIP）/ 認可（他アカウント・他案件は 404）/ バックアップ
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { strFromU8, unzipSync } from 'fflate';
import { app, Client, makeApp, rid, setNow, setupProject, signup } from '../helpers';

class PortalClient extends Client {
  async req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await super.req(method, path, body, headers);
    const set = res.headers.get('set-cookie');
    if (set) {
      const m = /fd_portal=([^;]*)/.exec(set);
      if (m) this.cookie = m[1] && !/Max-Age=0/i.test(set) ? `fd_portal=${m[1]}` : '';
    }
    return res;
  }
}

const png = () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Buffer.from(`png-${crypto.randomUUID()}`)]);
const pdf = () => new Uint8Array(Buffer.from(`%PDF-1.4\n% ${crypto.randomUUID()}\n%%EOF\n`));
function form(file: Uint8Array, name: string) {
  const f = new FormData();
  f.append('file', new File([file as BlobPart], name));
  return f;
}

const fullAnswers = {
  company_name: 'Sample株式会社',
  company_address: '東京都千代田区サンプル1-2-3',
  ceo_message: '私たちは地域のお客様とともに歩んでいます。',
  site_purpose: ['company', 'inquiry'],
  site_goal: '問い合わせを月20件に増やしたい',
  business_description: 'Webサイトの制作と運用支援を行っています。',
  reference_sites: [{ url: 'https://example.com', reason: '余白の使い方' }],
  contact_name: '山田 花子',
  contact_email: 'hanako@example.com',
  privacy_ack: true,
};

/** 運営者＋問い合わせ段階の案件＋公開済みポータル＋招待を引き換えたお客様＋Web制作サンプルのヒアリング（公開済み） */
async function setupIntake(opts: { share?: boolean } = {}) {
  const A = await signup();
  const op = A.client;
  const { projectId, customerId } = await setupProject(op, 'コーポレートサイト制作');
  await op.put(`/api/projects/${projectId}/portal`, { status: 'published' });
  const inv = await op.post(`/api/projects/${projectId}/portal/invites`, {}, 201);
  const cl = new PortalClient();
  await cl.post('/api/portal/invite/redeem', { token: inv.path.split('#t=')[1], email: 'info@example.com' }, 200);
  const created = await op.post(`/api/projects/${projectId}/intakes`, { requestId: rid(), sampleKey: 'web', title: 'Web制作ヒアリング', dueDate: '2026-11-01' }, 201);
  const intakeId = created.id as string;
  if (opts.share !== false) await op.post(`/api/projects/${projectId}/intakes/${intakeId}/share`, { shared: true }, 200);
  const opBase = `/api/projects/${projectId}/intakes/${intakeId}`;
  const clBase = `/api/portal/projects/${projectId}/intakes/${intakeId}`;
  return { op, cl, projectId, customerId, intakeId, opBase, clBase };
}

async function upload(c: Client, url: string, file: Uint8Array, name: string, expectStatus = 201) {
  const r = await c.json('POST', url, form(file, name));
  expect(r._status, JSON.stringify(r)).toBe(expectStatus);
  return r;
}

afterEach(() => setNow(null));

describe('テンプレート', () => {
  it('サンプル一覧・サンプルから作成・定義の検証（循環・参照切れは 400）・作成済みヒアリングはテンプレート変更の影響を受けない・アーカイブ', async () => {
    const { client: op } = await signup();
    const list = await op.get('/api/intake-templates');
    expect(list.samples.map((s: any) => s.key)).toEqual(expect.arrayContaining(['web', 'ec', 'sns', 'video', 'recruit', 'consulting', 'tax', 'realestate', 'generic']));
    const t = await op.post('/api/intake-templates', { requestId: rid(), sampleKey: 'generic' }, 201);
    expect(t.template).toMatchObject({ name: '汎用ヒアリング', questionCount: 5, fileItemCount: 1 });
    const def = t.template.definition;
    // 循環ルールは保存できない
    const bad = structuredClone(def);
    bad.rules = [
      { id: 'c1', when: { questionId: 'details', op: 'answered' }, then: [{ type: 'show', target: 'purpose' }] },
      { id: 'c2', when: { questionId: 'purpose', op: 'answered' }, then: [{ type: 'hide', target: 'details' }] },
    ];
    const r1 = await op.put(`/api/intake-templates/${t.template.id}`, { definition: bad }, 400);
    expect(r1.error.code).toBe('invalid_definition');
    expect(r1.error.message).toMatch(/循環/);
    const bad2 = structuredClone(def);
    bad2.requiredItems.push({ id: 'x', label: 'X', type: 'question', required: true, questionIds: ['nope'] });
    expect((await op.put(`/api/intake-templates/${t.template.id}`, { definition: bad2 }, 400)).error.message).toMatch(/存在しない質問/);
    await op.put(`/api/intake-templates/${t.template.id}`, { definition: { questions: 'x' } }, 400);

    // ヒアリングを作成 → テンプレートを編集しても、作成済みヒアリングの定義は変わらない
    const { projectId } = await setupProject(op);
    const ik = await op.post(`/api/projects/${projectId}/intakes`, { templateId: t.template.id }, 201);
    const edited = structuredClone(def);
    edited.questions.push({ id: 'extra_q', sectionId: 's_main', type: 'short_text', label: '追加の質問', required: true });
    const up = await op.put(`/api/intake-templates/${t.template.id}`, { name: '汎用（改）', definition: edited }, 200);
    expect(up.template.questionCount).toBe(6);
    const d = await op.get(`/api/projects/${projectId}/intakes/${ik.id}`);
    expect(d.definition.questions.map((q: any) => q.id)).not.toContain('extra_q');
    expect(d.intake.title).toBe('汎用ヒアリング');
    // アーカイブ後は編集・新規作成不可
    await op.post(`/api/intake-templates/${t.template.id}/archive`, { archived: true }, 200);
    await op.put(`/api/intake-templates/${t.template.id}`, { name: 'x' }, 409);
    await op.post(`/api/projects/${projectId}/intakes`, { templateId: t.template.id }, 400);
    // requestId の再送は同じテンプレート
    const k = rid();
    const a1 = await op.post('/api/intake-templates', { requestId: k, sampleKey: 'web' }, 201);
    const a2 = await op.post('/api/intake-templates', { requestId: k, sampleKey: 'web' }, 201);
    expect(a2.template.id).toBe(a1.template.id);
  });
});

describe('ヒアリングのライフサイクル（問い合わせ段階・クライアントポータル経由）', () => {
  it('作成（冪等）→ 非公開の間はお客様に見えない → 公開 → 回答（形式エラーは保存しない）→ 条件分岐で必須が増える → ファイル 3/5 → 送信', async () => {
    const P = await setupIntake({ share: false });
    // 作成の再送は同じヒアリング
    const k = rid();
    const c1 = await P.op.post(`/api/projects/${P.projectId}/intakes`, { requestId: k, sampleKey: 'generic' }, 201);
    const c2 = await P.op.post(`/api/projects/${P.projectId}/intakes`, { requestId: k, sampleKey: 'generic' }, 200);
    expect(c2.id).toBe(c1.id);
    // 案件は問い合わせ段階のまま
    expect((await P.op.get(`/api/projects/${P.projectId}`)).project.status).toBe('inquiry');
    let d = await P.op.get(P.opBase);
    expect(d.intake.status).toBe('draft');
    // 非公開：一覧に出ず、詳細・書込みは 404
    expect((await P.cl.get(`/api/portal/projects/${P.projectId}/intakes`)).intakes).toHaveLength(0);
    await P.cl.get(P.clBase, 404);
    await P.cl.put(`${P.clBase}/answers`, { answers: { company_name: 'x' } }, 404);
    // 公開
    await P.op.post(`${P.opBase}/share`, { shared: true }, 200);
    d = await P.op.get(P.opBase);
    expect(d.intake.status).toBe('sent');
    const portal = await P.cl.get(`/api/portal/projects/${P.projectId}`);
    expect(portal.intakes.map((x: any) => x.id)).toEqual([P.intakeId]);
    expect(portal.events.map((e: any) => e.title)).toContain('ヒアリング「Web制作ヒアリング」へのご回答をお願いしています');

    // お客様の詳細：パック設定・内部情報は返さない
    let cd = await P.cl.get(P.clBase);
    expect(cd.definition.packageTemplate).toBeUndefined();
    expect(cd.intake.progress).toMatchObject({ denominator: 7, submitted: 0 });

    // 回答：形式エラーの回答は保存されず errors に返る
    const s1 = await P.cl.put(`${P.clBase}/answers`, { answers: { ...fullAnswers, contact_email: 'not-an-email', unknown_q: 'x' } }, 200);
    expect(s1.errors.map((e: any) => e.questionId).sort()).toEqual(['contact_email', 'unknown_q']);
    expect(s1.saved).toContain('company_name');
    expect(s1.status).toBe('in_progress');
    await P.cl.put(`${P.clBase}/answers`, { answers: { contact_email: 'hanako@example.com' } }, 200);
    cd = await P.cl.get(P.clBase);
    expect(cd.intake.progress).toMatchObject({ denominator: 7, submitted: 5, percent: 71 });
    // EC を選ぶと EC の質問が必須化（7→9）
    const s2 = await P.cl.put(`${P.clBase}/answers`, { answers: { site_purpose: ['company', 'ec'] } }, 200);
    expect(s2.progress).toMatchObject({ denominator: 9, submitted: 5 });
    await P.cl.put(`${P.clBase}/answers`, { answers: { site_purpose: ['company', 'inquiry'], ec_product_count: 10 } }, 200);
    // 非表示になった回答は保持されるが判定から除外
    d = await P.op.get(P.opBase);
    expect(d.answers.ec_product_count).toBe(10);
    expect(d.completeness.progress.denominator).toBe(7);

    // ファイル：形式違い・中身と拡張子の不一致・実行ファイルは拒否
    await upload(P.cl, `${P.clBase}/items/logo/files`, png(), 'logo.jpg', 415); // logo は ai/pdf/png のみ
    await upload(P.cl, `${P.clBase}/items/logo/files`, pdf(), 'logo.png', 415); // 拡張子 png・中身 PDF
    await upload(P.cl, `${P.clBase}/items/logo/files`, new Uint8Array([0x4d, 0x5a, 1, 2]), 'logo.png', 415);
    await upload(P.cl, `${P.clBase}/items/nope/files`, png(), 'a.png', 404);
    await upload(P.cl, `${P.clBase}/items/company_info/files`, png(), 'a.png', 404); // 質問項目にはファイルを出せない
    const logo = await upload(P.cl, `${P.clBase}/items/logo/files`, pdf(), 'logo.ai'); // PDF互換の AI は可
    expect(logo.status).toBe('pending_review');
    for (let i = 0; i < 3; i++) await upload(P.cl, `${P.clBase}/items/product_images/files`, png(), `item${i}.png`);
    cd = await P.cl.get(P.clBase);
    const imgs = cd.items.find((i: any) => i.itemId === 'product_images');
    expect(imgs).toMatchObject({ status: 'partial', count: 3, minCount: 5, statusLabel: '一部提出' });
    expect(cd.items.find((i: any) => i.itemId === 'logo').status).toBe('submitted'); // 提出≠承認
    // 提出ファイルはお客様もポータル経由で取得できる（sandbox CSP）
    const f0 = cd.files[0];
    const got = await P.cl.req('GET', f0.url);
    expect(got.status).toBe(200);
    expect(got.headers.get('cache-control')).toContain('no-store');
    // 提出ファイルは通常の添付APIでは削除できない・案件の「ファイル」タブに出ない
    const opDetail = await P.op.get(P.opBase);
    const attId = opDetail.files[0].url.split('/').pop();
    expect((await P.op.del(`/api/attachments/${attId}`, 409)).error.code).toBe('intake_file');
    const pj = await P.op.get(`/api/projects/${P.projectId}`);
    expect(JSON.stringify(pj.attachments ?? [])).not.toContain('logo.ai');

    // 確認前の自分の提出は削除できる
    const extra = await upload(P.cl, `${P.clBase}/items/product_images/files`, png(), 'wrong.png');
    await P.cl.del(`${P.clBase}/files/${extra.fileId}`, 200);

    // 未提出ありで送信 → 「対応待ち」。履歴（お客様にも表示）
    const sub = await P.cl.post(`${P.clBase}/submit`, {}, 200);
    expect(sub).toMatchObject({ complete: false, status: 'needs_client' });
    const ev = await P.cl.get(`/api/portal/projects/${P.projectId}`);
    expect(ev.events.map((e: any) => e.title)).toContain('ヒアリング「Web制作ヒアリング」の回答が送信されました（未提出の項目あり）');
  });

  it('承認・差し戻し（理由はお客様に表示）→ 再提出 → サインオフで Ready → 必須情報の変更で Ready 解除 → 理由付き上書き → 開始済みで受付終了', async () => {
    const P = await setupIntake();
    await P.cl.put(`${P.clBase}/answers`, { answers: fullAnswers }, 200);
    const logo = await upload(P.cl, `${P.clBase}/items/logo/files`, png(), 'logo.png');
    const imgs = [];
    for (let i = 0; i < 5; i++) imgs.push(await upload(P.cl, `${P.clBase}/items/product_images/files`, png(), `p${i}.png`));
    let d = await P.op.get(P.opBase);
    expect(d.intake.status).toBe('needs_internal_review');
    expect(d.completeness.ready.reasons.map((r: any) => r.code)).toEqual(expect.arrayContaining(['ITEM_NOT_ACCEPTED', 'SIGNOFF_REQUIRED']));
    // サインオフは条件を満たすまで不可
    expect((await P.op.post(`${P.opBase}/signoff`, {}, 409)).error.code).toBe('not_ready');

    // ロゴを差し戻し（理由必須）
    expect((await P.op.post(`${P.opBase}/files/${logo.fileId}/review`, { decision: 'reject' }, 400)).error.code).toBe('note_required');
    await P.op.post(`${P.opBase}/files/${logo.fileId}/review`, { decision: 'reject', note: '解像度が低いため、元データをお送りください' }, 200);
    let cd = await P.cl.get(P.clBase);
    expect(cd.items.find((i: any) => i.itemId === 'logo').status).toBe('rejected');
    expect(cd.files.find((f: any) => f.id === logo.fileId)).toMatchObject({ status: 'rejected', reviewNote: '解像度が低いため、元データをお送りください' });
    expect(cd.intake.status).toBe('needs_client');
    // 確認済み（差し戻し）のファイルはお客様が削除できない
    expect((await P.cl.del(`${P.clBase}/files/${logo.fileId}`, 409)).error.code).toBe('file_reviewed');
    // 再提出
    const logo2 = await upload(P.cl, `${P.clBase}/items/logo/files`, pdf(), 'logo.pdf');
    // 項目単位の承認：ロゴ・商品画像（未確認ファイルもまとめて承認）。件数不足は 409
    await P.op.post(`${P.opBase}/files/${logo2.fileId}/review`, { decision: 'accept' }, 200);
    await P.op.post(`${P.opBase}/files/${imgs[0].fileId}/review`, { decision: 'reject', note: '別の写真を' }, 200);
    expect((await P.op.post(`${P.opBase}/items/product_images/review`, { decision: 'accept' }, 409)).error.code).toBe('not_enough_files');
    await upload(P.cl, `${P.clBase}/items/product_images/files`, png(), 'p5.png');
    await P.op.post(`${P.opBase}/items/product_images/review`, { decision: 'accept' }, 200);
    // 項目の差し戻し（質問項目）→ 回答の変更で解除
    await P.op.post(`${P.opBase}/items/greeting/review`, { decision: 'reject', note: 'もう少し詳しく' }, 200);
    cd = await P.cl.get(P.clBase);
    expect(cd.items.find((i: any) => i.itemId === 'greeting')).toMatchObject({ status: 'rejected', note: 'もう少し詳しく' });
    await P.cl.put(`${P.clBase}/answers`, { answers: { ceo_message: fullAnswers.ceo_message + '創業30年、これからも。' } }, 200);
    cd = await P.cl.get(P.clBase);
    expect(cd.items.find((i: any) => i.itemId === 'greeting').status).toBe('accepted');
    // 対象外は理由必須
    await P.op.post(`${P.opBase}/items/references/review`, { decision: 'not_applicable' }, 400);

    d = await P.op.get(P.opBase);
    expect(d.completeness.ready.reasons.map((r: any) => r.code)).toEqual(['SIGNOFF_REQUIRED']);
    const so = await P.op.post(`${P.opBase}/signoff`, { note: '確認しました' }, 200);
    expect(so.status).toBe('ready');
    const portal = await P.cl.get(`/api/portal/projects/${P.projectId}`);
    expect(portal.events.map((e: any) => e.title)).toContain('ヒアリング「Web制作ヒアリング」：必要な情報がそろいました');
    expect(portal.events.map((e: any) => e.title)).not.toContain('ヒアリング「Web制作ヒアリング」：内部確認（サインオフ）');

    // Ready 後に必須情報（会社名）が変わると、サインオフが無効になり Ready 解除
    await P.cl.put(`${P.clBase}/answers`, { answers: { company_name: 'Sample株式会社（新社名）' } }, 200);
    d = await P.op.get(P.opBase);
    expect(d.intake.status).toBe('needs_internal_review');
    expect(d.intake.internalSignoffAt).toBeNull();
    // 上書き：理由5文字以上
    expect((await P.op.post(`${P.opBase}/override`, { reason: '急ぎ' }, 400)).error.code).toBe('reason_required');
    expect((await P.op.post(`${P.opBase}/override`, { reason: '社名変更は口頭で確認済みのため' }, 200)).status).toBe('ready');
    d = await P.op.get(P.opBase);
    expect(d.intake.readyOverride.unmet.map((r: any) => r.code)).toEqual(['SIGNOFF_REQUIRED']);
    // 開始済み → お客様の書込みは 409
    await P.op.post(`${P.opBase}/close`, { to: 'started' }, 200);
    expect((await P.cl.put(`${P.clBase}/answers`, { answers: { company_name: 'x' } }, 409)).error.code).toBe('intake_closed');
    await upload(P.cl, `${P.clBase}/items/logo/files`, png(), 'late.png', 409);
    expect((await P.cl.get(P.clBase)).intake.closed).toBe(true);
    // 開始済みは Ready 以外からは不可
    const Q = await setupIntake();
    expect((await Q.op.post(`${Q.opBase}/close`, { to: 'started' }, 409)).error.code).toBe('not_ready');
    await Q.op.post(`${Q.opBase}/close`, { to: 'cancelled' }, 200);
    await Q.cl.get(Q.clBase, 404); // 中止したヒアリングはお客様に見えない
  });

  it('回答チェック（ルール判定）：曖昧な目的・数量の矛盾を候補に。お客様に質問 → 回答 → 元の回答に追記して解決。未解決の間は Ready にならない', async () => {
    const P = await setupIntake();
    await P.cl.put(`${P.clBase}/answers`, { answers: { ...fullAnswers, site_goal: '会社のサイトです', site_purpose: ['ec'], ec_product_count: 10, ec_payment: ['card'], requests: '全25商品を掲載したいと考えています' } }, 200);
    const chk = await P.op.post(`${P.opBase}/check`, {}, 200);
    expect(chk.created).toBe(2);
    // 同じ回答での再実行は重複しない
    expect((await P.op.post(`${P.opBase}/check`, {}, 200)).created).toBe(0);
    let d = await P.op.get(P.opBase);
    const fu = d.candidates.find((c: any) => c.kind === 'follow_up');
    const con = d.candidates.find((c: any) => c.kind === 'contradiction');
    expect(fu.payload.options).toEqual(['問い合わせ獲得', '採用', '会社案内', '販売']);
    expect(con.payload.text).toMatch(/10.*25/);
    expect(d.answers.ec_product_count).toBe(10); // 自動修正しない
    expect(d.completeness.ready.reasons.map((r: any) => r.code)).toContain('AI_UNRESOLVED');
    // お客様にはチェック結果（候補）を見せない
    expect(JSON.stringify(await P.cl.get(P.clBase))).not.toContain('全25商品を掲載したい」とあります');

    await P.op.post(`${P.opBase}/candidates/${con.id}/resolve`, { decision: 'dismiss' }, 200);
    await P.op.post(`${P.opBase}/candidates/${con.id}/resolve`, { decision: 'dismiss' }, 409);
    await P.op.post(`${P.opBase}/candidates/${fu.id}/resolve`, { decision: 'send_to_client', text: 'サイトの一番の目的を教えてください' }, 200);
    d = await P.op.get(P.opBase);
    expect(d.intake.status).toBe('needs_client');
    let cd = await P.cl.get(P.clBase);
    expect(cd.followups).toHaveLength(1);
    expect(cd.followups[0]).toMatchObject({ text: 'サイトの一番の目的を教えてください', options: ['問い合わせ獲得', '採用', '会社案内', '販売'], status: 'open' });
    await P.cl.post(`${P.clBase}/followups/${cd.followups[0].id}/answer`, { answer: '' }, 400);
    await P.cl.post(`${P.clBase}/followups/${cd.followups[0].id}/answer`, { answer: '問い合わせ獲得' }, 200);
    d = await P.op.get(P.opBase);
    expect(d.followups[0]).toMatchObject({ status: 'answered', answer: '問い合わせ獲得' });
    await P.op.post(`${P.opBase}/followups/${d.followups[0].id}/resolve`, { decision: 'resolve', applyToQuestion: true }, 200);
    d = await P.op.get(P.opBase);
    expect(d.answers.site_goal).toBe('会社のサイトです\n（追加回答）問い合わせ獲得');
    expect(d.candidates.find((c: any) => c.id === fu.id).status).toBe('resolved');
    expect(d.completeness.ready.reasons.map((r: any) => r.code)).not.toContain('AI_UNRESOLVED');
    // 運営者が直接追加質問（存在しない質問IDは 400）
    await P.op.post(`${P.opBase}/followups`, { text: '公開希望日は？', questionId: 'nope' }, 400);
    await P.op.post(`${P.opBase}/followups`, { text: '公開希望日は？', questionId: 'launch_date' }, 201);
    cd = await P.cl.get(P.clBase);
    expect(cd.followups.map((f: any) => f.text)).toEqual(['公開希望日は？']);
    // お客様の「送信」でも回答チェックが走る（候補はお客様には見えない）
    await P.cl.put(`${P.clBase}/answers`, { answers: { launch_date: '2020-01-01' } }, 200);
    await P.cl.post(`${P.clBase}/submit`, {}, 200);
    d = await P.op.get(P.opBase);
    expect(d.candidates.some((c: any) => c.kind === 'contradiction' && /過去の日付/.test(c.payload.text))).toBe(true);
  });
});

describe('FreelanceDesk 案件開始パック', () => {
  it('出典付き Markdown/TXT（BOM・CRLF）・版管理・非表示の回答を含めない・ZIP（提出ファイル＋パック、差し戻しは除外）', async () => {
    const P = await setupIntake();
    await P.cl.put(`${P.clBase}/answers`, { answers: { ...fullAnswers, ec_product_count: 77 } }, 200);
    const logo = await upload(P.cl, `${P.clBase}/items/logo/files`, pdf(), 'ロゴ.pdf');
    const bad = await upload(P.cl, `${P.clBase}/items/product_images/files`, png(), 'bad.png');
    await upload(P.cl, `${P.clBase}/items/product_images/files`, png(), 'good.png');
    await P.op.post(`${P.opBase}/files/${bad.fileId}/review`, { decision: 'reject', note: 'ぼやけています' }, 200);
    await P.op.post(`${P.opBase}/followups`, { text: 'ターゲットは？' }, 201);

    const g1 = await P.op.post(`${P.opBase}/packages`, {}, 201);
    expect(g1.version).toBe(1);
    const md: string = g1.markdown;
    expect(md).toContain('# FreelanceDesk 案件開始パック：コーポレートサイト制作');
    expect(md).toContain('クライアント名**: Sample Design株式会社');
    expect(md).toContain('**会社名**: Sample株式会社 `[q:company_name]`');
    expect(md).toContain(`files/logo/${logo.fileId.slice(0, 8)}_ロゴ.pdf`);
    expect(md).not.toContain('bad.png');
    expect(md).not.toContain('77'); // 非表示（EC未選択）の回答は含めない
    expect(md).toContain('ターゲットは？（回答待ち）');
    expect(md).toContain('# Web Development Handoff');
    expect(md).toContain('ヒアリング回答期限**: 2026-11-01');
    expect(g1.package.sections.openQuestions.length).toBeGreaterThan(0);
    // プロファイル指定・版
    const g2 = await P.op.post(`${P.opBase}/packages`, { profile: 'design' }, 201);
    expect(g2.version).toBe(2);
    expect(g2.markdown).toContain('# Design Handoff');
    const d = await P.op.get(P.opBase);
    expect(d.packages.map((p: any) => p.version)).toEqual([2, 1]);
    const j = await P.op.get(`${P.opBase}/packages/${g1.id}`);
    expect(j.package.schema).toBe('freelancedesk.intake-package/v1');
    // Markdown / TXT ダウンロード
    const mdRes = await P.op.req('GET', `${P.opBase}/packages/${g1.id}?format=md`);
    expect(mdRes.headers.get('content-type')).toContain('text/markdown');
    expect(mdRes.headers.get('content-disposition')).toContain(encodeURIComponent('案件開始パック_Web制作ヒアリング_v1.md'));
    const mdBody = new Uint8Array(await mdRes.arrayBuffer());
    expect([...mdBody.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(new TextDecoder().decode(mdBody)).toContain('\r\n');
    const txt = await (await P.op.req('GET', `${P.opBase}/packages/${g1.id}?format=txt`)).text();
    expect(txt).not.toMatch(/\*\*|`/);
    // ZIP
    const z = await P.op.req('GET', `${P.opBase}/files.zip`);
    expect(z.headers.get('content-type')).toBe('application/zip');
    const entries = unzipSync(new Uint8Array(await z.arrayBuffer()));
    const names = Object.keys(entries);
    expect(names).toContain(`files/logo/${logo.fileId.slice(0, 8)}_ロゴ.pdf`);
    expect(names.some((n) => n.endsWith('good.png'))).toBe(true);
    expect(names.some((n) => n.endsWith('bad.png'))).toBe(false);
    expect(strFromU8(entries['案件開始パック_v2.md'])).toContain('Design Handoff');
    // 履歴（運営者のみ）
    const ev = await P.cl.get(`/api/portal/projects/${P.projectId}`);
    expect(ev.events.some((e: any) => /案件開始パック/.test(e.title))).toBe(false);
  });
});

describe('認可：他アカウント・他案件のIDは 404', () => {
  let A: Awaited<ReturnType<typeof setupIntake>>;
  let B: Awaited<ReturnType<typeof setupIntake>>;
  let bFile: string;
  let bFollowup: string;
  let bAttachment: string;
  let bCandidate: string;
  let bPackage: string;

  beforeAll(async () => {
    A = await setupIntake();
    B = await setupIntake();
    const up = await upload(B.cl, `${B.clBase}/items/logo/files`, png(), 'b.png');
    bFile = up.fileId;
    bFollowup = (await B.op.post(`${B.opBase}/followups`, { text: 'B社への質問' }, 201)).id;
    await B.cl.put(`${B.clBase}/answers`, { answers: { site_goal: '未定' } }, 200);
    await B.op.post(`${B.opBase}/check`, {}, 200);
    const d = await B.op.get(B.opBase);
    bAttachment = d.files[0].url.split('/').pop();
    bCandidate = d.candidates[0].id;
    bPackage = (await B.op.post(`${B.opBase}/packages`, {}, 201)).id;
  });

  const clientRoutes = (pid: string, iid: string) =>
    [
      ['GET', `/api/portal/projects/${pid}/intakes`],
      ['GET', `/api/portal/projects/${pid}/intakes/${iid}`],
      ['PUT', `/api/portal/projects/${pid}/intakes/${iid}/answers`, { answers: { company_name: 'x' } }],
      ['POST', `/api/portal/projects/${pid}/intakes/${iid}/items/logo/files`, 'upload'],
      ['DELETE', `/api/portal/projects/${pid}/intakes/${iid}/files/${bFile}`],
      ['POST', `/api/portal/projects/${pid}/intakes/${iid}/submit`, {}],
      ['POST', `/api/portal/projects/${pid}/intakes/${iid}/followups/${bFollowup}/answer`, { answer: 'x' }],
      ['GET', `/api/portal/projects/${pid}/files/${bAttachment}`],
    ] as Array<[string, string, unknown?]>;

  const call = (c: Client, m: string, path: string, b: unknown) => (b === 'upload' ? c.json(m, path, form(png(), 'x.png')) : c.json(m, path, b));

  it('お客様API：他アカウントの案件ID＋ヒアリングIDは全ルートで 404', async () => {
    for (const [m, path, b] of clientRoutes(B.projectId, B.intakeId)) {
      const r = await call(A.cl, m, path, b);
      expect(r._status, `${m} ${path}`).toBe(404);
    }
  });

  it('お客様API：自分の案件ID＋他アカウントのヒアリング/ファイル/追加質問IDは 404', async () => {
    for (const [m, path, b] of clientRoutes(A.projectId, B.intakeId).slice(1)) {
      const r = await call(A.cl, m, path, b);
      expect(r._status, `${m} ${path}`).toBe(404);
    }
    // 自分のヒアリング＋他のファイル・追加質問
    expect((await A.cl.json('DELETE', `${A.clBase}/files/${bFile}`))._status).toBe(404);
    expect((await A.cl.post(`${A.clBase}/followups/${bFollowup}/answer`, { answer: 'x' }))._status).toBe(404);
  });

  it('同じアカウントの別案件（招待未使用）のヒアリングも 404。非公開に戻すと見えない', async () => {
    const p2 = await setupProject(A.op, '別案件');
    await A.op.put(`/api/projects/${p2.projectId}/portal`, { status: 'published' });
    const ik = await A.op.post(`/api/projects/${p2.projectId}/intakes`, { sampleKey: 'generic' }, 201);
    await A.op.post(`/api/projects/${p2.projectId}/intakes/${ik.id}/share`, { shared: true }, 200);
    await A.cl.get(`/api/portal/projects/${p2.projectId}/intakes/${ik.id}`, 404);
    // 自分の案件IDに別案件のヒアリングID
    await A.cl.get(`/api/portal/projects/${A.projectId}/intakes/${ik.id}`, 404);
    // 非公開に戻すと 404・提出ファイルも 404
    const up = await upload(A.cl, `${A.clBase}/items/logo/files`, png(), 'mine.png');
    const d = await A.op.get(A.opBase);
    const url = d.files.find((f: any) => f.id === up.fileId).url.replace('/api/attachments/', `/api/portal/projects/${A.projectId}/files/`);
    await A.cl.get(url, 200);
    await A.op.post(`${A.opBase}/share`, { shared: false }, 200);
    await A.cl.get(A.clBase, 404);
    await A.cl.get(url, 404);
    await A.op.post(`${A.opBase}/share`, { shared: true }, 200);
  });

  it('認証の分離：Cookieなし 401、運営者Cookieでお客様API 401、お客様Cookieで運営者API 401、CSRFヘッダなし 403', async () => {
    await new Client().get(A.clBase, 401);
    await A.op.get(A.clBase, 401);
    await A.cl.get(A.opBase, 401);
    await A.cl.get('/api/intake-templates', 401);
    const res = await app.request(`${A.clBase}/answers`, {
      method: 'PUT',
      headers: { cookie: A.cl.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ answers: {} }),
    });
    expect(res.status).toBe(403);
  });

  it('運営者API：他アカウントの案件・ヒアリング・ファイル・候補・追加質問・パック・テンプレートは 404', async () => {
    const tB = (await B.op.post('/api/intake-templates', { sampleKey: 'generic' }, 201)).template.id;
    const routes: Array<[string, string, unknown?]> = [];
    const sets: Array<[string, string]> = [
      [B.projectId, B.intakeId], // 他アカウントの案件＋ヒアリング
      [A.projectId, B.intakeId], // 自分の案件＋他アカウントのヒアリング
    ];
    for (const [pid, iid] of sets) {
      const base = `/api/projects/${pid}/intakes/${iid}`;
      routes.push(
        ['GET', base],
        ['PUT', base, { title: 'x' }],
        ['DELETE', base],
        ['POST', `${base}/share`, { shared: false }],
        ['PUT', `${base}/answers`, { answers: {} }],
        ['POST', `${base}/items/logo/files`, 'upload'],
        ['DELETE', `${base}/files/${bFile}`],
        ['POST', `${base}/files/${bFile}/review`, { decision: 'accept' }],
        ['POST', `${base}/items/logo/review`, { decision: 'accept' }],
        ['POST', `${base}/check`, {}],
        ['POST', `${base}/candidates/${bCandidate}/resolve`, { decision: 'dismiss' }],
        ['POST', `${base}/followups`, { text: 'x' }],
        ['POST', `${base}/followups/${bFollowup}/resolve`, { decision: 'cancel' }],
        ['POST', `${base}/signoff`, {}],
        ['POST', `${base}/override`, { reason: '理由があります' }],
        ['POST', `${base}/close`, { to: 'cancelled' }],
        ['POST', `${base}/packages`, {}],
        ['GET', `${base}/packages/${bPackage}`],
        ['GET', `${base}/files.zip`],
      );
    }
    routes.push(
      ['GET', `/api/projects/${B.projectId}/intakes`],
      ['POST', `/api/projects/${B.projectId}/intakes`, { sampleKey: 'generic' }],
      ['POST', `/api/projects/${A.projectId}/intakes`, { templateId: tB }],
      ['GET', `/api/intake-templates/${tB}`],
      ['PUT', `/api/intake-templates/${tB}`, { name: 'x' }],
      ['POST', `/api/intake-templates/${tB}/archive`, { archived: true }],
      // 自分のヒアリング＋他アカウントのサブリソース
      ['POST', `${A.opBase}/files/${bFile}/review`, { decision: 'accept' }],
      ['DELETE', `${A.opBase}/files/${bFile}`],
      ['POST', `${A.opBase}/candidates/${bCandidate}/resolve`, { decision: 'dismiss' }],
      ['POST', `${A.opBase}/followups/${bFollowup}/resolve`, { decision: 'cancel' }],
      ['GET', `${A.opBase}/packages/${bPackage}`],
      ['GET', `/api/attachments/${bAttachment}`],
    );
    for (const [m, path, b] of routes) {
      const r = await call(A.op, m, path, b);
      expect(r._status, `${m} ${path}`).toBe(404);
    }
    // B のデータは変わっていない
    const d = await B.op.get(B.opBase);
    expect(d.intake.sharedAt).not.toBeNull();
    expect(d.files[0].status).toBe('pending_review');
  });
});

describe('レート制限・バックアップ', () => {
  it('お客様の回答保存は1セッション1分60回まで（429）', async () => {
    const strict = makeApp({ relaxRateLimits: false });
    const P = await setupIntake();
    const c = new PortalClient(strict);
    c.cookie = P.cl.cookie;
    let last = 0;
    for (let i = 0; i < 61; i++) last = (await c.put(`${P.clBase}/answers`, { answers: { company_name: `n${i}` } }, i < 60 ? 200 : 429))._status;
    expect(last).toBe(429);
  });

  it('ヒアリングのテーブルを含めて別アカウントへ復元できる（提出ファイル・パック・回答）', async () => {
    const P = await setupIntake();
    await P.op.post('/api/intake-templates', { sampleKey: 'sns' }, 201);
    await P.cl.put(`${P.clBase}/answers`, { answers: { ...fullAnswers, site_goal: '未定' } }, 200);
    await upload(P.cl, `${P.clBase}/items/logo/files`, pdf(), 'logo.pdf');
    await P.op.post(`${P.opBase}/check`, {}, 200);
    const d0 = await P.op.get(P.opBase);
    await P.op.post(`${P.opBase}/candidates/${d0.candidates[0].id}/resolve`, { decision: 'send_to_client' }, 200);
    await P.op.post(`${P.opBase}/items/greeting/review`, { decision: 'reject', note: '詳しく' }, 200);
    await P.op.post(`${P.opBase}/packages`, {}, 201);
    const res = await P.op.req('GET', '/api/data/backup.zip');
    const bytes = new Uint8Array(await res.arrayBuffer());
    const manifest = JSON.parse(strFromU8(unzipSync(bytes)['manifest.json']));
    expect(manifest.stats.counts).toMatchObject({ intake_templates: 1, intakes: 1, intake_files: 1, intake_packages: 1, intake_followups: 1, intake_item_states: 1 });
    expect(manifest.stats.counts.intake_responses).toBeGreaterThan(5);
    const B = await signup();
    const f = new FormData();
    f.append('file', new File([bytes as BlobPart], 'backup.zip'));
    const r = await B.client.json('POST', '/api/data/restore', f);
    expect(r._status, JSON.stringify(r)).toBe(200);
    const pid = (await B.client.get('/api/projects')).projects[0].id;
    const list = await B.client.get(`/api/projects/${pid}/intakes`);
    expect(list.intakes).toHaveLength(1);
    const d = await B.client.get(`/api/projects/${pid}/intakes/${list.intakes[0].id}`);
    expect(d.answers.company_name).toBe('Sample株式会社');
    expect(d.followups).toHaveLength(1);
    expect(d.packages).toHaveLength(1);
    const file = await B.client.req('GET', d.files[0].url);
    expect(file.status).toBe(200);
    expect((await B.client.get('/api/intake-templates')).templates).toHaveLength(1);
  });

  it('案件の削除・ヒアリングの削除・アカウント削除でヒアリングと提出ファイルも消える', async () => {
    const P = await setupIntake();
    await upload(P.cl, `${P.clBase}/items/logo/files`, pdf(), 'logo.pdf');
    // ヒアリングの削除（提出ファイルの添付も削除）
    const extra = await P.op.post(`/api/projects/${P.projectId}/intakes`, { sampleKey: 'generic' }, 201);
    await P.op.del(`/api/projects/${P.projectId}/intakes/${extra.id}`, 200);
    await P.op.get(`/api/projects/${P.projectId}/intakes/${extra.id}`, 404);
    // 案件の削除
    await P.op.del(`/api/projects/${P.projectId}`, 200);
    await P.op.get(P.opBase, 404);
    // アカウント削除（テンプレート・ヒアリングがあっても削除できる）
    const Q = await setupIntake();
    await Q.op.post('/api/intake-templates', { sampleKey: 'web' }, 201);
    const t = (await Q.op.get('/api/intake-templates')).templates[0].id;
    await Q.op.post(`/api/projects/${Q.projectId}/intakes`, { templateId: t }, 201);
    await Q.op.post('/api/auth/delete-account', { password: 'password-1234', confirm: '削除します' }, 200);
  });
});
