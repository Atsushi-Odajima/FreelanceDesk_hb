import { test, expect } from '@playwright/test';
import path from 'node:path';
import { apiGet, apiIssuedInvoice, apiOrdered, apiPost, apiPut, line, loginUi, MOBILE, newCtx, noHorizontalOverflow, PC, rid, signupApi } from './helpers';

test('シナリオ2：見積提出→失注（請求を生成しない）', async ({ browser }) => {
  const { ctx, page } = await newCtx(browser, PC);
  await signupApi(page);
  const cu = await apiPost(page.request, '/api/customers', { code: '', name: '架空商店', contactName: '', honorific: '御中', postalCode: '', address: '', phone: '', email: '', paymentTerms: '', payerName: '', internalMemo: '' });
  const p = await apiPost(page.request, '/api/projects', { requestId: rid(), customerId: cu.customer.id, title: 'パンフレット', inquiryDate: null, plannedStart: null, plannedDue: null, internalMemo: '' });
  const q = await apiPost(page.request, `/api/projects/${p.id}/quotes`, { requestId: rid() });
  await apiPut(page.request, `/api/quote-versions/${q.versionId}`, { issueDate: '2026-09-01', validUntil: null, subject: 'x', deliveryNote: '', paymentTerms: '', notes: '', taxMode: 'exclusive', lineRounding: 'round', taxRounding: 'floor', lines: [line('パンフレット', 200000)], adjustments: [], changeMemo: '' });
  await apiPost(page.request, `/api/quote-versions/${q.versionId}/submit`, { submittedOn: '2026-09-02' });

  await page.goto(`/projects/${p.id}`);
  await page.getByRole('tab', { name: '見積・受注' }).click();
  await page.getByRole('button', { name: '失注にする' }).click();
  await page.getByRole('dialog').getByRole('button', { name: '失注にする' }).click();
  await expect(page.getByTestId('project-detail').getByText('失注', { exact: true }).first()).toBeVisible();
  await page.getByRole('tab', { name: '請求・入金' }).click();
  await expect(page.getByRole('button', { name: '請求書を作る' })).toHaveCount(0);
  const inv = await apiGet(page.request, '/api/invoices?state=all');
  expect(inv.invoices).toHaveLength(0);
  await ctx.close();
});

test('シナリオ3：受注→納品→未請求表示→請求作成で未請求から消える', async ({ browser }) => {
  const { ctx, page } = await newCtx(browser, PC);
  await signupApi(page);
  const o = await apiOrdered(page.request, { title: '未請求チェック案件' });
  await page.goto(`/projects/${o.projectId}`);
  await page.getByTestId('next-action').click(); // 次の操作：タスクを進める or 納品を記録
  await page.getByRole('tab', { name: '納品' }).click();
  await page.getByRole('button', { name: '納品を記録' }).first().click();
  await page.getByRole('dialog').getByRole('button', { name: '納品を記録' }).click();
  await page.goto('/');
  await expect(page.getByTestId('list-unbilled')).toContainText('未請求チェック案件');
  await page.getByTestId('list-unbilled').getByText('未請求チェック案件').click();
  await page.getByRole('tab', { name: '請求・入金' }).click();
  await page.getByRole('button', { name: '請求書を作る' }).last().click();
  await page.getByTestId('to-confirm').click();
  await page.getByTestId('finalize-invoice').click();
  await expect(page).toHaveURL(/\/invoices\//);
  await page.goto('/');
  await expect(page.getByTestId('list-unbilled')).not.toContainText('未請求チェック案件');
  await ctx.close();
});

test('シナリオ4：期限超過請求→銀行CSV(Shift_JIS)→候補→利用者確定→入金済み', async ({ browser }) => {
  const { ctx, page } = await newCtx(browser, PC);
  await signupApi(page);
  const a = await apiIssuedInvoice(page.request, '2026-09-01', { title: 'ロゴ制作', total: 55000 });
  await page.goto('/');
  await expect(page.getByTestId('list-overdue')).toContainText('Sample Design株式会社');

  await page.goto('/payments/import');
  await page.getByLabel('銀行CSVファイル').setInputFiles(path.resolve('e2e/fixtures/bank_sjis.csv'));
  await expect(page.getByLabel('文字コード')).toHaveValue('shift_jis'); // 自動判定
  await expect(page.getByLabel('日付の列')).toHaveValue('0');
  await expect(page.getByLabel('名義（摘要）の列')).toHaveValue('1');
  await expect(page.getByLabel('入金額の列')).toHaveValue('3');
  await expect(page.getByText(/入金 2件/)).toBeVisible(); // 出金行は対象外、改行入りフィールドも1行
  await page.getByTestId('import-bank').click();
  await expect(page.getByText('2件の入金を取り込みました')).toBeVisible();

  // 自動では割り当てられていない
  let inv = await apiGet(page.request, `/api/invoices/${a.invoiceId}`);
  expect(inv.invoice.paymentState).toBe('unpaid');

  await page.getByRole('link', { name: '照合して割り当てる' }).click();
  const card = page.getByTestId('payment-list').locator('.list-item', { hasText: '55,000' });
  await card.getByTestId('match-payment').click();
  const cands = page.getByTestId('candidates');
  await expect(cands).toContainText('残額と入金額が一致');
  await expect(cands).toContainText('名義と顧客名が一致');
  await cands.getByRole('radio').first().check();
  await page.getByTestId('confirm-allocation').click();
  await expect(page.getByTestId('payment-list')).not.toContainText('55,000');
  inv = await apiGet(page.request, `/api/invoices/${a.invoiceId}`);
  expect(inv.invoice).toMatchObject({ paymentState: 'paid', overdue: false });

  // 同じCSVの再取込は拒否（UTF-8 BOM版でも内容が同じなら拒否）
  await page.goto('/payments/import');
  await page.getByLabel('銀行CSVファイル').setInputFiles(path.resolve('e2e/fixtures/bank_utf8_bom.csv'));
  await expect(page.getByLabel('文字コード')).toHaveValue('utf-8');
  await page.getByTestId('import-bank').click();
  await expect(page.getByText('すでに取り込まれています')).toBeVisible();
  await ctx.close();
});

test('シナリオ5：スマホで案件作成（二重送信）→PCで編集→スマホで最新確認', async ({ browser }) => {
  const mobile = await newCtx(browser, MOBILE);
  const { email, password } = await signupApi(mobile.page);
  await apiPost(mobile.page.request, '/api/customers', { code: '', name: '架空商店', contactName: '', honorific: '御中', postalCode: '', address: '', phone: '', email: '', paymentTerms: '', payerName: '', internalMemo: '' });
  const m = mobile.page;
  await m.goto('/projects/new');
  await m.getByLabel('顧客', { exact: true }).selectOption({ label: '架空商店' });
  await m.getByLabel('案件名').fill('スマホで作った案件');
  // 端末下書きが保存されている
  await expect(m.getByText(/端末下書き/)).toBeVisible();
  // 二重タップ＋再送（同じ requestId）
  const btn = m.getByRole('button', { name: '登録する' });
  await Promise.all([btn.dblclick(), m.waitForURL(/\/projects\/[0-9a-f-]{36}$/)]);
  const url = m.url();
  const list = await apiGet(m.request, '/api/projects');
  expect(list.projects.filter((p: any) => p.title === 'スマホで作った案件')).toHaveLength(1);

  // PCでログインして続きを編集
  const pc = await newCtx(browser, PC);
  await loginUi(pc.page, email, password);
  await pc.page.goto(new URL(url).pathname);
  await pc.page.getByRole('link', { name: '編集' }).click();
  await pc.page.getByLabel('案件名').fill('PCで編集した案件名');
  await pc.page.getByLabel('予定納期').fill('2026-12-24');
  await pc.page.getByRole('button', { name: '保存' }).click();
  await expect(pc.page.getByRole('heading', { name: 'PCで編集した案件名' })).toBeVisible();

  // スマホで最新を確認
  await m.reload();
  await expect(m.getByRole('heading', { name: 'PCで編集した案件名' })).toBeVisible();
  await expect(m.getByText('2026年12月24日').first()).toBeVisible();
  const list2 = await apiGet(m.request, '/api/projects');
  expect(list2.projects).toHaveLength(1);
  await noHorizontalOverflow(m);
  await mobile.ctx.close();
  await pc.ctx.close();
});
