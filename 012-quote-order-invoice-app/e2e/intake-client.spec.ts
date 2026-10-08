// E2E：FreelanceDesk ヒアリング／FreelanceDesk 案件開始パック
// 運営者が案件詳細「ヒアリング」タブでサンプルから作成・公開 → お客様がスマホでポータルから回答・ファイル提出・送信 →
// 運営者が承認・サインオフ（Ready）→ 案件開始パックを作成 → お客様側にも「そろいました」
import { test, expect } from '@playwright/test';
import { MOBILE, PC, apiPost, apiPut, newCtx, noHorizontalOverflow, rid, signupApi } from './helpers';

test('ヒアリング：作成・公開→お客様が回答・提出・送信→承認・サインオフ→案件開始パック', async ({ browser }) => {
  // ---- 運営者 ----
  const op = await newCtx(browser, PC);
  await signupApi(op.page);
  const req = op.page.request;
  const cu = await apiPost(req, '/api/customers', {
    code: '', name: 'Sample商店', contactName: '佐藤 一郎', honorific: '様', postalCode: '', address: '', phone: '', email: 'intake@example.com',
    paymentTerms: '', payerName: '', internalMemo: '',
  });
  const p = await apiPost(req, '/api/projects', { requestId: rid(), customerId: cu.customer.id, title: 'ヒアリングE2E案件', inquiryDate: null, plannedStart: null, plannedDue: null, internalMemo: '' });
  await apiPut(req, `/api/projects/${p.id}/portal`, { status: 'published' });
  const inv = await apiPost(req, `/api/projects/${p.id}/portal/invites`, {});

  await op.page.goto(`/projects/${p.id}?tab=intake`);
  await expect(op.page.getByTestId('intake-tab')).toBeVisible();
  await op.page.getByTestId('intake-template-select').selectOption('sample:generic');
  await op.page.getByRole('button', { name: '作成', exact: true }).click();
  await expect(op.page.getByTestId('intake-op-status')).toHaveText('下書き');
  await op.page.getByRole('button', { name: 'お客様に公開する' }).click();
  await expect(op.page.getByTestId('intake-op-status')).toHaveText('回答受付中（公開済み）');

  // ---- お客様（スマホ） ----
  const cl = await newCtx(browser, MOBILE);
  const page = cl.page;
  await page.goto(inv.path);
  await page.getByLabel('メールアドレス').fill('intake@example.com');
  await page.getByRole('button', { name: 'ポータルを開く' }).click();
  await expect(page.getByRole('heading', { name: 'ヒアリングE2E案件' })).toBeVisible();
  await page.getByRole('link', { name: /汎用ヒアリング/ }).click();
  await expect(page.getByTestId('intake-progress')).toContainText('必要項目 0/4');
  await expect(page.getByTestId('intake-missing')).toContainText('関連資料');
  await page.getByLabel('お名前・会社名').fill('Sample商店 佐藤');
  await page.getByLabel('メールアドレス').fill('sato@example');
  await page.getByLabel('ご依頼の目的').fill('新商品のチラシとWebバナーを作りたいです');
  await page.getByRole('button', { name: '一時保存' }).click();
  await expect(page.getByRole('alert')).toContainText('1件の回答を保存できませんでした');
  await expect(page.getByTestId('intake-q-email')).toContainText('メールアドレスの形式が正しくありません');
  await page.getByLabel('メールアドレス').fill('sato@example.com');
  await page.getByRole('button', { name: '一時保存' }).click();
  await expect(page.getByTestId('intake-progress')).toContainText('必要項目 3/4');
  // ファイル提出（PDF）
  await page.getByLabel('関連資料を提出').setInputFiles({ name: '資料.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n% e2e\n%%EOF\n') });
  await expect(page.getByTestId('item-status-generic_files')).toContainText('提出済み（確認待ち）');
  await expect(page.getByRole('link', { name: '資料.pdf' })).toBeVisible();
  await noHorizontalOverflow(page);
  await page.getByRole('button', { name: '内容を送信する' }).click();
  await expect(page.getByTestId('intake-status')).toHaveText('担当者が確認中です');

  // ---- 運営者：承認・サインオフ・パック ----
  await op.page.reload();
  await expect(op.page.getByTestId('intake-op-status')).toHaveText('内部確認待ち');
  await op.page.getByTestId('op-item-generic_files').getByRole('button', { name: '承認', exact: true }).click();
  await expect(op.page.getByTestId('ready-reasons')).toHaveText('内部レビューの最終確認（サインオフ）が未完了です');
  await op.page.getByRole('button', { name: '内容を確認してサインオフ' }).click();
  await expect(op.page.getByTestId('intake-op-status')).toHaveText('Ready（開始可能）');
  await op.page.getByRole('button', { name: '案件開始パックを作成' }).click();
  await expect(op.page.getByTestId('package-preview')).toContainText('# FreelanceDesk 案件開始パック：ヒアリングE2E案件');
  await expect(op.page.getByTestId('package-preview')).toContainText('新商品のチラシとWebバナーを作りたいです `[q:purpose]`');
  await expect(op.page.getByTestId('package-list')).toContainText('v1');
  const md = await op.page.request.get(await op.page.getByRole('link', { name: 'Markdown' }).getAttribute('href') as string);
  expect(md.headers()['content-disposition']).toContain('.md');
  const zip = await op.page.request.get(await op.page.getByRole('link', { name: '提出ファイルをZIPで保存' }).getAttribute('href') as string);
  expect(zip.headers()['content-type']).toBe('application/zip');

  // ---- お客様：状態と経過 ----
  await page.reload();
  await expect(page.getByTestId('intake-status')).toHaveText('必要な情報がそろいました');
  await page.getByRole('link', { name: /ヒアリングE2E案件 に戻る/ }).click();
  await expect(page.getByText('ヒアリング「汎用ヒアリング」：必要な情報がそろいました')).toBeVisible();
  await noHorizontalOverflow(page);

  await cl.ctx.close();
  await op.ctx.close();
});
