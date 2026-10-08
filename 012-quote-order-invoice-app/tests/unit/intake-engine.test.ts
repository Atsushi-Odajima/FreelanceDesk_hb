// FreelanceDesk ヒアリング — 純粋ロジックの単体テスト（IntakeMint tests/engine.test.ts の該当部分を移植）
// 充足判定（分母/分子・3/5・Upload≠Accepted）・条件分岐（カスケード・下書きルール無視・循環検知）・形式チェック・回答チェック（ルール判定）・案件開始パック
import { describe, it, expect } from 'vitest';
import { evaluateCompleteness, missingSummary, readyExceptSignoff } from '../../shared/intake/completeness';
import { detectCycles, evalCondition, evaluateLogic } from '../../shared/intake/logic';
import { webTemplate, sampleTemplates } from '../../shared/intake/samples';
import { validateAnswer } from '../../shared/intake/validate';
import { lintDefinition } from '../../shared/intake/lint';
import { runAnswerChecks } from '../../shared/intake/checks';
import { buildPackage, toMarkdown, toText } from '../../shared/intake/package';
import type { FileInfo, TemplateDefinition } from '../../shared/intake/types';

const def = webTemplate.definition;
const fullAnswers = {
  company_name: 'A', company_address: 'Tokyo', ceo_message: 'hello', site_purpose: ['company'], site_goal: '問い合わせを増やしたい（月20件）',
  business_description: 'x', reference_sites: [{ url: 'https://example.com', reason: 'design' }], contact_name: 'B', contact_email: 'b@example.com', privacy_ack: true,
};
const f = (itemId: string, n: number, status: FileInfo['status'] = 'pending_review'): FileInfo[] =>
  Array.from({ length: n }, (_, i) => ({ id: `${itemId}${i}`, itemId, status, originalName: `${i}.png`, mime: 'image/png', size: 10 }));

describe('必須項目の進捗（分子/分母）', () => {
  it('必要項目7件中5件提出 → 71%', () => {
    const r = evaluateCompleteness({ def, answers: fullAnswers, files: [], itemStates: [] });
    expect(r.progress.denominator).toBe(7);
    expect(r.progress.submitted).toBe(5);
    expect(r.progress.percent).toBe(71);
    expect(r.items.find((i) => i.itemId === 'logo')!.status).toBe('missing');
    expect(missingSummary(r.items)).toContain('ロゴデータ未提出');
  });
  it('非表示の質問は分母から除外、表示＋必須化されたものは加算（EC選択で7→9）', () => {
    const base = evaluateCompleteness({ def, answers: fullAnswers, files: [], itemStates: [] });
    expect(base.items.find((i) => i.itemId === 'q:ec_product_count')!.applicable).toBe(false);
    const ec = evaluateCompleteness({ def, answers: { ...fullAnswers, site_purpose: ['company', 'ec'] }, files: [], itemStates: [] });
    expect(ec.progress.denominator).toBe(9);
    expect(ec.progress.submitted).toBe(5);
  });
  it('非表示の質問の回答は保持されるが判定から除外（effectiveAnswers）', () => {
    const st = evaluateLogic(def, { ...fullAnswers, ec_product_count: 10 });
    expect(st.visible.ec_product_count).toBe(false);
    expect(st.effectiveAnswers.ec_product_count).toBeUndefined();
  });
});

describe('条件分岐', () => {
  it('EC選択でEC質問を表示・必須化、採用は非表示のまま', () => {
    const st = evaluateLogic(def, { site_purpose: ['ec'] });
    expect(st.visible.ec_product_count).toBe(true);
    expect(st.required.ec_product_count).toBe(true);
    expect(st.visible.recruit_positions).toBe(false);
  });
  it('カスケード：非表示の質問に依存する質問も非表示', () => {
    const d: TemplateDefinition = structuredClone(def);
    d.rules.push({ id: 'r_c', when: { questionId: 'ec_membership', op: 'eq', value: 'yes' }, then: [{ type: 'show', target: 'recruit_flow' }] });
    expect(evaluateLogic(d, { site_purpose: ['ec'], ec_membership: 'yes' }).visible.recruit_flow).toBe(true);
    expect(evaluateLogic(d, { site_purpose: ['company'], ec_membership: 'yes' }).visible.recruit_flow).toBe(false);
  });
  it('下書き（未有効化）のルールは評価しない', () => {
    const d: TemplateDefinition = structuredClone(def);
    d.rules.push({ id: 'r_ai', status: 'draft', origin: 'ai', when: { questionId: 'company_name', op: 'answered' }, then: [{ type: 'show', target: 'recruit_flow' }] });
    expect(evaluateLogic(d, { company_name: 'x' }).visible.recruit_flow).toBe(false);
  });
  it('循環 A→B→A を検知し lint でエラー。サンプルはすべてエラーなし', () => {
    const d: TemplateDefinition = structuredClone(def);
    d.rules.push({ id: 'c1', when: { questionId: 'ec_shipping', op: 'answered' }, then: [{ type: 'show', target: 'ec_membership' }] });
    d.rules.push({ id: 'c2', when: { questionId: 'ec_membership', op: 'eq', value: 'yes' }, then: [{ type: 'hide', target: 'ec_shipping' }] });
    expect(detectCycles(d).length).toBeGreaterThan(0);
    expect(lintDefinition(d).errors.join()).toMatch(/循環/);
    for (const s of sampleTemplates) expect(lintDefinition(s.definition).errors, s.key).toEqual([]);
  });
  it('複数選択への eq は「含む」、in は配列・カンマ区切りを受け付ける', () => {
    expect(evalCondition({ questionId: 'p', op: 'eq', value: 'ec' }, { p: ['company', 'ec'] })).toBe(true);
    expect(evalCondition({ questionId: 'p', op: 'neq', value: 'ec' }, { p: ['company', 'ec'] })).toBe(false);
    expect(evalCondition({ questionId: 'p', op: 'in', value: 'ec, recruit' }, { p: 'recruit' })).toBe(true);
    expect(evalCondition({ questionId: 'p', op: 'in', value: ['ec'] }, { p: ['company'] })).toBe(false);
  });
});

describe('ファイル項目：3/5は一部提出、提出≠承認', () => {
  it('件数と承認', () => {
    const r = evaluateCompleteness({ def, answers: fullAnswers, files: f('product_images', 3), itemStates: [] });
    const it = r.items.find((i) => i.itemId === 'product_images')!;
    expect([it.status, it.count, it.minCount]).toEqual(['partial', 3, 5]);
    const r5 = evaluateCompleteness({ def, answers: fullAnswers, files: f('product_images', 5), itemStates: [] });
    expect(r5.items.find((i) => i.itemId === 'product_images')!.status).toBe('submitted');
    const ok = evaluateCompleteness({ def, answers: fullAnswers, files: f('product_images', 5, 'accepted'), itemStates: [] });
    expect(ok.items.find((i) => i.itemId === 'product_images')!.status).toBe('accepted');
    const rej = evaluateCompleteness({ def, answers: fullAnswers, files: [...f('product_images', 4, 'accepted'), { ...f('product_images', 1, 'rejected')[0], id: 'r' }], itemStates: [] });
    expect(rej.items.find((i) => i.itemId === 'product_images')!.status).toBe('partial');
    const allRej = evaluateCompleteness({ def, answers: fullAnswers, files: f('logo', 1, 'rejected'), itemStates: [] });
    expect(allRej.items.find((i) => i.itemId === 'logo')!.status).toBe('rejected');
  });
  it('Ready：全承認＋未解決0件＋サインオフ。サインオフ前は SIGNOFF_REQUIRED のみ', () => {
    const files = [...f('logo', 1, 'accepted'), ...f('product_images', 5, 'accepted')];
    const pre = evaluateCompleteness({ def, answers: fullAnswers, files, itemStates: [] });
    expect(pre.ready.reasons.map((r) => r.code)).toEqual(['SIGNOFF_REQUIRED']);
    expect(readyExceptSignoff(pre)).toBe(true);
    const blocked = evaluateCompleteness({ def, answers: fullAnswers, files, itemStates: [], unresolvedAiCount: 2 });
    expect(blocked.ready.reasons.map((r) => r.code)).toContain('AI_UNRESOLVED');
    expect(readyExceptSignoff(blocked)).toBe(false);
    expect(evaluateCompleteness({ def, answers: fullAnswers, files, itemStates: [], internalSignoff: true }).ready.ready).toBe(true);
  });
});

describe('回答の形式チェック', () => {
  const q = (type: any, extra = {}) => ({ id: 'x', sectionId: 's', type, label: 'x', ...extra });
  it('各タイプ', () => {
    expect(validateAnswer(q('email'), 'a@b')).not.toBeNull();
    expect(validateAnswer(q('email'), 'a@b.jp')).toBeNull();
    expect(validateAnswer(q('url'), 'javascript:alert(1)')).not.toBeNull();
    expect(validateAnswer(q('number', { min: 0, max: 10 }), 11)).not.toBeNull();
    expect(validateAnswer(q('date'), '2026-02-30')).not.toBeNull();
    expect(validateAnswer(q('single_choice', { options: [{ value: 'a', label: 'A' }] }), 'b')).not.toBeNull();
    expect(validateAnswer(q('yes_no'), 'maybe')).not.toBeNull();
    expect(validateAnswer(q('phone'), '03-1234-5678')).toBeNull();
    expect(validateAnswer(q('repeating_group', { fields: [{ id: 'url', label: 'URL', type: 'url' }] }), [{ url: 'nope' }])).not.toBeNull();
  });
});

describe('回答チェック（ルール判定）', () => {
  it('商品数10 vs「全25商品」は矛盾候補（回答は変更しない）', () => {
    const answers = { ...fullAnswers, site_purpose: ['ec'], ec_product_count: 10, requests: '全25商品を掲載したい' };
    const out = runAnswerChecks({ def, answers, fileTexts: [], today: '2026-10-05' });
    expect(out.contradictions.length).toBe(1);
    expect(out.contradictions[0].text).toMatch(/10.*25/);
    expect(out.contradictions[0].sourceRefs.map((s) => s.questionId)).toEqual(['ec_product_count', 'requests']);
    expect(answers.ec_product_count).toBe(10);
  });
  it('曖昧な目的 → 追加質問候補（選択肢つき）、参考サイトの理由なし・過去の公開希望日', () => {
    const out = runAnswerChecks({
      def,
      answers: { ...fullAnswers, site_goal: '会社のサイトです', reference_sites: [{ url: 'https://example.com' }], launch_date: '2026-01-01' },
      fileTexts: [],
      today: '2026-10-05',
    });
    expect(out.followUps[0].questionId).toBe('site_goal');
    expect(out.followUps[0].options).toEqual(['問い合わせ獲得', '採用', '会社案内', '販売']);
    expect(out.ambiguities.map((a) => a.questionId)).toContain('reference_sites');
    expect(out.contradictions.some((c) => c.fingerprint.startsWith('date:launch_date'))).toBe(true);
  });
  it('テキストファイル本文の数量とも照合', () => {
    const out = runAnswerChecks({ def, answers: { ...fullAnswers, site_purpose: ['ec'], ec_product_count: 10 }, fileTexts: [{ fileId: 'f1', name: 'list.txt', text: '合計 12 品目' }], today: '2026-10-05' });
    expect(out.contradictions[0].sourceRefs[1]).toEqual({ fileId: 'f1' });
  });
});

describe('FreelanceDesk 案件開始パック', () => {
  it('出典付き・未回答は Unknown・非表示の回答は含めない・未承認は Open Questions', () => {
    const answers = { ...fullAnswers, ec_product_count: 99, site_purpose: ['company', 'inquiry'] };
    const result = evaluateCompleteness({ def, answers, files: f('logo', 1, 'accepted'), itemStates: [] });
    const pkg = buildPackage(
      {
        intake: { id: 'i1', title: 'Web制作ヒアリング', status: 'needs_client', ready_at: null, ready_override: null, due_date: '2026-11-01', internal_signoff_at: null, signoff_note: null },
        project: { number: 'P-2026-0001', title: 'コーポレートサイト' },
        clientName: 'Sample株式会社',
        def,
        result,
        files: [{ id: 'abcdef1234', itemId: 'logo', originalName: 'logo.pdf', status: 'accepted', size: 2048 }],
        itemStates: [],
      },
      new Date('2026-10-08T00:00:00Z'),
      { followups: [{ id: 'fu1', question_id: 'site_goal', text: '目的は？', status: 'open', answer: null }] },
    );
    const md = toMarkdown(pkg);
    expect(md).toContain('# FreelanceDesk 案件開始パック：コーポレートサイト');
    expect(md).toContain('`[q:company_name]`');
    expect(md).toContain('主なお客様（ターゲット）**: Unknown（未回答）');
    expect(md).not.toContain('掲載する商品数'); // 非表示（EC未選択）の回答は含めない
    expect(md).toContain('files/logo/abcdef12_logo.pdf');
    expect(md).toMatch(/商品・サービス画像\*\*: 未提出（0\/5）/);
    expect(md).toContain('目的は？（回答待ち）');
    expect(md).toContain('お問い合わせフォーム（候補）');
    expect(pkg.sections.openQuestions.every((e) => e.status === 'unknown')).toBe(true);
    expect(toText(md)).not.toMatch(/\*\*|`|^#/m);
  });
});
